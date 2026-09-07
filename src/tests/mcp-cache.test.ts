// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The server's own cache, as the two tools that report on it see it.
 *
 * These take no application path, so the sweep that calls every module with
 * one never reaches them: what they describe is the process, not a project.
 */

import { cacheManager } from '../utils/cache-manager';
import { clearMcpCache, inspectMcpCache } from '../tools/cache-inspector';

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

afterEach(() => {
  cacheManager.clear();
});

test('the statistics name every namespace holding entries', () => {
  cacheManager.set('routes', 'list', { value: 1 });
  cacheManager.set('entities', 'list', { value: 2 });
  cacheManager.get('routes', 'list');
  cacheManager.get('routes', 'missing');

  const text = textOf(inspectMcpCache());

  expect(text).toContain('MCP Server Cache Statistics');
  expect(text).toContain('Namespaces:');
  expect(text).toContain('routes');
  expect(text).toContain('Hits:');
});

test('clearing says how much it removed', () => {
  cacheManager.set('routes', 'list', { value: 1 });

  const text = textOf(clearMcpCache());

  expect(text).toContain('cache cleared');
  expect(textOf(inspectMcpCache())).toContain('Total entries: 0');
});

test('a cache that cannot report on itself comes back as an error, not a crash', () => {
  jest.spyOn(cacheManager, 'getStats').mockImplementation(() => {
    throw new Error('statistics unavailable');
  });

  try {
    const stats = inspectMcpCache();
    const cleared = clearMcpCache();

    expect(stats.isError).toBe(true);
    expect(textOf(stats)).toContain('statistics unavailable');
    expect(cleared.isError).toBe(true);
    expect(textOf(cleared)).toContain('statistics unavailable');
  } finally {
    jest.restoreAllMocks();
  }
});
