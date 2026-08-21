import {
  withConcurrencyLimit,
  getConcurrencyStats,
  resetConcurrencyLimiter,
} from '../utils/concurrency-limiter';

beforeEach(() => {
  resetConcurrencyLimiter();
  delete process.env['SYMFONY_MCP_MAX_CONCURRENT'];
  delete process.env['SYMFONY_MCP_CONCURRENT_QUEUE'];
});

afterEach(() => {
  resetConcurrencyLimiter();
  delete process.env['SYMFONY_MCP_MAX_CONCURRENT'];
  delete process.env['SYMFONY_MCP_CONCURRENT_QUEUE'];
});

describe('withConcurrencyLimit — basic execution', () => {
  test('executes a function and returns its result', async () => {
    const result = await withConcurrencyLimit(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  test('propagates errors from the wrapped function', async () => {
    await expect(
      withConcurrencyLimit(() => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom');
  });

  test('releases slot after error', async () => {
    await expect(
      withConcurrencyLimit(() => Promise.reject(new Error('fail')))
    ).rejects.toThrow();
    const stats = getConcurrencyStats();
    expect(stats.active).toBe(0);
  });
});

describe('withConcurrencyLimit — concurrency cap', () => {
  test('allows up to maxConcurrent simultaneous executions', async () => {
    process.env['SYMFONY_MCP_MAX_CONCURRENT'] = '3';
    process.env['SYMFONY_MCP_CONCURRENT_QUEUE'] = '10';
    resetConcurrencyLimiter();

    let maxObserved = 0;
    let current = 0;

    const task = (): Promise<void> => withConcurrencyLimit(async () => {
      current++;
      if (current > maxObserved) maxObserved = current;
      await new Promise(r => setTimeout(r, 10));
      current--;
    });

    await Promise.all(Array.from({ length: 6 }, () => task()));
    expect(maxObserved).toBeLessThanOrEqual(3);
  }, 5000);

  test('rejects immediately when queue is full', async () => {
    process.env['SYMFONY_MCP_MAX_CONCURRENT'] = '1';
    process.env['SYMFONY_MCP_CONCURRENT_QUEUE'] = '1';
    resetConcurrencyLimiter();

    // Hold the single slot
    let releaseHeld!: () => void;
    const held = withConcurrencyLimit(() => new Promise<void>(r => { releaseHeld = r; }));

    // Fill the 1-slot queue
    const queued = withConcurrencyLimit(() => Promise.resolve());

    // Third call should be rejected immediately (queue full)
    await expect(
      withConcurrencyLimit(() => Promise.resolve())
    ).rejects.toThrow('concurrency_queue_full');

    releaseHeld();
    await held;
    await queued;
  }, 5000);
});

describe('getConcurrencyStats', () => {
  test('reports zero active and queued when idle', () => {
    const stats = getConcurrencyStats();
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
  });

  test('reports configured limits', () => {
    process.env['SYMFONY_MCP_MAX_CONCURRENT'] = '5';
    process.env['SYMFONY_MCP_CONCURRENT_QUEUE'] = '15';
    resetConcurrencyLimiter();
    const stats = getConcurrencyStats();
    expect(stats.maxConcurrent).toBe(5);
    expect(stats.maxQueue).toBe(15);
  });
});

describe('unlimited mode', () => {
  test('SYMFONY_MCP_MAX_CONCURRENT=0 allows unlimited concurrency', async () => {
    process.env['SYMFONY_MCP_MAX_CONCURRENT'] = '0';
    resetConcurrencyLimiter();

    // Should never throw — no queue limit applies
    const tasks = Array.from({ length: 50 }, (_, i) =>
      withConcurrencyLimit(() => Promise.resolve(i))
    );
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(50);
  }, 5000);
});
