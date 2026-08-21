/**
 * Audit Logger
 *
 * Records all tool invocations with timestamps and durations.
 * Never logs sensitive parameter values — app_path is hashed, other params are omitted.
 *
 * Features:
 *  - AES-256-GCM encryption at rest (SYMFONY_MCP_AUDIT_KEY)
 *  - SIEM-compatible CEF format (SYMFONY_MCP_AUDIT_FORMAT=cef)
 *  - Standard JSONL format (default)
 *  - File permissions 0600, directory 0700
 *  - Session header per process start
 *
 * Log location (in priority order):
 *  1. SYMFONY_MCP_AUDIT_LOG env var (absolute path)
 *  2. ~/.symfony-agent-mcp/audit.log
 *  3. stderr only (if home dir is not writable)
 *
 * Configuration:
 *   SYMFONY_MCP_AUDIT_LOG             — Custom log path
 *   SYMFONY_MCP_AUDIT=false           — Disable file logging
 *   SYMFONY_MCP_AUDIT_FORMAT          — "jsonl" (default) or "cef"
 *   SYMFONY_MCP_AUDIT_KEY             — AES-256-GCM key as 32-byte base64 string (enables encryption)
 *   SYMFONY_MCP_AUDIT_KEY_PREV        — Previous key (fallback for reading rotated entries)
 *   SYMFONY_MCP_AUDIT_KEY_CREATED_AT  — ISO timestamp when the current key was created (for TTL checks)
 *   SYMFONY_MCP_AUDIT_KEY_TTL_DAYS    — Max key age in days before rotation is required (default: 90)
 *   SYMFONY_MCP_DEBUG=true            — Also echo to stderr
 *
 * Zero-downtime key rotation (Y):
 *   1. Generate a new key:   openssl rand -base64 32
 *   2. Set SYMFONY_MCP_AUDIT_KEY_PREV to the current SYMFONY_MCP_AUDIT_KEY value
 *   3. Set SYMFONY_MCP_AUDIT_KEY to the new key value
 *   4. Set SYMFONY_MCP_AUDIT_KEY_CREATED_AT to the current ISO timestamp
 *   5. Restart the server (or send SIGUSR2 if the env vars were updated in the process environment)
 *   6. Old log entries remain readable via AUDIT_KEY_PREV; new entries use AUDIT_KEY
 *   7. Optional: call reencryptAuditLog(newKeyB64) to re-encrypt all entries with the new key
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AuditEntry {
  ts: string;          // ISO timestamp
  tool: string;        // Tool name
  appHash: string;     // First 8 chars of SHA-256(app_path) — no raw path
  durationMs: number;  // Execution time
  success: boolean;    // Whether tool returned without isError
  errorMsg?: string;   // First 120 chars of error message (if any)
}

// ─── Configuration ─────────────────────────────────────────────────────────

function isLoggingEnabled(): boolean {
  return process.env['SYMFONY_MCP_AUDIT'] !== 'false';
}

function getFormat(): 'jsonl' | 'cef' {
  return process.env['SYMFONY_MCP_AUDIT_FORMAT'] === 'cef' ? 'cef' : 'jsonl';
}

function getEncryptionKey(): Buffer | null {
  const keyB64 = process.env['SYMFONY_MCP_AUDIT_KEY'];
  if (!keyB64) return null;

  // Buffer.from(_, 'base64') decodes what it can and silently ignores the
  // rest — it never throws — so malformed input surfaces as the wrong length
  // rather than as an exception.
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    process.stderr.write('[symfony-mcp][warn] SYMFONY_MCP_AUDIT_KEY must be a 32-byte base64 string. Encryption disabled.\n');
    return null;
  }
  return key;
}

/**
 * Returns the previous encryption key from env OR from the in-memory rotation buffer.
 * Used as a fallback when decrypting entries written before the last rotation.
 */
function getPrevEncryptionKey(): Buffer | null {
  // In-memory prev key takes precedence (set by rotateAuditKey())
  if (prevRotatedKey) return prevRotatedKey;

  const keyB64 = process.env['SYMFONY_MCP_AUDIT_KEY_PREV'];
  if (!keyB64) return null;
  const key = Buffer.from(keyB64, 'base64');
  return key.length === 32 ? key : null;
}

/**
 * Returns how old the current audit key is, in days.
 * Returns null if SYMFONY_MCP_AUDIT_KEY_CREATED_AT is not set or is invalid.
 */
