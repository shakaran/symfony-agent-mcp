// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Vault resolver — the backend paths that need a server to answer.
 *
 * vault-resolver.test.ts covers reference recognition, passthrough, the
 * missing-credential errors and getVaultStatus, all of which need no network.
 * This file takes everything past that point by mocking `http` and `https`:
 * KV v1 versus v2 response shapes, AppRole login, SigV4-signed SSM and
 * Secrets Manager calls, the caching layer, and how a failed lookup surfaces.
 * No socket is opened.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('https');
jest.mock('http');

import * as https from 'https';
import * as http from 'http';

import {
  resolveSecret,
  resolveSecrets,
  clearVaultCache,
  getVaultCacheStats,
  resetVaultTlsAgent,
} from '../utils/vault-resolver';

const ENV_KEYS = [
  'SYMFONY_MCP_VAULT_TOKEN', 'VAULT_TOKEN', 'SYMFONY_MCP_VAULT_ADDR',
  'SYMFONY_MCP_VAULT_ROLE_ID', 'SYMFONY_MCP_VAULT_SECRET_ID',
  'SYMFONY_MCP_SECRET_TTL_MS',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_PROFILE',
];

let saved: Record<string, string | undefined>;
let stderrSpy: jest.SpyInstance;

/** Fake response object that emits `body` then ends, with the given status. */
function fakeResponse(status: number, body: string): EventEmitter & { statusCode: number } {
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = status;
  setImmediate(() => {
    res.emit('data', Buffer.from(body));
    res.emit('end');
  });
  return res;
}

/** Fake request object: never errors, ignores timeouts. */
function fakeRequest(): EventEmitter & { setTimeout: jest.Mock; destroy: jest.Mock; write: jest.Mock; end: jest.Mock } {
  const req = new EventEmitter() as EventEmitter & {
    setTimeout: jest.Mock; destroy: jest.Mock; write: jest.Mock; end: jest.Mock;
  };
  req.setTimeout = jest.fn();
  req.destroy = jest.fn();
  req.write = jest.fn();
  req.end = jest.fn();
  return req;
}

// https.get and http.get share one FIFO queue: the resolver picks the library
// from the URL scheme, so per-mock `mockImplementationOnce` would leave the
// unused one primed and desynchronise every later test.
const getQueue: Array<{ status: number; body: string; timeout?: boolean }> = [];
const requestQueue: Array<{ status: number; body: string; timeout?: boolean }> = [];

/** Queues one GET response, for whichever of http/https the resolver picks. */
function nextGet(status: number, body: string): void {
  getQueue.push({ status, body });
}

/** Queues one POST (https.request) response. */
function nextRequest(status: number, body: string): void {
  requestQueue.push({ status, body });
}

/** Queues a GET that never answers, so the 5s timeout guard fires instead. */
function nextGetTimeout(): void {
  getQueue.push({ status: 0, body: '', timeout: true });
}

/** Queues a POST that never answers. */
function nextRequestTimeout(): void {
  requestQueue.push({ status: 0, body: '', timeout: true });
}

/** A request whose setTimeout callback fires immediately. */
function timingOutRequest(): ReturnType<typeof fakeRequest> {
  const req = fakeRequest();
  req.setTimeout = jest.fn((_ms: number, fn: () => void) => { setImmediate(fn); });
  return req;
}

/** Total GET calls made across both libraries. */
function getCallCount(): number {
  return (https.get as unknown as jest.Mock).mock.calls.length
       + (http.get as unknown as jest.Mock).mock.calls.length;
}

