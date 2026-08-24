// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CloudflareConfigInfo {
  file: string;
  type: 'worker' | 'pages' | 'wrangler';
  setting: string;
  issues: string[];
}

function safeReadFile(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

const SECRET_KEY_PATTERN = /password|secret|token|api_key|private|credential|access_key|\bpass\b|\bkey\b|\bcert\b|\bdsn\b|\bauth\b/i;

// Two-year threshold: current year minus 2
const COMPAT_DATE_THRESHOLD = new Date();
COMPAT_DATE_THRESHOLD.setFullYear(COMPAT_DATE_THRESHOLD.getFullYear() - 2);
const COMPAT_DATE_THRESHOLD_STR = COMPAT_DATE_THRESHOLD.toISOString().slice(0, 10);

function parseWranglerToml(content: string, relPath: string): CloudflareConfigInfo[] {
  const results: CloudflareConfigInfo[] = [];

  // name
  const nameMatch = content.match(/^name\s*=\s*["']?([^"'\n]{1,100})["']?/m);
  if (nameMatch) {
    results.push({ file: relPath, type: 'wrangler', setting: `name: ${nameMatch[1].trim()}`, issues: [] });
  }

  // main entry point
  const mainMatch = content.match(/^main\s*=\s*["']?([^"'\n]{1,200})["']?/m);
  if (mainMatch) {
    results.push({ file: relPath, type: 'wrangler', setting: `main: ${mainMatch[1].trim()}`, issues: [] });
  }

  // compatibility_date
  const compatDateMatch = content.match(/^compatibility_date\s*=\s*["']?(\d{4}-\d{2}-\d{2})["']?/m);
  if (compatDateMatch) {
    const compatDate = compatDateMatch[1];
    const info: CloudflareConfigInfo = { file: relPath, type: 'wrangler', setting: `compatibility_date: ${compatDate}`, issues: [] };
    if (compatDate < COMPAT_DATE_THRESHOLD_STR) {
      info.issues.push(`compatibility_date "${compatDate}" is more than 2 years old — update to a recent date to get the latest Cloudflare Workers behaviour flags`);
    }
    results.push(info);
  } else {
    results.push({
      file: relPath,
      type: 'wrangler',
      setting: 'compatibility_date',
      issues: ['No compatibility_date set in wrangler.toml — add compatibility_date = "YYYY-MM-DD" to opt into stable Workers behaviour'],
    });
  }

  // routes
  const hasRoutes = /^\[\[routes\]\]|^routes\s*=/m.test(content);
  if (!hasRoutes) {
    results.push({
      file: relPath,
      type: 'wrangler',
      setting: 'routes',
      issues: ['No routes configured — add [[routes]] with pattern and zone_name to deploy the worker to specific URLs'],
    });
  } else {
    const routePatternMatch = content.match(/pattern\s*=\s*["']([^"']{1,200})["']/);
    results.push({
      file: relPath,
      type: 'wrangler',
      setting: `routes: ${routePatternMatch ? routePatternMatch[1] : 'configured'}`,
      issues: [],
    });
  }

  // [vars] — flag secrets
  const varsMatch = content.match(/^\[vars\][^[]{0,2000}/ms);
  if (varsMatch) {
    const varsBlock = varsMatch[0];
    const lines = varsBlock.split('\n').slice(1);
    for (const line of lines) {
      if (line.startsWith('[')) break;
      const kvMatch = line.match(/^\s*([A-Za-z0-9_]{1,80})\s*=\s*["']([^"']{0,200})["']/);
      if (!kvMatch) continue;
      const [, varKey, varVal] = kvMatch;
      if (SECRET_KEY_PATTERN.test(varKey)) {
        results.push({
          file: relPath,
          type: 'wrangler',
          setting: `vars.${varKey}`,
          issues: [`Secret-like var "${varKey}" in [vars] — use "wrangler secret put ${varKey}" to store secrets securely instead`],
        });
      } else {
        results.push({ file: relPath, type: 'wrangler', setting: `vars.${varKey}: ${varVal.slice(0, 30)}`, issues: [] });
      }
    }
  }

  // [[kv_namespaces]]
  const kvMatches = content.match(/^\[\[kv_namespaces\]\][^[]{0,500}/gms) ?? [];
  for (const kvBlock of kvMatches) {
    const bindingMatch = kvBlock.match(/binding\s*=\s*["']([^"']{1,80})["']/);
    results.push({
      file: relPath,
      type: 'wrangler',
      setting: `kv_namespace: ${bindingMatch ? bindingMatch[1] : 'unknown'}`,
      issues: [],
    });
  }

  // Detect type: pages vs worker
  if (/^pages_build_output_dir\s*=/m.test(content)) {
    results.push({ file: relPath, type: 'pages', setting: 'pages project', issues: [] });
  } else {
    results.push({ file: relPath, type: 'worker', setting: 'worker project', issues: [] });
  }

  return results;
}

function parseWranglerJson(content: string, relPath: string): CloudflareConfigInfo[] {
  const results: CloudflareConfigInfo[] = [];
  let json: Record<string, unknown>;
  try { json = JSON.parse(content) as Record<string, unknown>; } catch {
    return [{ file: relPath, type: 'wrangler', setting: 'parse-error', issues: ['wrangler.json is not valid JSON'] }];
  }

  const name = json['name'] as string | undefined;
  if (name) results.push({ file: relPath, type: 'wrangler', setting: `name: ${name}`, issues: [] });

  const compatDate = json['compatibility_date'] as string | undefined;
  if (compatDate) {
    const info: CloudflareConfigInfo = { file: relPath, type: 'wrangler', setting: `compatibility_date: ${compatDate}`, issues: [] };
    if (compatDate < COMPAT_DATE_THRESHOLD_STR) {
      info.issues.push(`compatibility_date "${compatDate}" is more than 2 years old — update to a recent date`);
    }
    results.push(info);
  }

  const vars = json['vars'] as Record<string, unknown> | undefined;
  if (vars) {
    for (const [key] of Object.entries(vars)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        results.push({
          file: relPath,
          type: 'wrangler',
          setting: `vars.${key}`,
          issues: [`Secret-like var "${key}" in wrangler.json vars — use wrangler secrets instead`],
        });
      }
    }
  }

  return results;
}

function buildCloudflareConfigInfos(appPath: string): CloudflareConfigInfo[] {
  const results: CloudflareConfigInfo[] = [];
  const candidates: Array<[string, 'toml' | 'json' | 'dotenv']> = [
    ['wrangler.toml', 'toml'],
    ['wrangler.json', 'json'],
    ['.dev.vars', 'dotenv'],
  ];

  for (const [rel, fmt] of candidates) {
    const fullPath = path.join(appPath, rel);
    const content = safeReadFile(fullPath, appPath);
    if (content === null) continue;

    if (fmt === 'toml') {
      results.push(...parseWranglerToml(content, rel));
    } else if (fmt === 'json') {
      results.push(...parseWranglerJson(content, rel));
    } else {
      // .dev.vars — flag secrets present in dev file
      const lines = content.split('\n');
      for (const line of lines) {
        const kvMatch = line.match(/^([A-Za-z0-9_]{1,80})\s*=\s*(.{0,200})/);
        if (!kvMatch) continue;
        const [, key] = kvMatch;
        if (SECRET_KEY_PATTERN.test(key)) {
          results.push({
            file: rel,
            type: 'wrangler',
            setting: `dev.vars.${key}`,
            issues: [`Secret-like key "${key}" found in .dev.vars — ensure this file is in .gitignore and never committed`],
          });
        }
      }
    }
  }

  return results;
}

export function listCloudflareConfig(appPath: string): McpToolResult {
  try {
    const infos = buildCloudflareConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Cloudflare configuration files found (wrangler.toml, wrangler.json, .dev.vars).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Cloudflare Configuration Analysis\n${'='.repeat(55)}\n\nSettings: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.setting}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCloudflareConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildCloudflareConfigInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Cloudflare Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Settings analyzed:       ${infos.length}\n`;
    text += `Worker entries:          ${infos.filter((i) => i.type === 'worker').length}\n`;
    text += `Pages entries:           ${infos.filter((i) => i.type === 'pages').length}\n`;
    text += `Compat date issues:      ${infos.filter((i) => i.issues.some((x) => x.includes('compatibility_date'))).length}\n`;
    text += `Secret in vars issues:   ${infos.filter((i) => i.issues.some((x) => x.includes('secret') || x.includes('Secret'))).length}\n`;
    text += `Route issues:            ${infos.filter((i) => i.setting === 'routes' && i.issues.length > 0).length}\n`;
    text += `Total issues:            ${totalIssues}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCloudflareConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_cloudflare_config',
      description: 'Analyse Cloudflare wrangler.toml, wrangler.json, and .dev.vars for outdated compatibility_date, secrets in [vars] instead of wrangler secrets, missing routes, and KV namespace bindings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_cloudflare_config_stats',
      description: 'Statistics for Cloudflare configuration: settings count, worker/pages entry counts, compatibility_date/secret/route issues, and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