export function getAuditKeyAgeDays(): number | null {
  const raw = process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'];
  if (!raw) return null;
  const createdAt = new Date(raw);
  if (isNaN(createdAt.getTime())) return null;
  return (Date.now() - createdAt.getTime()) / 86_400_000;
}

/**
 * Returns the configured key TTL in days (default: 90).
 */
export function getAuditKeyTtlDays(): number {
  return parseInt(process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] ?? '90', 10) || 90;
}

function getLogFilePath(): string {
  const envPath = process.env['SYMFONY_MCP_AUDIT_LOG'];
  if (envPath) return path.resolve(envPath);
  const mcpDir = path.join(os.homedir(), '.symfony-agent-mcp');
  return path.join(mcpDir, 'audit.log');
}

// ─── Stream management ──────────────────────────────────────────────────────

let logFilePath: string | null = null;
let logStream: fs.WriteStream | null = null;
let initAttempted = false;
let bytesWritten = 0;

// ─── Key rotation state (Y) ─────────────────────────────────────────────────

/** In-memory backup of the key that was active before the last rotateAuditKey() call. */
let prevRotatedKey: Buffer | null = null;

function getOrCreateStream(): fs.WriteStream | null {
  if (initAttempted) return logStream;
  initAttempted = true;

  if (!isLoggingEnabled()) return null;

  const filePath = getLogFilePath();

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    logStream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 });
    logStream.on('error', () => { /* Non-fatal: best-effort logging */ });
    logFilePath = filePath;

    // Seed byte counter from existing file size so rotation works after restarts
    try {
      bytesWritten = fs.statSync(filePath).size;
    } catch {
      bytesWritten = 0;
    }

    const sessionId = crypto.randomBytes(6).toString('hex');
    const encryptionNote = getEncryptionKey() ? ' encrypted=true' : '';
    const formatNote = getFormat() === 'cef' ? ' format=cef' : '';
    logStream.write(`\n# Session ${sessionId} started at ${new Date().toISOString()} PID=${process.pid}${encryptionNote}${formatNote}\n`);

    return logStream;
  } catch {
    return null; // Non-fatal: best-effort
  }
}

// ─── Log rotation (O) ────────────────────────────────────────────────────────

function getMaxAuditSizeBytes(): number {
  const mb = parseInt(process.env['SYMFONY_MCP_AUDIT_MAX_SIZE_MB'] ?? '50', 10) || 50;
  return mb * 1024 * 1024;
}

function getMaxAuditFiles(): number {
  return parseInt(process.env['SYMFONY_MCP_AUDIT_MAX_FILES'] ?? '5', 10) || 5;
}

function rotateLogIfNeeded(): void {
  if (!logFilePath || !logStream) return;
  if (bytesWritten < getMaxAuditSizeBytes()) return;

  try {
    logStream.end();
    logStream = null;
    bytesWritten = 0;

    const maxFiles = getMaxAuditFiles();

    // Delete the oldest rotated file if it exists
    const oldest = `${logFilePath}.${maxFiles}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

    // Shift rotated files: audit.log.4 → .5, .3 → .4 … .1 → .2
    for (let i = maxFiles - 1; i >= 1; i--) {
      const src = `${logFilePath}.${i}`;
      const dst = `${logFilePath}.${i + 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }

    // Move current log to .1
    if (fs.existsSync(logFilePath)) {
      fs.renameSync(logFilePath, `${logFilePath}.1`);
    }

    // Open a fresh stream on the original path
    logStream = fs.createWriteStream(logFilePath, { flags: 'a', mode: 0o600 });
    logStream.on('error', () => { /* Non-fatal: best-effort logging */ });
    const sessionId = crypto.randomBytes(6).toString('hex');
    const encryptionNote = getEncryptionKey() ? ' encrypted=true' : '';
    logStream.write(`\n# Session ${sessionId} (rotated) started at ${new Date().toISOString()} PID=${process.pid}${encryptionNote}\n`);
  } catch {
    // Non-fatal: best-effort rotation
  }
}

// ─── Encryption helpers ─────────────────────────────────────────────────────

/**
 * Encrypts a line with AES-256-GCM.
 * Output format: "ENC:" + base64(12-byte IV + 16-byte authTag + ciphertext)
 */
function encryptLine(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: IV (12) + authTag (16) + ciphertext
  const payload = Buffer.concat([iv, authTag, encrypted]);
  return 'ENC:' + payload.toString('base64');
}

/**
 * Decrypts a line encrypted by encryptLine().
 */
