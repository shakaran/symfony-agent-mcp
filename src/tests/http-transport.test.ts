/**
 * The HTTP transport, exercised over a real socket.
 *
 * This is the only part of the server reachable from the network, and it was
 * the only file with no tests at all. Everything here goes through an actual
 * listener on a real port rather than a mocked request object: the security
 * headers, the IP allowlist, the payload cap and the session-token check are
 * only worth anything if they hold on the wire.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { startHttpTransport, getHttpTransportStatus } from '../transport/http-transport';
import { resetIpRateLimits } from '../utils/http-rate-limiter';

const ENV_KEYS = [
  'SYMFONY_MCP_HTTP_PORT', 'SYMFONY_MCP_HTTP_HOST', 'SYMFONY_MCP_ALLOWED_IPS',
  'SYMFONY_MCP_CORS_ORIGIN', 'SYMFONY_MCP_MAX_PAYLOAD_BYTES', 'SYMFONY_MCP_TLS_CERT',
  'SYMFONY_MCP_TLS_KEY', 'SYMFONY_MCP_TLS_CA', 'SYMFONY_MCP_SESSION_SECRET',
  'SYMFONY_MCP_SESSION_STRICT', 'SYMFONY_MCP_HTTP_RATE_LIMIT',
];

let saved: Record<string, string | undefined>;
let stderrSpy: jest.SpyInstance;

/** An ephemeral port, found by letting the OS pick one and handing it back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: opts.headers ?? {} },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c as string; });
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
        }));
      }
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Start the transport on a free port and return it with a teardown. */
async function start(env: Record<string, string> = {}): Promise<{ port: number; server: net.Server }> {
  const port = await freePort();
  process.env['SYMFONY_MCP_HTTP_PORT'] = String(port);
  process.env['SYMFONY_MCP_HTTP_HOST'] = '127.0.0.1';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  const mcp = new Server({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  const server = await startHttpTransport(mcp);
  if (!server) throw new Error('transport did not start');
  return { port, server };
}

const stop = (server: net.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // The transport rate-limits per IP; every test here comes from 127.0.0.1.
  process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '10000';
  resetIpRateLimits();
  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
  resetIpRateLimits();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('configuration refusing to start', () => {
  test('no port configured means no HTTP transport at all', async () => {
    const mcp = new Server({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
    // stdio is the default; the network listener must stay off unless asked for.
    await expect(startHttpTransport(mcp)).resolves.toBeNull();
  });

  test.each([
    ['not a number', 'abc'],
    ['zero', '0'],
    ['above the 16-bit range', '65536'],
    ['negative', '-1'],
  ])('a port that is %s is refused', async (_label, port) => {
    process.env['SYMFONY_MCP_HTTP_PORT'] = port;
    const mcp = new Server({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });

    await expect(startHttpTransport(mcp)).resolves.toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid SYMFONY_MCP_HTTP_PORT'));
  });

  test('a TLS certificate without its key is refused rather than served plaintext', async () => {
    // Silently falling back to HTTP would be the dangerous reading of this.
    process.env['SYMFONY_MCP_HTTP_PORT'] = String(await freePort());
    process.env['SYMFONY_MCP_TLS_CERT'] = '/tmp/cert.pem';
    const mcp = new Server({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });

    await expect(startHttpTransport(mcp)).resolves.toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('TLS requires both'));
  });

  test('a TLS key without its certificate is refused too', async () => {
    process.env['SYMFONY_MCP_HTTP_PORT'] = String(await freePort());
    process.env['SYMFONY_MCP_TLS_KEY'] = '/tmp/key.pem';
    const mcp = new Server({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });

    await expect(startHttpTransport(mcp)).resolves.toBeNull();
  });

  test('a CA without TLS warns but does not stop the server', async () => {
    const { server } = await start({ SYMFONY_MCP_TLS_CA: '/tmp/ca.pem' });
    try {
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('SYMFONY_MCP_TLS_CA requires TLS'));
    } finally {
      await stop(server);
    }
  });
});

describe('routes', () => {
  let port: number;
  let server: net.Server;

  beforeEach(async () => { ({ port, server } = await start()); });
  afterEach(async () => { await stop(server); });

  test('GET /health reports what is switched on', async () => {
    const res = await request(port, 'GET', '/health');
    const body = JSON.parse(res.body) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body['status']).toBe('ok');
    expect(body['protocol']).toBe('http');
    expect(body['mTls']).toBe(false);
    expect(body['ipWhitelisting']).toBe(false);
    expect(body['maxPayloadBytes']).toBe(1_048_576);
  });

  test('GET /metrics serves Prometheus text, not JSON', async () => {
    const res = await request(port, 'GET', '/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  test('GET /ui serves HTML and relaxes CSP only for inline styles', async () => {
    const res = await request(port, 'GET', '/ui');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // Styles yes, scripts never: the dashboard needs no JavaScript.
    expect(res.headers['content-security-policy']).toContain("style-src 'unsafe-inline'");
    expect(res.headers['content-security-policy']).not.toContain('script-src');
  });

  test('GET /ui/ with the trailing slash is the same page', async () => {
    expect((await request(port, 'GET', '/ui/')).status).toBe(200);
  });

  test('an unknown path 404s and names the routes that do exist', async () => {
    const res = await request(port, 'GET', '/nope');
    const body = JSON.parse(res.body) as { error: string; routes: string[] };

    expect(res.status).toBe(404);
    expect(body.routes).toContain('GET /health');
  });

  test('OPTIONS is answered as a CORS preflight with no body', async () => {
    const res = await request(port, 'OPTIONS', '/message');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('X-MCP-Session-Token');
  });
});

describe('security headers', () => {
  test('every response carries them, including the 404', async () => {
    const { port, server } = await start();
    try {
      for (const path of ['/health', '/nope']) {
        const res = await request(port, 'GET', path);

        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        expect(res.headers['cache-control']).toContain('no-store');
      }
    } finally {
      await stop(server);
    }
  });

  test('HSTS is absent over plaintext, where it would be meaningless', async () => {
    const { port, server } = await start();
    try {
      expect((await request(port, 'GET', '/health')).headers['strict-transport-security'])
        .toBeUndefined();
    } finally {
      await stop(server);
    }
  });

  test('the CORS origin is configurable', async () => {
    const { port, server } = await start({ SYMFONY_MCP_CORS_ORIGIN: 'https://app.example.com' });
    try {
      expect((await request(port, 'GET', '/health')).headers['access-control-allow-origin'])
        .toBe('https://app.example.com');
    } finally {
      await stop(server);
    }
  });
});

describe('IP allowlisting', () => {
  test('a caller outside the allowlist is refused before anything else runs', async () => {
    const { port, server } = await start({ SYMFONY_MCP_ALLOWED_IPS: '10.0.0.1' });
    try {
      const res = await request(port, 'GET', '/health');

      expect(res.status).toBe(403);
      expect(res.body).toContain('IP not allowed');
      // The refusal is still a hardened response.
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await stop(server);
    }
  });

  test('an exact match is allowed through', async () => {
    const { port, server } = await start({ SYMFONY_MCP_ALLOWED_IPS: '127.0.0.1' });
    try {
      expect((await request(port, 'GET', '/health')).status).toBe(200);
    } finally {
      await stop(server);
    }
  });

  test('a CIDR range is matched, not compared as a string', async () => {
    const { port, server } = await start({ SYMFONY_MCP_ALLOWED_IPS: '127.0.0.0/8' });
    try {
      expect((await request(port, 'GET', '/health')).status).toBe(200);
    } finally {
      await stop(server);
    }
  });

  test('a CIDR that excludes the caller still refuses', async () => {
    const { port, server } = await start({ SYMFONY_MCP_ALLOWED_IPS: '10.0.0.0/24' });
    try {
      expect((await request(port, 'GET', '/health')).status).toBe(403);
    } finally {
      await stop(server);
    }
  });

  test('a malformed entry does not accidentally allow everyone', async () => {
    // A CIDR that cannot be parsed must fail closed.
    const { port, server } = await start({ SYMFONY_MCP_ALLOWED_IPS: 'not-an-ip/99' });
    try {
      expect((await request(port, 'GET', '/health')).status).toBe(403);
    } finally {
      await stop(server);
    }
  });

  test('the allowlist reaches /health, which reports it is on', async () => {
    const { port, server } = await start({ SYMFONY_MCP_ALLOWED_IPS: '127.0.0.1' });
    try {
      const body = JSON.parse((await request(port, 'GET', '/health')).body) as Record<string, unknown>;
      expect(body['ipWhitelisting']).toBe(true);
    } finally {
      await stop(server);
    }
  });
});

describe('POST /message', () => {
  let port: number;
  let server: net.Server;

  beforeEach(async () => { ({ port, server } = await start()); });
  afterEach(async () => { await stop(server); });

  test('without a sessionId it is a 400, not a crash', async () => {
    const res = await request(port, 'POST', '/message', { body: '{}' });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('sessionId') });
  });

  test('an unknown sessionId is a 404 naming the session', async () => {
    const res = await request(port, 'POST', '/message?sessionId=does-not-exist', { body: '{}' });

    expect(res.status).toBe(404);
    expect(res.body).toContain('does-not-exist');
  });
});

describe('payload cap', () => {
  test('a body over the limit is rejected with 413 and the limit is stated', async () => {
    const { port, server } = await start({ SYMFONY_MCP_MAX_PAYLOAD_BYTES: '512' });
    try {
      const res = await request(port, 'POST', '/message?sessionId=x', {
        body: 'x'.repeat(4096),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(413);
      expect(res.body).toContain('512');
    } finally {
      await stop(server);
    }
  });

  test('a body under the limit gets past the cap to the session lookup', async () => {
    const { port, server } = await start({ SYMFONY_MCP_MAX_PAYLOAD_BYTES: '4096' });
    try {
      const res = await request(port, 'POST', '/message?sessionId=x', { body: 'x'.repeat(100) });

      // 404 means the cap let it through and the session check ran.
      expect(res.status).toBe(404);
    } finally {
      await stop(server);
    }
  });

  test('an unparseable limit falls back to the 1 MiB default', async () => {
    const { port, server } = await start({ SYMFONY_MCP_MAX_PAYLOAD_BYTES: 'garbage' });
    try {
      const body = JSON.parse((await request(port, 'GET', '/health')).body) as Record<string, unknown>;
      expect(body['maxPayloadBytes']).toBe(1_048_576);
    } finally {
      await stop(server);
    }
  });
});

describe('session tokens on GET /sse', () => {
  test('with authentication configured, a request with no token is refused', async () => {
    const { port, server } = await start({
      SYMFONY_MCP_SESSION_SECRET: 'a'.repeat(64),
      SYMFONY_MCP_SESSION_STRICT: 'true',
    });
    try {
      const res = await request(port, 'GET', '/sse');

      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toHaveProperty('error');
    } finally {
      await stop(server);
    }
  });

  test('a bogus bearer token is refused as well', async () => {
    const { port, server } = await start({
      SYMFONY_MCP_SESSION_SECRET: 'a'.repeat(64),
      SYMFONY_MCP_SESSION_STRICT: 'true',
    });
    try {
      const res = await request(port, 'GET', '/sse', {
        headers: { Authorization: 'Bearer not-a-real-token' },
      });

      expect(res.status).toBe(401);
    } finally {
      await stop(server);
    }
  });

  test('a token in the query string is refused just the same when invalid', async () => {
    const { port, server } = await start({
      SYMFONY_MCP_SESSION_SECRET: 'a'.repeat(64),
      SYMFONY_MCP_SESSION_STRICT: 'true',
    });
    try {
      expect((await request(port, 'GET', '/sse?token=nope')).status).toBe(401);
    } finally {
      await stop(server);
    }
  });
});

describe('getHttpTransportStatus', () => {
  test('reports disabled when no port is configured', () => {
    const status = getHttpTransportStatus();

    expect(status.enabled).toBe(false);
    expect(status.port).toBeNull();
    expect(status.host).toBeNull();
    expect(status.maxPayloadBytes).toBe(1_048_576);
  });

  test('reflects the configuration once it is set', () => {
    process.env['SYMFONY_MCP_HTTP_PORT'] = '9443';
    process.env['SYMFONY_MCP_HTTP_HOST'] = '0.0.0.0';
    process.env['SYMFONY_MCP_ALLOWED_IPS'] = '10.0.0.0/8';
    process.env['SYMFONY_MCP_TLS_CERT'] = '/tmp/c.pem';
    process.env['SYMFONY_MCP_TLS_KEY'] = '/tmp/k.pem';
    process.env['SYMFONY_MCP_TLS_CA'] = '/tmp/ca.pem';

    const status = getHttpTransportStatus();

    expect(status).toMatchObject({
      enabled: true, port: 9443, host: '0.0.0.0',
      tls: true, mtls: true, ipWhitelisting: true,
    });
  });

  test('an invalid port reads as disabled rather than as a number', () => {
    process.env['SYMFONY_MCP_HTTP_PORT'] = '70000';
    expect(getHttpTransportStatus().enabled).toBe(false);
  });
});

describe('per-IP rate limiting', () => {
  test('the second request over the limit is a 429 telling the caller when to retry', async () => {
    const { port, server } = await start({ SYMFONY_MCP_HTTP_RATE_LIMIT: '1' });
    try {
      expect((await request(port, 'GET', '/health')).status).toBe(200);

      const res = await request(port, 'GET', '/health');

      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('60');
      expect(JSON.parse(res.body)).toMatchObject({ retryAfterSeconds: 60 });
      // Refusals stay hardened.
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await stop(server);
    }
  });
});

describe('GET /sse', () => {
  test('an accepted connection opens an event stream and is counted', async () => {
    const { port, server } = await start();
    try {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/sse' }, resolve);
        req.on('error', reject);
        req.end();
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      // The session is tracked while the stream is open.
      expect(getHttpTransportStatus().activeSessions).toBeGreaterThan(0);

      res.destroy();
    } finally {
      await stop(server);
    }
  });
});

describe('TLS', () => {
  let dir: string;
  let certPath: string;
  let keyPath: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tls-'));
    certPath = path.join(dir, 'cert.pem');
    keyPath = path.join(dir, 'key.pem');
    // A throwaway self-signed pair: enough to prove the server negotiates TLS.
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1',
      '-subj', '/CN=localhost',
    ], { stdio: 'ignore' });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a certificate and key bring up HTTPS, and HSTS appears with it', async () => {
    const { port, server } = await start({
      SYMFONY_MCP_TLS_CERT: certPath,
      SYMFONY_MCP_TLS_KEY: keyPath,
    });
    try {
      const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
        (resolve, reject) => {
          // Trust exactly this certificate rather than switching verification
          // off: the connection stays authenticated, and a test that disables
          // validation teaches the pattern we do not want copied.
          const req = https.request(
            {
              host: 'localhost', port, method: 'GET', path: '/health',
              ca: fs.readFileSync(certPath),
            },
            (r) => {
              let body = '';
              r.on('data', (c) => { body += c as string; });
              r.on('end', () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body }));
            }
          );
          req.on('error', reject);
          req.end();
        }
      );

      expect(res.status).toBe(200);
      // HSTS is only meaningful over TLS, and only set there.
      expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
      expect(JSON.parse(res.body)).toMatchObject({ protocol: 'https' });
    } finally {
      await stop(server);
    }
  });

  test('adding a CA switches on mutual TLS, and a client with no certificate is rejected', async () => {
    const { port, server } = await start({
      SYMFONY_MCP_TLS_CERT: certPath,
      SYMFONY_MCP_TLS_KEY: keyPath,
      SYMFONY_MCP_TLS_CA: certPath,
    });
    try {
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('mTLS enabled'));

      // The server sets requestCert with rejectUnauthorized, so a client with
      // no certificate of its own fails the handshake and never gets a reply.
      await expect(new Promise((resolve, reject) => {
        const req = https.request(
          {
            host: 'localhost', port, method: 'GET', path: '/health',
            ca: fs.readFileSync(certPath),
          },
          resolve
        );
        req.on('error', reject);
        req.end();
      })).rejects.toThrow();
    } finally {
      await stop(server);
    }
  });
});

describe('a full client exchange', () => {
  test('a message posted to a live session is accepted, not 404d', async () => {
    const { port, server } = await start();
    try {
      // Open the stream and read the endpoint event, which carries the
      // sessionId the client is supposed to post back to.
      const sse = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/sse' }, resolve);
        req.on('error', reject);
        req.end();
      });

      const sessionId = await new Promise<string>((resolve, reject) => {
        let buffered = '';
        const timer = setTimeout(() => reject(new Error('no endpoint event')), 5000);
        sse.on('data', (chunk: Buffer) => {
          buffered += chunk.toString();
          const match = /sessionId=([0-9a-f-]+)/i.exec(buffered);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
      });

      expect(sessionId).toBeTruthy();

      const res = await request(port, 'POST', `/message?sessionId=${sessionId}`, {
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
        headers: { 'Content-Type': 'application/json' },
      });

      // The transport accepted it; anything but 404 proves the session lookup
      // resolved and handlePostMessage ran.
      expect(res.status).not.toBe(404);
      expect(res.status).toBeLessThan(500);

      sse.destroy();
    } finally {
      await stop(server);
    }
  });
});
