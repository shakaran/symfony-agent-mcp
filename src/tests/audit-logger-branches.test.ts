// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The audit logger's other halves.
 *
 * A previous key of the wrong length, rotation settings that are not numbers,
 * a rotation with no log file to move, a CEF line shorter than the format
 * promises, an audited call with no application path: each is a condition the
 * ordinary run never meets.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  withAudit, getAuditRotationConfig, rotateAuditKey, reencryptAuditLog,
  readRecentAuditEntries, resetAuditLogger,
} from '../utils/audit-logger';

const ENV_KEYS = [
  'SYMFONY_MCP_AUDIT', 'SYMFONY_MCP_AUDIT_LOG', 'SYMFONY_MCP_AUDIT_FORMAT',
  'SYMFONY_MCP_AUDIT_KEY', 'SYMFONY_MCP_AUDIT_KEY_PREV',
  'SYMFONY_MCP_AUDIT_MAX_SIZE_MB', 'SYMFONY_MCP_AUDIT_MAX_FILES',
];

let saved: Record<string, string | undefined>;
let dir: string;
let logPath: string;
let stderrSpy: jest.SpyInstance;

const key = (): string => crypto.randomBytes(32).toString('base64');

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-branches-'));
  logPath = path.join(dir, 'audit.log');
  process.env['SYMFONY_MCP_AUDIT_LOG'] = logPath;
  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  resetAuditLogger();
});

afterEach(() => {
  resetAuditLogger();
  stderrSpy.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

async function call(appPath = '/var/www/app'): Promise<void> {
  await withAudit('list_routes', appPath, async () => ({ content: [{ type: 'text', text: 'x' }] }));
  await new Promise((r) => setTimeout(r, 20));
}

test('rotation settings that are not numbers fall back', () => {
  process.env['SYMFONY_MCP_AUDIT_MAX_SIZE_MB'] = 'big';
  process.env['SYMFONY_MCP_AUDIT_MAX_FILES'] = 'several';

  expect(getAuditRotationConfig()).toEqual({ maxSizeMb: 50, maxFiles: 5 });
});

test('a previous key that is not thirty-two bytes is refused', () => {
  process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
  process.env['SYMFONY_MCP_AUDIT_KEY_PREV'] = Buffer.alloc(16, 3).toString('base64');
  fs.writeFileSync(logPath, 'ENC:not-decryptable\n');

  const result = reencryptAuditLog(key());

  expect(result.reencrypted).toBe(0);
});

test('an audited call with no application path', async () => {
  await call('');

  const entries = readRecentAuditEntries(5);

  expect(entries.length).toBeGreaterThan(0);
});

test('a key rotation with encryption configured writes the marker', async () => {
  process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
  await call();

  rotateAuditKey();

  // The marker goes through the same stream as everything else, so wait for
  // it to land rather than assuming it already has.
  for (let i = 0; i < 200 && !fs.readFileSync(logPath, 'utf-8').includes('KEY_ROTATION'); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  expect(fs.readFileSync(logPath, 'utf-8')).toContain('KEY_ROTATION');
});

test('a cef line with fewer fields than the format promises', () => {
  process.env['SYMFONY_MCP_AUDIT_FORMAT'] = 'cef';
  fs.writeFileSync(logPath, 'CEF:0|symfony-agent-mcp|symfony-mcp\n');

  expect(readRecentAuditEntries(5)).toEqual([]);
});

test('a key rotation while the log is disabled writes nothing', () => {
  process.env['SYMFONY_MCP_AUDIT'] = 'false';
  resetAuditLogger();

  rotateAuditKey();

  expect(fs.existsSync(logPath)).toBe(false);
});

test('re-encrypting a log when no key is configured at all', () => {
  fs.writeFileSync(logPath, 'ENC:v1:nothing-decryptable\n');

  const result = reencryptAuditLog(key());

  expect(result.errors + result.skipped).toBeGreaterThan(0);
});

test('a rotation with a key configured, and one with the log already gone', async () => {
  process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
  process.env['SYMFONY_MCP_AUDIT_MAX_SIZE_MB'] = '1';
  await call();

  resetAuditLogger();
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(logPath, 'X'.repeat(1024 * 1024 + 16), { mode: 0o600 });

  await call();
  await new Promise((r) => setTimeout(r, 30));

  expect(fs.existsSync(`${logPath}.1`)).toBe(true);
  expect(fs.readFileSync(logPath, 'utf-8')).toContain('encrypted=true');

  // Now the same again, with the log file removed between the size check and
  // the rename: the rotation has nothing to move.
  resetAuditLogger();
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(logPath, 'X'.repeat(1024 * 1024 + 16), { mode: 0o600 });
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  stream.close();
  fs.rmSync(logPath);

  await call();
  await new Promise((r) => setTimeout(r, 30));

  expect(fs.existsSync(logPath)).toBe(true);
});