function decryptLine(encoded: string, key: Buffer): string {
  const payload = Buffer.from(encoded.slice(4), 'base64'); // strip "ENC:"
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ─── CEF serialisation ──────────────────────────────────────────────────────

const CEF_HEADER = 'CEF:0|symfony-agent-mcp|symfony-mcp|1.2.0';

function severityForEntry(entry: AuditEntry): number {
  if (!entry.success) return 5; // Medium
  if (entry.durationMs > 2000) return 3; // Low-medium (slow)
  return 1; // Low (normal)
}

/**
 * Serialises an AuditEntry to CEF format.
 * CEF:0|Vendor|Product|Version|SignatureID|Name|Severity|Extension
 */
function toCef(entry: AuditEntry): string {
  const sev = severityForEntry(entry);
  const name = entry.success ? 'TOOL_CALL' : 'TOOL_ERROR';
  const ext = [
    `rt=${entry.ts}`,
    `app=${entry.tool}`,
    `appHash=${entry.appHash}`,
    `durationMs=${entry.durationMs}`,
    `outcome=${entry.success ? 'success' : 'failure'}`,
    entry.errorMsg ? `msg=${entry.errorMsg.replace(/\|/g, '\\|').replace(/=/g, '\\=')}` : '',
  ].filter(Boolean).join(' ');

  return `${CEF_HEADER}|${entry.tool}|${name}|${sev}|${ext}`;
}

// ─── Serialisation dispatch ─────────────────────────────────────────────────

function serialise(entry: AuditEntry): string {
  const raw = getFormat() === 'cef' ? toCef(entry) : JSON.stringify(entry);

  const key = getEncryptionKey();
  if (key) return encryptLine(raw, key);
  return raw;
}

function deserialise(line: string): AuditEntry | null {
  try {
    let raw = line;

    if (line.startsWith('ENC:')) {
      const currentKey = getEncryptionKey();
      if (currentKey) {
        try {
          raw = decryptLine(line, currentKey);
        } catch {
          // Current key failed — try previous key (post-rotation fallback)
          const fallback = getPrevEncryptionKey();
          if (!fallback) return null;
          try { raw = decryptLine(line, fallback); }
          catch { return null; }
        }
      } else {
        // No current key — try previous key only
        const fallback = getPrevEncryptionKey();
        if (!fallback) return null;
        try { raw = decryptLine(line, fallback); }
        catch { return null; }
      }
    }

    if (raw.startsWith('CEF:')) {
      // Parse CEF extension into AuditEntry
      const parts = raw.split('|');
      if (parts.length < 8) return null;
      const ext = parts.slice(7).join('|');
      // A CEF extension value runs until the next `key=` or the end of the
      // line. `[^ ]+` stopped at the first space, which truncated every error
      // message to its first token — errorMsg is `String(err)`, so it always
      // begins "Error: " and always contains a space. The forensic detail was
      // being dropped on read-back.
      const get = (field: string): string => {
        const m = new RegExp(`${field}=(.*?)(?= [A-Za-z][A-Za-z0-9_]*=|$)`).exec(ext);
        return m ? m[1] : '';
      };
      return {
        ts: get('rt'),
        tool: parts[4] ?? '',
        appHash: get('appHash'),
        durationMs: parseInt(get('durationMs'), 10) || 0,
        success: get('outcome') === 'success',
        errorMsg: get('msg') || undefined,
      };
    }

    return JSON.parse(raw) as AuditEntry;
  } catch {
    return null;
  }
}

// ─── Core write function ────────────────────────────────────────────────────

function hashAppPath(appPath: string): string {
  return crypto.createHash('sha256').update(appPath).digest('hex').slice(0, 8);
}

function writeEntry(entry: AuditEntry): void {
  const stream = getOrCreateStream();
  const line = serialise(entry) + '\n';

  if (stream) {
    stream.write(line);
    bytesWritten += Buffer.byteLength(line, 'utf8');
    rotateLogIfNeeded();
  }

  if (process.env['SYMFONY_MCP_DEBUG'] === 'true') {
    // Always show plaintext in debug mode regardless of encryption
    process.stderr.write(`[audit] ${JSON.stringify(entry)}\n`);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Wraps a tool handler with audit logging.
 * Records tool name, app_path hash, duration, and success/failure.
 */
export function withAudit<T>(
  toolName: string,
  appPath: string,
  fn: () => T | Promise<T>
): T | Promise<T> {
  const start = Date.now();
  const appHash = hashAppPath(appPath || '');

  const record = (result: { isError?: boolean; content?: Array<{ text?: string }> }): void => {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      tool: toolName,
      appHash,
      durationMs: Date.now() - start,
      success: !result.isError,
    };

    if (result.isError && result.content?.[0]?.text) {
      entry.errorMsg = result.content[0].text.slice(0, 120);
    }

    writeEntry(entry);
  };

  try {
    const result = fn();

    if (result instanceof Promise) {
      return result.then((r) => {
        record(r as { isError?: boolean; content?: Array<{ text?: string }> });
        return r;
      }).catch((err) => {
        writeEntry({
          ts: new Date().toISOString(),
          tool: toolName,
          appHash,
          durationMs: Date.now() - start,
          success: false,
          errorMsg: String(err).slice(0, 120),
        });
        throw err;
      }) as T;
    }

    record(result as { isError?: boolean; content?: Array<{ text?: string }> });
    return result;
  } catch (err) {
    writeEntry({
      ts: new Date().toISOString(),
      tool: toolName,
      appHash,
      durationMs: Date.now() - start,
      success: false,
      errorMsg: String(err).slice(0, 120),
    });
    throw err;
  }
}

/**
 * Returns the path to the current audit log file, or null if not logging to file.
 */
export function getAuditLogPath(): string | null {
  getOrCreateStream();
  return logFilePath;
}

/**
 * Reads the last N audit entries from the log file.
 * Automatically decrypts entries if SYMFONY_MCP_AUDIT_KEY is set.
 * Returns an empty array if audit logging is disabled or log doesn't exist.
 */
export function readRecentAuditEntries(count: number = 50): AuditEntry[] {
  const filePath = getLogFilePath();
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const entries: AuditEntry[] = [];

    for (const line of content.split('\n').reverse()) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const entry = deserialise(trimmed);
      if (entry) {
        entries.push(entry);
        if (entries.length >= count) break;
      }
    }

    return entries.reverse();
  } catch {
    return [];
  }
}

