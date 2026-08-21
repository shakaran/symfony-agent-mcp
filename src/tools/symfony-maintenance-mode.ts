import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MaintenanceInfo {
  type: 'lock-file' | 'middleware' | 'event-listener' | 'custom';
  file: string;
  description: string;
  returns503: boolean;
  hasWhitelist: boolean;
  issues: string[];
}

const LOCK_FILE_NAMES = ['maintenance', 'maintenance.lock', '.maintenance', 'down', 'app.lock'];

function scanLockFiles(appPath: string): MaintenanceInfo[] {
  const found: MaintenanceInfo[] = [];
  for (const name of LOCK_FILE_NAMES) {
    const candidates = [path.join(appPath, name), path.join(appPath, 'var', name), path.join(appPath, 'public', name)];
    for (const f of candidates) {
      if (fs.existsSync(f)) {
        found.push({ type: 'lock-file', file: path.relative(appPath, f), description: `Maintenance lock file: ${name}`, returns503: false, hasWhitelist: false, issues: ['Lock file present — site may be in maintenance mode; remove file to restore service'] });
      }
    }
  }
  return found;
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

function scanPhpMaintenance(appPath: string): MaintenanceInfo[] {
  const found: MaintenanceInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return found;
  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const has503 = content.includes('Response::HTTP_SERVICE_UNAVAILABLE') || /new\s+Response[^)]*503/.test(content) || content.includes('503');
    const hasMaintenance = content.toLowerCase().includes('maintenance') || content.includes('unavailable') || content.includes('down');
    if (!has503 && !hasMaintenance) continue;
    if (content.includes('namespace Symfony\\')) continue;
    const classM = /class\s+(\w+)/.exec(content);
    const isListener = content.includes('KernelEvents') || content.includes('onKernelRequest');
    const hasWhitelist = content.includes('allowedIps') || content.includes('whitelist') || content.includes('MAINTENANCE_IPS') || content.includes('bypass');
    const issues: string[] = [];
    if (has503 && !hasWhitelist) issues.push('Maintenance response without IP whitelist — developers cannot bypass maintenance mode');
    if (isListener && !content.includes('$event->setResponse')) issues.push('KernelRequest listener without setResponse() — 503 may not be returned properly');
    found.push({ type: isListener ? 'event-listener' : 'custom', file: path.relative(appPath, file), description: classM?.[1] ?? '(file)', returns503: has503, hasWhitelist, issues });
  }
  return found;
}

export function listMaintenanceMode(appPath: string): McpToolResult {
  try {
    const all = [...scanLockFiles(appPath), ...scanPhpMaintenance(appPath)];
    if (all.length === 0) return { content: [{ type: 'text', text: 'No maintenance mode implementation found.\n\nCommon patterns:\n  1. Lock file: if file_exists(\'var/maintenance\') return 503\n  2. KernelRequest listener: check env var or lock file, setResponse(503)\n  3. Symfony Maintenance Bundle: lexik/maintenance-bundle' }] };
    const totalIssues = all.reduce((s, m) => s + m.issues.length, 0);
    let text = `Maintenance Mode\n${'='.repeat(55)}\n\nImplementations: ${all.length}  Issues: ${totalIssues}\n`;
    for (const m of all.sort((a, b) => b.issues.length - a.issues.length)) {
      const returns = m.returns503 ? '  ✓ 503' : '  ⚠ no 503';
      const wl = m.hasWhitelist ? '  ✓ whitelist' : '  ⚠ no whitelist';
      text += `\n  ${m.description}  type: ${m.type}${returns}${wl}  (${m.file})\n`;
      for (const i of m.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMaintenanceModeStats(appPath: string): McpToolResult {
  try {
    const all = [...scanLockFiles(appPath), ...scanPhpMaintenance(appPath)];
    let text = `Maintenance Mode Statistics\n${'='.repeat(40)}\n\n`;
    text += `Implementations: ${all.length}\n  Lock files: ${all.filter((m) => m.type === 'lock-file').length}\n  Event listeners: ${all.filter((m) => m.type === 'event-listener').length}\n  Returns 503: ${all.filter((m) => m.returns503).length}\n  With whitelist: ${all.filter((m) => m.hasWhitelist).length}\nIssues: ${all.reduce((s, m) => s + m.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMaintenanceModeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_maintenance_mode', description: 'Show maintenance mode implementation: lock files (maintenance/down/app.lock), KernelRequest 503 listeners, IP whitelist bypass, 503 status code return, missing whitelist warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_maintenance_mode_stats', description: 'Show maintenance mode statistics: implementation count by type, 503 count, whitelist count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
