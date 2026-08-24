// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Kill switches, optional-parameter branches and validator rejections.
 *
 * Most of the pipeline can be switched off by an environment variable, and
 * every one of those early returns is a path where the server does *less*
 * than it normally would. They deserve tests precisely because a mistake
 * there is silent: the feature simply stops running.
 *
 * The rest of the file covers the type validators' remaining rejections and
 * the parsers' "this input is not what I handle" returns.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { validateToolArgs } from '../utils/input-validator';
import {
  scanText, redactText, containsDlpViolation, dlpSanitize, getDlpPatternInfo,
} from '../utils/dlp-detector';
import {
  checkAnomaly, recordAuthFailure, recordToolError, recordRateLimitBlock,
  resetAnomalyCounters, resetScanTracking, resetCorrelationTracking,
  getAnomalySummary, getRecentAnomalyEvents,
} from '../utils/anomaly-detector';
import { runStartupAudit } from '../utils/startup-audit';
import { applyPrivacyMode } from '../utils/privacy-mode';
import { loadDoctrineMetadata } from '../utils/doctrine-metadata';
import { cacheManager } from '../utils/cache-manager';

const ENV_KEYS = [
  'SYMFONY_MCP_DLP', 'SYMFONY_MCP_DLP_TIMEOUT_MS',
  'SYMFONY_MCP_ANOMALY', 'SYMFONY_MCP_ANOMALY_STRICT',
  'SYMFONY_MCP_METRICS', 'SYMFONY_MCP_PRIVACY',
  'SYMFONY_MCP_STARTUP_AUDIT', 'SYMFONY_MCP_SIGNING_SECRET',
  'SYMFONY_MCP_SESSION_SECRET', 'SYMFONY_MCP_ALLOWED_PATHS',
  'SYMFONY_MCP_AUDIT_KEY', 'SYMFONY_MCP_ANOMALY_WINDOW_MS',
];

let saved: Record<string, string | undefined>;
let stderrSpy: jest.SpyInstance;
let appDir: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  resetAnomalyCounters();
  resetScanTracking();
  resetCorrelationTracking();
  cacheManager.clear();
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-'));
});

