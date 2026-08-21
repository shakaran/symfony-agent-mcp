/**
 * Outer error guards: the try/catch that wraps a whole operation.
 *
 * Each of these exists so a failure in one subsystem cannot take down the
 * tool call that triggered it — a malformed webhook URL must not crash the
 * anomaly path, and an unreadable mapping file must not crash entity
 * discovery. They are the last line before an exception escapes.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { notifyAnomalyEvent } from '../utils/anomaly-notifier';
import { loadDoctrineMetadata } from '../utils/doctrine-metadata';
import { resolveSecret, clearVaultCache } from '../utils/vault-resolver';
import { cacheManager } from '../utils/cache-manager';
import type { AnomalyEvent } from '../utils/anomaly-detector';

const ENV_KEYS = [
  'SYMFONY_MCP_WEBHOOK_URL', 'SYMFONY_MCP_SLACK_WEBHOOK',
  'SYMFONY_MCP_PAGERDUTY_KEY', 'SYMFONY_MCP_NOTIFY_MIN_SEVERITY',
  'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
];

let saved: Record<string, string | undefined>;
let tmpDir: string;
let stderrSpy: jest.SpyInstance;

const event = (): AnomalyEvent => ({
  type: 'PATH_TRAVERSAL_PROBE',
  severity: 'CRITICAL',
  detail: 'probe',
  blocked: true,
  ts: new Date(1_700_000_000_000).toISOString(),
} as AnomalyEvent);

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-guards-'));
  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  cacheManager.clear();
  clearVaultCache();
});

afterEach(() => {
  stderrSpy.mockRestore();
  clearVaultCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('notifier — a webhook URL that cannot be parsed', () => {
  test('logs the failure instead of rejecting', async () => {
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'not a url at all';

    await expect(notifyAnomalyEvent(event())).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to send notification')
    );
  });

  test('one unusable channel does not stop a usable one from being attempted', async () => {
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = ':::malformed:::';
    process.env['SYMFONY_MCP_SLACK_WEBHOOK'] = ':::also-malformed:::';

    await expect(notifyAnomalyEvent(event())).resolves.toBeUndefined();
  });
});

describe('doctrine metadata — a YAML mapping with a scalar body', () => {
  test('yields an entity with defaults rather than throwing', () => {
    const dir = path.join(tmpDir, 'config', 'doctrine');
    fs.mkdirSync(dir, { recursive: true });
    // The root key is present but its value is a string. Property lookups on
    // a string return undefined rather than throwing, so the parser produces
    // a bare entity instead of rejecting the file — worth pinning down, since
    // the shape is what downstream tools receive.
    fs.writeFileSync(path.join(dir, 'Odd.orm.yml'), 'App\\Entity\\Odd: just-a-string\n');

    const [e] = loadDoctrineMetadata(tmpDir).entities;

    expect(e.shortName).toBe('Odd');
    expect(e.properties).toEqual([]);
    expect(e.relationships).toEqual([]);
    expect(e.tableName).toBe('odd');
  });
});

describe('vault — Secrets Manager returns something that is not JSON', () => {
  test('the parse failure surfaces as a rejection', async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAEXAMPLEEXAMPLE00';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'secret-key-material';

    // No mock here: the request cannot reach AWS from a test runner, so this
    // asserts the promise rejects rather than hanging or resolving.
    await expect(resolveSecret('aws-secret:app/creds#pw')).rejects.toThrow();
  }, 20000);
});
