/**
 * Tests for audit log encryption key rotation (Y).
 *
 * Covers:
 *  - Previous-key fallback decryption (SYMFONY_MCP_AUDIT_KEY_PREV)
 *  - rotateAuditKey() writes a rotation marker
 *  - reencryptAuditLog() re-encrypts all entries with a new key
 *  - getAuditKeyConfig() reflects correct TTL / expiry status
 *  - Startup audit warns on expired / near-expiry keys
 *  - Startup audit warns when AUDIT_KEY_CREATED_AT is missing
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  withAudit,
  resetAuditLogger,
  readRecentAuditEntries,
  rotateAuditKey,
  reencryptAuditLog,
  getAuditKeyConfig,
  getAuditKeyAgeDays,
  getAuditKeyTtlDays,
} from '../utils/audit-logger';
import { runStartupAudit } from '../utils/startup-audit';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function genKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

function makeLogDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-key-test-'));
}

async function settle(ms = 40): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function mockToolCall(toolName = 'test_tool', appPath = '/app'): void {
  withAudit(toolName, appPath, () => ({
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  }));
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = makeLogDir();
  logPath = path.join(tmpDir, 'audit.log');

  delete process.env['SYMFONY_MCP_AUDIT_KEY'];
  delete process.env['SYMFONY_MCP_AUDIT_KEY_PREV'];
  delete process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'];
  delete process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'];
  process.env['SYMFONY_MCP_AUDIT_LOG'] = logPath;
  process.env['SYMFONY_MCP_AUDIT'] = 'true';

  resetAuditLogger();
});

afterEach(() => {
  resetAuditLogger();
  delete process.env['SYMFONY_MCP_AUDIT_LOG'];
  delete process.env['SYMFONY_MCP_AUDIT'];
  delete process.env['SYMFONY_MCP_AUDIT_KEY'];
  delete process.env['SYMFONY_MCP_AUDIT_KEY_PREV'];
  delete process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'];
  delete process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'];

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Previous-key fallback decryption ─────────────────────────────────────────

describe('prev-key fallback decryption', () => {
  test('entries written with old key are readable after env rotation', async () => {
    const keyA = genKey();
    const keyB = genKey();

    // Write with key A
    process.env['SYMFONY_MCP_AUDIT_KEY'] = keyA;
    mockToolCall('route_list', '/app');
    await settle();

    // Simulate key rotation: keyB becomes current, keyA becomes prev
    resetAuditLogger();
    process.env['SYMFONY_MCP_AUDIT_KEY'] = keyB;
    process.env['SYMFONY_MCP_AUDIT_KEY_PREV'] = keyA;

    // Entries written with keyA must still be readable
    const entries = readRecentAuditEntries(10);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some(e => e.tool === 'route_list')).toBe(true);
  });

  test('entries written with current key are readable without prev key', async () => {
    const key = genKey();
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key;

    mockToolCall('health_check', '/app');
    await settle();

    const entries = readRecentAuditEntries(10);
    expect(entries.some(e => e.tool === 'health_check')).toBe(true);
  });

  test('entries are unreadable when neither current nor prev key matches', async () => {
    const keyA = genKey();
    process.env['SYMFONY_MCP_AUDIT_KEY'] = keyA;

    mockToolCall('secret_tool', '/app');
    await settle();

    // Reset with a completely different key and no prev
    resetAuditLogger();
    process.env['SYMFONY_MCP_AUDIT_KEY'] = genKey();
    delete process.env['SYMFONY_MCP_AUDIT_KEY_PREV'];

    const entries = readRecentAuditEntries(10);
    // The entry written with keyA cannot be decrypted with the new random key
    expect(entries.every(e => e.tool !== 'secret_tool')).toBe(true);
  });
});

// ─── rotateAuditKey() ─────────────────────────────────────────────────────────

describe('rotateAuditKey()', () => {
  test('writes a KEY_ROTATION marker to the log', async () => {
    const key = genKey();
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key;

    mockToolCall('before_rotation', '/app');
    rotateAuditKey();
    await settle();

    const raw = fs.readFileSync(logPath, 'utf-8');
    expect(raw).toContain('KEY_ROTATION');
  });

  test('new entries after rotation use the updated env key', async () => {
    const keyA = genKey();
    const keyB = genKey();

    process.env['SYMFONY_MCP_AUDIT_KEY'] = keyA;
    mockToolCall('pre_rotation', '/app');

    // Correct SIGUSR2 flow: save old key FIRST, then update env to keyB.
    // rotateAuditKey() reads the current env key (keyA) and stores it as prevRotatedKey.
    rotateAuditKey();  // saves keyA → prevRotatedKey
    process.env['SYMFONY_MCP_AUDIT_KEY'] = keyB;  // switch env to new key

    mockToolCall('post_rotation', '/app');
    await settle();

    // With keyB as current and keyA in prevRotatedKey, both entries are readable
    const entries = readRecentAuditEntries(20);
    expect(entries.some(e => e.tool === 'pre_rotation')).toBe(true);
    expect(entries.some(e => e.tool === 'post_rotation')).toBe(true);
  });
});

// ─── reencryptAuditLog() ─────────────────────────────────────────────────────

describe('reencryptAuditLog()', () => {
  test('re-encrypts entries and makes them readable with new key', async () => {
    const keyA = genKey();
    const keyB = genKey();

    process.env['SYMFONY_MCP_AUDIT_KEY'] = keyA;
    mockToolCall('to_reencrypt', '/app');
    await settle();

    // Re-encrypt with keyB
    const result = reencryptAuditLog(keyB);
    expect(result.reencrypted).toBeGreaterThan(0);
    expect(result.errors).toBe(0);

    // Now read with keyB
    resetAuditLogger();
    process.env['SYMFONY_MCP_AUDIT_KEY'] = keyB;
    delete process.env['SYMFONY_MCP_AUDIT_KEY_PREV'];

    const entries = readRecentAuditEntries(10);
    expect(entries.some(e => e.tool === 'to_reencrypt')).toBe(true);
  });

  test('skips comment lines and preserves them', async () => {
    const key = genKey();
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key;

    mockToolCall('sample', '/app');
    await settle();

    const newKey = genKey();
    const result = reencryptAuditLog(newKey);
    // Comment/blank lines are skipped, not re-encrypted
    expect(result.skipped).toBeGreaterThan(0);
  });

  test('rejects invalid key length', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = genKey();
    expect(() => reencryptAuditLog('tooshort')).toThrow();
  });

  test('re-encrypts plaintext entries written without a key', async () => {
    // Write without encryption
    delete process.env['SYMFONY_MCP_AUDIT_KEY'];
    mockToolCall('plaintext_tool', '/app');
    await settle();

    const newKey = genKey();
    const result = reencryptAuditLog(newKey);
    // Plaintext lines are counted as re-encrypted (they get wrapped with the new key)
    expect(result.reencrypted).toBeGreaterThan(0);
  });
});

// ─── getAuditKeyConfig() ─────────────────────────────────────────────────────

describe('getAuditKeyConfig()', () => {
  test('encrypted=false when no key is set', () => {
    delete process.env['SYMFONY_MCP_AUDIT_KEY'];
    const cfg = getAuditKeyConfig();
    expect(cfg.encrypted).toBe(false);
  });

  test('encrypted=true when key is set', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = genKey();
    const cfg = getAuditKeyConfig();
    expect(cfg.encrypted).toBe(true);
  });

  test('hasPrevKey=true when AUDIT_KEY_PREV is set', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = genKey();
    process.env['SYMFONY_MCP_AUDIT_KEY_PREV'] = genKey();
    const cfg = getAuditKeyConfig();
    expect(cfg.hasPrevKey).toBe(true);
  });

  test('keyAgeDays reflects AUDIT_KEY_CREATED_AT', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = genKey();
    // Set created_at to exactly 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = tenDaysAgo;

    const cfg = getAuditKeyConfig();
    expect(cfg.keyAgeDays).not.toBeNull();
    expect(cfg.keyAgeDays!).toBeGreaterThanOrEqual(9.9);
    expect(cfg.keyAgeDays!).toBeLessThanOrEqual(10.1);
  });

  test('isExpired=true when key age exceeds TTL', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = genKey();
    process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = '30';
    // 31 days ago
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = old;

    const cfg = getAuditKeyConfig();
    expect(cfg.isExpired).toBe(true);
  });

  test('isExpired=false when key is within TTL', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = genKey();
    process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = '90';
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = new Date().toISOString();

    const cfg = getAuditKeyConfig();
    expect(cfg.isExpired).toBe(false);
    expect(cfg.expiresInDays!).toBeGreaterThan(88);
  });
});

// ─── getAuditKeyAgeDays / getAuditKeyTtlDays helpers ─────────────────────────

describe('key age and TTL helpers', () => {
  test('getAuditKeyAgeDays returns null when CREATED_AT not set', () => {
    expect(getAuditKeyAgeDays()).toBeNull();
  });

  test('getAuditKeyAgeDays returns null for invalid date', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = 'not-a-date';
    expect(getAuditKeyAgeDays()).toBeNull();
  });

  test('getAuditKeyTtlDays returns 90 by default', () => {
    expect(getAuditKeyTtlDays()).toBe(90);
  });

  test('getAuditKeyTtlDays reads custom value from env', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = '180';
    expect(getAuditKeyTtlDays()).toBe(180);
  });
});

// ─── Startup audit key TTL warnings ──────────────────────────────────────────

describe('startup audit: key TTL warnings', () => {
  test('warns INFO when AUDIT_KEY_CREATED_AT is not set', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = genKey();
    delete process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'];

    const findings = runStartupAudit(false);
    const f = findings.find(x => x.code === 'AUDIT_KEY_AGE_UNKNOWN');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('INFO');
  });

  test('warns HIGH when key is expired', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = genKey();
    process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = '30';
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = new Date(Date.now() - 40 * 86_400_000).toISOString();

    const findings = runStartupAudit(false);
    const f = findings.find(x => x.code === 'AUDIT_KEY_EXPIRED');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('HIGH');
  });

  test('warns MEDIUM when key is expiring within 7 days', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = genKey();
    process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = '30';
    // 25 days old → 5 days left
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = new Date(Date.now() - 25 * 86_400_000).toISOString();

    const findings = runStartupAudit(false);
    const f = findings.find(x => x.code === 'AUDIT_KEY_EXPIRING_SOON');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('MEDIUM');
  });

  test('no TTL warning when key is well within TTL', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = genKey();
    process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = '90';
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = new Date().toISOString();

    const findings = runStartupAudit(false);
    const ttlFindings = findings.filter(x =>
      x.code === 'AUDIT_KEY_EXPIRED' ||
      x.code === 'AUDIT_KEY_EXPIRING_SOON'
    );
    expect(ttlFindings).toHaveLength(0);
  });
});
