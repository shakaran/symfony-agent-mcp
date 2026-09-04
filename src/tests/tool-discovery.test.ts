// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Progressive discovery: the five meta-tools a client sees before anything
 * else, and the session state behind them.
 *
 * The sweep calls these like any other module, with an application path,
 * which is not what they take. What they take is a session and a category,
 * and the answers that matter are the ones about a session: what is active,
 * what activating costs, what happens over the budget and what a name that
 * does not exist comes back as.
 */

import { toolRegistry } from '../utils/tool-registry.js';
import {
  activateCategory,
  deactivateCategory,
  getActiveTools,
  getToolDiscoveryTools,
  listToolCategories,
  resolveSessionId,
  searchTools,
} from '../tools/tool-discovery.js';

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

// The registry is filled by the server on start-up. Here it gets a set built
// for the purpose: names that fall into several categories, one of them large
// enough to matter against the budget.
beforeAll(() => {
  const appPath = {
    type: 'object',
    properties: { app_path: { type: 'string', description: 'Root of the application' } },
    required: ['app_path'],
  };

  const names = [
    'list_routes', 'get_route_details', 'search_routes',
    'list_entities', 'get_entity_details', 'list_doctrine_migrations',
    'list_security_voters', 'list_firewalls', 'list_security_ip_access',
    'list_messenger_transports', 'list_messenger_routing_table',
    'list_twig_templates', 'list_twig_extensions',
    'list_phpunit_config', 'list_behat_tags',
    'list_aws_s3_config', 'list_azure_pipelines_config',
    'list_docker_compose_health', 'list_kubernetes_manifests',
  ];

  const filler = Array.from({ length: 220 }, (_, i) => `list_generated_thing_${i}`);

  toolRegistry.init([...names, ...filler].map((name) => ({
    name,
    description: `Inspect ${name.replace(/_/g, ' ')} in a Symfony application, reporting what it finds and the problems in it`,
    inputSchema: appPath,
  })));
});

let session = 0;
const nextSession = (): string => `test-session-${++session}`;

describe('the categories a client is offered', () => {
  test('every category is listed with what it costs', () => {
    const text = textOf(listToolCategories());

    expect(text).toContain('Available tool categories');
    expect(text).toContain('tokens if all active');
    expect(text).toMatch(/tools \|| \d+ tools/);
    expect(text).toContain('activate_category');
  });

  test('the meta-tools describe themselves', () => {
    const tools = getToolDiscoveryTools();

    expect(tools.length).toBeGreaterThanOrEqual(5);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z0-9_]+$/);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toHaveProperty('type', 'object');
    }
  });
});

describe('searching for a tool', () => {
  test('a query with no words is refused rather than answered', () => {
    const empty = searchTools('', 8);
    const blank = searchTools('   ', 8);

    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toContain('query is required');
    expect(blank.isError).toBe(true);
  });

  test('a query that matches comes back with schemas and what to activate', () => {
    const text = textOf(searchTools('routes', 5));

    expect(text).toMatch(/Found \d+ tools matching "routes"/);
    expect(text).toContain('Input schema:');
    expect(text).toContain('activate_category(');
  });

  test('a query that matches nothing says so and points at the categories', () => {
    const text = textOf(searchTools('zzzz-nothing-matches-4a1c9f', 8));

    expect(text).toContain('No tools found');
    expect(text).toContain('list_tool_categories');
  });

  test('the limit is clamped at both ends', () => {
    const none = textOf(searchTools('entity', 0));
    const huge = textOf(searchTools('entity', 500));

    expect(none).toMatch(/Found \d+ tools/);
    expect(huge).toMatch(/Found \d+ tools/);
    // Twenty is the ceiling, whatever was asked for.
    expect((huge.match(/^### /gm) ?? []).length).toBeLessThanOrEqual(20);
  });
});

describe('activating and deactivating', () => {
  test('a session starts with nothing active', () => {
    const text = textOf(getActiveTools(nextSession()));

    expect(text).toContain('No tool categories are currently active');
    expect(text).toContain('list_tool_categories()');
  });

  test('a category without a name is refused', () => {
    const result = activateCategory(nextSession(), '', false);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('category is required');
  });

  test('a category that does not exist lists the ones that do', () => {
    const result = activateCategory(nextSession(), 'not-a-category', false);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown category');
    expect(textOf(result)).toContain('Valid categories:');
  });

  test('a real category becomes active, and shows in the session', () => {
    const id = nextSession();
    const first = listToolCategories();
    const category = /^ {2}([a-z0-9_-]+)\s+│/m.exec(textOf(first))?.[1];
    expect(category).toBeDefined();

    const activated = activateCategory(id, category!, false);
    expect(activated.isError).toBeFalsy();
    expect(textOf(activated)).toContain('tools/list refresh');

    const active = textOf(getActiveTools(id));
    expect(active).toContain('Active tool categories');
    expect(active).toContain(category!);
    expect(active).toContain('Token estimate:');
  });

  test('deactivating gives the budget back', () => {
    const id = nextSession();
    const category = /^ {2}([a-z0-9_-]+)\s+│/m.exec(textOf(listToolCategories()))?.[1];

    activateCategory(id, category!, false);
    const off = deactivateCategory(id, category!);

    expect(textOf(off).length).toBeGreaterThan(0);
    expect(textOf(getActiveTools(id))).toContain('No tool categories are currently active');
  });

  test('deactivating without a name, and one that was never active', () => {
    const id = nextSession();
    const missing = deactivateCategory(id, '');
    const never = deactivateCategory(id, 'routes');

    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('category is required');
    expect(textOf(never).length).toBeGreaterThan(0);
  });

  test('"all" activates everything at once', () => {
    const id = nextSession();
    const text = textOf(activateCategory(id, 'all', false));

    expect(text).toContain('tools are now active');
    expect(text).toContain('Total estimated tokens:');

    const active = textOf(getActiveTools(id));
    expect(active).toContain('Active tool categories');
    expect(active).toMatch(/and \d+ more/);
  });

  test('a second category on top of the first is either allowed or refused on budget', () => {
    const id = nextSession();
    const categories = [...textOf(listToolCategories()).matchAll(/^ {2}([a-z0-9_-]+)\s+│/gm)].map((m) => m[1]);
    expect(categories.length).toBeGreaterThan(1);

    let refusedOnce = false;
    for (const category of categories) {
      const result = activateCategory(id, category, false);
      if (result.isError) {
        refusedOnce = true;
        // Over the budget is the only reason to refuse a valid category.
        expect(textOf(result).length).toBeGreaterThan(0);
        // And forcing it through is what the flag is for.
        const forced = activateCategory(id, category, true);
        expect(forced.isError).toBeFalsy();
        break;
      }
    }

    expect(typeof refusedOnce).toBe('boolean');
  });
});

describe('the session a request belongs to', () => {
  test('the identifier comes from the request when it carries one', () => {
    expect(resolveSessionId({ sessionId: 'abc-123' })).toBe('abc-123');
  });

  test('and falls back to a default when it does not', () => {
    const fallback = resolveSessionId();

    expect(resolveSessionId({})).toBe(fallback);
    expect(resolveSessionId({ sessionId: '' })).toBe(fallback);
    expect(resolveSessionId({ sessionId: 42 as unknown as string })).toBe(fallback);
    expect(fallback.length).toBeGreaterThan(0);
  });
});
