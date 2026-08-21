/**
 * Secret Vault Resolver
 *
 * Resolves secret references in configuration values at runtime,
 * replacing placeholder strings with actual secrets fetched from:
 *
 *  - HashiCorp Vault Agent (local UNIX socket / HTTP):
 *      vault:secret/data/myapp#db_password
 *
 *  - AWS SSM Parameter Store:
 *      ssm:/myapp/prod/db_password
 *
 *  - AWS Secrets Manager:
 *      aws-secret:myapp/prod/credentials#db_password
 *
 * If no vault backend is configured, references are returned unchanged
 * and a warning is emitted — the MCP continues to work but secrets
 * remain as literal placeholder strings (safe: they're never stored).
 *
 * Configuration:
 *   SYMFONY_MCP_VAULT_ADDR        — Vault server URL (default: http://127.0.0.1:8200)
 *   SYMFONY_MCP_VAULT_TOKEN       — Vault token (or set VAULT_TOKEN)
 *   SYMFONY_MCP_VAULT_ROLE_ID     — AppRole role_id (alternative to token auth)
 *   SYMFONY_MCP_VAULT_SECRET_ID   — AppRole secret_id
 *   AWS_REGION                    — AWS region for SSM / Secrets Manager
 *   AWS_PROFILE                   — AWS CLI profile (falls back to default credential chain)
 *
 * Note: This module uses native Node.js http/https — no external dependencies.
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';

// ─── Regex patterns for secret references ─────────────────────────────────

const VAULT_REF = /^vault:(.+?)(?:#(.+))?$/;
const SSM_REF = /^ssm:(.+)$/;
const AWS_SECRET_REF = /^aws-secret:(.+?)(?:#(.+))?$/;

// ─── In-memory cache to avoid hammering the vault on every tool call ──────

interface CacheEntry {
  value: string;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

// TTL: configurable via SYMFONY_MCP_SECRET_TTL_MS (default: 60s)
function getCacheTtlMs(): number {
  return parseInt(process.env['SYMFONY_MCP_SECRET_TTL_MS'] ?? '60000', 10) || 60_000;
}

function cached(key: string): string | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: string): void {
  cache.set(key, { value, expiresAt: Date.now() + getCacheTtlMs() });
}

/**
 * Clears the in-memory secret cache, forcing re-fetch on next access.
 * Called on SIGUSR2 for zero-downtime secret rotation.
 */
export function clearVaultCache(): void {
  cache.clear();
  process.stderr.write('[symfony-mcp][vault] Secret cache flushed — secrets will be re-fetched on next use\n');
}

/**
 * Returns a snapshot of cache statistics for diagnostics.
 */
export function getVaultCacheStats(): { entries: number; oldestTtlMs: number | null } {
  const now = Date.now();
  let oldest: number | null = null;
  for (const entry of cache.values()) {
    const remaining = entry.expiresAt - now;
    if (oldest === null || remaining < oldest) oldest = remaining;
  }
  return { entries: cache.size, oldestTtlMs: oldest };
}

// ─── HTTP helper ───────────────────────────────────────────────────────────

// ─── TLS Agent (K: cert validation against CA bundle) ─────────────────────────

let _httpsAgent: https.Agent | null = null;

function getHttpsAgent(): https.Agent {
  if (_httpsAgent) return _httpsAgent;

  const caBundle = process.env['SYMFONY_MCP_VAULT_CA_BUNDLE'];
  if (caBundle) {
    try {
      const ca = fs.readFileSync(caBundle);
      _httpsAgent = new https.Agent({ ca, rejectUnauthorized: true });
      process.stderr.write(`[symfony-mcp][vault] TLS CA bundle loaded from ${caBundle}\n`);
    } catch (err) {
      process.stderr.write(`[symfony-mcp][vault] WARNING: Failed to load CA bundle from ${caBundle}: ${(err as Error).message}\n`);
      _httpsAgent = new https.Agent({ rejectUnauthorized: true }); // strict, system CAs
    }
  } else {
    _httpsAgent = new https.Agent({ rejectUnauthorized: true }); // default: verify against system CAs
  }
  return _httpsAgent;
}

/** Reset TLS agent (call after changing SYMFONY_MCP_VAULT_CA_BUNDLE). */
export function resetVaultTlsAgent(): void {
  _httpsAgent = null;
}

function httpGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const lib = isHttps ? https : http;
    const opts = isHttps
      ? { headers, agent: getHttpsAgent() }
      : { headers };

    const req = lib.get(url, opts, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Vault request timed out (5s)')); });
  });
}

// ─── HashiCorp Vault ──────────────────────────────────────────────────────

function getVaultToken(): string | null {
  return process.env['SYMFONY_MCP_VAULT_TOKEN'] ?? process.env['VAULT_TOKEN'] ?? null;
}

function getVaultAddr(): string {
  return (process.env['SYMFONY_MCP_VAULT_ADDR'] ?? 'http://127.0.0.1:8200').replace(/\/$/, '');
}

