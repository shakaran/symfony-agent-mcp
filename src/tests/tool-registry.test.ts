/**
 * ToolRegistry unit tests.
 *
 * The registry backs progressive tool discovery: it categorises every tool
 * definition at startup, and `search_tools` / `list_tool_categories` read
 * through it. It had no coverage at all, which is how a stale expectation
 * about tools/list survived until the first public CI run.
 */

import { toolRegistry } from '../utils/tool-registry';
import { categorizeToolName, CATEGORY_DESCRIPTIONS, CATEGORY_TAGS } from '../utils/tool-categories';
import { estimateTokens, estimateToolTokens } from '../utils/token-counter';

// The registry is a process-wide singleton with an idempotent init(), so the
// first init wins for the whole file. Seed it with a small, known corpus.
const FIXTURES = [
  { name: 'list_routes', description: 'List all Symfony routes', inputSchema: { type: 'object' } },
  { name: 'get_route_details', description: 'Details for one route', inputSchema: { type: 'object' } },
  { name: 'list_entities', description: 'List Doctrine entities', inputSchema: { type: 'object' } },
  { name: 'get_table_schema', description: 'Database table schema', inputSchema: { type: 'object' } },
  { name: 'list_security_voters', description: 'Security voters and firewalls', inputSchema: {} },
  { name: 'list_tool_categories', description: 'Discovery meta-tool', inputSchema: {} },
];

beforeAll(() => {
  toolRegistry.init(FIXTURES);
});

describe('initialisation', () => {
  test('reports itself initialised and holds every tool', () => {
    expect(toolRegistry.isInitialized()).toBe(true);
    expect(toolRegistry.getAllTools()).toHaveLength(FIXTURES.length);
  });

  test('init is idempotent — a second call does not duplicate', () => {
    toolRegistry.init([{ name: 'should_be_ignored', description: 'x' }]);
    expect(toolRegistry.getAllTools()).toHaveLength(FIXTURES.length);
    expect(toolRegistry.getByName('should_be_ignored')).toBeUndefined();
  });

  test('assigns a category to every tool', () => {
    for (const t of toolRegistry.getAllTools()) {
      expect(t._category).toBe(categorizeToolName(t.name));
      expect(CATEGORY_DESCRIPTIONS[t._category]).toBeDefined();
    }
  });
});

describe('lookup', () => {
  test('getByName returns the tool with its category attached', () => {
    const t = toolRegistry.getByName('list_routes');
    expect(t).toBeDefined();
    expect(t?.name).toBe('list_routes');
    expect(t?._category).toBe(categorizeToolName('list_routes'));
  });

  test('getByName returns undefined for an unknown name', () => {
    expect(toolRegistry.getByName('no_such_tool')).toBeUndefined();
  });

  test('getByCategory returns an empty array for a category with no tools', () => {
    // 'cloud-aws' has no fixture in this corpus.
    expect(toolRegistry.getByCategory('cloud-aws')).toEqual([]);
  });

  test('every tool is reachable through its own category', () => {
    for (const t of toolRegistry.getAllTools()) {
      expect(toolRegistry.getByCategory(t._category).map((x) => x.name)).toContain(t.name);
    }
  });
});

describe('search', () => {
  test('finds a tool by a word in its name', () => {
    const names = toolRegistry.search('routes').map((t) => t.name);
    expect(names).toContain('list_routes');
  });

  test('finds a tool by a word in its description', () => {
    const names = toolRegistry.search('doctrine').map((t) => t.name);
    expect(names).toContain('list_entities');
  });

  test('returns an empty array for an empty query', () => {
    expect(toolRegistry.search('')).toEqual([]);
  });

  test('ignores tokens of two characters or fewer', () => {
    // The tokeniser drops short tokens, so this cannot match anything.
    expect(toolRegistry.search('a b')).toEqual([]);
  });

  test('honours the result limit', () => {
    expect(toolRegistry.search('list', 2).length).toBeLessThanOrEqual(2);
  });

  test('ranks an exact name match above a mere description hit', () => {
    const results = toolRegistry.search('list_routes');
    expect(results[0]?.name).toBe('list_routes');
  });

  test('never returns a tool twice', () => {
    const names = toolRegistry.search('list route entity', 10).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('category information', () => {
  test('omits the discovery category, which is always available', () => {
    expect(toolRegistry.getCategoryInfo().map((c) => c.key)).not.toContain('discovery');
  });

  test('each entry carries description, tags and a consistent count', () => {
    for (const info of toolRegistry.getCategoryInfo()) {
      expect(info.description).toBe(CATEGORY_DESCRIPTIONS[info.key]);
      expect(info.tags).toEqual(CATEGORY_TAGS[info.key]);
      expect(info.toolCount).toBe(toolRegistry.getByCategory(info.key).length);
      expect(info.estimatedTokens).toBe(estimateToolTokens(toolRegistry.getByCategory(info.key)));
    }
  });

  test('is sorted by tool count, descending', () => {
    const counts = toolRegistry.getCategoryInfo().map((c) => c.toolCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });
});

describe('token estimates', () => {
  test('the total is the sum over all tools', () => {
    expect(toolRegistry.getTotalTokenEstimate()).toBe(
      toolRegistry.getAllTools().reduce((sum, t) => sum + estimateTokens(t), 0)
    );
  });

  test('is positive for a non-empty registry', () => {
    expect(toolRegistry.getTotalTokenEstimate()).toBeGreaterThan(0);
  });
});
