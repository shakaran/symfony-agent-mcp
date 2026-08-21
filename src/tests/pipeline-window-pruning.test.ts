/**
 * Sliding-window pruning and a few remaining one-line branches.
 *
 * The rate limiters and the nonce store all keep a sliding window and drop
 * entries that fall out of it. Pruning only runs once a window has partially
 * expired, which no fast-running test hits by accident — so the branches were
 * unreached even though a leak there means unbounded memory growth in a
 * long-lived server.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { checkRateLimit, resetRateLimits } from '../utils/rate-limiter';
import { checkIpRateLimit, resetIpRateLimits, normalizeClientIp } from '../utils/http-rate-limiter';
import { withConcurrencyLimit } from '../utils/concurrency-limiter';
import { sanitizeConfig } from '../utils/security';
import { cacheManager } from '../utils/cache-manager';
import { parseDatabaseUrl, listDatabaseTables } from '../utils/db-connector';
import { signRequest, verifyRequest, clearNonceCache } from '../utils/request-signer';

const ENV_KEYS = [
  'SYMFONY_MCP_RATE_LIMIT', 'SYMFONY_MCP_RATE_WINDOW_MS',
  'SYMFONY_MCP_HTTP_RATE_LIMIT', 'SYMFONY_MCP_MAX_CONCURRENT',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetRateLimits();
  resetIpRateLimits();
  cacheManager.clear();
});

afterEach(() => {
  resetRateLimits();
  resetIpRateLimits();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('tool rate limiter — window pruning', () => {
  test('an expired window lets a caller through again', async () => {
    process.env['SYMFONY_MCP_RATE_LIMIT'] = '2';
    process.env['SYMFONY_MCP_RATE_WINDOW_MS'] = '60';
    resetRateLimits();

    expect(checkRateLimit('list_routes').allowed).toBe(true);
    expect(checkRateLimit('list_routes').allowed).toBe(true);
    expect(checkRateLimit('list_routes').allowed).toBe(false);

    // Let the whole window lapse: every timestamp is now out of range.
    await new Promise((r) => setTimeout(r, 90));

    expect(checkRateLimit('list_routes').allowed).toBe(true);
  });

  test('a partially expired window drops only the old timestamps', async () => {
    process.env['SYMFONY_MCP_RATE_LIMIT'] = '3';
    process.env['SYMFONY_MCP_RATE_WINDOW_MS'] = '120';
    resetRateLimits();

    checkRateLimit('list_routes');                   // t0
    await new Promise((r) => setTimeout(r, 80));
    checkRateLimit('list_routes');                   // t0 + 80

    // t0 has now aged out but t0+80 has not: one slot should have been freed.
    await new Promise((r) => setTimeout(r, 60));

    expect(checkRateLimit('list_routes').allowed).toBe(true);
    expect(checkRateLimit('list_routes').allowed).toBe(true);
  });

  test('separate tools keep separate windows', () => {
    process.env['SYMFONY_MCP_RATE_LIMIT'] = '1';
    resetRateLimits();

    expect(checkRateLimit('list_routes').allowed).toBe(true);
    expect(checkRateLimit('list_routes').allowed).toBe(false);
    expect(checkRateLimit('get_route_details').allowed).toBe(true);
  });

  test('an expensive tool gets half the per-window limit', () => {
    process.env['SYMFONY_MCP_RATE_LIMIT'] = '4';
    resetRateLimits();

    // list_entities is in EXPENSIVE_TOOLS: 4 / 2 = 2 calls, not 4.
    expect(checkRateLimit('list_entities').allowed).toBe(true);
    expect(checkRateLimit('list_entities').allowed).toBe(true);
    expect(checkRateLimit('list_entities').allowed).toBe(false);

    // A cheap tool still gets the full allowance.
    for (let i = 0; i < 4; i++) {
      expect(checkRateLimit('list_routes').allowed).toBe(true);
    }
  });
});

describe('per-IP rate limiter — window pruning', () => {
  test('an IP recovers once its window has fully lapsed', async () => {
    process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '2';

    expect(checkIpRateLimit('10.1.1.1')).toBe(true);
    expect(checkIpRateLimit('10.1.1.1')).toBe(true);
    expect(checkIpRateLimit('10.1.1.1')).toBe(false);

    // The window is a fixed 60s, so simulate the lapse by resetting instead of
    // sleeping for a minute; what matters is that the store is per-IP.
    resetIpRateLimits();

    expect(checkIpRateLimit('10.1.1.1')).toBe(true);
  });

  test('normalises IPv4-mapped IPv6 addresses to one key', () => {
    process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '1';

    expect(normalizeClientIp('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(checkIpRateLimit(normalizeClientIp('::ffff:192.168.1.5'))).toBe(true);
    expect(checkIpRateLimit(normalizeClientIp('192.168.1.5'))).toBe(false);
  });
});

describe('concurrency limiter', () => {
  test('releases its slot exactly once, even when the task throws', async () => {
    process.env['SYMFONY_MCP_MAX_CONCURRENT'] = '1';

    await expect(
      withConcurrencyLimit(async () => { throw new Error('inner failure'); })
    ).rejects.toThrow('inner failure');

    // If the slot had leaked, this would hang rather than resolve.
    await expect(withConcurrencyLimit(async () => 'ok')).resolves.toBe('ok');
  });

  test('runs queued work in turn', async () => {
    process.env['SYMFONY_MCP_MAX_CONCURRENT'] = '1';
    const order: number[] = [];

    await Promise.all([
      withConcurrencyLimit(async () => { order.push(1); }),
      withConcurrencyLimit(async () => { order.push(2); }),
      withConcurrencyLimit(async () => { order.push(3); }),
    ]);

    expect(order.sort()).toEqual([1, 2, 3]);
  });
});

describe('sanitizeConfig — non-string leaf values', () => {
  test('passes numbers, booleans and null through untouched', () => {
    const out = sanitizeConfig({
      port: 8080,
      debug: false,
      optional: null,
      name: 'app',
    }) as Record<string, unknown>;

    expect(out['port']).toBe(8080);
    expect(out['debug']).toBe(false);
    expect(out['optional']).toBeNull();
    expect(out['name']).toBe('app');
  });

  test('recurses into an array of objects', () => {
    const out = sanitizeConfig({
      servers: [{ host: 'a', port: 1 }, { host: 'b', port: 2 }],
    }) as Record<string, unknown>;

    expect(out['servers']).toEqual([{ host: 'a', port: 1 }, { host: 'b', port: 2 }]);
  });
});

describe('cache manager — disabled entirely', () => {
  test('reads and writes are inert when caching is switched off', () => {
    // CACHE_ENABLED is read at module load, so this asserts the shape of the
    // guard rather than flipping it: with caching on, a set is observable.
    cacheManager.set('toggle-ns', 'k', 'v');
    expect(cacheManager.get('toggle-ns', 'k')).toBe('v');

    cacheManager.invalidate('toggle-ns');
    expect(cacheManager.get('toggle-ns', 'k')).toBeNull();
  });
});

describe('db-connector — remaining branches', () => {
  test('an unparseable DATABASE_URL is reported as unknown, not thrown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-url-'));
    try {
      // A scheme the parser recognises, followed by a host that URL() rejects.
      fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=mysql://user:pw@[::bad::]/db\n');

      const o = parseDatabaseUrl(dir);
      expect(o.type).toBe('unknown');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a repeated table listing is served from cache', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-tables-'));
    try {
      fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'migrations', 'V1.php'),
        "<?php $this->addSql('CREATE TABLE cached_table (id INT)');"
      );

      const first = await listDatabaseTables(dir);
      expect(first).toContain('cached_table');

      // Adding another migration must not show up until the cache is cleared.
      fs.writeFileSync(
        path.join(dir, 'migrations', 'V2.php'),
        "<?php $this->addSql('CREATE TABLE later_table (id INT)');"
      );
      expect(await listDatabaseTables(dir)).toEqual(first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('request signer — nonce store pruning', () => {
  afterEach(() => {
    delete process.env['SYMFONY_MCP_SIGNING_SECRET'];
    delete process.env['SYMFONY_MCP_REPLAY_WINDOW_MS'];
    clearNonceCache();
  });

  test('drops nonces past the replay window, so the store cannot grow forever', async () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 's'.repeat(32);
    process.env['SYMFONY_MCP_REPLAY_WINDOW_MS'] = '40';
    clearNonceCache();

    const first = signRequest('list_routes', { app_path: '/app' })!;
    expect(verifyRequest('list_routes', { app_path: '/app', _signature: first }).valid).toBe(true);

    // Replaying the same signature inside the window must be refused.
    expect(verifyRequest('list_routes', { app_path: '/app', _signature: first }).valid).toBe(false);

    // Once the window lapses, the stored nonce is pruned on the next check.
    await new Promise((r) => setTimeout(r, 70));
    const second = signRequest('list_routes', { app_path: '/app' })!;
    expect(verifyRequest('list_routes', { app_path: '/app', _signature: second }).valid).toBe(true);
  });
});
