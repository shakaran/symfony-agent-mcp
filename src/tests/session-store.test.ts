// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * SessionStore unit tests.
 *
 * The store decides which tools a given MCP session sees, and enforces the
 * token budget that keeps a client from being handed 1600 schemas at once.
 * It had no coverage, yet the budget guard is what made `activate_category`
 * reject symfony-core in the end-to-end suite.
 */

import { sessionStore, DEFAULT_SESSION, DEFAULT_TOKEN_BUDGET } from '../utils/session-store';
import { toolRegistry } from '../utils/tool-registry';
import { estimateToolTokens } from '../utils/token-counter';
import type { ToolCategory } from '../utils/tool-categories';

// Seeded with real tool names so categorisation lands where it would in
// production; init() is idempotent, so this is a no-op when another suite
// got there first in the same worker.
beforeAll(() => {
  toolRegistry.init([
    { name: 'list_routes', description: 'List Symfony routes', inputSchema: { type: 'object' } },
    { name: 'get_route_details', description: 'Route details', inputSchema: { type: 'object' } },
    { name: 'list_entities', description: 'List Doctrine entities', inputSchema: { type: 'object' } },
    { name: 'get_table_schema', description: 'Table schema', inputSchema: { type: 'object' } },
  ]);
});

// Pick two categories that actually hold tools in whatever corpus is loaded,
// so these tests hold whether this file runs alone or after another suite.
function populatedCategories(): ToolCategory[] {
  return toolRegistry
    .getCategoryInfo()
    .filter((c) => c.toolCount > 0)
    .map((c) => c.key);
}

const SESSION = 'test-session';

beforeEach(() => {
  sessionStore.clear(SESSION);
  delete process.env['SYMFONY_MCP_TOKEN_BUDGET'];
});

afterAll(() => {
  sessionStore.clear(SESSION);
  delete process.env['SYMFONY_MCP_TOKEN_BUDGET'];
});

describe('defaults', () => {
  test('exposes the documented session id and budget', () => {
    expect(DEFAULT_SESSION).toBe('default');
    expect(DEFAULT_TOKEN_BUDGET).toBe(40_000);
  });

  test('an untouched session has nothing active', () => {
    expect(sessionStore.getActiveCategories('never-seen')).toEqual([]);
    expect(sessionStore.getActiveTools('never-seen')).toEqual([]);
    expect(sessionStore.estimateSessionTokens('never-seen')).toBe(0);
  });
});

describe('activation', () => {
  test('activating a category exposes its tools', () => {
    const [cat] = populatedCategories();
    const expected = toolRegistry.getByCategory(cat);

    const r = sessionStore.activateCategory(SESSION, cat);

    expect(r.ok).toBe(true);
    expect(r.added).toBe(expected.length);
    expect(sessionStore.getActiveCategories(SESSION)).toEqual([cat]);
    expect(sessionStore.getActiveTools(SESSION).map((t) => t.name).sort())
      .toEqual(expected.map((t) => t.name).sort());
  });

  test('activating twice is a no-op that still reports success', () => {
    const [cat] = populatedCategories();
    sessionStore.activateCategory(SESSION, cat);

    const second = sessionStore.activateCategory(SESSION, cat);

    expect(second.ok).toBe(true);
    expect(second.added).toBe(0);
    expect(second.message).toMatch(/already active/i);
    expect(sessionStore.getActiveCategories(SESSION)).toHaveLength(1);
  });

  test('token total tracks the tools actually exposed', () => {
    const [cat] = populatedCategories();
    sessionStore.activateCategory(SESSION, cat);

    expect(sessionStore.estimateSessionTokens(SESSION))
      .toBe(estimateToolTokens(toolRegistry.getByCategory(cat)));
  });

  test('sessions are isolated from one another', () => {
    const [cat] = populatedCategories();
    sessionStore.activateCategory(SESSION, cat);

    expect(sessionStore.getActiveCategories('other-session')).toEqual([]);
    sessionStore.clear('other-session');
  });
});

