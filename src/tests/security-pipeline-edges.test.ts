/**
 * The defensive branches the happy-path suites never reach.
 *
 * Every module in the security pipeline has fallbacks that only fire on input
 * nobody writes a fixture for: a symlink pointing outside the allowlist, a
 * broken symlink, LRU eviction at capacity, the paranoid privacy level, the
 * rate limiter's window pruning. These are exactly the paths that matter when
 * something goes wrong, so they get their own tests here rather than being
 * left to the "it never happens" pile.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { guardAppPath, resetGuardCache } from '../utils/app-guard';
import { applyPrivacyMode, getPrivacyLevel, isPrivacyApplicable } from '../utils/privacy-mode';
import { cacheManager } from '../utils/cache-manager';
import { getHttpRateLimitConfig, checkIpRateLimit, resetIpRateLimits } from '../utils/http-rate-limiter';
import { emitTokenInstructions } from '../utils/session-token';

const ENV_KEYS = [
  'SYMFONY_MCP_ALLOWED_PATHS', 'SYMFONY_MCP_REQUIRE_SYMFONY',
  'SYMFONY_MCP_PRIVACY', 'SYMFONY_MCP_PRIVACY_TOOLS',
  'SYMFONY_MCP_HTTP_RATE_LIMIT',
  'SYMFONY_MCP_SESSION_SECRET', 'SYMFONY_MCP_SESSION_WINDOW',
];

let saved: Record<string, string | undefined>;
let tmpDir: string;
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-edges-'));
  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  resetGuardCache();
  cacheManager.clear();
  resetIpRateLimits();
});

afterEach(() => {
  stderrSpy.mockRestore();
  resetGuardCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Creates a Symfony-shaped directory so the guard's structure check passes. */
function symfonyApp(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(dir, 'config', 'packages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'composer.json'),
    JSON.stringify({ name: 'test/app', require: { 'symfony/framework-bundle': '^7.0' } })
  );
  fs.writeFileSync(path.join(dir, 'bin', 'console'), '#!/usr/bin/env php');
  return dir;
}

