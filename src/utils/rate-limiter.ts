/**
 * Rate Limiter — sliding window per-tool request limiting.
 *
 * Configuration via environment variables:
 *   SYMFONY_MCP_RATE_LIMIT          — max requests per window (default: 60)
 *   SYMFONY_MCP_RATE_WINDOW_MS      — window size in ms (default: 60000 = 1 min)
 *   SYMFONY_MCP_RATE_BURST          — max burst in 1s (default: 10)
 *   SYMFONY_MCP_RATE_LIMIT=0        — disables rate limiting entirely
 *
 * Expensive tools (log reads, entity scans) get a tighter per-minute limit.
 */

interface WindowEntry {
  timestamps: number[];  // Request timestamps within the current window
}

const windowStore = new Map<string, WindowEntry>();

// Tools that are heavier and get lower limits
const EXPENSIVE_TOOLS = new Set([
  'tail_log',
  'search_log',
  'get_error_summary',
  'list_entities',
  'validate_schema_mapping',
  'get_installed_packages',
]);

function getConfig(): { maxPerWindow: number; windowMs: number; burstMax: number; enabled: boolean } {
  const raw = parseInt(process.env['SYMFONY_MCP_RATE_LIMIT'] ?? '60', 10);
  const enabled = !isNaN(raw) && raw > 0;

  return {
    enabled,
    maxPerWindow: isNaN(raw) || raw <= 0 ? 60 : raw,
    windowMs: parseInt(process.env['SYMFONY_MCP_RATE_WINDOW_MS'] ?? '60000', 10) || 60000,
    burstMax: parseInt(process.env['SYMFONY_MCP_RATE_BURST'] ?? '10', 10) || 10,
  };
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
  retryAfterMs?: number;
}

/**
 * Check whether a tool call is within rate limits.
 * Call this BEFORE executing the tool.
 *
 * @param toolName - Name of the tool being called
 * @param clientKey - Identifier for the caller (default: 'default')
 */
export function checkRateLimit(toolName: string, clientKey: string = 'default'): RateLimitResult {
  const config = getConfig();

  if (!config.enabled) {
    return { allowed: true, remaining: Infinity, resetInMs: 0 };
  }

  const now = Date.now();
  const windowMs = config.windowMs;
  const isExpensive = EXPENSIVE_TOOLS.has(toolName);

  // Expensive tools get half the per-window limit
  const limit = isExpensive ? Math.floor(config.maxPerWindow / 2) : config.maxPerWindow;

  // Burst check (1-second window)
  const burstKey = `burst:${clientKey}:${toolName}`;
  const burstEntry = getOrCreate(burstKey, now);
  pruneBefore(burstEntry, now - 1000);

  if (burstEntry.timestamps.length >= config.burstMax) {
    const oldestBurst = burstEntry.timestamps[0];
    const retryAfterMs = 1000 - (now - oldestBurst);
    return {
      allowed: false,
      remaining: 0,
      resetInMs: retryAfterMs,
      retryAfterMs,
    };
  }

  // Per-window check
  const windowKey = `window:${clientKey}:${toolName}`;
  const windowEntry = getOrCreate(windowKey, now);
  pruneBefore(windowEntry, now - windowMs);

  const resetInMs = windowEntry.timestamps.length > 0
    ? windowMs - (now - windowEntry.timestamps[0])
    : windowMs;

  if (windowEntry.timestamps.length >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetInMs,
      retryAfterMs: resetInMs,
    };
  }

  // Record this request
  burstEntry.timestamps.push(now);
  windowEntry.timestamps.push(now);

  return {
    allowed: true,
    remaining: limit - windowEntry.timestamps.length,
    resetInMs,
  };
}

/**
 * Returns current rate limit stats for all tracked tool/client pairs.
 * Useful for the audit tool.
 */
export function getRateLimitStats(): Record<string, { count: number; limit: number }> {
  const config = getConfig();
  const stats: Record<string, { count: number; limit: number }> = {};
  const now = Date.now();

  for (const [key, entry] of windowStore.entries()) {
    if (!key.startsWith('window:')) continue;
    const toolName = key.split(':').slice(2).join(':');
    const active = entry.timestamps.filter((t) => t > now - config.windowMs).length;
    const isExpensive = EXPENSIVE_TOOLS.has(toolName);
    const limit = isExpensive ? Math.floor(config.maxPerWindow / 2) : config.maxPerWindow;
    if (active > 0) {
      stats[toolName] = { count: active, limit };
    }
  }

  return stats;
}

/**
 * Resets rate limit counters (useful for testing).
 */
export function resetRateLimits(): void {
  windowStore.clear();
}

// Internals

function getOrCreate(key: string, _now: number): WindowEntry {
  let entry = windowStore.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    windowStore.set(key, entry);
  }
  return entry;
}

function pruneBefore(entry: WindowEntry, cutoff: number): void {
  const idx = entry.timestamps.findIndex((t) => t >= cutoff);
  if (idx > 0) {
    entry.timestamps.splice(0, idx);
  } else if (idx === -1) {
    entry.timestamps.length = 0;
  }
}