describe('token budget', () => {
  test('refuses an activation that would exceed the budget', () => {
    process.env['SYMFONY_MCP_TOKEN_BUDGET'] = '1';
    const [cat] = populatedCategories();

    const r = sessionStore.activateCategory(SESSION, cat);

    expect(r.ok).toBe(false);
    expect(r.added).toBe(0);
    expect(r.budgetWarning).toMatch(/exceeding the 1 token budget/);
    expect(r.budgetWarning).toMatch(/force=true/);
    expect(sessionStore.getActiveCategories(SESSION)).toEqual([]);
  });

  test('force=true overrides the budget and warns', () => {
    process.env['SYMFONY_MCP_TOKEN_BUDGET'] = '1';
    const [cat] = populatedCategories();

    const r = sessionStore.activateCategory(SESSION, cat, true);

    expect(r.ok).toBe(true);
    expect(r.added).toBeGreaterThan(0);
    expect(r.budgetWarning).toMatch(/exceed the configured budget/);
    expect(sessionStore.getActiveCategories(SESSION)).toEqual([cat]);
  });

  test('a non-numeric budget falls back to the default', () => {
    process.env['SYMFONY_MCP_TOKEN_BUDGET'] = 'not-a-number';
    const [cat] = populatedCategories();

    const r = sessionStore.activateCategory(SESSION, cat);

    // The fixture corpus is far below 40 000 tokens, so this must succeed.
    expect(r.ok).toBe(true);
    expect(r.budgetWarning).toBeUndefined();
  });

  test('no warning while comfortably inside the budget', () => {
    const [cat] = populatedCategories();
    expect(sessionStore.activateCategory(SESSION, cat).budgetWarning).toBeUndefined();
  });
});

describe('deactivation', () => {
  test('removes the category and its tools', () => {
    const [cat] = populatedCategories();
    sessionStore.activateCategory(SESSION, cat);

    const r = sessionStore.deactivateCategory(SESSION, cat);

    expect(r.ok).toBe(true);
    expect(r.removed).toBe(toolRegistry.getByCategory(cat).length);
    expect(sessionStore.getActiveCategories(SESSION)).toEqual([]);
    expect(sessionStore.getActiveTools(SESSION)).toEqual([]);
  });

  test('deactivating something that is not active reports failure', () => {
    const [cat] = populatedCategories();
    const r = sessionStore.deactivateCategory(SESSION, cat);

    expect(r.ok).toBe(false);
    expect(r.removed).toBe(0);
    expect(r.message).toMatch(/not active/i);
  });

  test('deactivating on an unknown session reports failure rather than throwing', () => {
    const [cat] = populatedCategories();
    expect(sessionStore.deactivateCategory('no-such-session', cat).ok).toBe(false);
  });
});

describe('activateAll', () => {
  test('activates every non-discovery category', () => {
    const r = sessionStore.activateAll(SESSION);

    expect(r.ok).toBe(true);
    expect(sessionStore.getActiveCategories(SESSION).sort())
      .toEqual(populatedCategories().sort());
    expect(r.totalTokens).toBe(sessionStore.estimateSessionTokens(SESSION));
  });

  test('ignores the budget entirely', () => {
    process.env['SYMFONY_MCP_TOKEN_BUDGET'] = '1';
    expect(sessionStore.activateAll(SESSION).ok).toBe(true);
  });

  test('counts only what it newly added', () => {
    const [cat] = populatedCategories();
    sessionStore.activateCategory(SESSION, cat);
    const already = toolRegistry.getByCategory(cat).length;

    const r = sessionStore.activateAll(SESSION);

    const everything = populatedCategories()
      .reduce((sum, c) => sum + toolRegistry.getByCategory(c).length, 0);
    expect(r.added).toBe(everything - already);
  });
});

describe('clear', () => {
  test('drops all state for the session', () => {
    sessionStore.activateAll(SESSION);
    sessionStore.clear(SESSION);

    expect(sessionStore.getActiveCategories(SESSION)).toEqual([]);
    expect(sessionStore.estimateSessionTokens(SESSION)).toBe(0);
  });

  test('clearing an unknown session does not throw', () => {
    expect(() => sessionStore.clear('never-existed')).not.toThrow();
  });
});
