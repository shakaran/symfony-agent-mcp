/**
 * Concurrent Request Limiter
 *
 * Caps the number of tool calls executing simultaneously.
 * This is distinct from rate limiting (which controls calls/time) —
 * it controls how many slow calls can run in parallel before new
 * callers are queued or rejected.
 *
 * Configuration:
 *   SYMFONY_MCP_MAX_CONCURRENT=10   — Max simultaneous tool executions (default: 10)
 *   SYMFONY_MCP_CONCURRENT_QUEUE=20 — Max callers waiting in queue before rejection (default: 20)
 *   SYMFONY_MCP_MAX_CONCURRENT=0    — Disable limit (allow unlimited concurrency)
 */

// ─── State ────────────────────────────────────────────────────────────────────

let activeCount = 0;
let queuedCount = 0;

// ─── Config ───────────────────────────────────────────────────────────────────

function getMaxConcurrent(): number {
  const val = parseInt(process.env['SYMFONY_MCP_MAX_CONCURRENT'] ?? '10', 10);
  return isNaN(val) ? 10 : val;
}

function getMaxQueue(): number {
  const val = parseInt(process.env['SYMFONY_MCP_CONCURRENT_QUEUE'] ?? '20', 10);
  return isNaN(val) ? 20 : val;
}

// ─── Semaphore implementation ─────────────────────────────────────────────────

type Release = () => void;

// FIFO queue of waiting callers
const waitQueue: Array<(release: Release) => void> = [];

function acquire(): Promise<Release> {
  const max = getMaxConcurrent();
  if (max === 0) {
    // Unlimited — return a no-op release immediately
    return Promise.resolve(() => { /* unlimited mode */ });
  }

  if (activeCount < max) {
    activeCount++;
    return Promise.resolve(makeRelease());
  }

  // At capacity — check queue limit
  const maxQueue = getMaxQueue();
  if (queuedCount >= maxQueue) {
    return Promise.reject(new Error('concurrency_queue_full'));
  }

  // Enqueue
  queuedCount++;
  return new Promise<Release>((resolve) => {
    waitQueue.push((release) => resolve(release));
  });
}

function makeRelease(): Release {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCount--;

    if (waitQueue.length > 0) {
      const next = waitQueue.shift()!;
      queuedCount--;
      activeCount++;
      next(makeRelease());
    }
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Executes `fn` under the concurrency limit.
 * If the limit is reached and the queue is full, rejects immediately.
 *
 * @param fn - Async function to execute
 * @returns Result of `fn`
 * @throws {Error} with message `'concurrency_queue_full'` when overloaded
 */
export async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Returns current concurrency statistics for metrics/diagnostics.
 */
export function getConcurrencyStats(): {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueue: number;
} {
  return {
    active: activeCount,
    queued: queuedCount,
    maxConcurrent: getMaxConcurrent(),
    maxQueue: getMaxQueue(),
  };
}

/** Reset state (for testing). */
export function resetConcurrencyLimiter(): void {
  activeCount = 0;
  queuedCount = 0;
  waitQueue.length = 0;
}
