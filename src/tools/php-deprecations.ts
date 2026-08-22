import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DeprecationInfo {
  file: string;
  class?: string;
  type: 'annotation' | 'trigger_deprecation' | 'set_error_handler';
  message?: string;
  since?: string;
  lineApprox: number;
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

function scanDeprecations(filePath: string, appPath: string): DeprecationInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  const classM = /class\s+(\w+)/.exec(content);
  const results: DeprecationInfo[] = [];
  const annotPattern = /@deprecated(?:\s+([^\n*]{0,100}))?/g;
  let m: RegExpExecArray | null;
  while ((m = annotPattern.exec(content)) !== null) {
    const annotation = m[1]?.trim() ?? '';
    const sinceM = /since\s+(?:version\s+)?([\d.]+)/i.exec(annotation);
    const lineApprox = content.slice(0, m.index).split('\n').length;
    results.push({ file: path.relative(appPath, filePath), class: classM?.[1], type: 'annotation', message: annotation.slice(0, 100), since: sinceM?.[1], lineApprox });
  }
  const triggerPattern = /trigger_deprecation\s*\(\s*['"]([^'"]{0,200})['"]\s*,\s*['"]([^'"]{0,40})['"]/g;
  while ((m = triggerPattern.exec(content)) !== null) {
    const lineApprox = content.slice(0, m.index).split('\n').length;
    results.push({ file: path.relative(appPath, filePath), class: classM?.[1], type: 'trigger_deprecation', message: m[1], since: m[2], lineApprox });
  }
  return results;
}

export function listPhpDeprecations(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const all: DeprecationInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      all.push(...scanDeprecations(file, appPath));
    }
    if (all.length === 0) return { content: [{ type: 'text', text: 'No @deprecated annotations or trigger_deprecation() calls found.' }] };
    const byType = new Map<string, number>();
    for (const d of all) byType.set(d.type, (byType.get(d.type) ?? 0) + 1);
    let text = `PHP Deprecations\n${'='.repeat(55)}\n\nTotal: ${all.length}\n`;
    for (const [type, count] of byType.entries()) text += `  ${type}: ${count}\n`;
    text += '\n';
    for (const d of all.slice(0, 50)) {
      const since = d.since ? `  since: ${d.since}` : '';
      text += `  ${d.class ?? '(file)'}  [${d.type}]${since}  line ~${d.lineApprox}  (${d.file})\n`;
      if (d.message) text += `    ${d.message}\n`;
    }
    if (all.length > 50) text += `\n  ... and ${all.length - 50} more\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDeprecationStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const all: DeprecationInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        all.push(...scanDeprecations(file, appPath));
      }
    }
    let text = `PHP Deprecation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total: ${all.length}\n  @deprecated annotations: ${all.filter((d) => d.type === 'annotation').length}\n  trigger_deprecation(): ${all.filter((d) => d.type === 'trigger_deprecation').length}\n  With since version: ${all.filter((d) => !!d.since).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDeprecationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_deprecations', description: 'Show PHP @deprecated annotations and trigger_deprecation() calls: class, since version, message; useful for tracking technical debt and deprecation roadmap', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_deprecation_stats', description: 'Show PHP deprecation statistics: total count, by type (annotation vs trigger_deprecation), with-since count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