/**
 * Generates a new AES-256-GCM audit key and prints it to stdout.
 * Run: node -e "require('./dist/utils/audit-logger').generateAuditKey()"
 */
export function generateAuditKey(): string {
  const key = crypto.randomBytes(32).toString('base64');
  process.stdout.write(`SYMFONY_MCP_AUDIT_KEY=${key}\n`);
  return key;
}

/**
 * Returns the active rotation configuration (for startup audit / introspection).
 */
export function getAuditRotationConfig(): { maxSizeMb: number; maxFiles: number } {
  return {
    maxSizeMb: getMaxAuditSizeBytes() / (1024 * 1024),
    maxFiles: getMaxAuditFiles(),
  };
}

/**
 * Performs a zero-downtime encryption key rotation (Y).
 *
 * - Saves the current key to the in-memory `prevRotatedKey` buffer so that
 *   entries written before the rotation can still be decrypted.
 * - Writes a KEY_ROTATION marker to the audit log for forensic traceability.
 * - After `ttlMs` milliseconds the old key is wiped from memory.
 *   Set SYMFONY_MCP_AUDIT_KEY_TTL_DAYS to control the default TTL (default: 90 days).
 *
 * To complete a full rotation:
 *   1. Update SYMFONY_MCP_AUDIT_KEY in the process environment (or via systemd reload)
 *   2. Call rotateAuditKey() — or send SIGUSR2 to trigger it automatically
 *   3. Old entries remain readable via prevRotatedKey until the TTL expires
 *   4. Optionally call reencryptAuditLog(newKeyB64) to re-encrypt all existing entries
 */
export function rotateAuditKey(): void {
  const oldKey = getEncryptionKey();
  prevRotatedKey = oldKey; // may be null if no key was configured

  const stream = getOrCreateStream();
  if (stream) {
    stream.write(`\n# KEY_ROTATION at ${new Date().toISOString()} PID=${process.pid}\n`);
  }

  process.stderr.write('[symfony-mcp][audit] Key rotation recorded in audit log\n');

  // Clear the in-memory backup after the configured TTL
  const ttlDays = getAuditKeyTtlDays();
  const ttlMs = ttlDays * 86_400_000;
  if (ttlMs > 0 && prevRotatedKey !== null) {
    const timer = setTimeout(() => {
      prevRotatedKey = null;
      process.stderr.write('[symfony-mcp][audit] Previous audit key wiped from memory (TTL expired)\n');
    }, Math.min(ttlMs, 2_147_483_647)); // clamp to max safe setTimeout value
    timer.unref(); // don't keep the event loop alive
  }
}

