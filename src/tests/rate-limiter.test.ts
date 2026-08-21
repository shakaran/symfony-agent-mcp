import { checkRateLimit, resetRateLimits, getRateLimitStats } from '../utils/rate-limiter';

beforeEach(() => {
  resetRateLimits();
  // Ensure rate limiting is active during tests
  delete process.env['SYMFONY_MCP_RATE_LIMIT'];
  delete process.env['SYMFONY_MCP_RATE_WINDOW_MS'];
  delete process.env['SYMFONY_MCP_RATE_BURST'];
});

afterEach(() => {
  resetRateLimits();
});

describe('checkRateLimit', () => {
  test('allows requests within limits', () => {
    const result = checkRateLimit('list_routes', 'test-client');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
  });

  test('returns remaining count that decrements', () => {
    const first = checkRateLimit('list_routes', 'test-decrement');
    const second = checkRateLimit('list_routes', 'test-decrement');
    expect(second.remaining).toBe(first.remaining - 1);
  });

  test('blocks when burst limit exceeded', () => {
    process.env['SYMFONY_MCP_RATE_BURST'] = '3';
    resetRateLimits();

    // Make 3 requests (the limit)
    for (let i = 0; i < 3; i++) {
      const r = checkRateLimit('list_routes', 'burst-client');
      expect(r.allowed).toBe(true);
    }

    // 4th should be blocked
    const blocked = checkRateLimit('list_routes', 'burst-client');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  test('different clients are tracked independently', () => {
    process.env['SYMFONY_MCP_RATE_BURST'] = '1';
    resetRateLimits();

    checkRateLimit('list_routes', 'client-a');
    const blocked = checkRateLimit('list_routes', 'client-a');
    expect(blocked.allowed).toBe(false);

    // client-b should still be allowed
    const clientB = checkRateLimit('list_routes', 'client-b');
    expect(clientB.allowed).toBe(true);
  });

  test('different tools are tracked independently', () => {
    process.env['SYMFONY_MCP_RATE_BURST'] = '1';
    resetRateLimits();

    checkRateLimit('list_routes', 'client');
    const blocked = checkRateLimit('list_routes', 'client');
    expect(blocked.allowed).toBe(false);

    // Different tool should still be allowed
    const other = checkRateLimit('list_services', 'client');
    expect(other.allowed).toBe(true);
  });

  test('rate limiting disabled when SYMFONY_MCP_RATE_LIMIT=0', () => {
    process.env['SYMFONY_MCP_RATE_LIMIT'] = '0';
    resetRateLimits();

    for (let i = 0; i < 100; i++) {
      const r = checkRateLimit('list_routes', 'unlimited');
      expect(r.allowed).toBe(true);
    }
  });

  test('expensive tools get half the per-window limit', () => {
    process.env['SYMFONY_MCP_RATE_LIMIT'] = '10';
    process.env['SYMFONY_MCP_RATE_BURST'] = '20'; // High burst so we're testing window, not burst
    resetRateLimits();

    // Make 5 requests to an expensive tool (half of 10)
    let lastResult;
    for (let i = 0; i < 5; i++) {
      lastResult = checkRateLimit('tail_log', 'exp-client');
    }
    // 5th should still be allowed (we're AT the limit, not over)
    expect(lastResult?.allowed).toBe(true);
    expect(lastResult?.remaining).toBe(0);

    // 6th should be blocked
    const blocked = checkRateLimit('tail_log', 'exp-client');
    expect(blocked.allowed).toBe(false);
  });
});

describe('getRateLimitStats', () => {
  test('returns stats for active tools', () => {
    process.env['SYMFONY_MCP_RATE_LIMIT'] = '60';
    resetRateLimits();

    checkRateLimit('list_routes', 'stats-client');
    checkRateLimit('list_routes', 'stats-client');

    const stats = getRateLimitStats();
    expect(stats['list_routes']).toBeDefined();
    expect(stats['list_routes'].count).toBe(2);
    expect(stats['list_routes'].limit).toBeGreaterThan(0);
  });

  test('returns empty object when no requests made', () => {
    resetRateLimits();
    const stats = getRateLimitStats();
    expect(Object.keys(stats)).toHaveLength(0);
  });
});