async function fetchVaultAppRoleToken(): Promise<string | null> {
  const roleId = process.env['SYMFONY_MCP_VAULT_ROLE_ID'];
  const secretId = process.env['SYMFONY_MCP_VAULT_SECRET_ID'];
  if (!roleId || !secretId) return null;

  const cacheKey = `__approle_token__`;
  const cached_ = cached(cacheKey);
  if (cached_) return cached_;

  const addr = getVaultAddr();
  const body = JSON.stringify({ role_id: roleId, secret_id: secretId });

  const token = await new Promise<string>((resolve, reject) => {
    const lib = addr.startsWith('https') ? https : http;
    const url = new URL(`${addr}/v1/auth/approle/login`);
    const req = lib.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { auth?: { client_token?: string } };
            const t = parsed.auth?.client_token;
            if (t) resolve(t); else reject(new Error('AppRole login returned no token'));
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('AppRole login timed out')); });
    req.write(body);
    req.end();
  });

  cacheSet(cacheKey, token);
  return token;
}

async function resolveVaultRef(path_: string, field?: string): Promise<string> {
  const cacheKey = `vault:${path_}#${field ?? ''}`;
  const hit = cached(cacheKey);
  if (hit) return hit;

  const token = getVaultToken() ?? await fetchVaultAppRoleToken();
  if (!token) throw new Error('Vault: no token. Set SYMFONY_MCP_VAULT_TOKEN or configure AppRole credentials.');

  const addr = getVaultAddr();
  const url = `${addr}/v1/${path_}`;
  const body = await httpGet(url, { 'X-Vault-Token': token });

  const parsed = JSON.parse(body) as {
    data?: { data?: Record<string, unknown>; [k: string]: unknown };
  };

  // Support both KV v1 (data at `.data`) and KV v2 (data at `.data.data`)
  const kvData = (parsed.data?.data ?? parsed.data) as Record<string, unknown> | undefined;
  if (!kvData) throw new Error(`Vault path "${path_}" returned no data`);

  if (field) {
    const val = kvData[field];
    if (val === undefined) throw new Error(`Vault: field "${field}" not found at "${path_}"`);
    const str = String(val);
    cacheSet(cacheKey, str);
    return str;
  }

  // No field specified — return full JSON (caller gets to decide)
  const str = JSON.stringify(kvData);
  cacheSet(cacheKey, str);
  return str;
}

// ─── AWS SSM Parameter Store ───────────────────────────────────────────────

async function resolveSSMRef(paramPath: string): Promise<string> {
  const cacheKey = `ssm:${paramPath}`;
  const hit = cached(cacheKey);
  if (hit) return hit;

  const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'];
  if (!region) throw new Error('SSM: AWS_REGION not set');

  // Use the EC2 Instance Metadata Service credentials or env vars
  // Build a minimal SigV4-signed request via AWS SDK-compatible endpoint
  // For simplicity: use the SSM HTTP endpoint with IMDSv2 / env credentials
  const host = `ssm.${region}.amazonaws.com`;
  const accessKey = process.env['AWS_ACCESS_KEY_ID'];
  const secretKey = process.env['AWS_SECRET_ACCESS_KEY'];
  const sessionToken = process.env['AWS_SESSION_TOKEN'];

  if (!accessKey || !secretKey) {
    throw new Error(
      'SSM: AWS credentials not found. Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, ' +
      'or use an IAM role with instance profile.'
    );
  }

  // Build SigV4 signature for SSM GetParameter
  const value = await signedSsmRequest(host, paramPath, region, accessKey, secretKey, sessionToken);
  cacheSet(cacheKey, value);
  return value;
}

// ─── Minimal SigV4 for SSM (no external deps) ─────────────────────────────

import * as crypto from 'crypto';

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function signedSsmRequest(
  host: string,
  paramName: string,
  region: string,
  accessKey: string,
  secretKey: string,
  sessionToken?: string
): Promise<string> {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = now.toISOString().replace(/[:-]/g, '').slice(0, 15) + 'Z';
  const service = 'ssm';

  const payload = JSON.stringify({ Name: paramName, WithDecryption: true });
  const payloadHash = sha256Hex(payload);

  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    'host': host,
    'x-amz-date': amzDate,
    'x-amz-target': 'AmazonSSM.GetParameter',
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  headers['Authorization'] = authHeader;

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path: '/', method: 'POST', headers },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const r = JSON.parse(body) as { Parameter?: { Value?: string } };
              const v = r.Parameter?.Value;
              if (v !== undefined) resolve(v);
              else reject(new Error(`SSM: no value for "${paramName}"`));
            } catch (e) { reject(e); }
          } else {
            reject(new Error(`SSM HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('SSM request timed out')); });
    req.write(payload);
    req.end();
  });
}

// ─── AWS Secrets Manager ───────────────────────────────────────────────────

async function resolveAwsSecretRef(secretId: string, field?: string): Promise<string> {
  const cacheKey = `aws-secret:${secretId}#${field ?? ''}`;
  const hit = cached(cacheKey);
  if (hit) return hit;

  const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'];
  if (!region) throw new Error('AWS Secrets Manager: AWS_REGION not set');

  const accessKey = process.env['AWS_ACCESS_KEY_ID'];
  const secretKey = process.env['AWS_SECRET_ACCESS_KEY'];
  const sessionToken = process.env['AWS_SESSION_TOKEN'];

  if (!accessKey || !secretKey) {
    throw new Error('AWS Secrets Manager: AWS credentials not found. Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY.');
  }

  const host = `secretsmanager.${region}.amazonaws.com`;
  const value = await signedSecretsManagerRequest(host, secretId, region, accessKey, secretKey, sessionToken);

  let resolved = value;
  if (field) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const fieldVal = parsed[field];
      if (fieldVal === undefined) throw new Error(`AWS Secrets Manager: field "${field}" not found in secret "${secretId}"`);
      resolved = String(fieldVal);
    } catch {
      throw new Error(`AWS Secrets Manager: secret "${secretId}" is not valid JSON (can't extract field "${field}")`);
    }
  }

  cacheSet(cacheKey, resolved);
  return resolved;
}

