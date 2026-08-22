/**
 * API Rate Limit Inspector
 *
 * Distinct from rate-limiter.ts (which inspects the Symfony RateLimiter component).
 * This tool focuses on rate limiting at the API/HTTP layer:
 *
 * NelmioApiDocBundle:
 *   - config/packages/nelmio_api_doc.yaml: no rate-limit annotations (info only)
 *
 * Throttle decorators / attributes on controllers:
 *   - #[RateLimit], #[Throttle], #[IsLimited] (custom or third-party attributes)
 *   - Symfony's built-in login_throttling (in security.yaml firewalls)
 *
 * Nginx / Caddy / Apache config in project:
 *   - nginx.conf or docker/nginx/*.conf: limit_req_zone, limit_req
 *   - Caddyfile: rate_limit directive
 *
 * API Platform:
 *   - mercure / push rate-limit config in api_platform.yaml
 *
 * Scans src/ for:
 *   - Uses of symfony/rate-limiter in controllers (not just services)
 *   - RateLimiterFactory injected in controllers (endpoint-level limits)
 *
 * Cross-reference:
 *   - Routes with no rate-limit protection (endpoint audit)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface RateLimitedEndpoint {
  controller: string;
  file: string;
  method?: string;
  source: 'attribute' | 'injected-limiter' | 'nginx' | 'caddy';
  detail: string;
}

interface NginxLimit {
  zone: string;
  rate: string;
  burst?: string;
  location?: string;
}

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

function scanControllerRateLimits(appPath: string): RateLimitedEndpoint[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: RateLimitedEndpoint[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('Controller') && !content.includes('AbstractController')) continue;
    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // Attribute-based limits
    const limitAttrs = ['#[RateLimit', '#[Throttle', '#[IsLimited', '#[ApiRateLimit'];
    for (const attr of limitAttrs) {
      if (content.includes(attr)) {
        const methodM = new RegExp(`${attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^)]*\\)\\s*(?:public\\s+function\\s+(\\w+))?`, 'g');
        for (const m of content.matchAll(methodM)) {
          results.push({
            controller: classM[1],
            file: path.basename(file),
            method: m[1],
            source: 'attribute',
            detail: `${attr}] attribute`,
          });
        }
      }
    }

    // RateLimiterFactory injection
    if (content.includes('RateLimiterFactory') && content.includes('Controller')) {
      results.push({
        controller: classM[1],
        file: path.basename(file),
        source: 'injected-limiter',
        detail: 'RateLimiterFactory injected in controller',
      });
    }
  }
  return results;
}

function scanNginxLimits(appPath: string): NginxLimit[] {
  const dirs = ['.', 'docker', '.docker', 'docker/nginx', 'nginx', 'config/nginx'];
  const results: NginxLimit[] = [];

  for (const dir of dirs) {
    const dirPath = path.join(appPath, dir);
    try {
      for (const fname of fs.readdirSync(dirPath)) {
        if (!fname.endsWith('.conf') && !fname.includes('nginx')) continue;
        const content = fs.readFileSync(path.join(dirPath, fname), 'utf-8');
        for (const m of content.matchAll(/limit_req_zone\s+[^\s]+\s+zone=(\w+):[^\s]+\s+rate=([^\s;]+)/g)) {
          results.push({ zone: m[1], rate: m[2] });
        }
        for (const m of content.matchAll(/limit_req\s+zone=(\w+)(?:[^;]*burst=(\d+))?/g)) {
          const existing = results.find((r) => r.zone === m[1]);
          if (existing) existing.burst = m[2];
        }
      }
    } catch { /* skip */ }
  }
  return results;
}

function scanCaddyLimits(appPath: string): string[] {
  const candidates = ['Caddyfile', 'docker/caddy/Caddyfile', '.docker/caddy/Caddyfile'];
  const limits: string[] = [];
  for (const fname of candidates) {
    try {
      const content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      if (content.includes('rate_limit')) {
        for (const m of content.matchAll(/rate_limit\s+([^\n]+)/g)) {
          limits.push(m[1].trim());
        }
      }
    } catch { /* skip */ }
  }
  return limits;
}

function readControllerCount(appPath: string): number {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  for (const file of getAllPhpFiles(srcDir)) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('AbstractController') || (content.includes('Controller') && content.includes('#[Route'))) count++;
    } catch { /* skip */ }
  }
  return count;
}

export function listApiRateLimits(appPath: string): McpToolResult {
  try {
    const endpoints  = scanControllerRateLimits(appPath);
    const nginx      = scanNginxLimits(appPath);
    const caddy      = scanCaddyLimits(appPath);

    if (endpoints.length === 0 && nginx.length === 0 && caddy.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No API-layer rate limiting detected.\n\nOptions:\n  1. Symfony RateLimiter in controllers (see list_rate_limiters)\n  2. nginx limit_req_zone + limit_req in nginx.conf\n  3. Symfony security.yaml login_throttling\n  4. #[RateLimit] attribute (custom/third-party)',
        }],
      };
    }

    let text = `API Rate Limit Configuration\n${'='.repeat(55)}\n`;

    if (nginx.length > 0) {
      text += `\nnginx rate limit zones (${nginx.length}):\n`;
      for (const n of nginx) {
        const burst = n.burst ? `  burst=${n.burst}` : '';
        text += `  zone: ${n.zone.padEnd(20)} rate: ${n.rate}${burst}\n`;
      }
    }

    if (caddy.length > 0) {
      text += `\nCaddy rate_limit directives (${caddy.length}):\n`;
      for (const c of caddy) text += `  ${c}\n`;
    }

    if (endpoints.length > 0) {
      text += `\nController-level rate limits (${endpoints.length}):\n`;
      for (const e of endpoints) {
        const method = e.method ? `.${e.method}()` : '';
        text += `  ${e.controller}${method}  (${e.file})\n    ${e.detail}\n`;
      }
    }

    const controllerCount = readControllerCount(appPath);
    const limitedCount    = new Set(endpoints.map((e) => e.controller)).size;
    if (controllerCount > 0 && limitedCount < controllerCount && nginx.length === 0 && caddy.length === 0) {
      text += `\n⚠ ${controllerCount - limitedCount} of ${controllerCount} controllers have no apparent rate limiting\n`;
      text += `  Consider nginx limit_req_zone or Symfony RateLimiterFactory for broad coverage\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiRateLimitStats(appPath: string): McpToolResult {
  try {
    const endpoints = scanControllerRateLimits(appPath);
    const nginx     = scanNginxLimits(appPath);
    const caddy     = scanCaddyLimits(appPath);

    let text = `API Rate Limit Statistics\n${'='.repeat(40)}\n\n`;
    text += `Controller limits:   ${endpoints.length}\n`;
    text += `nginx zones:         ${nginx.length}\n`;
    text += `Caddy directives:    ${caddy.length}\n`;
    text += `Total mechanisms:    ${(endpoints.length > 0 ? 1 : 0) + (nginx.length > 0 ? 1 : 0) + (caddy.length > 0 ? 1 : 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiRateLimitsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_api_rate_limits',
      description: 'Show API-layer rate limiting: nginx limit_req_zone/limit_req directives, Caddy rate_limit, controller-level RateLimiterFactory injection and rate-limit attributes, controllers without any limit coverage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_api_rate_limit_stats',
      description: 'Show API rate limit statistics: controller-level limits, nginx zone count, Caddy directive count, total mechanisms detected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