function installGetMock(lib: typeof https | typeof http): void {
  (lib.get as unknown as jest.Mock).mockImplementation(
    (_url: unknown, optsOrCb: unknown, maybeCb?: (r: unknown) => void) => {
      const cb = typeof optsOrCb === 'function' ? (optsOrCb as (r: unknown) => void) : maybeCb!;
      const next = getQueue.shift() ?? { status: 500, body: 'no response queued' };
      if (next.timeout) return timingOutRequest();
      cb(fakeResponse(next.status, next.body));
      return fakeRequest();
    }
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  clearVaultCache();
  resetVaultTlsAgent();
  getQueue.length = 0;
  requestQueue.length = 0;
  installGetMock(https);
  installGetMock(http);
  (https.request as unknown as jest.Mock).mockImplementation(
    (_opts: unknown, cb: (r: unknown) => void) => {
      const next = requestQueue.shift() ?? { status: 500, body: 'no response queued' };
      if (next.timeout) return timingOutRequest();
      cb(fakeResponse(next.status, next.body));
      return fakeRequest();
    }
  );
  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  clearVaultCache();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('HashiCorp Vault', () => {
  beforeEach(() => {
    process.env['SYMFONY_MCP_VAULT_TOKEN'] = 'test-token';
    process.env['SYMFONY_MCP_VAULT_ADDR'] = 'https://vault.example.com';
  });

  test('reads a field from a KV v2 secret', async () => {
    nextGet(200, JSON.stringify({ data: { data: { db_password: 'hunter2' } } }));

    await expect(resolveSecret('vault:secret/data/app#db_password')).resolves.toBe('hunter2');
  });

  test('reads a field from a KV v1 secret', async () => {
    nextGet(200, JSON.stringify({ data: { db_password: 'v1-secret' } }));

    await expect(resolveSecret('vault:secret/app#db_password')).resolves.toBe('v1-secret');
  });

  test('returns the whole map as JSON when no field is named', async () => {
    nextGet(200, JSON.stringify({ data: { data: { a: '1', b: '2' } } }));

    const out = await resolveSecret('vault:secret/data/app');
    expect(JSON.parse(out)).toEqual({ a: '1', b: '2' });
  });

  test('sends the token as X-Vault-Token', async () => {
    nextGet(200, JSON.stringify({ data: { data: { k: 'v' } } }));
    await resolveSecret('vault:secret/data/app#k');

    const opts = (https.get as unknown as jest.Mock).mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers['X-Vault-Token']).toBe('test-token');
  });

  test('builds the URL from the configured address', async () => {
    nextGet(200, JSON.stringify({ data: { data: { k: 'v' } } }));
    await resolveSecret('vault:secret/data/app#k');

    expect((https.get as unknown as jest.Mock).mock.calls[0][0])
      .toBe('https://vault.example.com/v1/secret/data/app');
  });

  test('fails clearly when the field is absent', async () => {
    nextGet(200, JSON.stringify({ data: { data: { other: 'x' } } }));

    await expect(resolveSecret('vault:secret/data/app#missing'))
      .rejects.toThrow(/field "missing" not found/);
  });

  test('fails clearly when the path returns no data', async () => {
    nextGet(200, JSON.stringify({}));

    await expect(resolveSecret('vault:secret/data/app#k'))
      .rejects.toThrow(/returned no data/);
  });

  test('surfaces a non-2xx response', async () => {
    nextGet(403, 'permission denied');

    await expect(resolveSecret('vault:secret/data/app#k')).rejects.toThrow(/HTTP 403/);
  });

  test('surfaces malformed JSON', async () => {
    nextGet(200, 'not json');

    await expect(resolveSecret('vault:secret/data/app#k')).rejects.toThrow();
  });

  test('refuses when no token is configured at all', async () => {
    delete process.env['SYMFONY_MCP_VAULT_TOKEN'];

    await expect(resolveSecret('vault:secret/data/app#k')).rejects.toThrow(/no token/i);
  });

  test('accepts VAULT_TOKEN as an alias', async () => {
    delete process.env['SYMFONY_MCP_VAULT_TOKEN'];
    process.env['VAULT_TOKEN'] = 'alias-token';
    nextGet(200, JSON.stringify({ data: { data: { k: 'v' } } }));

    await expect(resolveSecret('vault:secret/data/app#k')).resolves.toBe('v');
  });

  test('logs in with AppRole when no token is present', async () => {
    delete process.env['SYMFONY_MCP_VAULT_TOKEN'];
    process.env['SYMFONY_MCP_VAULT_ROLE_ID'] = 'role-1';
    process.env['SYMFONY_MCP_VAULT_SECRET_ID'] = 'secret-1';

    nextRequest(200, JSON.stringify({ auth: { client_token: 'approle-token' } }));
    nextGet(200, JSON.stringify({ data: { data: { k: 'from-approle' } } }));

    await expect(resolveSecret('vault:secret/data/app#k')).resolves.toBe('from-approle');
  });

  test('reports an AppRole login failure', async () => {
    delete process.env['SYMFONY_MCP_VAULT_TOKEN'];
    process.env['SYMFONY_MCP_VAULT_ROLE_ID'] = 'role-1';
    process.env['SYMFONY_MCP_VAULT_SECRET_ID'] = 'bad';
    nextRequest(400, 'invalid role or secret id');

    await expect(resolveSecret('vault:secret/data/app#k')).rejects.toThrow();
  });

  test('uses plain http when the address is not https', async () => {
    process.env['SYMFONY_MCP_VAULT_ADDR'] = 'http://vault.internal:8200';
    nextGet(200, JSON.stringify({ data: { data: { k: 'v' } } }));

    await resolveSecret('vault:secret/data/app#k');
    expect(http.get).toHaveBeenCalled();
  });
});

describe('caching', () => {
  beforeEach(() => {
    process.env['SYMFONY_MCP_VAULT_TOKEN'] = 'test-token';
    process.env['SYMFONY_MCP_VAULT_ADDR'] = 'https://vault.example.com';
  });

  test('a repeated reference is served without a second request', async () => {
    nextGet(200, JSON.stringify({ data: { data: { k: 'cached-value' } } }));

    await resolveSecret('vault:secret/data/app#k');
    await resolveSecret('vault:secret/data/app#k');

    expect(getCallCount()).toBe(1);
  });

  test('different fields are cached separately', async () => {
    nextGet(200, JSON.stringify({ data: { data: { a: '1', b: '2' } } }));
    nextGet(200, JSON.stringify({ data: { data: { a: '1', b: '2' } } }));

    await resolveSecret('vault:secret/data/app#a');
    await resolveSecret('vault:secret/data/app#b');

    expect(getCallCount()).toBe(2);
  });

  test('an expired entry is fetched again', async () => {
    process.env['SYMFONY_MCP_SECRET_TTL_MS'] = '0';
    nextGet(200, JSON.stringify({ data: { data: { k: 'v' } } }));
    nextGet(200, JSON.stringify({ data: { data: { k: 'v' } } }));

    await resolveSecret('vault:secret/data/app#k');
    await resolveSecret('vault:secret/data/app#k');

    expect(getCallCount()).toBe(2);
  });

  test('clearVaultCache empties the cache and says so', async () => {
    nextGet(200, JSON.stringify({ data: { data: { k: 'v' } } }));
    await resolveSecret('vault:secret/data/app#k');
    expect(getVaultCacheStats().entries).toBe(1);

    clearVaultCache();

    expect(getVaultCacheStats().entries).toBe(0);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('cache flushed'));
  });

  test('cache stats report a TTL once something is cached', async () => {
    expect(getVaultCacheStats()).toEqual({ entries: 0, oldestTtlMs: null });

    nextGet(200, JSON.stringify({ data: { data: { k: 'v' } } }));
    await resolveSecret('vault:secret/data/app#k');

    const stats = getVaultCacheStats();
    expect(stats.entries).toBe(1);
    expect(typeof stats.oldestTtlMs).toBe('number');
  });
});

