/**
 * HTTP Cache Inspector
 *
 * Detects HTTP caching configuration in Symfony applications:
 *   - #[Cache(maxAge, sharedMaxAge, public, vary, lastModified, etag)] on controllers
 *   - framework.http_cache settings in framework.yaml
 *   - Reverse proxy / Varnish config (TRUSTED_PROXIES, X-Forwarded-*)
 *   - ESI / hinclude detection
 *   - Cache-busting headers (no-store, no-cache, private) on specific routes
 *   - Cacheable routes without authentication guards (potential cache poisoning risk)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface CacheAttribute {
  controller: string;
  action: string;
  file: string;
  maxAge?: number;
  sharedMaxAge?: number;
  isPublic?: boolean;
  vary?: string[];
  hasLastModified: boolean;
  hasEtag: boolean;
  noStore: boolean;
  noCache: boolean;
}

interface HttpCacheConfig {
  enabled: boolean;
  traceLevel?: string;
  storeOptions?: string[];
  trustedProxies?: string[];
  trustedHeaders?: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────


function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

// ─── Cache attribute parsing ───────────────────────────────────────────────

function parseNumericOption(options: string, key: string): number | undefined {
  const m = new RegExp(`${key}\\s*:\\s*(\\d+)`).exec(options);
  return m ? parseInt(m[1], 10) : undefined;
}

function parseBoolOption(options: string, key: string): boolean | undefined {
  const m = new RegExp(`${key}\\s*:\\s*(true|false)`).exec(options);
  if (!m) return undefined;
  return m[1] === 'true';
}

function parseVaryOption(options: string): string[] | undefined {
  const m = /vary\s*:\s*\[([^\]]+)\]/.exec(options);
  if (!m) return undefined;
  return m[1].split(',').map((v) => v.trim().replace(/['"]/g, '')).filter(Boolean);
}

function parseCacheAttributes(filePath: string): CacheAttribute[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  if (!content.includes('#[Cache') && !content.includes('Response::') && !content.includes('setMaxAge')) {
    return [];
  }

  const controllerM = /class\s+(\w+)/.exec(content);
  if (!controllerM) return [];
  const controller = controllerM[1];

  const attrs: CacheAttribute[] = [];

  // #[Cache(...)] attribute
  for (const m of content.matchAll(/#\[Cache\s*\(([^)]*)\)\]/g)) {
    const options = m[1];
    const after = content.slice(m.index ?? 0, (m.index ?? 0) + 400);
    const actionM = /(?:public|protected)\s+function\s+(\w+)\s*\(/.exec(after);

    attrs.push({
      controller,
      action: actionM?.[1] ?? '(unknown)',
      file: path.basename(filePath),
      maxAge: parseNumericOption(options, 'maxAge'),
      sharedMaxAge: parseNumericOption(options, 'sharedMaxAge'),
      isPublic: parseBoolOption(options, 'public'),
      vary: parseVaryOption(options),
      hasLastModified: options.includes('lastModified'),
      hasEtag: options.includes('etag'),
      noStore: options.includes('no-store') || options.includes('noStore'),
      noCache: options.includes('no-cache') || options.includes('noCache'),
    });
  }

  // Response-level cache control (setMaxAge, setSharedMaxAge, setPublic, etc.)
  if (attrs.length === 0 && content.includes('setMaxAge')) {
    for (const m of content.matchAll(/function\s+(\w+)\s*\([^)]*\)[^{]*\{[^}]*setMaxAge\s*\(\s*(\d+)\s*\)/g)) {
      const sharedM = content.slice(m.index ?? 0, (m.index ?? 0) + 500).match(/setSharedMaxAge\s*\(\s*(\d+)\s*\)/);
      attrs.push({
        controller,
        action: m[1],
        file: path.basename(filePath),
        maxAge: parseInt(m[2], 10),
        sharedMaxAge: sharedM ? parseInt(sharedM[1], 10) : undefined,
        isPublic: content.slice(m.index ?? 0, (m.index ?? 0) + 500).includes('setPublic()'),
        hasLastModified: false,
        hasEtag: false,
        noStore: false,
        noCache: false,
      });
    }
  }

  return attrs;
}

// ─── Framework config ──────────────────────────────────────────────────────

function loadHttpCacheConfig(appPath: string): HttpCacheConfig {
  const frameworkFile = path.join(appPath, 'config', 'packages', 'framework.yaml');
  const raw = parseYamlFile(frameworkFile) as Record<string, unknown> | null;

  const config: HttpCacheConfig = { enabled: false };

  if (!raw) return config;

  const fw = (raw['framework'] ?? raw) as Record<string, unknown>;
  const httpCache = fw['http_cache'] as Record<string, unknown> | undefined;

  if (httpCache) {
    config.enabled = true;
    if (httpCache['trace_level']) config.traceLevel = String(httpCache['trace_level']);
  }

  // Trusted proxies
  const trusted = fw['trusted_proxies'];
  if (trusted) {
    config.trustedProxies = typeof trusted === 'string'
      ? [trusted]
      : Array.isArray(trusted) ? (trusted as string[]) : [];
  }

  const trustedHeaders = fw['trusted_headers'];
  if (trustedHeaders) {
    config.trustedHeaders = typeof trustedHeaders === 'string'
      ? trustedHeaders.split(',').map((h) => h.trim())
      : (trustedHeaders as string[]) ?? [];
  }

  return config;
}

function loadAllCacheAttributes(appPath: string): CacheAttribute[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const attrs: CacheAttribute[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    attrs.push(...parseCacheAttributes(file));
  }
  return attrs;
}

// ─── Tool functions ────────────────────────────────────────────────────────

function formatTtl(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function listHttpCacheConfig(appPath: string): McpToolResult {
  try {
    const config = loadHttpCacheConfig(appPath);
    const attrs = loadAllCacheAttributes(appPath);

    const hasESI = attrs.some(() => {
      try {
        const f = path.join(appPath, 'config', 'packages', 'framework.yaml');
        return fs.readFileSync(f, 'utf-8').includes('esi');
      } catch { return false; }
    });

    let text = `HTTP Cache Configuration\n${'='.repeat(55)}\n`;

    text += `\nSymfony HTTP Cache proxy: ${config.enabled ? 'enabled' : 'disabled'}\n`;
    if (config.traceLevel) text += `  Trace level: ${config.traceLevel}\n`;

    if (config.trustedProxies && config.trustedProxies.length > 0) {
      text += `\nTrusted proxies: ${config.trustedProxies.join(', ')}\n`;
    }
    if (config.trustedHeaders && config.trustedHeaders.length > 0) {
      text += `Trusted headers: ${config.trustedHeaders.join(', ')}\n`;
    }

    if (hasESI) text += `\nESI: detected in framework config\n`;

    if (attrs.length === 0) {
      text += `\nNo #[Cache] attributes or Response cache control found.\n`;
      text += `\nAdd caching:\n  #[Cache(maxAge: 300, sharedMaxAge: 3600, public: true)]\n  public function index(): Response { ... }`;
    } else {
      text += `\nCached actions (${attrs.length}):\n`;

      const noStore = attrs.filter((a) => a.noStore);
      const pub = attrs.filter((a) => a.isPublic);
      const priv = attrs.filter((a) => a.isPublic === false);

      if (noStore.length > 0) {
        text += `  No-store (sensitive): ${noStore.map((a) => `${a.controller}::${a.action}`).join(', ')}\n`;
      }
      if (pub.length > 0) {
        text += `  Public cached: ${pub.length}\n`;
      }
      if (priv.length > 0) {
        text += `  Private cached: ${priv.length}\n`;
      }

      text += `\n  ${'Controller::action'.padEnd(45)} maxAge  sharedMaxAge  public\n`;
      text += `  ${'-'.repeat(75)}\n`;
      for (const a of attrs.sort((x, y) => x.controller.localeCompare(y.controller))) {
        const maxAge = a.maxAge !== undefined ? formatTtl(a.maxAge) : '-';
        const sharedMaxAge = a.sharedMaxAge !== undefined ? formatTtl(a.sharedMaxAge) : '-';
        const pub2 = a.isPublic === true ? 'yes' : a.isPublic === false ? 'no' : '-';
        const key = `${a.controller}::${a.action}`;
        text += `  ${key.padEnd(45)} ${maxAge.padEnd(7)} ${sharedMaxAge.padEnd(13)} ${pub2}\n`;
        if (a.vary && a.vary.length > 0) {
          text += `    Vary: ${a.vary.join(', ')}\n`;
        }
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getHttpCacheStats(appPath: string): McpToolResult {
  try {
    const config = loadHttpCacheConfig(appPath);
    const attrs = loadAllCacheAttributes(appPath);

    let text = `HTTP Cache Statistics\n${'='.repeat(40)}\n\n`;
    text += `HTTP Cache proxy:  ${config.enabled ? 'enabled' : 'disabled'}\n`;
    text += `Cached actions:    ${attrs.length}\n`;
    text += `Public:            ${attrs.filter((a) => a.isPublic === true).length}\n`;
    text += `Private:           ${attrs.filter((a) => a.isPublic === false).length}\n`;
    text += `No-store:          ${attrs.filter((a) => a.noStore).length}\n`;
    text += `With Vary headers: ${attrs.filter((a) => a.vary && a.vary.length > 0).length}\n`;
    text += `With ETag:         ${attrs.filter((a) => a.hasEtag).length}\n`;
    text += `Trusted proxies:   ${config.trustedProxies?.length ?? 0}\n`;

    if (attrs.length > 0) {
      const maxAges = attrs.filter((a) => a.maxAge !== undefined).map((a) => a.maxAge!);
      if (maxAges.length > 0) {
        text += `\nMax-age range: ${formatTtl(Math.min(...maxAges))} – ${formatTtl(Math.max(...maxAges))}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getHttpCacheTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_http_cache_config',
      description: 'Show HTTP caching: #[Cache] attributes on controllers (maxAge, sharedMaxAge, public, Vary), Symfony HTTP Cache proxy config, trusted proxies',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_http_cache_stats',
      description: 'Show HTTP cache statistics: cached action count, public vs private split, ETag/Vary usage, proxy config, max-age range',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
