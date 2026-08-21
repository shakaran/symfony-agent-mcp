/**
 * Optional HTTP/SSE Transport
 *
 * Provides an alternative to stdio transport for cases where the MCP client
 * communicates over HTTP. Uses Server-Sent Events (SSE) for server→client
 * messages and HTTP POST for client→server messages.
 *
 * Security features:
 *  - Security response headers (HSTS, CSP, X-Content-Type-Options, etc.)
 *  - TLS (HTTPS) via SYMFONY_MCP_TLS_CERT + SYMFONY_MCP_TLS_KEY
 *  - Mutual TLS (mTLS) via SYMFONY_MCP_TLS_CA (requires client certificate)
 *  - IP whitelisting via SYMFONY_MCP_ALLOWED_IPS (comma-separated, CIDR ok)
 *  - Session token validation on SSE handshake
 *  - Request body size cap (SYMFONY_MCP_MAX_PAYLOAD_BYTES)
 *  - CORS header support
 *
 * Endpoints:
 *   GET  /sse           — Establish SSE stream (requires session token if configured)
 *   POST /message       — Receive client→server MCP messages
 *   GET  /health        — Liveness check (JSON)
 *   GET  /metrics       — Prometheus metrics (plain text)
 *
 * Activation: set SYMFONY_MCP_HTTP_PORT to a port number.
 *
 * Configuration:
 *   SYMFONY_MCP_HTTP_PORT          — Port to listen on (required to activate HTTP mode)
 *   SYMFONY_MCP_HTTP_HOST          — Bind address (default: 127.0.0.1)
 *   SYMFONY_MCP_TLS_CERT           — Path to PEM server certificate (enables HTTPS)
 *   SYMFONY_MCP_TLS_KEY            — Path to PEM private key
 *   SYMFONY_MCP_TLS_CA             — Path to CA bundle for mTLS client verification
 *   SYMFONY_MCP_ALLOWED_IPS        — Comma-separated IP/CIDR allowlist
 *   SYMFONY_MCP_CORS_ORIGIN        — Allowed CORS origin (default: *)
 *   SYMFONY_MCP_MAX_PAYLOAD_BYTES  — Max POST body size in bytes (default: 1048576 = 1 MB)
 *   SYMFONY_MCP_STDIO=false        — Disable stdio when running HTTP-only
 */

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as net from 'net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { verifySessionToken } from '../utils/session-token.js';
import { renderPrometheus, incHttpRequest, incSseSession } from '../utils/security-metrics.js';
import { checkIpRateLimit, normalizeClientIp } from '../utils/http-rate-limiter.js';

// ─── Configuration ─────────────────────────────────────────────────────────

export interface HttpTransportConfig {
  port: number;
  host: string;
  tlsCert?: string;
  tlsKey?: string;
  tlsCa?: string;
  allowedIps: string[];
  corsOrigin: string;
  maxPayloadBytes: number;
}

