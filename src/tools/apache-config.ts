// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ApacheConfigInfo {
  file: string;
  type: 'rewrite' | 'security-header' | 'disclosure' | 'directory' | 'performance';
  pattern: string;
  issues: string[];
}

function scanApacheFile(filePath: string, relPath: string, appPath: string): ApacheConfigInfo[] {
  const content = safeRead(filePath, appPath);
  if (content === null) return [];

  const results: ApacheConfigInfo[] = [];

  // RewriteEngine check
  if (/RewriteEngine\s+On/i.test(content)) {
    const info: ApacheConfigInfo = { file: relPath, type: 'rewrite', pattern: 'RewriteEngine On', issues: [] };
    if (!/RewriteRule\s+\^\s+index\.php/i.test(content)) {
      info.issues.push('Apache .htaccess without front controller rewrite rule — Symfony requires RewriteRule ^ index.php [QSA,L] to route all requests through front controller');
    }
    results.push(info);
  }

  // Options +Indexes
  if (/Options\s+\+Indexes/i.test(content)) {
    results.push({
      file: relPath,
      type: 'directory',
      pattern: 'Options +Indexes',
      issues: ['Options +Indexes in Apache config — enables directory listing; use Options -Indexes to prevent exposing file list'],
    });
  }

  // Security headers
  if (!/X-Content-Type-Options/i.test(content)) {
    results.push({
      file: relPath,
      type: 'security-header',
      pattern: 'Missing X-Content-Type-Options',
      issues: ['Apache config without X-Content-Type-Options header — add: Header set X-Content-Type-Options nosniff'],
    });
  }

  if (!/X-Frame-Options/i.test(content)) {
    results.push({
      file: relPath,
      type: 'security-header',
      pattern: 'Missing X-Frame-Options',
      issues: ['Apache config without X-Frame-Options header — add: Header set X-Frame-Options SAMEORIGIN to prevent clickjacking'],
    });
  }

  // Server disclosure
  if (/ServerSignature\s+On|ServerTokens\s+Full/i.test(content)) {
    results.push({
      file: relPath,
      type: 'disclosure',
      pattern: 'ServerSignature On / ServerTokens Full',
      issues: ['Server version disclosure in Apache config — set ServerSignature Off and ServerTokens Prod to hide version info'],
    });
  }

  // AllowOverride None
  if (/AllowOverride\s+None/i.test(content)) {
    results.push({
      file: relPath,
      type: 'performance',
      pattern: 'AllowOverride None',
      issues: ["AllowOverride None in main config prevents .htaccess — ensure Symfony's .htaccess rules are in the VirtualHost DirectoryIndex instead for better performance"],
    });
  }

  // Performance: caching headers (no issues)
  if (/ExpiresActive\s+On|CacheControl/i.test(content)) {
    results.push({
      file: relPath,
      type: 'performance',
      pattern: 'ExpiresActive / CacheControl configured',
      issues: [],
    });
  }

  return results;
}

function buildApacheConfigInfos(appPath: string): ApacheConfigInfo[] {
  const results: ApacheConfigInfo[] = [];

  // Check .htaccess in public/
  const htaccessPath = path.join(appPath, 'public', '.htaccess');
  if (fs.existsSync(htaccessPath)) {
    results.push(...scanApacheFile(htaccessPath, 'public/.htaccess', appPath));
  }

  // Scan apache config directories
  const configDirs = ['config', 'apache', 'docker', '.'];
  for (const dir of configDirs) {
    const dirPath = path.join(appPath, dir);
    if (!fs.existsSync(dirPath)) continue;
    try {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.conf') && entry.name !== '.htaccess') continue;
        const fullPath = path.join(dirPath, entry.name);
        const relPath = path.relative(appPath, fullPath);
        results.push(...scanApacheFile(fullPath, relPath, appPath));
      }
    } catch { /* skip */ }
  }

  return results;
}

export function listApacheConfig(appPath: string): McpToolResult {
  try {
    const infos = buildApacheConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Apache configuration files found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Apache Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApacheConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildApacheConfigInfos(appPath);
    let text = `Apache Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Rewrite:        ${infos.filter((i) => i.type === 'rewrite').length}\n`;
    text += `Security-header: ${infos.filter((i) => i.type === 'security-header').length}\n`;
    text += `Disclosure:     ${infos.filter((i) => i.type === 'disclosure').length}\n`;
    text += `Directory:      ${infos.filter((i) => i.type === 'directory').length}\n`;
    text += `Performance:    ${infos.filter((i) => i.type === 'performance').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApacheConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_apache_config',
      description: 'Analyse Apache .htaccess and virtual-host config files for missing front-controller rewrite rules, missing security headers, server version disclosure, directory listing, and performance settings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_apache_config_stats',
      description: 'Statistics for Apache configuration: counts by type (rewrite/security-header/disclosure/directory/performance) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