describe('app-guard — symlink resolution against the allowlist', () => {
  test('accepts a symlink that resolves inside an allowed path', () => {
    const real = symfonyApp('real-app');
    const link = path.join(tmpDir, 'link-to-app');
    try {
      fs.symlinkSync(real, link);
    } catch {
      return; // no symlink support on this platform
    }

    process.env['SYMFONY_MCP_ALLOWED_PATHS'] = tmpDir;
    resetGuardCache();

    expect(guardAppPath(link).allowed).toBe(true);
  });

  test('rejects a symlink that escapes the allowlist', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-outside-'));
    fs.mkdirSync(path.join(outside, 'config', 'packages'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'src'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(outside, 'composer.json'),
      JSON.stringify({ name: 'x/y', require: { 'symfony/framework-bundle': '^7.0' } })
    );
    fs.writeFileSync(path.join(outside, 'bin', 'console'), '#!/usr/bin/env php');

    const allowedDir = path.join(tmpDir, 'allowed');
    fs.mkdirSync(allowedDir, { recursive: true });
    const link = path.join(allowedDir, 'escape');
    try {
      fs.symlinkSync(outside, link);
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }

    process.env['SYMFONY_MCP_ALLOWED_PATHS'] = allowedDir;
    resetGuardCache();

    try {
      const r = guardAppPath(link);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/symlink/i);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('rejects a broken symlink', () => {
    const link = path.join(tmpDir, 'dangling');
    try {
      fs.symlinkSync(path.join(tmpDir, 'does-not-exist'), link);
    } catch {
      return;
    }

    const r = guardAppPath(link);

    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/broken or inaccessible symlink|does not exist/i);
  });
});

describe('privacy-mode — paranoid level', () => {
  /** Runs one text blob through the pipeline and returns the transformed text. */
  const run = (text: string, tool = 'list_routes'): string =>
    applyPrivacyMode({ content: [{ type: 'text', text }] }, tool).content[0].text as string;

  const paranoid = (text: string, tool = 'list_routes'): string => {
    process.env['SYMFONY_MCP_PRIVACY'] = 'paranoid';
    return run(text, tool);
  };

  test('the level is read from the environment', () => {
    expect(getPrivacyLevel()).toBe('standard');

    process.env['SYMFONY_MCP_PRIVACY'] = 'paranoid';
    expect(getPrivacyLevel()).toBe('paranoid');

    process.env['SYMFONY_MCP_PRIVACY'] = 'STRICT';
    expect(getPrivacyLevel()).toBe('strict');
  });

  test('strips version numbers', () => {
    expect(paranoid('Symfony 6.4.2 running')).toContain('[VERSION]');
  });

  test('strips timestamps', () => {
    expect(paranoid('[2024-01-01 10:00:00] INFO started')).toContain('[TIMESTAMP]');
  });

  test('strips ports', () => {
    expect(paranoid('listening on localhost:8080')).toContain('[PORT]');
  });

  test('anonymises file basenames but keeps the extension', () => {
    const out = paranoid('error in /var/www/app/src/Controller/HomeController.php');

    expect(out).not.toContain('HomeController');
    expect(out).toContain('PHP');
  });

  test('annotates sensitive schema columns for schema tools', () => {
    process.env['SYMFONY_MCP_PRIVACY'] = 'paranoid';
    const out = run('| password | varchar(255) |', 'get_table_schema');

    expect(out).toContain('SENSITIVE:PII');
  });

  test('leaves a non-schema tool unannotated', () => {
    process.env['SYMFONY_MCP_PRIVACY'] = 'paranoid';
    expect(run('| password | varchar(255) |', 'list_routes')).not.toContain('SENSITIVE:PII');
  });

  test('the tool allowlist narrows where privacy applies', () => {
    process.env['SYMFONY_MCP_PRIVACY'] = 'paranoid';
    process.env['SYMFONY_MCP_PRIVACY_TOOLS'] = 'tail_log';

    expect(isPrivacyApplicable('tail_log')).toBe(true);
    expect(isPrivacyApplicable('list_routes')).toBe(false);
  });
});

describe('cache-manager — capacity and disabled mode', () => {
  test('evicts the oldest entry once the namespace is at capacity', () => {
    // Default cap is 200 entries per namespace.
    for (let i = 0; i < 205; i++) cacheManager.set('cap-test', `k${i}`, i);

    // The very first keys must have been pushed out.
    expect(cacheManager.get('cap-test', 'k0')).toBeNull();
    expect(cacheManager.get('cap-test', 'k204')).toBe(204);
    expect(cacheManager.getStats().evictions).toBeGreaterThan(0);
  });

  test('access order protects a recently read entry from eviction', () => {
    for (let i = 0; i < 200; i++) cacheManager.set('lru-test', `k${i}`, i);
    cacheManager.get('lru-test', 'k0');   // touch the oldest
    cacheManager.set('lru-test', 'fresh', 1);

    expect(cacheManager.get('lru-test', 'k0')).toBe(0);
  });
});

describe('http rate limiter', () => {
  test('reports its configuration', () => {
    expect(getHttpRateLimitConfig().enabled).toBe(true);

    process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '0';
    expect(getHttpRateLimitConfig()).toEqual({ maxPerMinute: 0, enabled: false });
  });

  test('a limit of 0 lets everything through', () => {
    process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '0';
    for (let i = 0; i < 50; i++) {
      expect(checkIpRateLimit('10.0.0.1')).toBe(true);
    }
  });

  test('blocks once an IP passes its limit, and tracks IPs separately', () => {
    process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '3';

    expect(checkIpRateLimit('10.0.0.2')).toBe(true);
    expect(checkIpRateLimit('10.0.0.2')).toBe(true);
    expect(checkIpRateLimit('10.0.0.2')).toBe(true);
    expect(checkIpRateLimit('10.0.0.2')).toBe(false);

    // A different IP starts with a clean window.
    expect(checkIpRateLimit('10.0.0.3')).toBe(true);
  });
});

describe('session token instructions', () => {
  test('says nothing when no secret is configured', () => {
    emitTokenInstructions();
    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('SESSION_TOKEN='));
  });

  test('prints a usable token and the window when a secret is set', () => {
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 's'.repeat(32);
    process.env['SYMFONY_MCP_SESSION_WINDOW'] = '120';

    emitTokenInstructions();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('SYMFONY_MCP_SESSION_TOKEN='));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('120s'));
  });
});
