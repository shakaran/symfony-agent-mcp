/**
 * Vercel Deploy Config Inspector
 *
 * Scans vercel.json in the project root for:
 * - routes / rewrites / redirects: lists rules, flags missing auth on admin routes
 * - functions: per-function timeout and memory settings; flags missing explicit timeout
 * - headers: checks for X-Content-Type-Options and X-Frame-Options on wildcard sources
 * - env / build.env: flags hardcoded values instead of @variable-name references
 * - framework: notes detected framework
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface VercelDeployConfigInfo {
  section: string;
  key: string;
  value: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecrets(value: string): string {
  return value.replace(/([A-Za-z_][A-Za-z0-9_]*\s*=\s*)[^\s$#'"]{4,}/g, '$1***');
}

function isWildcardSource(source: string): boolean {
  return source === '/(.*)'
    || source === '**'
    || source === '/(.*)'
    || source.startsWith('(');
}

function checkSecurityHeaders(headers: Record<string, string>): string[] {
  const issues: string[] = [];
  const keys = Object.keys(headers).map((k) => k.toLowerCase());
  if (!keys.includes('x-content-type-options')) {
    issues.push('Missing X-Content-Type-Options security header — add "X-Content-Type-Options: nosniff"');
  }
  if (!keys.includes('x-frame-options')) {
    issues.push('Missing X-Frame-Options security header — add "X-Frame-Options: SAMEORIGIN" to prevent clickjacking');
  }
  return issues;
}

function parseEnvBlock(
  envObj: Record<string, unknown>,
  section: string,
  results: VercelDeployConfigInfo[],
): void {
  for (const [key, val] of Object.entries(envObj)) {
    const strVal = String(val ?? '');
    const masked = maskSecrets(strVal);
    // Values that start with @ are proper Vercel env references
    if (strVal && !strVal.startsWith('@')) {
      results.push({
        section,
        key,
        value: masked,
        issue: `Hardcoded env value for "${key}" — use Vercel environment variable reference "@${key.toLowerCase()}" instead of embedding the value directly`,
      });
    } else {
      results.push({ section, key, value: masked, issue: null });
    }
  }
}

function buildVercelDeployConfigInfos(appPath: string): VercelDeployConfigInfo[] {
  const vercelJsonPath = path.join(appPath, 'vercel.json');
  const raw = safeRead(vercelJsonPath, appPath);
  if (raw === null) return [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [{ section: 'parse', key: 'vercel.json', value: '', issue: 'vercel.json is not valid JSON — cannot parse' }];
  }

  const results: VercelDeployConfigInfo[] = [];

  // framework
  if (typeof parsed['framework'] === 'string') {
    results.push({ section: 'framework', key: 'framework', value: parsed['framework'], issue: null });
  }

  // routes
  if (Array.isArray(parsed['routes'])) {
    const routes = parsed['routes'] as Array<Record<string, unknown>>;
    for (const route of routes) {
      const src = String(route['src'] ?? route['source'] ?? '');
      const dest = String(route['dest'] ?? route['destination'] ?? '');
      let issue: string | null = null;
      if (/\/admin/.test(src) && !route['headers'] && !route['has']) {
        issue = `Admin route "${src}" has no auth check (no "has" condition or auth header) — verify access is protected`;
      }
      results.push({ section: 'routes', key: src || dest, value: dest, issue });
    }
  }

  // rewrites
  if (Array.isArray(parsed['rewrites'])) {
    const rewrites = parsed['rewrites'] as Array<Record<string, unknown>>;
    for (const rewrite of rewrites) {
      const src = String(rewrite['source'] ?? '');
      const dest = String(rewrite['destination'] ?? '');
      let issue: string | null = null;
      if (/\/admin/.test(src)) {
        issue = `Admin rewrite "${src}" — ensure downstream route enforces authentication`;
      }
      results.push({ section: 'rewrites', key: src, value: dest, issue });
    }
  }

  // redirects
  if (Array.isArray(parsed['redirects'])) {
    const redirects = parsed['redirects'] as Array<Record<string, unknown>>;
    for (const redirect of redirects) {
      const src = String(redirect['source'] ?? '');
      const dest = String(redirect['destination'] ?? '');
      results.push({ section: 'redirects', key: src, value: dest, issue: null });
    }
  }

  // functions
  if (parsed['functions'] && typeof parsed['functions'] === 'object' && !Array.isArray(parsed['functions'])) {
    const fns = parsed['functions'] as Record<string, Record<string, unknown>>;
    for (const [fnPattern, config] of Object.entries(fns)) {
      const timeout = config['maxDuration'] ?? config['timeout'];
      const memory = config['memory'];
      const runtime = String(config['runtime'] ?? '');

      if (timeout === undefined || timeout === null) {
        results.push({
          section: 'functions',
          key: fnPattern,
          value: 'no timeout set (default 10s)',
          issue: `Function "${fnPattern}" has no explicit maxDuration — default is 10s; set maxDuration to document intent`,
        });
      } else {
        const timeoutNum = Number(timeout);
        let issue: string | null = null;
        if (timeoutNum > 300) {
          issue = `Function "${fnPattern}" timeout ${timeoutNum}s exceeds Vercel maximum of 300s for Pro plan`;
        } else if (timeoutNum > 60) {
          issue = `Function "${fnPattern}" timeout ${timeoutNum}s exceeds 60s — only available on Pro/Enterprise plans; Hobby plan limit is 60s and may incur unexpected cost`;
        }
        results.push({ section: 'functions', key: `${fnPattern}.maxDuration`, value: String(timeoutNum), issue });
      }

      if (memory !== undefined && memory !== null) {
        results.push({ section: 'functions', key: `${fnPattern}.memory`, value: String(memory), issue: null });
      }

      if (runtime && /^php/.test(runtime)) {
        const hasPinned = /php@[\d.]{3,}/.test(runtime);
        results.push({
          section: 'functions',
          key: `${fnPattern}.runtime`,
          value: runtime,
          issue: hasPinned ? null : `PHP runtime "${runtime}" has no version pin — pin to a specific version e.g. "php@8.2" to avoid unexpected upgrades`,
        });
      }
    }
  }

  // headers
  let hasWildcardHeaders = false;
  if (Array.isArray(parsed['headers'])) {
    const headerBlocks = parsed['headers'] as Array<Record<string, unknown>>;
    for (const block of headerBlocks) {
      const source = String(block['source'] ?? '');
      const headersList = block['headers'];
      if (isWildcardSource(source) && Array.isArray(headersList)) {
        hasWildcardHeaders = true;
        const SENSITIVE_HEADER_KEYS = /^(authorization|x-api-key|x-auth-token|cookie|proxy-authorization|x-secret|x-token|set-cookie)$/i;
        const headerMap: Record<string, string> = {};
        for (const h of headersList as Array<Record<string, string>>) {
          headerMap[h['key']] = h['value'];
        }
        const safeHeaderMap: Record<string, string> = {};
        for (const [k, v] of Object.entries(headerMap)) {
          safeHeaderMap[k] = SENSITIVE_HEADER_KEYS.test(k) ? '***' : v;
        }
        const missing = checkSecurityHeaders(headerMap);
        for (const issue of missing) {
          results.push({ section: 'headers', key: source, value: JSON.stringify(safeHeaderMap).slice(0, 120), issue });
        }
        if (missing.length === 0) {
          results.push({ section: 'headers', key: source, value: 'security headers present', issue: null });
        }
      } else {
        results.push({ section: 'headers', key: source, value: '(non-wildcard block)', issue: null });
      }
    }
    if (!hasWildcardHeaders) {
      results.push({
        section: 'headers',
        key: 'global',
        value: 'no wildcard header block',
        issue: 'No wildcard headers block (source: "/(.*)" or "**") — security headers like X-Content-Type-Options and X-Frame-Options are not applied globally',
      });
    }
  } else {
    results.push({
      section: 'headers',
      key: 'global',
      value: 'headers not configured',
      issue: 'No "headers" field in vercel.json — add a headers block to set X-Content-Type-Options and X-Frame-Options globally',
    });
  }

  // env
  if (parsed['env'] && typeof parsed['env'] === 'object' && !Array.isArray(parsed['env'])) {
    parseEnvBlock(parsed['env'] as Record<string, unknown>, 'env', results);
  }

  // build.env
  if (parsed['build'] && typeof parsed['build'] === 'object') {
    const build = parsed['build'] as Record<string, unknown>;
    if (build['env'] && typeof build['env'] === 'object' && !Array.isArray(build['env'])) {
      parseEnvBlock(build['env'] as Record<string, unknown>, 'build.env', results);
    }
  }

  return results;
}

export function listVercelDeployConfig(appPath: string): McpToolResult {
  try {
    const vercelJsonPath = path.join(appPath, 'vercel.json');
    if (!fs.existsSync(vercelJsonPath)) {
      return { content: [{ type: 'text', text: 'vercel.json not found in project root. This tool requires vercel.json to be present.' }] };
    }

    const infos = buildVercelDeployConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'vercel.json found but contained no analysable sections.' }] };
    }

    const issues = infos.filter((i) => i.issue !== null);

    let text = `Vercel Deploy Config Analysis\n${'='.repeat(55)}\n\n`;
    text += `Entries found: ${infos.length}  |  Issues: ${issues.length}\n\n`;

    const sections = [...new Set(infos.map((i) => i.section))];
    for (const section of sections) {
      const sectionInfos = infos.filter((i) => i.section === section);
      text += `[${section.toUpperCase()}]\n`;
      for (const info of sectionInfos) {
        text += `  ${info.key}: ${info.value}\n`;
        if (info.issue) {
          text += `    ISSUE: ${info.issue}\n`;
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getVercelDeployConfigStats(appPath: string): McpToolResult {
  try {
    const vercelJsonPath = path.join(appPath, 'vercel.json');
    if (!fs.existsSync(vercelJsonPath)) {
      return { content: [{ type: 'text', text: 'vercel.json not found in project root.' }] };
    }

    const infos = buildVercelDeployConfigInfos(appPath);
    const issues = infos.filter((i) => i.issue !== null);
    const hardcoded = infos.filter((i) => i.issue && i.issue.includes('Hardcoded env value'));
    const missingHeaders = infos.filter((i) => i.issue && i.issue.includes('Missing') && i.issue.includes('header'));
    const functionIssues = infos.filter((i) => i.section === 'functions' && i.issue !== null);
    const phpRuntime = infos.filter((i) => i.section === 'functions' && i.key.includes('.runtime') && i.value.includes('php'));

    let text = `Vercel Deploy Config Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total entries analysed:    ${infos.length}\n`;
    text += `Total issues found:        ${issues.length}\n`;
    text += `  Hardcoded env values:    ${hardcoded.length}\n`;
    text += `  Missing security headers:${missingHeaders.length}\n`;
    text += `  Function config issues:  ${functionIssues.length}\n`;
    text += `  PHP runtime entries:     ${phpRuntime.length}\n`;

    const framework = infos.find((i) => i.section === 'framework');
    if (framework) {
      text += `\nDetected framework: ${framework.value}\n`;
    }

    if (issues.length > 0) {
      text += `\nTop issues:\n`;
      for (const issue of issues.slice(0, 5)) {
        text += `  [${issue.section}] ${issue.key}: ${issue.issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getVercelDeployConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the project containing vercel.json' } };
  return [
    {
      name: 'list_vercel_deploy_config',
      description: 'Parse vercel.json and list all routes/rewrites/redirects/functions/headers/env settings with issue flags: hardcoded secrets in env, missing security headers, function timeout warnings, PHP runtime without version pin, admin routes without auth',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_vercel_deploy_config_stats',
      description: 'Show Vercel deploy config statistics: total entries, issue counts by category (hardcoded env values, missing security headers, function config issues, PHP runtime entries), detected framework',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