describe('AWS SSM Parameter Store', () => {
  beforeEach(() => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAEXAMPLEEXAMPLE00';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'secret-key-material';
    process.env['AWS_REGION'] = 'eu-west-1';
  });

  test('resolves a parameter value', async () => {
    nextRequest(200, JSON.stringify({ Parameter: { Value: 'ssm-secret' } }));

    await expect(resolveSecret('ssm:/myapp/prod/db_password')).resolves.toBe('ssm-secret');
  });

  test('signs the request with SigV4', async () => {
    nextRequest(200, JSON.stringify({ Parameter: { Value: 'x' } }));
    await resolveSecret('ssm:/myapp/prod/db_password');

    const opts = (https.request as unknown as jest.Mock).mock.calls[0][0] as {
      headers: Record<string, string>; hostname: string; method: string;
    };
    expect(opts.method).toBe('POST');
    expect(opts.hostname).toContain('eu-west-1');
    expect(opts.headers['Authorization']).toContain('AWS4-HMAC-SHA256');
  });

  test('fails when the parameter has no value', async () => {
    nextRequest(200, JSON.stringify({}));

    await expect(resolveSecret('ssm:/myapp/missing')).rejects.toThrow(/no value/);
  });

  test('surfaces a non-200 response', async () => {
    nextRequest(400, 'ParameterNotFound');

    await expect(resolveSecret('ssm:/myapp/missing')).rejects.toThrow(/SSM HTTP 400/);
  });

  test('refuses without AWS credentials', async () => {
    delete process.env['AWS_ACCESS_KEY_ID'];
    delete process.env['AWS_SECRET_ACCESS_KEY'];

    await expect(resolveSecret('ssm:/myapp/prod/db')).rejects.toThrow();
  });
});

