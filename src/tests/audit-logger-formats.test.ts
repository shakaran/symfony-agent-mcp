// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Audit logger — the SIEM-facing CEF format.
 *
 * audit-logger.test.ts covers JSONL writing, audit-rotation.test.ts covers
 * size-based file rotation, and audit-key-rotation.test.ts covers the
 * previous-key fallback. What none of them touch is
 * SYMFONY_MCP_AUDIT_FORMAT=cef: the header, severity mapping, extension
 * escaping and the parser that reads it back — plus the two branches that
 * reject a malformed encryption key.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  withAudit,
  readRecentAuditEntries,
  resetAuditLogger,
} from '../utils/audit-logger';

const ENV_KEYS = [
  'SYMFONY_MCP_AUDIT', 'SYMFONY_MCP_AUDIT_LOG', 'SYMFONY_MCP_AUDIT_FORMAT',
  'SYMFONY_MCP_AUDIT_KEY', 'SYMFONY_MCP_AUDIT_KEY_PREV',
  'SYMFONY_MCP_AUDIT_MAX_SIZE_MB', 'SYMFONY_MCP_AUDIT_MAX_FILES',
];

let saved: Record<string, string | undefined>;
let tmpDir: string;
let logPath: string;
let stderrSpy: jest.SpyInstance;

const key = (): string => crypto.randomBytes(32).toString('base64');

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fmt-'));
  logPath = path.join(tmpDir, 'audit.log');
  process.env['SYMFONY_MCP_AUDIT_LOG'] = logPath;

  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  resetAuditLogger();
});

afterEach(() => {
  resetAuditLogger();
  stderrSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Runs one successful tool call through the audit pipeline. */
async function ok(tool = 'list_routes'): Promise<void> {
  await withAudit(tool, '/var/www/app', async () => ({ content: [{ type: 'text', text: 'x' }] }));
  await new Promise((r) => setTimeout(r, 30));
}

/** Runs one failing tool call. */
async function fail(tool = 'list_routes', msg = 'boom'): Promise<void> {
  await expect(
    withAudit(tool, '/var/www/app', async () => { throw new Error(msg); })
  ).rejects.toThrow(msg);
  await new Promise((r) => setTimeout(r, 30));
}

/** Runs a call that takes longer than the CEF "slow" threshold. */
async function slow(tool = 'slow_tool'): Promise<void> {
  await withAudit(tool, '/var/www/app', async () => {
    await new Promise((r) => setTimeout(r, 2100));
    return { content: [{ type: 'text', text: 'x' }] };
  });
  await new Promise((r) => setTimeout(r, 30));
}

describe('CEF output', () => {
  beforeEach(() => {
    process.env['SYMFONY_MCP_AUDIT_FORMAT'] = 'cef';
    resetAuditLogger();
  });

  test('writes a CEF header line rather than JSON', async () => {
    await ok();
    const content = fs.readFileSync(logPath, 'utf-8');

    expect(content).toContain('CEF:0|symfony-agent-mcp|symfony-mcp|');
    expect(content).toContain('TOOL_CALL');
  });

  test('notes the format in the session banner', async () => {
    await ok();
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('format=cef');
  });

  test('carries the tool, timestamp and duration as CEF extensions', async () => {
    await ok('list_entities');
    const content = fs.readFileSync(logPath, 'utf-8');

    expect(content).toContain('app=list_entities');
    expect(content).toContain('rt=');
    expect(content).toContain('durationMs=');
    expect(content).toContain('outcome=success');
  });

  test('marks a failed call as TOOL_ERROR with the failure outcome', async () => {
    await fail('list_routes', 'db unreachable');
    const content = fs.readFileSync(logPath, 'utf-8');

    expect(content).toContain('TOOL_ERROR');
    expect(content).toContain('outcome=failure');
  });

  test('escapes pipes and equals signs in the error message', async () => {
    await fail('list_routes', 'a|b=c');
    const content = fs.readFileSync(logPath, 'utf-8');

    expect(content).toContain('a\\|b\\=c');
  });

  test('escapes the backslash before the characters it introduces', async () => {
    // A message that already contains \| must not become indistinguishable
    // from one where the escaping produced it.
    await fail('list_routes', 'path a\\|b');
    const line = fs.readFileSync(logPath, 'utf-8')
      .split('\n').find((l) => l.startsWith('CEF:'))!;

    expect(line).toContain('a\\\\\\|b');
  });

  test('raises the severity for a failure', async () => {
    await fail();
    // CEF severity is the 7th pipe-delimited field.
    const line = fs.readFileSync(logPath, 'utf-8')
      .split('\n').find((l) => l.startsWith('CEF:'))!;
    expect(line.split('|')[6]).toBe('5');
  });

  test('uses the low severity for a normal call', async () => {
    await ok();
    const line = fs.readFileSync(logPath, 'utf-8')
      .split('\n').find((l) => l.startsWith('CEF:'))!;
    expect(line.split('|')[6]).toBe('1');
  });

  test('flags a slow call with the intermediate severity', async () => {
    await slow();
    const line = fs.readFileSync(logPath, 'utf-8')
      .split('\n').find((l) => l.startsWith('CEF:'))!;
    expect(line.split('|')[6]).toBe('3');
  }, 15000);

  test('reads its own CEF entries back', async () => {
    await ok('list_routes');
    const entries = readRecentAuditEntries(10);

    expect(entries.length).toBeGreaterThan(0);
    const e = entries[entries.length - 1];
    expect(e.tool).toBe('list_routes');
    expect(e.success).toBe(true);
    expect(typeof e.durationMs).toBe('number');
  });

  test('reads back a failed CEF entry with its message', async () => {
    await fail('list_routes', 'nope');
    const e = readRecentAuditEntries(10).pop()!;

    expect(e.success).toBe(false);
    expect(e.errorMsg).toContain('nope');
  });

  test('ignores a truncated CEF line', () => {
    fs.writeFileSync(logPath, 'CEF:0|too|few|fields\n');
    expect(readRecentAuditEntries(10)).toEqual([]);
  });

  test('round-trips CEF through encryption', async () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
    resetAuditLogger();

    await ok('list_tables');

    expect(fs.readFileSync(logPath, 'utf-8')).not.toContain('list_tables');
    expect(readRecentAuditEntries(10).map((e) => e.tool)).toContain('list_tables');
  });
});

describe('encryption key validation', () => {
  test('refuses a key that is not 32 bytes and says so', async () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = Buffer.from('too-short').toString('base64');
    resetAuditLogger();

    await ok('list_routes');

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('must be a 32-byte base64'));
    // Falls back to plaintext rather than dropping the record.
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('list_routes');
  });

  test('a rejected key leaves the log unencrypted', async () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = 'x';
    resetAuditLogger();
    await ok();

    expect(fs.readFileSync(logPath, 'utf-8')).not.toContain('encrypted=true');
  });
});

