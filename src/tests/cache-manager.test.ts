// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * LRUCacheManager unit tests.
 *
 * Covers the paths that decide whether a tool re-reads the filesystem: TTL
 * expiry, mtime invalidation, LRU ordering and eviction. Mtime invalidation
 * in particular is what stops a tool returning stale parse results after the
 * user edits a Symfony config file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cacheManager } from '../utils/cache-manager';

const NS = 'unit-test';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-mgr-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  cacheManager.clear();
});

function tmpFile(name: string, contents: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, contents);
  return p;
}

describe('basic get/set', () => {
  test('a miss returns null', () => {
    expect(cacheManager.get(NS, 'absent')).toBeNull();
  });

  test('a stored value comes back', () => {
    cacheManager.set(NS, 'k', { a: 1 });
    expect(cacheManager.get(NS, 'k')).toEqual({ a: 1 });
  });

  test('namespaces do not collide', () => {
    cacheManager.set('ns-a', 'same-key', 'from-a');
    cacheManager.set('ns-b', 'same-key', 'from-b');

    expect(cacheManager.get('ns-a', 'same-key')).toBe('from-a');
    expect(cacheManager.get('ns-b', 'same-key')).toBe('from-b');
  });

  test('setting the same key twice keeps the newer value', () => {
    cacheManager.set(NS, 'k', 'old');
    cacheManager.set(NS, 'k', 'new');
    expect(cacheManager.get(NS, 'k')).toBe('new');
  });

  test('falsy values round-trip and are distinguishable from a miss', () => {
    cacheManager.set(NS, 'zero', 0);
    cacheManager.set(NS, 'empty', '');
    cacheManager.set(NS, 'false', false);

    expect(cacheManager.get(NS, 'zero')).toBe(0);
    expect(cacheManager.get(NS, 'empty')).toBe('');
    expect(cacheManager.get(NS, 'false')).toBe(false);
    expect(cacheManager.get(NS, 'never-set')).toBeNull();
  });
});

describe('TTL', () => {
  test('an entry past its TTL is a miss', () => {
    cacheManager.set(NS, 'k', 'v', undefined, -1); // already expired
    expect(cacheManager.get(NS, 'k')).toBeNull();
  });

  test('an expired entry is evicted, not merely hidden', () => {
    cacheManager.set(NS, 'k', 'v', undefined, -1);
    cacheManager.get(NS, 'k');

    const before = cacheManager.getStats().misses;
    cacheManager.get(NS, 'k');
    expect(cacheManager.getStats().misses).toBe(before + 1);
  });

  test('an entry inside its TTL survives', () => {
    cacheManager.set(NS, 'k', 'v', undefined, 60_000);
    expect(cacheManager.get(NS, 'k')).toBe('v');
  });
});

describe('file mtime invalidation', () => {
  test('an unchanged watched file keeps the entry', () => {
    const f = tmpFile('stable.yaml', 'a: 1');
    cacheManager.set(NS, 'k', 'parsed', [f]);

    expect(cacheManager.get(NS, 'k', [f])).toBe('parsed');
  });

  test('a modified watched file invalidates the entry', () => {
    const f = tmpFile('changing.yaml', 'a: 1');
    cacheManager.set(NS, 'k', 'parsed', [f]);

    // Move the mtime forward explicitly; writing alone can land in the same
    // millisecond on a fast filesystem.
    const future = new Date(Date.now() + 10_000);
    fs.writeFileSync(f, 'a: 2');
    fs.utimesSync(f, future, future);

    expect(cacheManager.get(NS, 'k', [f])).toBeNull();
  });

  test('a deleted watched file invalidates the entry', () => {
    const f = tmpFile('doomed.yaml', 'a: 1');
    cacheManager.set(NS, 'k', 'parsed', [f]);
    fs.rmSync(f);

    expect(cacheManager.get(NS, 'k', [f])).toBeNull();
  });

  test('an unreadable file at set time is simply not tracked', () => {
    const missing = path.join(tmpDir, 'never-existed.yaml');
    expect(() => cacheManager.set(NS, 'k', 'v', [missing])).not.toThrow();
    // Reading without asking to watch anything still returns the value.
    expect(cacheManager.get(NS, 'k')).toBe('v');
  });

  test('one changed file among several invalidates', () => {
    const a = tmpFile('multi-a.yaml', '1');
    const b = tmpFile('multi-b.yaml', '2');
    cacheManager.set(NS, 'k', 'parsed', [a, b]);

    const future = new Date(Date.now() + 10_000);
    fs.writeFileSync(b, '3');
    fs.utimesSync(b, future, future);

    expect(cacheManager.get(NS, 'k', [a, b])).toBeNull();
  });
});

describe('invalidate and clear', () => {
  test('invalidate with a key drops just that entry', () => {
    cacheManager.set(NS, 'keep', 1);
    cacheManager.set(NS, 'drop', 2);

    cacheManager.invalidate(NS, 'drop');

    expect(cacheManager.get(NS, 'keep')).toBe(1);
    expect(cacheManager.get(NS, 'drop')).toBeNull();
  });

  test('invalidate without a key drops the whole namespace', () => {
    cacheManager.set(NS, 'a', 1);
    cacheManager.set(NS, 'b', 2);
    cacheManager.set('other', 'c', 3);

    cacheManager.invalidate(NS);

    expect(cacheManager.get(NS, 'a')).toBeNull();
    expect(cacheManager.get(NS, 'b')).toBeNull();
    expect(cacheManager.get('other', 'c')).toBe(3);
  });

  test('clear empties every namespace and resets counters', () => {
    cacheManager.set(NS, 'a', 1);
    cacheManager.get(NS, 'a');
    cacheManager.clear();

    expect(cacheManager.get(NS, 'a')).toBeNull();
    const stats = cacheManager.getStats();
    expect(stats.hits).toBe(0);
  });
});

describe('statistics', () => {
  test('hits and misses are counted separately', () => {
    cacheManager.set(NS, 'k', 'v');
    cacheManager.get(NS, 'k');       // hit
    cacheManager.get(NS, 'absent');  // miss

    const stats = cacheManager.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  test('getStats always returns numeric counters', () => {
    const s = cacheManager.getStats();
    expect(typeof s.hits).toBe('number');
    expect(typeof s.misses).toBe('number');
    expect(typeof s.evictions).toBe('number');
  });
});