describe('AWS Secrets Manager', () => {
  beforeEach(() => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAEXAMPLEEXAMPLE00';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'secret-key-material';
    process.env['AWS_REGION'] = 'us-east-1';
  });

  test('returns the whole secret string when no field is named', async () => {
    nextRequest(200, JSON.stringify({ SecretString: '{"db_pass":"p"}' }));

    await expect(resolveSecret('aws-secret:myapp/creds')).resolves.toBe('{"db_pass":"p"}');
  });

  test('extracts a single field from a JSON secret', async () => {
    nextRequest(200, JSON.stringify({ SecretString: '{"db_pass":"p","other":"o"}' }));

    await expect(resolveSecret('aws-secret:myapp/creds#db_pass')).resolves.toBe('p');
  });

  test('surfaces a non-200 response', async () => {
    nextRequest(404, 'ResourceNotFoundException');

    await expect(resolveSecret('aws-secret:myapp/nope')).rejects.toThrow();
  });
});

describe('resolveSecrets over a config map', () => {
  beforeEach(() => {
    process.env['SYMFONY_MCP_VAULT_TOKEN'] = 'test-token';
    process.env['SYMFONY_MCP_VAULT_ADDR'] = 'https://vault.example.com';
  });

  test('leaves a map with no references untouched', async () => {
    const cfg = { APP_ENV: 'prod', APP_DEBUG: 'false' };
    await expect(resolveSecrets(cfg)).resolves.toEqual(cfg);
  });

  test('replaces only the reference values', async () => {
    nextGet(200, JSON.stringify({ data: { data: { pw: 'resolved' } } }));

    const out = await resolveSecrets({
      APP_ENV: 'prod',
      DB_PASSWORD: 'vault:secret/data/app#pw',
    });

    expect(out.APP_ENV).toBe('prod');
    expect(out.DB_PASSWORD).toBe('resolved');
  });

  test('keeps the original value and warns when one reference fails', async () => {
    nextGet(500, 'vault is sealed');

    const out = await resolveSecrets({ DB_PASSWORD: 'vault:secret/data/app#pw' });

    expect(out.DB_PASSWORD).toBe('vault:secret/data/app#pw');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to resolve vault ref'));
  });

  test('does not let one failure stop the others', async () => {
    nextGet(500, 'boom');
    nextGet(200, JSON.stringify({ data: { data: { ok: 'fine' } } }));

    const out = await resolveSecrets({
      BAD: 'vault:secret/data/bad#pw',
      GOOD: 'vault:secret/data/good#ok',
    });

    expect(out.BAD).toBe('vault:secret/data/bad#pw');
    expect(out.GOOD).toBe('fine');
  });
});