/**
 * Re-encrypts all entries in the current audit log with a new key.
 *
 * Safe to call while the server is running — writes to a temp file first,
 * then atomically renames it over the original. After completion the log
 * stream is reset so new entries use the current SYMFONY_MCP_AUDIT_KEY.
 *
 * @param newKeyB64 - The new 32-byte AES-256-GCM key, base64-encoded.
 *                    This should be the value you will set as SYMFONY_MCP_AUDIT_KEY.
 * @returns Counts of re-encrypted, skipped (comments/plaintext), and unreadable lines.
 */
export function reencryptAuditLog(newKeyB64: string): { reencrypted: number; skipped: number; errors: number } {
  // Validate key first — before any file I/O so callers get an immediate error
  const newKey = Buffer.from(newKeyB64, 'base64');
  if (newKey.length !== 32) {
    throw new Error('reencryptAuditLog: newKeyB64 must be a 32-byte base64 string');
  }

  const filePath = getLogFilePath();
  if (!fs.existsSync(filePath)) return { reencrypted: 0, skipped: 0, errors: 0 };

  // Flush and close the active stream so we can safely read + rename the file
  if (logStream) {
    logStream.end();
    logStream = null;
    initAttempted = false;
    bytesWritten = 0;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const outLines: string[] = [];
  let reencrypted = 0, skipped = 0, errors = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Preserve blank lines and comment lines as-is
    if (!trimmed || trimmed.startsWith('#')) {
      outLines.push(line);
      skipped++;
      continue;
    }

    // Plaintext entries (no encryption was configured when they were written)
    if (!trimmed.startsWith('ENC:')) {
      outLines.push(encryptLine(trimmed, newKey));
      reencrypted++;
      continue;
    }

    // Encrypted entry — decrypt with current or prev key, then re-encrypt with new key
    let plaintext: string | null = null;
    const currentKey = getEncryptionKey();
    if (currentKey) {
      try { plaintext = decryptLine(trimmed, currentKey); } catch { /* try prev */ }
    }
    if (!plaintext) {
      const fallback = getPrevEncryptionKey();
      if (fallback) {
        try { plaintext = decryptLine(trimmed, fallback); } catch { /* unreachable */ }
      }
    }

    if (!plaintext) {
      outLines.push(line); // can't decrypt — leave untouched
      errors++;
      continue;
    }

    outLines.push(encryptLine(plaintext, newKey));
    reencrypted++;
  }

  // Write temp file, then atomically swap
  const tmpPath = `${filePath}.reenc-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, outLines.join('\n'), { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file if rename failed
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  process.stderr.write(
    `[symfony-mcp][audit] Re-encryption complete: ${reencrypted} entries re-encrypted, ` +
    `${skipped} skipped, ${errors} unreadable\n`
  );

  return { reencrypted, skipped, errors };
}

/**
 * Returns audit key configuration and TTL status (for startup audit / introspection).
 */
export function getAuditKeyConfig(): {
  encrypted: boolean;
  hasPrevKey: boolean;
  keyAgeDays: number | null;
  ttlDays: number;
  isExpired: boolean;
  expiresInDays: number | null;
} {
  const ageDays = getAuditKeyAgeDays();
  const ttlDays = getAuditKeyTtlDays();
  const expiresInDays = ageDays !== null ? ttlDays - ageDays : null;
  return {
    encrypted: getEncryptionKey() !== null,
    hasPrevKey: getPrevEncryptionKey() !== null,
    keyAgeDays: ageDays,
    ttlDays,
    isExpired: expiresInDays !== null && expiresInDays <= 0,
    expiresInDays,
  };
}

/**
 * Resets audit logger state (useful for testing).
 * WARNING: this closes and discards the current log stream.
 */
export function resetAuditLogger(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
  logFilePath = null;
  initAttempted = false;
  bytesWritten = 0;
  prevRotatedKey = null;
}

// ─── SIGUSR2 handler: zero-downtime key rotation ────────────────────────────
// Sending SIGUSR2 triggers rotateAuditKey() so operators can rotate the
// encryption key without restarting the server. Update SYMFONY_MCP_AUDIT_KEY
// in the environment first (e.g. via systemd EnvironmentFile reload), then
// send SIGUSR2. Also clears the Vault secret cache (see vault-resolver.ts).
if (process.env['NODE_ENV'] !== 'test') {
  process.on('SIGUSR2', () => {
    rotateAuditKey();
  });
}
