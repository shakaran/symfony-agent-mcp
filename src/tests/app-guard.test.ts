// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { guardAppPath, resetGuardCache } from '../utils/app-guard';

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeSymfonyProject(dir: string): void {
  // Create minimum required Symfony indicators
  fs.mkdirSync(path.join(dir, 'config', 'packages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'console'), '#!/usr/bin/env php\n<?php');
  fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({
    require: { 'symfony/framework-bundle': '^7.0' },
  }));
}

beforeEach(() => {
  resetGuardCache();
  delete process.env['SYMFONY_MCP_ALLOWED_PATHS'];
  process.env['SYMFONY_MCP_REQUIRE_SYMFONY'] = 'false'; // Skip Symfony check by default
});

afterEach(() => {
  resetGuardCache();
  delete process.env['SYMFONY_MCP_ALLOWED_PATHS'];
  delete process.env['SYMFONY_MCP_REQUIRE_SYMFONY'];
});

describe('guardAppPath', () => {
  test('allows valid readable directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-valid-'));
    const result = guardAppPath(tmpDir);
    expect(result.allowed).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('rejects empty string', () => {
    const result = guardAppPath('');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('required');
  });

  test('rejects non-existent path', () => {
    const result = guardAppPath('/tmp/definitely-does-not-exist-abc123xyz');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  test('rejects file path (not a directory)', () => {
    const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-file-')), 'test-file.txt');
    fs.writeFileSync(tmpFile, 'content');
    const result = guardAppPath(tmpFile);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not a directory');
    fs.unlinkSync(tmpFile);
  });

  test('rejects path with null byte', () => {
    const result = guardAppPath('/tmp/test\0evil');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('invalid characters');
  });

  test('resolves .. sequences before checking', () => {
    // /tmp/foo/../foo is the same as /tmp/foo — should be allowed if readable
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-dots-'));
    const result = guardAppPath(tmpDir + '/subdir/..');
    expect(result.allowed).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('guardAppPath with allowlist', () => {
  test('allows path in allowlist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-allow-'));
    process.env['SYMFONY_MCP_ALLOWED_PATHS'] = tmpDir;
    resetGuardCache();

    const result = guardAppPath(tmpDir);
    expect(result.allowed).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('blocks path NOT in allowlist', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-allowed-'));
    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-blocked-'));
    process.env['SYMFONY_MCP_ALLOWED_PATHS'] = allowed;
    resetGuardCache();

    const result = guardAppPath(blocked);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('allowed paths list');

    fs.rmSync(allowed, { recursive: true });
    fs.rmSync(blocked, { recursive: true });
  });

  test('allows subdirectory of allowed path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-parent-'));
    const subDir = path.join(tmpDir, 'subproject');
    fs.mkdirSync(subDir);
    process.env['SYMFONY_MCP_ALLOWED_PATHS'] = tmpDir;
    resetGuardCache();

    const result = guardAppPath(subDir);
    expect(result.allowed).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('supports multiple colon-separated paths', () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-multi1-'));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-multi2-'));
    process.env['SYMFONY_MCP_ALLOWED_PATHS'] = `${dir1}:${dir2}`;
    resetGuardCache();

    expect(guardAppPath(dir1).allowed).toBe(true);
    expect(guardAppPath(dir2).allowed).toBe(true);

    fs.rmSync(dir1, { recursive: true });
    fs.rmSync(dir2, { recursive: true });
  });
});

describe('guardAppPath Symfony project validation', () => {
  test('allows valid Symfony project', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-symfony-'));
    makeSymfonyProject(tmpDir);
    process.env['SYMFONY_MCP_REQUIRE_SYMFONY'] = 'true';
    resetGuardCache();

    const result = guardAppPath(tmpDir);
    expect(result.allowed).toBe(true);
    cleanup(tmpDir);
  });

  test('rejects directory without Symfony indicators', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-notphp-'));
    process.env['SYMFONY_MCP_REQUIRE_SYMFONY'] = 'true';
    resetGuardCache();

    const result = guardAppPath(tmpDir);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not appear to be a Symfony project');
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('rejects composer.json without symfony/* deps', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-nodepress-'));
    // Add enough indicators to pass count check but wrong deps
    fs.mkdirSync(path.join(tmpDir, 'config', 'packages'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^10.0' },
    }));
    process.env['SYMFONY_MCP_REQUIRE_SYMFONY'] = 'true';
    resetGuardCache();

    const result = guardAppPath(tmpDir);
    expect(result.allowed).toBe(false);
    cleanup(tmpDir);
  });

  test('SYMFONY_MCP_REQUIRE_SYMFONY=false skips validation', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-skip-'));
    process.env['SYMFONY_MCP_REQUIRE_SYMFONY'] = 'false';
    resetGuardCache();

    const result = guardAppPath(tmpDir);
    expect(result.allowed).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });
});
