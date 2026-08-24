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

interface SessionSecurityInfo {
  source: string;
  type: 'cookie' | 'regeneration' | 'transport' | 'config';
  setting: string;
  issues: string[];
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

function buildPhpSessionSecurityInfos(appPath: string): SessionSecurityInfo[] {
  const results: SessionSecurityInfo[] = [];

  const iniCandidates = [
    path.join(appPath, 'php.ini'),
    path.join(appPath, 'config', 'php.ini'),
    path.join(appPath, 'docker', 'php.ini'),
  ];

  for (const iniPath of iniCandidates) {
    if (!fs.existsSync(iniPath)) continue;
    let content: string;
    try {
      content = fs.readFileSync(iniPath, 'utf8');
    } catch { continue; }

    const relSource = path.relative(appPath, iniPath);

    if (!content.includes('session.use_only_cookies') || /session\.use_only_cookies\s*=\s*0/.test(content)) {
      results.push({
        source: relSource,
        type: 'config',
        setting: 'session.use_only_cookies',
        issues: ['session.use_only_cookies not enabled — session IDs can be passed in URLs, enabling session fixation attacks; set session.use_only_cookies=1'],
      });
    }

    if (!content.includes('session.cookie_secure') || /session\.cookie_secure\s*=\s*0/.test(content)) {
      results.push({
        source: relSource,
        type: 'cookie',
        setting: 'session.cookie_secure',
        issues: ['session.cookie_secure not enabled — session cookies sent over HTTP; set session.cookie_secure=1 for HTTPS-only apps'],
      });
    }

    if (!content.includes('session.cookie_httponly') || /session\.cookie_httponly\s*=\s*0/.test(content)) {
      results.push({
        source: relSource,
        type: 'cookie',
        setting: 'session.cookie_httponly',
        issues: ['session.cookie_httponly not enabled — session cookie accessible via JavaScript; set session.cookie_httponly=1 to prevent XSS session theft'],
      });
    }

    if (!content.includes('session.cookie_samesite')) {
      results.push({
        source: relSource,
        type: 'cookie',
        setting: 'session.cookie_samesite',
        issues: ['session.cookie_samesite not configured — cross-site request cookie leakage possible; set session.cookie_samesite=Strict or Lax'],
      });
    }
  }

  const srcDir = path.join(appPath, 'src');
  const phpFiles = getAllPhpFiles(srcDir);

  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (content === null) continue;

    if (!content.includes('session_')) continue;

    const relSource = path.relative(appPath, filePath);

    if (/session_start\(\s*\)/.test(content)) {
      results.push({
        source: relSource,
        type: 'config',
        setting: 'session_start() without options',
        issues: ['session_start() without options array — use session_start([\'cookie_secure\'=>1,\'cookie_httponly\'=>1,\'cookie_samesite\'=>\'Strict\']) for PHP 7.0+'],
      });
    }

    if (/session_regenerate_id\s*\(\s*\)/.test(content) || /session_regenerate_id\s*\(\s*false\s*\)/.test(content)) {
      results.push({
        source: relSource,
        type: 'regeneration',
        setting: 'session_regenerate_id without delete_old_session',
        issues: ['session_regenerate_id() without deleting old session — old session ID still valid; use session_regenerate_id(true) to delete the old session'],
      });
    }

    if (/session\.use_trans_sid.*=.*1/.test(content) || /ini_set\s*\([^)]*use_trans_sid[^)]*1/.test(content)) {
      results.push({
        source: relSource,
        type: 'transport',
        setting: 'session.use_trans_sid=1',
        issues: ['session.use_trans_sid=1 puts session ID in URLs — always visible in browser history and logs; disable use_trans_sid'],
      });
    }
  }

  return results;
}

export function listPhpSessionSecurity(appPath: string): McpToolResult {
  try {
    const infos = buildPhpSessionSecurityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No session security issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP Session Security Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.setting}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpSessionSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpSessionSecurityInfos(appPath);
    let text = `PHP Session Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `Cookie:       ${infos.filter((i) => i.type === 'cookie').length}\n`;
    text += `Regeneration: ${infos.filter((i) => i.type === 'regeneration').length}\n`;
    text += `Transport:    ${infos.filter((i) => i.type === 'transport').length}\n`;
    text += `Config:       ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpSessionSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_session_security', description: 'Analyze PHP session security settings for cookie, regeneration, transport, and config issues', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_session_security_stats', description: 'Statistics for PHP session security: counts by type and issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