function loadConfig(): HttpTransportConfig | null {
  const portStr = process.env['SYMFONY_MCP_HTTP_PORT'];
  if (!portStr) return null;

  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    process.stderr.write(`[symfony-mcp][error] Invalid SYMFONY_MCP_HTTP_PORT="${portStr}". Must be 1–65535.\n`);
    return null;
  }

  const tlsCert = process.env['SYMFONY_MCP_TLS_CERT'];
  const tlsKey = process.env['SYMFONY_MCP_TLS_KEY'];
  const tlsCa = process.env['SYMFONY_MCP_TLS_CA'];

  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    process.stderr.write('[symfony-mcp][error] TLS requires both SYMFONY_MCP_TLS_CERT and SYMFONY_MCP_TLS_KEY.\n');
    return null;
  }

  if (tlsCa && !tlsCert) {
    process.stderr.write('[symfony-mcp][warn] SYMFONY_MCP_TLS_CA requires TLS to be enabled (set SYMFONY_MCP_TLS_CERT + KEY).\n');
  }

  const allowedIps = (process.env['SYMFONY_MCP_ALLOWED_IPS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const maxPayloadBytes = parseInt(process.env['SYMFONY_MCP_MAX_PAYLOAD_BYTES'] ?? '1048576', 10) || 1_048_576;

  return {
    port,
    host: process.env['SYMFONY_MCP_HTTP_HOST'] ?? '127.0.0.1',
    tlsCert,
    tlsKey,
    tlsCa,
    allowedIps,
    corsOrigin: process.env['SYMFONY_MCP_CORS_ORIGIN'] ?? '*',
    maxPayloadBytes,
  };
}

// ─── Security headers ──────────────────────────────────────────────────────

function setSecurityHeaders(res: http.ServerResponse, isTls: boolean): void {
  // Prevent MIME-type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Prevent embedding in frames
  res.setHeader('X-Frame-Options', 'DENY');
  // Strict Content Security Policy — MCP transport doesn't serve any scripts
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  // No referrer leakage
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Don't cache any MCP responses
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (isTls) {
    // HSTS — 1 year, including subdomains
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function setCorsHeaders(res: http.ServerResponse, corsOrigin: string): void {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MCP-Session-Token, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ─── IP whitelisting ───────────────────────────────────────────────────────

function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7); // IPv4-mapped IPv6
  return ip;
}

function isIpAllowed(remoteAddress: string | undefined, allowedIps: string[]): boolean {
  if (allowedIps.length === 0) return true;
  if (!remoteAddress) return false;
  const normalized = normalizeIp(remoteAddress);
  return allowedIps.some((allowed) =>
    allowed.includes('/') ? ipMatchesCidr(normalized, allowed) : normalized === normalizeIp(allowed)
  );
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  try {
    const [range, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    const ipNum = ipToNum(ip);
    const rangeNum = ipToNum(range);
    if (ipNum === null || rangeNum === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
  } catch {
    return false;
  }
}

function ipToNum(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// ─── Session token extraction ──────────────────────────────────────────────

function extractSessionToken(req: http.IncomingMessage): string | undefined {
  const headerToken = req.headers['x-mcp-session-token'];
  if (typeof headerToken === 'string') return headerToken;

  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) return authHeader.slice(7);

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  return url.searchParams.get('token') ?? undefined;
}

// ─── Request body reader with size cap ─────────────────────────────────────

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds limit of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── Server creation ───────────────────────────────────────────────────────

function createNodeServer(
  config: HttpTransportConfig,
  requestHandler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
): http.Server | https.Server {
  if (config.tlsCert && config.tlsKey) {
    const cert = fs.readFileSync(config.tlsCert);
    const key = fs.readFileSync(config.tlsKey);

    const tlsOptions: https.ServerOptions = { cert, key };

    if (config.tlsCa) {
      // Mutual TLS: require and verify client certificates
      tlsOptions.ca = fs.readFileSync(config.tlsCa);
      tlsOptions.requestCert = true;
      tlsOptions.rejectUnauthorized = true;
      process.stderr.write('[symfony-mcp][http] mTLS enabled — clients must present a valid certificate\n');
    }

    return https.createServer(tlsOptions, requestHandler);
  }
  return http.createServer(requestHandler);
}

// ─── Transport session management ──────────────────────────────────────────

interface TransportSession {
  transport: SSEServerTransport;
  connectedAt: number;
}

const activeSessions = new Map<string, TransportSession>();

// ─── Main entry point ──────────────────────────────────────────────────────

// ─── Web UI renderer ────────────────────────────────────────────────────────

function renderWebUi(
  protocol: string,
  host: string,
  port: number,
  activeSessions: number,
  isTls: boolean
): string {
  const baseUrl = `${protocol}://${host}:${port}`;
  const now = new Date().toUTCString();

  const toolGroups: Array<{ group: string; tools: string[] }> = [
    { group: 'Routes', tools: ['list_routes', 'get_route_details', 'search_routes', 'list_http_methods'] },
    { group: 'Services', tools: ['list_services', 'get_service_details', 'search_services', 'list_services_by_tag', 'list_available_tags'] },
    { group: 'Configuration', tools: ['get_app_environment', 'list_environment_variables', 'get_database_config', 'get_services_config', 'get_framework_config', 'get_security_config', 'list_config_packages'] },
    { group: 'Logs', tools: ['list_logs', 'tail_log', 'search_log', 'get_error_summary', 'get_environment_logs'] },
    { group: 'Entities', tools: ['list_entities', 'get_entity_details', 'search_entities', 'get_related_entities', 'get_entities_stats'] },
    { group: 'Database', tools: ['list_tables', 'get_table_schema', 'get_database_info', 'search_tables', 'validate_schema_mapping', 'get_migration_status'] },
    { group: 'Controllers', tools: ['list_controllers', 'get_controller_actions', 'search_controllers'] },
    { group: 'Composer', tools: ['get_composer_info', 'get_installed_packages', 'get_symfony_version'] },
    { group: 'Messenger', tools: ['get_messenger_info', 'list_messenger_transports', 'list_messenger_routing', 'list_message_classes'] },
    { group: 'Forms', tools: ['list_form_types', 'get_form_type_details', 'search_form_types', 'get_form_stats'] },
    { group: 'Profiler', tools: ['list_profiler_requests', 'get_profiler_details', 'get_profiler_queries', 'get_profiler_stats'] },
    { group: 'Cache', tools: ['inspect_symfony_cache', 'get_cache_config', 'inspect_mcp_cache', 'clear_mcp_cache'] },
    { group: 'Doctrine Metadata', tools: ['get_doctrine_metadata', 'list_doctrine_mappings'] },
  ];

  const toolGroupHtml = toolGroups.map(({ group, tools }) => `
      <div class="group">
        <h3>${group}</h3>
        <ul>
          ${tools.map((t) => `<li><code>${t}</code></li>`).join('\n          ')}
        </ul>
      </div>`).join('\n');

  const totalTools = toolGroups.reduce((sum, g) => sum + g.tools.length, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>symfony-agent-mcp — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    header { background: #1e293b; border-bottom: 1px solid #334155; padding: 1.25rem 2rem; display: flex; align-items: center; gap: 1rem; }
    header h1 { font-size: 1.25rem; color: #38bdf8; font-weight: 700; }
    header .badge { background: #0ea5e9; color: #fff; font-size: 0.7rem; padding: 0.2rem 0.5rem; border-radius: 9999px; font-weight: 600; }
    .status-bar { background: #1e293b; border-bottom: 1px solid #1e3a5f; padding: 0.6rem 2rem; display: flex; gap: 2rem; font-size: 0.8rem; color: #94a3b8; }
    .status-bar strong { color: #38bdf8; }
    main { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat-card { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1.25rem; text-align: center; }
    .stat-card .value { font-size: 2rem; font-weight: 700; color: #38bdf8; }
    .stat-card .label { font-size: 0.75rem; color: #64748b; margin-top: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
    h2 { font-size: 1.1rem; color: #94a3b8; margin-bottom: 1rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
    .group { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1.25rem; }
    .group h3 { font-size: 0.9rem; font-weight: 700; color: #7dd3fc; margin-bottom: 0.75rem; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; }
    .group ul { list-style: none; display: flex; flex-direction: column; gap: 0.3rem; }
    .group li code { font-size: 0.78rem; color: #94a3b8; background: #0f172a; padding: 0.2rem 0.4rem; border-radius: 0.25rem; font-family: 'SFMono-Regular', Consolas, monospace; }
    .endpoints { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1.25rem; margin-bottom: 2rem; }
    .endpoint { display: flex; align-items: center; gap: 0.75rem; padding: 0.4rem 0; border-bottom: 1px solid #0f172a; }
    .endpoint:last-child { border-bottom: none; }
    .method { font-size: 0.7rem; font-weight: 700; padding: 0.15rem 0.4rem; border-radius: 0.25rem; }
    .get { background: #064e3b; color: #34d399; }
    .post { background: #1e3a5f; color: #60a5fa; }
    .endpoint a { color: #7dd3fc; text-decoration: none; font-family: monospace; font-size: 0.85rem; }
    .endpoint a:hover { text-decoration: underline; }
    .endpoint .desc { color: #64748b; font-size: 0.78rem; }
    footer { text-align: center; padding: 2rem; color: #334155; font-size: 0.75rem; }
    .tls-badge { color: #4ade80; font-size: 0.72rem; }
    .no-tls-badge { color: #f87171; font-size: 0.72rem; }
  </style>
</head>
<body>
  <header>
    <h1>symfony-agent-mcp</h1>
    <span class="badge">v1.3.0</span>
    <span class="${isTls ? 'tls-badge' : 'no-tls-badge'}">${isTls ? '🔒 HTTPS' : '⚠ HTTP'}</span>
  </header>
  <div class="status-bar">
    <span>Server: <strong>${baseUrl}</strong></span>
    <span>Active SSE sessions: <strong>${activeSessions}</strong></span>
    <span>Generated: <strong>${now}</strong></span>
  </div>
  <main>
    <div class="stats">
      <div class="stat-card"><div class="value">${totalTools}</div><div class="label">Tools</div></div>
      <div class="stat-card"><div class="value">${toolGroups.length}</div><div class="label">Categories</div></div>
      <div class="stat-card"><div class="value">${activeSessions}</div><div class="label">SSE Sessions</div></div>
      <div class="stat-card"><div class="value">${isTls ? 'TLS' : 'HTTP'}</div><div class="label">Transport</div></div>
    </div>

    <h2>API Endpoints</h2>
    <div class="endpoints" style="margin-bottom:2rem">
      <div class="endpoint"><span class="method get">GET</span><a href="/health">/health</a><span class="desc">Liveness check</span></div>
      <div class="endpoint"><span class="method get">GET</span><a href="/metrics">/metrics</a><span class="desc">Prometheus metrics</span></div>
      <div class="endpoint"><span class="method get">GET</span><a href="/sse">/sse</a><span class="desc">SSE stream (requires session token)</span></div>
      <div class="endpoint"><span class="method post">POST</span><span style="font-family:monospace;font-size:.85rem;color:#7dd3fc">/message?sessionId=&lt;id&gt;</span><span class="desc">MCP JSON-RPC messages</span></div>
      <div class="endpoint"><span class="method get">GET</span><a href="/ui">/ui</a><span class="desc">This dashboard</span></div>
    </div>

    <h2>Available Tools (${totalTools})</h2>
    <div class="grid">
      ${toolGroupHtml}
    </div>
  </main>
  <footer>symfony-agent-mcp — Model Context Protocol server for Symfony applications (read-only)</footer>
</body>
</html>`;
}

/**
 * Starts the HTTP/SSE transport server if SYMFONY_MCP_HTTP_PORT is set.
 * Returns null if HTTP mode is not configured.
 */
export async function startHttpTransport(mcpServer: Server): Promise<net.Server | null> {
  const config = loadConfig();
  if (!config) return null;

  const isTls = !!(config.tlsCert);
  const protocol = isTls ? 'https' : 'http';

  const nodeServer = createNodeServer(config, async (req, res) => {
    const remoteIp = req.socket?.remoteAddress;
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `${protocol}://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // ── IP whitelisting ─────────────────────────────────────────────────
    if (!isIpAllowed(remoteIp, config.allowedIps)) {
      process.stderr.write(`[symfony-mcp][http] Rejected ${remoteIp ?? 'unknown'} (not in allowlist) → ${method} ${pathname}\n`);
      setSecurityHeaders(res, isTls);
      incHttpRequest(pathname, method, '403');
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden: IP not allowed');
      return;
    }

    // ── Per-IP rate limiting (R) ────────────────────────────────────────
    if (remoteIp && !checkIpRateLimit(remoteIp)) {
      process.stderr.write(`[symfony-mcp][http] IP rate limit exceeded for ${normalizeClientIp(remoteIp)} → ${method} ${pathname}\n`);
      setSecurityHeaders(res, isTls);
      incHttpRequest(pathname, method, '429');
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({
        error: 'Too many requests from this IP. Try again in 60 seconds.',
        retryAfterSeconds: 60,
      }));
      return;
    }

    setSecurityHeaders(res, isTls);

    // ── CORS preflight ──────────────────────────────────────────────────
    if (method === 'OPTIONS') {
      setCorsHeaders(res, config.corsOrigin);
      incHttpRequest(pathname, method, '204');
      res.writeHead(204);
      res.end();
      return;
    }

    setCorsHeaders(res, config.corsOrigin);

    // ── GET /sse — establish SSE stream ─────────────────────────────────
    if (method === 'GET' && pathname === '/sse') {
      const tokenResult = verifySessionToken(extractSessionToken(req));
      if (!tokenResult.valid) {
        incHttpRequest(pathname, method, '401');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: tokenResult.reason }));
        return;
      }

      const transport = new SSEServerTransport('/message', res);
      activeSessions.set(transport.sessionId, { transport, connectedAt: Date.now() });
      incSseSession('open');
      incHttpRequest(pathname, method, '200');

      transport.onclose = (): void => {
        activeSessions.delete(transport.sessionId);
        incSseSession('close');
        process.stderr.write(`[symfony-mcp][http] SSE closed: ${transport.sessionId}\n`);
      };

      transport.onerror = (err: Error): void => {
        process.stderr.write(`[symfony-mcp][http] SSE error (${transport.sessionId}): ${err.message}\n`);
      };

      await mcpServer.connect(transport);
      process.stderr.write(`[symfony-mcp][http] SSE connected: ${transport.sessionId} from ${remoteIp}\n`);
      return;
    }

    // ── POST /message — receive client→server messages ──────────────────
    if (method === 'POST' && pathname === '/message') {
      // Enforce body size cap before handing to transport
      try {
        await readBody(req, config.maxPayloadBytes);
      } catch {
        incHttpRequest(pathname, method, '413');
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Payload too large. Max: ${config.maxPayloadBytes} bytes` }));
        return;
      }

      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        incHttpRequest(pathname, method, '400');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing sessionId query parameter' }));
        return;
      }

      const session = activeSessions.get(sessionId);
      if (!session) {
        incHttpRequest(pathname, method, '404');
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Session "${sessionId}" not found or expired` }));
        return;
      }

      incHttpRequest(pathname, method, '200');
      await session.transport.handlePostMessage(req, res);
      return;
    }

    // ── GET /health — liveness check ────────────────────────────────────
    if (method === 'GET' && pathname === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        transport: 'http-sse',
        protocol,
        mTls: !!(config.tlsCa),
        activeSessions: activeSessions.size,
        ipWhitelisting: config.allowedIps.length > 0,
        maxPayloadBytes: config.maxPayloadBytes,
      });
      incHttpRequest(pathname, method, '200');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    // ── GET /metrics — Prometheus metrics ───────────────────────────────
    if (method === 'GET' && pathname === '/metrics') {
      const body = renderPrometheus();
      incHttpRequest(pathname, method, '200');
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(body);
      return;
    }

    // ── GET /ui — HTML dashboard ─────────────────────────────────────────
    if (method === 'GET' && (pathname === '/ui' || pathname === '/ui/')) {
      const uiHtml = renderWebUi(protocol, config.host, config.port, activeSessions.size, isTls);
      incHttpRequest(pathname, method, '200');
      // Relaxed CSP for the UI: allow inline styles (no scripts needed)
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(uiHtml);
      return;
    }

    // ── 404 for everything else ──────────────────────────────────────────
    incHttpRequest(pathname, method, '404');
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Not found',
      routes: ['GET /sse', 'POST /message', 'GET /health', 'GET /metrics', 'GET /ui'],
    }));
  });

  await new Promise<void>((resolve, reject) => {
    nodeServer.listen(config.port, config.host, () => resolve());
    nodeServer.once('error', reject);
  });

  const securityNotes: string[] = [];
  if (!isTls) securityNotes.push('TLS disabled');
  if (isTls && !config.tlsCa) securityNotes.push('mTLS disabled');
  if (config.allowedIps.length === 0) securityNotes.push('IP whitelisting disabled');

  process.stderr.write(
    `[symfony-mcp][http] Listening on ${protocol}://${config.host}:${config.port}\n` +
    (securityNotes.length
      ? `[symfony-mcp][http] Security warnings: ${securityNotes.join('; ')}\n`
      : `[symfony-mcp][http] TLS=${isTls} mTLS=${!!(config.tlsCa)} IP-allowlist=${config.allowedIps.length > 0}\n`)
  );

  return nodeServer;
}

/**
 * Returns HTTP transport status for diagnostics.
 */
export function getHttpTransportStatus(): {
  enabled: boolean;
  port: number | null;
  host: string | null;
  tls: boolean;
  mtls: boolean;
  ipWhitelisting: boolean;
  maxPayloadBytes: number;
  activeSessions: number;
} {
  const config = loadConfig();
  return {
    enabled: config !== null,
    port: config?.port ?? null,
    host: config?.host ?? null,
    tls: !!(config?.tlsCert),
    mtls: !!(config?.tlsCa),
    ipWhitelisting: (config?.allowedIps.length ?? 0) > 0,
    maxPayloadBytes: config?.maxPayloadBytes ?? 1_048_576,
    activeSessions: activeSessions.size,
  };
}
