// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Audit logger — key management, rotation and log reading.
 *
 * The existing audit-logger suite covers writing entries through withAudit.
 * This one takes the key lifecycle around it: age and TTL reporting, the
 * zero-downtime rotation that keeps the previous key readable, re-encrypting
 * an existing log under a new key, and reading entries back. A mistake here
 * either loses the forensic record or leaves it readable with a key that was
 * supposed to be retired.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  getAuditKeyAgeDays,
  getAuditKeyTtlDays,
  getAuditKeyConfig,
  getAuditRotationConfig,
  getAuditLogPath,
  readRecentAuditEntries,
  generateAuditKey,
  rotateAuditKey,
  reencryptAuditLog,
  resetAuditLogger,
  withAudit,
} from '../utils/audit-logger';

const ENV_KEYS = [
  'SYMFONY_MCP_AUDIT',
  'SYMFONY_MCP_AUDIT_LOG',
  'SYMFONY_MCP_AUDIT_KEY',
  'SYMFONY_MCP_AUDIT_KEY_CREATED_AT',
  'SYMFONY_MCP_AUDIT_KEY_TTL_DAYS',
  'SYMFONY_MCP_AUDIT_MAX_SIZE_MB',
  'SYMFONY_MCP_AUDIT_MAX_FILES',
];

let saved: Record<string, string | undefined>;
let tmpDir: string;
let logPath: string;
let stderrSpy: jest.SpyInstance;
let stdoutSpy: jest.SpyInstance;

const key = (): string => crypto.randomBytes(32).toString('base64');

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-keys-'));
  logPath = path.join(tmpDir, 'audit.log');
  process.env['SYMFONY_MCP_AUDIT_LOG'] = logPath;

  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  resetAuditLogger();
});

afterEach(() => {
  resetAuditLogger();
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Writes one audit entry and waits for the stream to flush it. */
async function writeEntry(tool = 'list_routes'): Promise<void> {
  await withAudit(tool, '/var/www/app', async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  await new Promise((r) => setTimeout(r, 30));
}

describe('key age and TTL', () => {
  test('age is unknown when no creation timestamp is set', () => {
    expect(getAuditKeyAgeDays()).toBeNull();
  });

  test('age is unknown when the timestamp does not parse', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = 'yesterday-ish';
    expect(getAuditKeyAgeDays()).toBeNull();
  });

  test('age is measured in days from the timestamp', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] =
      new Date(Date.now() - 10 * 86_400_000).toISOString();

    expect(getAuditKeyAgeDays()).toBeCloseTo(10, 1);
  });

  test('TTL defaults to 90 days', () => {
    expect(getAuditKeyTtlDays()).toBe(90);
  });

  test('TTL is configurable, and a junk value falls back to the default', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = '30';
    expect(getAuditKeyTtlDays()).toBe(30);

    process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = 'soon';
    expect(getAuditKeyTtlDays()).toBe(90);
  });
});

describe('getAuditKeyConfig', () => {
  test('reports an unencrypted log with no key', () => {
    const cfg = getAuditKeyConfig();

    expect(cfg.encrypted).toBe(false);
    expect(cfg.hasPrevKey).toBe(false);
    expect(cfg.keyAgeDays).toBeNull();
    expect(cfg.expiresInDays).toBeNull();
    expect(cfg.isExpired).toBe(false);
  });

  test('reports encryption once a key is configured', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
    expect(getAuditKeyConfig().encrypted).toBe(true);
  });

  test('computes remaining days from age and TTL', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
    process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = '90';
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] =
      new Date(Date.now() - 30 * 86_400_000).toISOString();

    const cfg = getAuditKeyConfig();
    expect(cfg.expiresInDays).toBeCloseTo(60, 0);
    expect(cfg.isExpired).toBe(false);
  });

  test('marks a key past its TTL as expired', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
    process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = '10';
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] =
      new Date(Date.now() - 40 * 86_400_000).toISOString();

    expect(getAuditKeyConfig().isExpired).toBe(true);
  });
});

describe('rotation configuration', () => {
  test('reports the defaults', () => {
    const cfg = getAuditRotationConfig();
    expect(cfg.maxSizeMb).toBeGreaterThan(0);
    expect(cfg.maxFiles).toBeGreaterThan(0);
  });

  test('reflects configured overrides', () => {
    process.env['SYMFONY_MCP_AUDIT_MAX_SIZE_MB'] = '7';
    process.env['SYMFONY_MCP_AUDIT_MAX_FILES'] = '3';

    expect(getAuditRotationConfig()).toEqual({ maxSizeMb: 7, maxFiles: 3 });
  });
});

