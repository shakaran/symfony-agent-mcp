/* eslint-disable @typescript-eslint/no-require-imports --
 * jest.isolateModules works by re-requiring inside its callback; a static
 * import would be hoisted out of the isolated registry and defeat the point.
 * require() is the intended API here, not a CommonJS leftover.
 */

/**
 * Toggles read once, at module load.
 *
 * SYMFONY_MCP_CACHE and SYMFONY_MCP_DB_CONNECT are captured into module
 * constants when the file is first required, so setting them in a test after
 * the fact does nothing. Reaching those branches means loading the module
 * afresh with the environment already in place — which is exactly what an
 * operator does when they set the variable and restart the server.
 */

describe('cache disabled at load time', () => {
  const withCacheOff = <T>(fn: (m: typeof import('../utils/cache-manager')) => T): T => {
    let out!: T;
    jest.isolateModules(() => {
      const prev = process.env['SYMFONY_MCP_CACHE'];
      process.env['SYMFONY_MCP_CACHE'] = 'false';
      try {
        out = fn(require('../utils/cache-manager') as typeof import('../utils/cache-manager'));
      } finally {
        if (prev === undefined) delete process.env['SYMFONY_MCP_CACHE'];
        else process.env['SYMFONY_MCP_CACHE'] = prev;
      }
    });
    return out;
  };

  test('a write is discarded and the read misses', () => {
    withCacheOff(({ cacheManager }) => {
      cacheManager.set('ns', 'k', 'v');
      expect(cacheManager.get('ns', 'k')).toBeNull();
    });
  });

  test('nothing is counted as a hit', () => {
    withCacheOff(({ cacheManager }) => {
      cacheManager.set('ns', 'k', 'v');
      cacheManager.get('ns', 'k');
      expect(cacheManager.getStats().hits).toBe(0);
    });
  });

  test('caching is on by default', () => {
    jest.isolateModules(() => {
      const prev = process.env['SYMFONY_MCP_CACHE'];
      delete process.env['SYMFONY_MCP_CACHE'];
      try {
        const { cacheManager } = require('../utils/cache-manager') as typeof import('../utils/cache-manager');
        cacheManager.set('ns', 'k', 'v');
        expect(cacheManager.get('ns', 'k')).toBe('v');
      } finally {
        if (prev !== undefined) process.env['SYMFONY_MCP_CACHE'] = prev;
      }
    });
  });
});

describe('live database connections disabled at load time', () => {
  const withDbOff = <T>(fn: (m: typeof import('../utils/db-real-connector')) => Promise<T>): Promise<T> => {
    let out!: Promise<T>;
    jest.isolateModules(() => {
      const prev = process.env['SYMFONY_MCP_DB_CONNECT'];
      process.env['SYMFONY_MCP_DB_CONNECT'] = 'false';
      try {
        out = fn(require('../utils/db-real-connector') as typeof import('../utils/db-real-connector'));
      } finally {
        if (prev === undefined) delete process.env['SYMFONY_MCP_DB_CONNECT'];
        else process.env['SYMFONY_MCP_DB_CONNECT'] = prev;
      }
    });
    return out;
  };

  test('a query is refused and says how to enable it', async () => {
    await withDbOff(async ({ executeQuery }) => {
      await expect(executeQuery('/app', 'SELECT 1'))
        .rejects.toThrow(/SYMFONY_MCP_DB_CONNECT=true/);
    });
  });

  test('the refusal happens before the query is even inspected', async () => {
    await withDbOff(async ({ executeQuery }) => {
      // Even a write statement reports the kill switch, not the read-only guard.
      await expect(executeQuery('/app', 'DROP TABLE users'))
        .rejects.toThrow(/disabled/i);
    });
  });

  test('a connection test reports it as disabled rather than failing to connect', async () => {
    await withDbOff(async ({ testDatabaseConnection }) => {
      const r = await testDatabaseConnection('/app');

      expect(r.connected).toBe(false);
      expect(r.error).toMatch(/disabled/i);
      expect(Array.isArray(r.driversAvailable)).toBe(true);
    });
  });
});

describe('metrics disabled at load time', () => {
  test('counters stay empty while metrics are off', () => {
    jest.isolateModules(() => {
      const prev = process.env['SYMFONY_MCP_METRICS'];
      process.env['SYMFONY_MCP_METRICS'] = 'false';
      try {
        const m = require('../utils/security-metrics') as typeof import('../utils/security-metrics');
        m.resetMetrics();
        m.incToolCall('list_routes', 'success');
        m.incDlpRedaction('AWS_ACCESS_KEY');
        m.incHttpRequest('/sse', 'GET', '200');
        m.incSseSession('open');

        expect(m.renderPrometheus()).not.toContain('symfony_mcp_tool_calls_total');
      } finally {
        if (prev === undefined) delete process.env['SYMFONY_MCP_METRICS'];
        else process.env['SYMFONY_MCP_METRICS'] = prev;
      }
    });
  });
});

describe('metrics counters that the transport feeds', () => {
  test('HTTP requests and SSE sessions are counted', () => {
    jest.isolateModules(() => {
      const prev = process.env['SYMFONY_MCP_METRICS'];
      delete process.env['SYMFONY_MCP_METRICS'];
      try {
        const m = require('../utils/security-metrics') as typeof import('../utils/security-metrics');
        m.resetMetrics();
        m.incHttpRequest('/sse', 'GET', '200');
        m.incSseSession('open');
        m.incSseSession('close');

        const out = m.renderPrometheus();
        expect(out).toContain('symfony_mcp_http_requests_total');
        expect(out).toContain('symfony_mcp_sse_sessions_total');
      } finally {
        if (prev !== undefined) process.env['SYMFONY_MCP_METRICS'] = prev;
      }
    });
  });
});
