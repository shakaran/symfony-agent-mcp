// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Coverage for the remaining branches of security.ts.
 *
 * sanitizeConfig walks arbitrary parsed YAML/JSON before it leaves the server,
 * and isPathSafe is the symlink-aware containment check. Both have fallback
 * branches — recursion depth, non-existent paths, unresolvable parents — that
 * only fire on inputs the happy-path tests never produce.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  sanitizeConfig,
  sanitizeEnvironment,
  isPathSafe,
  sanitizeDatabaseUrl,
} from '../utils/security';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('sanitizeConfig', () => {
  test('passes null and undefined straight through', () => {
    expect(sanitizeConfig(null)).toBeNull();
    expect(sanitizeConfig(undefined)).toBeUndefined();
  });

  test('leaves non-string scalars alone', () => {
    expect(sanitizeConfig(42)).toBe(42);
    expect(sanitizeConfig(true)).toBe(true);
  });

  test('leaves innocuous strings alone', () => {
    expect(sanitizeConfig('prod')).toBe('prod');
  });

  test('redacts a secret-shaped bare string', () => {
    expect(sanitizeConfig('mysql://user:hunter2@db.example.com/app')).toBe('[REDACTED]');
  });

  test('redacts a long base64-looking string', () => {
    expect(sanitizeConfig('A'.repeat(48))).toBe('[REDACTED]');
  });

  test('walks nested objects', () => {
    const out = sanitizeConfig({
      env: 'prod',
      db: { url: 'postgresql://admin:secret@db.example.com:5432/app' },
    }) as Record<string, unknown>;

    expect(out['env']).toBe('prod');
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  test('walks arrays', () => {
    const out = sanitizeConfig(['plain', 'mysql://u:p@host.example.com/db']) as unknown[];
    expect(out[0]).toBe('plain');
    expect(out[1]).toBe('[REDACTED]');
  });

  test('bottoms out instead of recursing forever', () => {
    // 12 levels deep — past the depth-10 guard.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 12; i++) deep = { nested: deep };

    expect(JSON.stringify(sanitizeConfig(deep))).toContain('max depth');
  });

  test('is stable — sanitising twice changes nothing further', () => {
    const once = sanitizeConfig({ a: 'mysql://u:p@host.example.com/db', b: 'ok' });
    expect(sanitizeConfig(once)).toEqual(once);
  });
});

describe('sanitizeEnvironment', () => {
  test('redacts by sensitive key name regardless of the value', () => {
    const out = sanitizeEnvironment({ DB_PASSWORD: 'short', APP_ENV: 'prod' });
    expect(out['DB_PASSWORD']).toBe('[REDACTED]');
    expect(out['APP_ENV']).toBe('prod');
  });

  test('key matching is case-insensitive', () => {
    expect(sanitizeEnvironment({ database_url: 'postgres://x' })['database_url'])
      .toBe('[REDACTED]');
  });

  test('redacts a secret-shaped value under an innocuous key', () => {
    const out = sanitizeEnvironment({ SOMETHING: 'mysql://user:pass@db.example.com/app' });
    expect(out['SOMETHING']).toBe('[REDACTED]');
  });

  test('leaves ordinary values untouched', () => {
    expect(sanitizeEnvironment({ APP_DEBUG: '0', APP_ENV: 'dev' }))
      .toEqual({ APP_DEBUG: '0', APP_ENV: 'dev' });
  });

  test('handles an empty environment', () => {
    expect(sanitizeEnvironment({})).toEqual({});
  });
});

describe('isPathSafe', () => {
  test('accepts a file inside the base directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'inside.txt'), 'x');
    expect(isPathSafe(tmpDir, 'inside.txt')).toBe(true);
  });

  test('rejects a lexical traversal out of the base', () => {
    expect(isPathSafe(tmpDir, '../../etc/passwd')).toBe(false);
  });

  test('accepts a path that does not exist yet but stays inside', () => {
    expect(isPathSafe(tmpDir, 'not-created-yet.txt')).toBe(true);
  });

  test('falls back to the lexical check when the base does not exist', () => {
    const ghost = path.join(tmpDir, 'no-such-dir');
    expect(isPathSafe(ghost, 'file.txt')).toBe(true);
  });

  test('falls back when the parent directory does not exist either', () => {
    expect(isPathSafe(tmpDir, 'missing-dir/deeper/file.txt')).toBe(true);
  });

  test('rejects a symlink pointing outside the base', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'security-outside-'));
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'classified');

    const link = path.join(tmpDir, 'escape-link');
    try {
      fs.symlinkSync(secret, link);
    } catch {
      return; // symlinks unavailable on this platform; nothing to assert
    }

    try {
      expect(isPathSafe(tmpDir, 'escape-link')).toBe(false);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('accepts a symlink that stays inside the base', () => {
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(target, 'fine');
    const link = path.join(tmpDir, 'inside-link');
    try {
      fs.symlinkSync(target, link);
    } catch {
      return;
    }

    try {
      expect(isPathSafe(tmpDir, 'inside-link')).toBe(true);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });
});

describe('sanitizeDatabaseUrl', () => {
  test('redacts the password and keeps the rest of the DSN readable', () => {
    const out = sanitizeDatabaseUrl('postgresql://appuser:hunter2@db.example.com:5432/appdb');

    expect(out).not.toContain('hunter2');
    expect(out).toContain('appuser');
    expect(out).toContain('db.example.com');
  });

  test('leaves a DSN with no credentials alone', () => {
    const dsn = 'sqlite:///var/data.db';
    expect(sanitizeDatabaseUrl(dsn)).toBe(dsn);
  });

  test('handles an empty value', () => {
    expect(sanitizeDatabaseUrl('')).toBe('');
  });

  test('a long credential-less string does not blow up the matcher', () => {
    // The old pattern backtracked polynomially here: two open-ended character
    // classes with no @ to anchor the end.
    const hostile = 'postgresql://' + 'a'.repeat(50_000);

    const start = Date.now();
    sanitizeDatabaseUrl(hostile);

    expect(Date.now() - start).toBeLessThan(1000);
  });
});