describe('timeouts', () => {
  beforeEach(() => {
    process.env['SYMFONY_MCP_VAULT_TOKEN'] = 'test-token';
    process.env['SYMFONY_MCP_VAULT_ADDR'] = 'https://vault.example.com';
  });

  test('a Vault read that never answers is rejected, not left hanging', async () => {
    nextGetTimeout();
    await expect(resolveSecret('vault:secret/data/app#k')).rejects.toThrow(/timed out/i);
  });

  test('an AppRole login that never answers is rejected', async () => {
    delete process.env['SYMFONY_MCP_VAULT_TOKEN'];
    process.env['SYMFONY_MCP_VAULT_ROLE_ID'] = 'r';
    process.env['SYMFONY_MCP_VAULT_SECRET_ID'] = 's';
    nextRequestTimeout();

    await expect(resolveSecret('vault:secret/data/app#k')).rejects.toThrow(/timed out/i);
  });

  test('an SSM request that never answers is rejected', async () => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAEXAMPLEEXAMPLE00';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'k';
    process.env['AWS_REGION'] = 'eu-west-1';
    nextRequestTimeout();

    await expect(resolveSecret('ssm:/app/db')).rejects.toThrow(/timed out/i);
  });

  test('a Secrets Manager request that never answers is rejected', async () => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAEXAMPLEEXAMPLE00';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'k';
    process.env['AWS_REGION'] = 'eu-west-1';
    nextRequestTimeout();

    await expect(resolveSecret('aws-secret:app/creds')).rejects.toThrow(/timed out/i);
  });
});

