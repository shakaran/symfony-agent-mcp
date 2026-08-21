/**
 * Time-Based Session Tokens (TOTP-style)
 *
 * Provides short-lived tokens that expire after a configurable window.
 * Works independently of transport — useful even for stdio (pass token
 * as SYMFONY_MCP_SESSION_TOKEN env var on the client side).
 *
 * Token algorithm:
 *   token = HMAC-SHA256(secret, floor(unix_ts / window) || ":" || purpose)
 *   Accepts current window AND previous window (prevents edge-case failures)
 *
 * Configuration:
 *   SYMFONY_MCP_SESSION_SECRET   — token generation secret (min 16 chars)
 *                                  If unset, token auth is DISABLED
 *   SYMFONY_MCP_SESSION_WINDOW   — window duration in seconds (default: 300 = 5 min)
 *   SYMFONY_MCP_SESSION_STRICT   — "true" = reject requests without valid token
 *   SYMFONY_MCP_SESSION_TOKEN    — token to validate on incoming requests
 *                                  (set by the MCP client)
 */

import * as crypto from 'crypto';

const PURPOSE = 'symfony-mcp-session';

function getSecret(): string | null {
  return process.env['SYMFONY_MCP_SESSION_SECRET'] ?? null;
}

function getWindowSeconds(): number {
  return parseInt(process.env['SYMFONY_MCP_SESSION_WINDOW'] ?? '300', 10) || 300;
}

function isStrict(): boolean {
  return process.env['SYMFONY_MCP_SESSION_STRICT'] === 'true';
}

function currentWindowCounter(): number {
  return Math.floor(Date.now() / 1000 / getWindowSeconds());
}

function deriveToken(secret: string, counter: number): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${counter}:${PURPOSE}`)
    .digest('hex')
    .slice(0, 32); // 128-bit, 32 hex chars
}

/**
 * Generates a fresh session token valid for the current window (and accepted for the next).
 * Returns null if session token auth is not configured.
 */
export function generateSessionToken(): string | null {
  const secret = getSecret();
  if (!secret) return null;

  return deriveToken(secret, currentWindowCounter());
}

export interface TokenVerifyResult {
  valid: boolean;
  reason?: string;
  expiresInSeconds?: number;
}

/**
 * Verifies a session token provided by the client.
 * Accepts tokens from the current window and the previous window (clock skew tolerance).
 *
 * @param token - Token to verify (from SYMFONY_MCP_SESSION_TOKEN or request meta)
 */
export function verifySessionToken(token: string | undefined): TokenVerifyResult {
  const secret = getSecret();
  const strict = isStrict();

  // Auth not configured — accept all
  if (!secret) return { valid: true };

  if (!token || typeof token !== 'string') {
    const reason = 'No session token provided. Set SYMFONY_MCP_SESSION_TOKEN on the client.';
    if (strict) return { valid: false, reason };
    process.stderr.write(`[symfony-mcp][warn] ${reason}\n`);
    return { valid: true };
  }

  const counter = currentWindowCounter();
  const windowSecs = getWindowSeconds();

  // Check current window and previous window (handles clock skew + window boundaries)
  for (const offset of [0, -1]) {
    const expected = deriveToken(secret, counter + offset);
    const tokenBuf = Buffer.from(token.padEnd(64, '0').slice(0, 64));
    const expectedBuf = Buffer.from(expected.padEnd(64, '0').slice(0, 64));

    if (crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
      // Token is valid — calculate how many seconds until current window expires
      const windowStartSec = (counter) * windowSecs;
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresInSeconds = windowStartSec + windowSecs - nowSec;

      return { valid: true, expiresInSeconds };
    }
  }

  return {
    valid: false,
    reason: 'Session token is invalid or expired. Generate a new one with: symfony-agent-mcp --generate-token',
  };
}

/**
 * Returns the token that the CLIENT should set as SYMFONY_MCP_SESSION_TOKEN.
 * Prints setup instructions to stderr on startup.
 */
export function emitTokenInstructions(): void {
  const secret = getSecret();
  if (!secret) return;

  const token = generateSessionToken();
  const windowSecs = getWindowSeconds();

  process.stderr.write(
    `[symfony-mcp] Session token auth ENABLED (window: ${windowSecs}s)\n` +
    `[symfony-mcp] Set on client: SYMFONY_MCP_SESSION_TOKEN=${token}\n` +
    `[symfony-mcp] Token regenerates every ${windowSecs}s — update client accordingly.\n`
  );
}

/**
 * Returns current token status for diagnostics.
 */
export function getTokenStatus(): {
  enabled: boolean;
  strict: boolean;
  windowSeconds: number;
  currentToken: string | null;
  expiresInSeconds: number;
} {
  const secret = getSecret();
  const windowSecs = getWindowSeconds();
  const counter = currentWindowCounter();
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresInSeconds = (counter + 1) * windowSecs - nowSec;

  return {
    enabled: secret !== null,
    strict: isStrict(),
    windowSeconds: windowSecs,
    currentToken: secret ? generateSessionToken() : null,
    expiresInSeconds,
  };
}