describe('generateAuditKey', () => {
  test('produces a 32-byte base64 key', () => {
    const k = generateAuditKey();
    expect(Buffer.from(k, 'base64')).toHaveLength(32);
  });

  test('produces a different key each time', () => {
    expect(generateAuditKey()).not.toBe(generateAuditKey());
  });

  test('prints the key in env-var form for the operator', () => {
    generateAuditKey();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('SYMFONY_MCP_AUDIT_KEY='));
  });
});

describe('reading entries back', () => {
  test('returns nothing when the log does not exist yet', () => {
    expect(readRecentAuditEntries()).toEqual([]);
  });

  test('reads back a plaintext entry', async () => {
    await writeEntry('list_routes');
    const entries = readRecentAuditEntries(10);

    expect(entries.length).toBeGreaterThan(0);
    expect(entries[entries.length - 1].tool).toBe('list_routes');
  });

  test('reads back an encrypted entry', async () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
    resetAuditLogger();

    await writeEntry('list_entities');

    // The bytes on disk must not be readable without the key.
    expect(fs.readFileSync(logPath, 'utf-8')).not.toContain('list_entities');
    expect(readRecentAuditEntries(10).map((e) => e.tool)).toContain('list_entities');
  });

  test('honours the requested count', async () => {
    for (const t of ['a_tool', 'b_tool', 'c_tool']) await writeEntry(t);
    expect(readRecentAuditEntries(2)).toHaveLength(2);
  });

  test('skips comment lines', async () => {
    await writeEntry();
    fs.appendFileSync(logPath, '# a marker comment\n');

    expect(readRecentAuditEntries(10).every((e) => Boolean(e.tool))).toBe(true);
  });

  test('ignores unreadable lines rather than throwing', async () => {
    await writeEntry();
    fs.appendFileSync(logPath, 'this is not a valid entry\n');

    expect(() => readRecentAuditEntries(10)).not.toThrow();
  });

  test('getAuditLogPath points at the configured file', () => {
    expect(getAuditLogPath()).toBe(path.resolve(logPath));
  });
});

describe('rotateAuditKey', () => {
  test('records a rotation marker in the log', async () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
    resetAuditLogger();
    await writeEntry();

    rotateAuditKey();
    await new Promise((r) => setTimeout(r, 30));

    expect(fs.readFileSync(logPath, 'utf-8')).toContain('# KEY_ROTATION at');
  });

  test('keeps the previous key available for reading old entries', async () => {
    const oldKey = key();
    process.env['SYMFONY_MCP_AUDIT_KEY'] = oldKey;
    resetAuditLogger();
    await writeEntry('written_under_old_key');

    rotateAuditKey();
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key();

    expect(getAuditKeyConfig().hasPrevKey).toBe(true);
    expect(readRecentAuditEntries(20).map((e) => e.tool)).toContain('written_under_old_key');
  });

  test('tells the operator on stderr', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
    resetAuditLogger();
    rotateAuditKey();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Key rotation recorded'));
  });

  test('does not throw when no key was configured', () => {
    expect(() => rotateAuditKey()).not.toThrow();
  });
});

describe('reencryptAuditLog', () => {
  test('rejects a key that is not 32 bytes', () => {
    expect(() => reencryptAuditLog('dG9vLXNob3J0')).toThrow(/32-byte base64/);
  });

  test('rejects a malformed base64 key', () => {
    expect(() => reencryptAuditLog('!!! not base64 !!!')).toThrow(/32-byte base64/);
  });

  test('re-encrypts existing entries so the new key reads them', async () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
    resetAuditLogger();
    await writeEntry('rotate_me');

    const newKey = key();
    const result = reencryptAuditLog(newKey);
    expect(result.reencrypted).toBeGreaterThan(0);

    // Only the new key must work from here on.
    process.env['SYMFONY_MCP_AUDIT_KEY'] = newKey;
    resetAuditLogger();
    expect(readRecentAuditEntries(20).map((e) => e.tool)).toContain('rotate_me');
  });

  test('counts comment lines as skipped, not as errors', async () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
    resetAuditLogger();
    await writeEntry();
    fs.appendFileSync(logPath, '# a comment\n');

    expect(reencryptAuditLog(key()).skipped).toBeGreaterThan(0);
  });

  test('reports zero counts when there is no log to convert', () => {
    expect(reencryptAuditLog(key())).toEqual({ reencrypted: 0, skipped: 0, errors: 0 });
  });
});

describe('resetAuditLogger', () => {
  test('clears the remembered path and previous key', async () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
    resetAuditLogger();
    await writeEntry();
    rotateAuditKey();
    expect(getAuditKeyConfig().hasPrevKey).toBe(true);

    resetAuditLogger();
    expect(getAuditKeyConfig().hasPrevKey).toBe(false);
  });

  test('is safe to call twice', () => {
    expect(() => { resetAuditLogger(); resetAuditLogger(); }).not.toThrow();
  });
});