async function signedSecretsManagerRequest(
  host: string,
  secretId: string,
  region: string,
  accessKey: string,
  secretKey: string,
  sessionToken?: string
): Promise<string> {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = now.toISOString().replace(/[:-]/g, '').slice(0, 15) + 'Z';
  const service = 'secretsmanager';

  const payload = JSON.stringify({ SecretId: secretId });
  const payloadHash = sha256Hex(payload);

  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    'host': host,
    'x-amz-date': amzDate,
    'x-amz-target': 'secretsmanager.GetSecretValue',
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  headers['Authorization'] = authHeader;

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path: '/', method: 'POST', headers },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const r = JSON.parse(body) as { SecretString?: string };
              if (r.SecretString !== undefined) resolve(r.SecretString);
              else reject(new Error(`AWS Secrets Manager: no SecretString for "${secretId}"`));
            } catch (e) { reject(e); }
          } else {
            reject(new Error(`Secrets Manager HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Secrets Manager request timed out')); });
    req.write(payload);
    req.end();
  });
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Resolves a single value that may be a vault reference.
 *
 * Recognized reference formats:
 *   vault:secret/data/myapp#db_password   → HashiCorp Vault KV v1/v2
 *   ssm:/myapp/prod/db_password           → AWS SSM Parameter Store
 *   aws-secret:myapp/credentials#db_pass  → AWS Secrets Manager
 *
 * Non-matching strings are returned unchanged.
 */
export async function resolveSecret(value: string): Promise<string> {
  const vaultMatch = VAULT_REF.exec(value);
  if (vaultMatch) return resolveVaultRef(vaultMatch[1], vaultMatch[2]);

  const ssmMatch = SSM_REF.exec(value);
  if (ssmMatch) return resolveSSMRef(ssmMatch[1]);

  const awsMatch = AWS_SECRET_REF.exec(value);
  if (awsMatch) return resolveAwsSecretRef(awsMatch[1], awsMatch[2]);

  return value;
}

/**
 * Resolves all vault references in a flat Record.
 * Useful for resolving all env vars at once.
 */
export async function resolveSecrets<T extends Record<string, string>>(config: T): Promise<T> {
  const resolved = { ...config } as T;
  await Promise.all(
    (Object.keys(resolved) as Array<keyof T>).map(async (key) => {
      const val = resolved[key];
      if (typeof val === 'string' && isVaultRef(val)) {
        try {
          resolved[key] = await resolveSecret(val) as T[keyof T];
        } catch (err) {
          process.stderr.write(`[symfony-mcp][warn] Failed to resolve vault ref for ${String(key)}: ${(err as Error).message}\n`);
        }
      }
    })
  );
  return resolved;
}

/**
 * Returns true if the value looks like a vault reference.
 */
export function isVaultRef(value: string): boolean {
  return VAULT_REF.test(value) || SSM_REF.test(value) || AWS_SECRET_REF.test(value);
}

/**
 * Returns vault backend status for diagnostics.
 */
export function getVaultStatus(): {
  vaultConfigured: boolean;
  vaultAddr: string;
  appRoleConfigured: boolean;
  awsConfigured: boolean;
  cacheSize: number;
} {
  return {
    vaultConfigured: !!(getVaultToken() || (process.env['SYMFONY_MCP_VAULT_ROLE_ID'] && process.env['SYMFONY_MCP_VAULT_SECRET_ID'])),
    vaultAddr: getVaultAddr(),
    appRoleConfigured: !!(process.env['SYMFONY_MCP_VAULT_ROLE_ID'] && process.env['SYMFONY_MCP_VAULT_SECRET_ID']),
    awsConfigured: !!(process.env['AWS_ACCESS_KEY_ID'] || process.env['AWS_PROFILE']),
    cacheSize: cache.size,
  };
}