describe('AppRole token reuse', () => {
  beforeEach(() => {
    delete process.env['SYMFONY_MCP_VAULT_TOKEN'];
    process.env['SYMFONY_MCP_VAULT_ADDR'] = 'https://vault.example.com';
    process.env['SYMFONY_MCP_VAULT_ROLE_ID'] = 'role-1';
    process.env['SYMFONY_MCP_VAULT_SECRET_ID'] = 'secret-1';
  });

  test('logs in once and reuses the token for a second path', async () => {
    nextRequest(200, JSON.stringify({ auth: { client_token: 'approle-token' } }));
    nextGet(200, JSON.stringify({ data: { data: { a: '1' } } }));
    nextGet(200, JSON.stringify({ data: { data: { b: '2' } } }));

    await resolveSecret('vault:secret/data/one#a');
    await resolveSecret('vault:secret/data/two#b');

    expect((https.request as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  test('rejects when the login succeeds but returns no token', async () => {
    nextRequest(200, JSON.stringify({ auth: {} }));
    await expect(resolveSecret('vault:secret/data/app#k'))
      .rejects.toThrow(/returned no token/i);
  });
});

describe('AWS extras', () => {
  beforeEach(() => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAEXAMPLEEXAMPLE00';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'secret-key-material';
    process.env['AWS_REGION'] = 'eu-west-1';
  });

  afterEach(() => {
    delete process.env['AWS_SESSION_TOKEN'];
  });

  test('forwards a session token when one is set', async () => {
    process.env['AWS_SESSION_TOKEN'] = 'sts-session-token';
    nextRequest(200, JSON.stringify({ Parameter: { Value: 'v' } }));

    await resolveSecret('ssm:/app/db');

    const opts = (https.request as unknown as jest.Mock).mock.calls[0][0] as {
      headers: Record<string, string>;
    };
    expect(opts.headers['x-amz-security-token']).toBe('sts-session-token');
  });

  test('forwards a session token to Secrets Manager too', async () => {
    process.env['AWS_SESSION_TOKEN'] = 'sts-session-token';
    nextRequest(200, JSON.stringify({ SecretString: '{"a":"1"}' }));

    await resolveSecret('aws-secret:app/creds');

    const opts = (https.request as unknown as jest.Mock).mock.calls[0][0] as {
      headers: Record<string, string>;
    };
    expect(opts.headers['x-amz-security-token']).toBe('sts-session-token');
  });

  test('surfaces malformed SSM JSON', async () => {
    nextRequest(200, 'not json at all');
    await expect(resolveSecret('ssm:/app/db')).rejects.toThrow();
  });

  test('rejects a Secrets Manager field that is absent', async () => {
    nextRequest(200, JSON.stringify({ SecretString: '{"other":"x"}' }));
    await expect(resolveSecret('aws-secret:app/creds#missing'))
      .rejects.toThrow(/field "missing"/);
  });

  test('rejects a secret with no SecretString', async () => {
    nextRequest(200, JSON.stringify({ SecretBinary: 'ignored' }));
    await expect(resolveSecret('aws-secret:app/creds'))
      .rejects.toThrow(/no SecretString/);
  });

  test('serves a repeated SSM lookup from cache', async () => {
    nextRequest(200, JSON.stringify({ Parameter: { Value: 'v' } }));

    await resolveSecret('ssm:/app/db');
    await resolveSecret('ssm:/app/db');

    expect(https.request as unknown as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test('serves a repeated Secrets Manager lookup from cache', async () => {
    nextRequest(200, JSON.stringify({ SecretString: '{"a":"1"}' }));

    await resolveSecret('aws-secret:app/creds#a');
    await resolveSecret('aws-secret:app/creds#a');

    expect(https.request as unknown as jest.Mock).toHaveBeenCalledTimes(1);
  });
});

describe('TLS CA bundle', () => {
  // A private directory rather than a guessable name in the shared temp dir:
  // another user could pre-create that path and have the test read theirs.
  let caDir: string;
  let caPath: string;

  beforeEach(() => {
    process.env['SYMFONY_MCP_VAULT_TOKEN'] = 'test-token';
    process.env['SYMFONY_MCP_VAULT_ADDR'] = 'https://vault.example.com';
    caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-ca-'));
    caPath = path.join(caDir, 'bundle.pem');
  });

  afterEach(() => {
    delete process.env['SYMFONY_MCP_VAULT_CA_BUNDLE'];
    fs.rmSync(caDir, { recursive: true, force: true });
    resetVaultTlsAgent();
  });

  test('loads a CA bundle when one is configured', async () => {
    fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n');
    process.env['SYMFONY_MCP_VAULT_CA_BUNDLE'] = caPath;
    resetVaultTlsAgent();
    nextGet(200, JSON.stringify({ data: { data: { k: 'v' } } }));

    await resolveSecret('vault:secret/data/app#k');

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('CA bundle loaded'));
  });

  test('warns and falls back to system CAs when the bundle is unreadable', async () => {
    process.env['SYMFONY_MCP_VAULT_CA_BUNDLE'] = path.join(caDir, 'no-such-ca.pem');
    resetVaultTlsAgent();
    nextGet(200, JSON.stringify({ data: { data: { k: 'v' } } }));

    await expect(resolveSecret('vault:secret/data/app#k')).resolves.toBe('v');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load CA bundle'));
  });
});

describe('Secrets Manager returning malformed JSON', () => {
  test('the parse error is surfaced rather than swallowed', async () => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAEXAMPLEEXAMPLE00';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'secret-key-material';
    process.env['AWS_REGION'] = 'eu-west-1';
    nextRequest(200, 'this is not json');

    await expect(resolveSecret('aws-secret:app/creds')).rejects.toThrow();
  });
});
