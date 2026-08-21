/**
 * Per-IP Rate Limiter for HTTP transport (R)
 *
 * A separate module so the logic can be unit-tested without importing
 * the ESM-only MCP SDK that lives in http-transport.ts.
 *
 * Configuration:
 *   SYMFONY_MCP_HTTP_RATE_LIMIT  — max requests per IP per 60 s (default: 120)
 *                                  Set to 0 to disable.
 */

const ipRateWindows = new Map<string, number[]>();

function getHttpRateLimit(): number {
  const raw = parseInt(process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] ?? '120', 10);
  return isNaN(raw) || raw < 0 ? 120 : raw; // 0 = disabled
}

/**
 * Returns the normalised form of an IP address.
 * IPv4-mapped IPv6 (::ffff:a.b.c.d) is collapsed to plain IPv4.
 */
export function normalizeClientIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

/**
 * Checks whether the given IP has exceeded the per-IP HTTP rate limit.
 * Uses a 60-second sliding window. Returns true if the request is allowed.
 */
export function checkIpRateLimit(ip: string): boolean {
  const max = getHttpRateLimit();
  if (max === 0) return true; // disabled

  const now = Date.now();
  const key = normalizeClientIp(ip);

  if (!ipRateWindows.has(key)) ipRateWindows.set(key, []);
  const timestamps = ipRateWindows.get(key)!;

  // Prune timestamps older than 60 seconds
  const cutoff = now - 60_000;
  const first = timestamps.findIndex((t) => t >= cutoff);
  if (first > 0) timestamps.splice(0, first);
  else if (first === -1) timestamps.length = 0;

  if (timestamps.length >= max) return false;
  timestamps.push(now);
  return true;
}

/**
 * Resets all per-IP rate limit counters (for testing).
 */
export function resetIpRateLimits(): void {
  ipRateWindows.clear();
}

/**
 * Returns the configured limit for diagnostics.
 */
export function getHttpRateLimitConfig(): { maxPerMinute: number; enabled: boolean } {
  const max = getHttpRateLimit();
  return { maxPerMinute: max, enabled: max > 0 };
}