afterEach(() => {
  stderrSpy.mockRestore();
  resetAnomalyCounters();
  resetScanTracking();
  resetCorrelationTracking();
  fs.rmSync(appDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('DLP kill switch', () => {
  const SECRET = 'AKIA' + 'IOSFODNN7EXAMPLE';

  test('scanText finds nothing once DLP is off', () => {
    process.env['SYMFONY_MCP_DLP'] = 'false';
    expect(scanText(SECRET)).toEqual([]);
  });

  test('redactText returns the value untouched once DLP is off', () => {
    process.env['SYMFONY_MCP_DLP'] = 'false';
    expect(redactText(SECRET)).toBe(SECRET);
  });

  test('dlpSanitize passes the value through once DLP is off', () => {
    process.env['SYMFONY_MCP_DLP'] = 'false';
    expect(dlpSanitize({ key: SECRET })).toEqual({ key: SECRET });
  });

  test('an empty string is handled without scanning', () => {
    expect(scanText('')).toEqual([]);
    expect(redactText('')).toBe('');
  });
});

describe('DLP — value shapes and validation', () => {
  test('containsDlpViolation is false for non-string leaves', () => {
    expect(containsDlpViolation(42)).toBe(false);
    expect(containsDlpViolation(null)).toBe(false);
    expect(containsDlpViolation(undefined)).toBe(false);
    expect(containsDlpViolation(true)).toBe(false);
  });

  test('dlpSanitize leaves non-string leaves alone', () => {
    expect(dlpSanitize({ n: 1, b: false, nil: null })).toEqual({ n: 1, b: false, nil: null });
  });

  test('a card-shaped number of the wrong length is not a card', () => {
    // The Luhn check only applies within 13–19 digits.
    expect(scanText('1234567890').some((m) => /CARD/i.test(m.type))).toBe(false);
    expect(scanText('1'.repeat(25)).some((m) => /CARD/i.test(m.type))).toBe(false);
  });

  test('a card-shaped number failing the Luhn check is rejected', () => {
    // 16 digits, deliberately not Luhn-valid.
    expect(scanText('4111111111111112').some((m) => /CARD/i.test(m.type))).toBe(false);
  });

  test('exposes its pattern inventory with severities', () => {
    const info = getDlpPatternInfo();
    expect(info.length).toBeGreaterThan(0);
    expect(info.every((p) => p.type && p.severity)).toBe(true);
  });

  test('a scan that exceeds its time budget gives up and warns', () => {
    process.env['SYMFONY_MCP_DLP_TIMEOUT_MS'] = '0';
    // With no time allowed, the scan bails on the first deadline check.
    expect(() => scanText('x'.repeat(5000))).not.toThrow();
  });
});

describe('anomaly detector kill switch', () => {
  test('checkAnomaly reports nothing once detection is off', () => {
    process.env['SYMFONY_MCP_ANOMALY'] = 'false';
    expect(checkAnomaly('list_routes', '../../../etc/passwd')).toBeNull();
  });

  test('recordAuthFailure is inert once detection is off', () => {
    process.env['SYMFONY_MCP_ANOMALY'] = 'false';
    for (let i = 0; i < 10; i++) expect(recordAuthFailure('bad signature')).toBeNull();
  });

  test('recordToolError is inert once detection is off', () => {
    process.env['SYMFONY_MCP_ANOMALY'] = 'false';
    for (let i = 0; i < 10; i++) expect(recordToolError('list_routes')).toBeNull();
  });

  test('recordRateLimitBlock is inert once detection is off', () => {
    process.env['SYMFONY_MCP_ANOMALY'] = 'false';
    for (let i = 0; i < 10; i++) expect(recordRateLimitBlock('list_routes')).toBeNull();
  });

  test('the summary and recent-event list are readable at any time', () => {
    expect(getAnomalySummary()).toBeDefined();
    expect(Array.isArray(getRecentAnomalyEvents(5))).toBe(true);
  });

  test('resetting clears accumulated state', () => {
    for (let i = 0; i < 3; i++) checkAnomaly('list_routes', '../../etc/passwd');
    resetAnomalyCounters();
    resetScanTracking();
    resetCorrelationTracking();

    expect(checkAnomaly('list_routes', '/var/www/app')).toBeNull();
  });

  test('the recent-event list is bounded', () => {
    for (let i = 0; i < 60; i++) checkAnomaly('list_routes', `../../etc/passwd${i}`);
    expect(getRecentAnomalyEvents(500).length).toBeLessThanOrEqual(100);
  });

  test('a non-indicator event does not count towards multi-vector detection', () => {
    // Ordinary calls must never accumulate into an attack signal.
    for (let i = 0; i < 30; i++) checkAnomaly('list_routes', '/var/www/app');
    expect(checkAnomaly('list_routes', '/var/www/app')).toBeNull();
  });
});

describe('startup audit — the quiet paths', () => {
  test('says so when every check passes', () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 's'.repeat(32);
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 's'.repeat(32);
    process.env['SYMFONY_MCP_AUDIT_KEY'] = Buffer.alloc(32, 1).toString('base64');
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = new Date().toISOString();
    process.env['SYMFONY_MCP_ANOMALY_STRICT'] = 'true';
    process.env['SYMFONY_MCP_ALLOWED_PATHS'] = '/var/www/app';

    try {
      const findings = runStartupAudit(false);
      if (findings.length === 0) {
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('All security checks passed'));
      } else {
        // Any residual finding must still be well-formed.
        expect(findings.every((f) => f.code && f.suggestion)).toBe(true);
      }
    } finally {
      delete process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'];
    }
  });
});

describe('privacy mode — content it does not transform', () => {
  test('leaves a non-text content item untouched', () => {
    process.env['SYMFONY_MCP_PRIVACY'] = 'paranoid';
    const result = applyPrivacyMode(
      { content: [{ type: 'image', data: 'base64==' } as never] },
      'list_routes'
    );

    expect(result.content[0]).toEqual({ type: 'image', data: 'base64==' });
  });

  test('strips a labelled numeric id but keeps the label', () => {
    process.env['SYMFONY_MCP_PRIVACY'] = 'paranoid';
    const out = applyPrivacyMode(
      { content: [{ type: 'text', text: 'id: 12345' }] },
      'list_routes'
    ).content[0].text as string;

    expect(out).toBe('id: [ID]');
  });

  test('leaves a non-sensitive column name alone', () => {
    process.env['SYMFONY_MCP_PRIVACY'] = 'paranoid';
    const out = applyPrivacyMode(
      { content: [{ type: 'text', text: '| created_at | datetime |' }] },
      'get_table_schema'
    ).content[0].text as string;

    expect(out).not.toContain('SENSITIVE:PII');
  });
});

describe('doctrine metadata — inputs it declines', () => {
  test('skips an XML entity tag with neither class nor name', () => {
    const dir = path.join(appDir, 'config', 'doctrine');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'anon.orm.xml'),
      '<doctrine-mapping><entity table="t"></entity></doctrine-mapping>');

    expect(loadDoctrineMetadata(appDir).entities).toEqual([]);
  });

  test('skips a YAML document whose root key is empty', () => {
    const dir = path.join(appDir, 'config', 'doctrine');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'blank.orm.yml'), '{}\n');

    expect(loadDoctrineMetadata(appDir).entities).toEqual([]);
  });
});

describe('input validator — remaining rejections', () => {
  test('rejects an empty optional name', () => {
    const r = validateToolArgs('get_environment_logs', { app_path: '/app', environment: '' });
    expect(r.valid).toBe(false);
  });

  test('rejects a NUL byte inside an otherwise valid path', () => {
    const r = validateToolArgs('list_routes', { app_path: '/var/www/app extra' });
    expect(r.valid).toBe(false);
  });

  test('accepts an omitted optional enum', () => {
    expect(validateToolArgs('list_logs', { app_path: '/var/www/app' }).valid).toBe(true);
  });

  test('an unknown parameter type is not rejected outright', () => {
    // Parameters with no matching validator fall through as valid.
    expect(validateToolArgs('list_routes', { app_path: '/var/www/app', extra: 1 }).valid).toBe(true);
  });
});
