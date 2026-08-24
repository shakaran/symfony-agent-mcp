// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface LiveComponentSecurityInfo {
  file: string;
  type: 'writable-prop' | 'live-action' | 'auth-missing';
  pattern: string;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

const SENSITIVE_FIELDS = ['id', 'userId', 'user', 'price', 'amount', 'role', 'isAdmin', 'status'];

function buildSymfonyLiveComponentSecurityInfos(appPath: string): LiveComponentSecurityInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: LiveComponentSecurityInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const rel = path.relative(appPath, file);

    const isLiveComponent = content.includes('use Symfony\\UX\\LiveComponent') || content.includes('#[AsLiveComponent]');
    if (!isLiveComponent) continue;

    // Check sensitive writable props
    for (const fieldName of SENSITIVE_FIELDS) {
      const sensitivePattern = new RegExp(`#\\[LiveProp\\(writable:\\s*true\\)[^\\]]*\\][^;]*\\$${fieldName}\\b`);
      if (sensitivePattern.test(content)) {
        results.push({ file: rel, type: 'writable-prop', pattern: `LiveProp(writable: true) $${fieldName}`, issues: [`Sensitive field '${fieldName}' marked as LiveProp(writable: true) — any authenticated user can modify this property via AJAX; add validation or remove writable`] });
      }
    }

    // Check writable props without Assert
    if (content.includes('LiveProp(writable: true)') && !content.includes('#[Assert\\')) {
      results.push({ file: rel, type: 'writable-prop', pattern: 'LiveProp(writable: true) without Assert', issues: ['LiveProp(writable: true) without validation constraints — add #[Assert\\NotNull] or other constraints to validate incoming values'] });
    }

    // Check LiveAction without IsGranted
    if (content.includes('#[LiveAction]') && !content.includes('#[IsGranted')) {
      results.push({ file: rel, type: 'live-action', pattern: '#[LiveAction] without #[IsGranted]', issues: ["LiveAction method without #[IsGranted] — any user with access to the component can trigger this action; add #[IsGranted('ROLE_USER')] or similar"] });
    }

    // Check AsLiveComponent without any security check
    if (content.includes('#[AsLiveComponent]') && !content.includes('IsGranted') && !content.includes('denyAccessUnlessGranted') && !content.includes('Security')) {
      results.push({ file: rel, type: 'auth-missing', pattern: '#[AsLiveComponent] without security', issues: ['Live component without authentication check — LiveComponents are accessible to all users who can access the containing page; ensure the parent route is secured'] });
    }
  }

  return results;
}

export function listSymfonyLiveComponentSecurity(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyLiveComponentSecurityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No LiveComponent security issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony UX LiveComponent Security Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyLiveComponentSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyLiveComponentSecurityInfos(appPath);
    let text = `Symfony UX LiveComponent Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `Writable-prop:  ${infos.filter((i) => i.type === 'writable-prop').length}\n`;
    text += `Live-action:    ${infos.filter((i) => i.type === 'live-action').length}\n`;
    text += `Auth-missing:   ${infos.filter((i) => i.type === 'auth-missing').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyLiveComponentSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_live_component_security', description: 'Analyze Symfony UX LiveComponent security: sensitive writable props, LiveAction without IsGranted, components missing authentication checks', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_live_component_security_stats', description: 'Statistics for LiveComponent security: counts by type (writable-prop/live-action/auth-missing) and total issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
