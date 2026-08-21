import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface NetlifyDeployConfigInfo {
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

// Minimal TOML-like parser: extract section blocks and key=value pairs
interface TomlSection {
  header: string;
  lines: string[];
}

function splitTomlSections(content: string): TomlSection[] {
  const sections: TomlSection[] = [];
  let current: TomlSection = { header: '__root__', lines: [] };
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line === '') continue;
    // Section header: [section] or [[section]]
    const headerMatch = /^\[+([^\]]{1,120})\]+/.exec(line);
    if (headerMatch) {
      sections.push(current);
      current = { header: headerMatch[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function extractKv(line: string): { key: string; value: string } | null {
  const eqIdx = line.indexOf('=');
  if (eqIdx < 1) return null;
  const key = line.slice(0, eqIdx).trim();
  const rawVal = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
  return { key, value: rawVal };
}

const SENSITIVE_HEADER_RE = /^(authorization|x-api-key|x-auth-token|cookie|proxy-authorization|x-secret|x-token|set-cookie)$/i;

function looksLikeSecret(key: string, value: string): boolean {
  const secretKeywords = ['secret', 'password', 'token', 'key', 'api_key', 'apikey', 'credential', 'auth', 'private', 'pass', 'cert', 'dsn'];
  const lk = key.toLowerCase();
  if (!secretKeywords.some((kw) => lk.includes(kw))) return false;
  // Not a reference like $VAR, $(VAR), ${VAR}, %env(VAR)%
  if (/^\$[{(]?[A-Z_]/.test(value) || /^%env\(/.test(value)) return false;
  // Value has enough length to be a real secret
  return value.length >= 8;
}

function buildNetlifyDeployConfigInfos(appPath: string): NetlifyDeployConfigInfo[] {
  const results: NetlifyDeployConfigInfo[] = [];

  const tomlPath = path.join(appPath, 'netlify.toml');
  const tomlContent = safeRead(tomlPath, appPath);

  if (!tomlContent) {
    results.push({
      section: 'file',
      key: 'netlify.toml',
      value: 'not found',
      issue: 'netlify.toml not found in project root — create netlify.toml to configure build commands, redirects, headers, and environment-specific settings',
    });
    return results;
  }

  const sections = splitTomlSections(tomlContent);

  // Track what we found for cross-section checks
  let hasHeaders = false;
  let hasXFrameOptions = false;
  let hasXContentTypeOptions = false;
  let hasCSP = false;
  let hasPermissionsPolicy = false;
  let hasSpaFallback = false;
  let hasRedirects = false;
  let hasFunctions = false;
  let functionsNodeBundler = '';
  let hasNodeVersion = false;

  for (const section of sections) {
    const sectionName = section.header;

    // [build] section
    if (sectionName === 'build') {
      for (const line of section.lines) {
        const kv = extractKv(line);
        if (!kv) continue;
        if (kv.key === 'command') {
          results.push({ section: '[build]', key: 'command', value: kv.value, issue: null });
        } else if (kv.key === 'publish') {
          results.push({ section: '[build]', key: 'publish', value: kv.value, issue: null });
        }
      }
    }

    // [build.environment] section
    if (sectionName === 'build.environment') {
      for (const line of section.lines) {
        const kv = extractKv(line);
        if (!kv) continue;
        const masked = maskSecrets(`${kv.key}=${kv.value}`);
        const issue = looksLikeSecret(kv.key, kv.value)
          ? `Possible secret "${kv.key}" hardcoded in [build.environment] — use Netlify UI environment variables (Site settings > Environment variables) instead of committing secrets to netlify.toml`
          : null;
        results.push({ section: '[build.environment]', key: kv.key, value: masked, issue });
      }
    }

    // [[redirects]] section
    if (sectionName === 'redirects') {
      hasRedirects = true;
      let from = '';
      let to = '';
      let status = '';
      let force = '';
      for (const line of section.lines) {
        const kv = extractKv(line);
        if (!kv) continue;
        if (kv.key === 'from') from = kv.value;
        if (kv.key === 'to') to = kv.value;
        if (kv.key === 'status') status = kv.value;
        if (kv.key === 'force') force = kv.value;
      }

      // SPA fallback detection: /* -> /index.html with 200
      if (from === '/*' && (to === '/index.html' || to.endsWith('index.html')) && status === '200') {
        hasSpaFallback = true;
        results.push({ section: '[[redirects]]', key: 'spa_fallback', value: `${from} -> ${to} (${status})`, issue: null });
      } else if (from && to) {
        const isSecurity = /login|auth|api|admin/.test(from) || /login|auth|api|admin/.test(to);
        const issue = (isSecurity && force === 'false')
          ? `Redirect from "${from}" to "${to}" has force=false — security-critical paths (login/api/admin) should use force=true to prevent bypass via direct route access`
          : null;
        results.push({ section: '[[redirects]]', key: `${from} -> ${to}`, value: `status=${status || 'default'} force=${force || 'default'}`, issue });
      }
    }

    // [[headers]] section
    if (sectionName === 'headers') {
      hasHeaders = true;
      let headerPath = '';
      let inValues = false;
      for (const line of section.lines) {
        if (/^for\s*=/.test(line)) {
          const kv = extractKv(line);
          if (kv) headerPath = kv.value;
          continue;
        }
        // Detect when we're inside [values] subsection (TOML inline)
        if (line === '[headers.values]' || line.includes('values')) {
          inValues = true;
          continue;
        }
        if (inValues || headerPath) {
          const kv = extractKv(line);
          if (!kv) continue;
          const hKey = kv.key.toLowerCase().replace(/['"]/g, '');
          if (hKey === 'x-frame-options') hasXFrameOptions = true;
          if (hKey === 'x-content-type-options') hasXContentTypeOptions = true;
          if (hKey === 'content-security-policy') hasCSP = true;
          if (hKey === 'permissions-policy') hasPermissionsPolicy = true;
          const headerValue = SENSITIVE_HEADER_RE.test(hKey) ? '***' : kv.value.slice(0, 120);
          results.push({ section: '[[headers]]', key: kv.key, value: headerValue, issue: null });
        }
      }
      // Also scan raw line for header names
      for (const line of section.lines) {
        const lowerLine = line.toLowerCase();
        if (lowerLine.includes('x-frame-options')) hasXFrameOptions = true;
        if (lowerLine.includes('x-content-type-options')) hasXContentTypeOptions = true;
        if (lowerLine.includes('content-security-policy')) hasCSP = true;
        if (lowerLine.includes('permissions-policy')) hasPermissionsPolicy = true;
        if (lowerLine.includes('/*')) headerPath = '/*';
      }
      if (headerPath) {
        results.push({ section: '[[headers]]', key: 'path', value: headerPath, issue: null });
      }
    }

    // [functions] section
    if (sectionName === 'functions') {
      hasFunctions = true;
      for (const line of section.lines) {
        const kv = extractKv(line);
        if (!kv) continue;
        if (kv.key === 'directory') {
          results.push({ section: '[functions]', key: 'directory', value: kv.value, issue: null });
        }
        if (kv.key === 'node_bundler') {
          functionsNodeBundler = kv.value;
          results.push({ section: '[functions]', key: 'node_bundler', value: kv.value, issue: null });
        }
      }
    }

    // [dev] section
    if (sectionName === 'dev') {
      for (const line of section.lines) {
        const kv = extractKv(line);
        if (!kv) continue;
        results.push({ section: '[dev]', key: kv.key, value: kv.value, issue: null });
      }
    }

    // [context.production] and [context.deploy-preview] sections
    if (sectionName === 'context.production' || sectionName === 'context.deploy-preview') {
      for (const line of section.lines) {
        const kv = extractKv(line);
        if (!kv) continue;
        const masked = maskSecrets(`${kv.key}=${kv.value}`);
        const issue = looksLikeSecret(kv.key, kv.value)
          ? `Possible secret "${kv.key}" hardcoded in [${sectionName}] — move to Netlify UI environment variables`
          : null;
        results.push({ section: `[${sectionName}]`, key: kv.key, value: masked, issue });
      }
    }

    // Detect NODE_VERSION anywhere for functions check
    for (const line of section.lines) {
      if (/NODE_VERSION|NODE_VER/.test(line)) hasNodeVersion = true;
    }
  }

  // Cross-section issue checks

  // Missing [[headers]] entirely
  if (!hasHeaders) {
    results.push({
      section: '[[headers]]',
      key: 'missing',
      value: 'no [[headers]] section',
      issue: 'No [[headers]] section in netlify.toml — add security headers for /* path: X-Frame-Options, X-Content-Type-Options, Content-Security-Policy, and Permissions-Policy',
    });
  } else {
    // Individual missing headers (only flag if headers section exists but headers are absent)
    if (!hasXFrameOptions) {
      results.push({
        section: '[[headers]]',
        key: 'X-Frame-Options',
        value: 'missing',
        issue: 'X-Frame-Options header not set — add "X-Frame-Options: DENY" or "SAMEORIGIN" to prevent clickjacking attacks',
      });
    }
    if (!hasXContentTypeOptions) {
      results.push({
        section: '[[headers]]',
        key: 'X-Content-Type-Options',
        value: 'missing',
        issue: 'X-Content-Type-Options header not set — add "X-Content-Type-Options: nosniff" to prevent MIME-type sniffing attacks',
      });
    }
    if (!hasCSP) {
      results.push({
        section: '[[headers]]',
        key: 'Content-Security-Policy',
        value: 'missing',
        issue: 'Content-Security-Policy header not set — define a CSP policy to restrict resource loading and mitigate XSS attacks',
      });
    }
    if (!hasPermissionsPolicy) {
      results.push({
        section: '[[headers]]',
        key: 'Permissions-Policy',
        value: 'missing',
        issue: 'Permissions-Policy header not set — add Permissions-Policy to restrict browser feature access (camera, microphone, geolocation)',
      });
    }
  }

  // SPA context: if redirects exist but no SPA fallback
  if (hasRedirects && !hasSpaFallback) {
    results.push({
      section: '[[redirects]]',
      key: 'spa_fallback',
      value: 'missing',
      issue: 'No SPA fallback redirect (/* -> /index.html with status=200) detected — if this is a single-page application, add a catch-all redirect to prevent 404 on deep links',
    });
  }

  // Functions with esbuild but no Node version
  if (hasFunctions && functionsNodeBundler === 'esbuild' && !hasNodeVersion) {
    results.push({
      section: '[functions]',
      key: 'node_bundler + NODE_VERSION',
      value: 'esbuild without explicit NODE_VERSION',
      issue: 'node_bundler=esbuild in [functions] without NODE_VERSION set — specify NODE_VERSION in [build.environment] for reproducible builds; Netlify default Node version may change',
    });
  }

  return results;
}

export function listNetlifyDeployConfig(appPath: string): McpToolResult {
  try {
    const infos = buildNetlifyDeployConfigInfos(appPath);
    const totalIssues = infos.filter((i) => i.issue !== null).length;
    let text = `Netlify Deploy Config Analysis\n${'='.repeat(55)}\n\nFindings: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.section}]  ${info.key}: ${info.value}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNetlifyDeployConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildNetlifyDeployConfigInfos(appPath);
    const sectionCounts: Record<string, number> = {};
    for (const info of infos) {
      const sec = info.section;
      sectionCounts[sec] = (sectionCounts[sec] ?? 0) + 1;
    }
    let text = `Netlify Deploy Config Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings: ${infos.length}\n`;
    text += `Total issues:   ${infos.filter((i) => i.issue !== null).length}\n\n`;
    text += `Findings by section:\n`;
    for (const [sec, count] of Object.entries(sectionCounts)) {
      text += `  ${sec.padEnd(30)} ${count}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNetlifyDeployConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_netlify_deploy_config',
      description: 'Analyze netlify.toml: parse [build] command/publish, [build.environment] secrets (masked), [[redirects]] from/to/status/force (SPA fallback detection, security path force=false), [[headers]] security headers (X-Frame-Options, X-Content-Type-Options, CSP, Permissions-Policy), [functions] directory/node_bundler, [dev], [context.production/deploy-preview]. Flags: missing security headers, hardcoded secrets, no SPA fallback, esbuild without NODE_VERSION',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_netlify_deploy_config_stats',
      description: 'Statistics for netlify.toml analysis: total findings and issues, breakdown by TOML section',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
