// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Request Signing — HMAC-SHA256
 *
 * Signs and verifies tool call requests to prevent:
 *  - Unauthorized callers in multi-tenant deployments
 *  - Replay attacks (via per-request nonce + timestamp)
 *
 * Configuration:
 *   SYMFONY_MCP_SIGNING_SECRET   — shared HMAC secret (min 32 chars)
 *                                  If unset, signing is DISABLED (open mode)
 *   SYMFONY_MCP_SIGN_STRICT      — set to "true" to REQUIRE valid signatures
 *                                  (default: false — warns but allows unsigned requests)
 *   SYMFONY_MCP_REPLAY_WINDOW_MS — max age of a valid signature in ms (default: 30000)
 *
 * Signature format (meta field on every tool call):
 *   {
 *     "name": "list_routes",
 *     "arguments": { "app_path": "..." },
 *     "_signature": {
 *       "ts":    1705312345678,   ← Unix ms timestamp
 *       "nonce": "a1b2c3d4",     ← 8 random hex chars
 *       "sig":   "sha256=<hex>"  ← HMAC-SHA256(secret, ts:nonce:tool_name:sorted_args_json)
 *     }
 *   }
 */

import * as crypto from 'crypto';

export interface SignaturePayload {
  ts: number;
  nonce: string;
  sig: string;
}

export interface SignResult {
  ts: number;
  nonce: string;
  sig: string;
}

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: string; fatal: boolean };

function getSecret(): string | null {
  return process.env['SYMFONY_MCP_SIGNING_SECRET'] ?? null;
}

function isStrict(): boolean {
  return process.env['SYMFONY_MCP_SIGN_STRICT'] === 'true';
}

function getReplayWindowMs(): number {
  return parseInt(process.env['SYMFONY_MCP_REPLAY_WINDOW_MS'] ?? '30000', 10) || 30000;
}

/**
 * Builds the canonical string that gets signed:
 *   "<timestamp>:<nonce>:<tool_name>:<canonical_args>"
 *
 * canonical_args = JSON of args with keys sorted alphabetically,
 * with the _signature field excluded.
 */
function canonicalize(ts: number, nonce: string, toolName: string, args: Record<string, unknown>): string {
  const sanitizedArgs = { ...args };
  delete sanitizedArgs['_signature'];

  const sortedArgs = Object.fromEntries(
    Object.keys(sanitizedArgs)
      .sort()
      .map((k) => [k, sanitizedArgs[k]])
  );

  return `${ts}:${nonce}:${toolName}:${JSON.stringify(sortedArgs)}`;
}

function hmac(secret: string, message: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Signs a tool call and returns the signature payload to attach as `_signature`.
 * Returns null if signing is not configured.
 */
export function signRequest(toolName: string, args: Record<string, unknown>): SignResult | null {
  const secret = getSecret();
  if (!secret) return null;

  const ts = Date.now();
  const nonce = crypto.randomBytes(4).toString('hex');
  const canonical = canonicalize(ts, nonce, toolName, args);
  const sig = hmac(secret, canonical);

  return { ts, nonce, sig };
}

// Nonce cache: prevents replay attacks within the replay window.
// Key: `${ts}:${nonce}`, Value: expiry timestamp
const usedNonces = new Map<string, number>();

function pruneNonces(): void {
  const now = Date.now();
  for (const [key, expiry] of usedNonces.entries()) {
    if (expiry < now) usedNonces.delete(key);
  }
}

/**
 * Verifies a signed tool call.
 *
 * Returns `{ valid: true }` if:
 *  - Signing is not configured (open mode), OR
 *  - The signature is present and valid
 *
 * Returns `{ valid: false, reason, fatal }` on failure.
 * `fatal: true` means the request MUST be rejected.
 * `fatal: false` means strict mode is off (warn only).
 */
export function verifyRequest(
  toolName: string,
  args: Record<string, unknown>
): VerifyResult {
  const secret = getSecret();
  const strict = isStrict();

  // Signing not configured — allow all requests
  if (!secret) return { valid: true };

  const sigPayload = args['_signature'] as SignaturePayload | undefined;

  if (!sigPayload) {
    const reason = `Tool call "${toolName}" is missing a _signature. Configure the caller to sign requests.`;
    if (strict) return { valid: false, reason, fatal: true };
    process.stderr.write(`[symfony-mcp][warn] ${reason}\n`);
    return { valid: true }; // non-strict: warn but allow
  }

  const { ts, nonce, sig } = sigPayload;

  // Timestamp validation
  const now = Date.now();
  const windowMs = getReplayWindowMs();
  const age = now - ts;

  if (age < 0 || age > windowMs) {
    return {
      valid: false,
      reason: `Signature timestamp is ${age < 0 ? 'in the future' : `too old (${Math.round(age / 1000)}s)`}. Replay window: ${windowMs / 1000}s.`,
      fatal: true,
    };
  }

  // Nonce replay check
  pruneNonces();
  const nonceKey = `${ts}:${nonce}`;
  if (usedNonces.has(nonceKey)) {
    return {
      valid: false,
      reason: 'Replay attack detected: nonce already used.',
      fatal: true,
    };
  }

  // Signature verification
  const canonical = canonicalize(ts, nonce, toolName, args);
  const expected = hmac(secret, canonical);

  // Constant-time comparison prevents timing attacks
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return {
      valid: false,
      reason: 'Invalid signature. Check that SYMFONY_MCP_SIGNING_SECRET matches the client configuration.',
      fatal: true,
    };
  }

  // Mark nonce as used
  usedNonces.set(nonceKey, now + windowMs);

  return { valid: true };
}

/**
 * Returns signing status information for diagnostics.
 */
export function getSigningStatus(): { enabled: boolean; strict: boolean; replayWindowMs: number } {
  return {
    enabled: getSecret() !== null,
    strict: isStrict(),
    replayWindowMs: getReplayWindowMs(),
  };
}

/** Clears the nonce cache (for testing). */
export function clearNonceCache(): void {
  usedNonces.clear();
}
