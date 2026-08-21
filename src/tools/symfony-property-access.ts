import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface PropertyAccessUsage {
  file: string;
  class?: string;
  hasGetValue: boolean;
  hasSetValue: boolean;
  hasIsReadable: boolean;
  hasIsWritable: boolean;
  usesMagicCall: boolean;
  hasExceptionHandling: boolean;
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

function parsePropertyAccess(filePath: string, appPath: string): PropertyAccessUsage | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  const hasPA = content.includes('PropertyAccess') || content.includes('PropertyAccessor') || content.includes('->getValue(') || content.includes('->setValue(');
  if (!hasPA) return null;
  if (content.includes('namespace Symfony\\Component\\PropertyAccess')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const hasGetValue = content.includes('->getValue(');
  const hasSetValue = content.includes('->setValue(');
  const hasIsReadable = content.includes('->isReadable(');
  const hasIsWritable = content.includes('->isWritable(');
  const usesMagicCall = content.includes('DISALLOW_MAGIC_CALL') || content.includes('MAGIC_CALL');
  const hasExceptionHandling = content.includes('NoSuchPropertyException') || content.includes('UnexpectedTypeException') || content.includes('AccessException') || content.includes('try {') && content.includes('getValue');
  const issues: string[] = [];
  if (hasGetValue && !hasIsReadable && !hasExceptionHandling) issues.push('PropertyAccessor::getValue() without isReadable() check or try/catch — may throw NoSuchPropertyException');
  if (hasSetValue && !hasIsWritable && !hasExceptionHandling) issues.push('PropertyAccessor::setValue() without isWritable() check or try/catch — may throw on read-only property');
  return { file: path.relative(appPath, filePath), class: classM?.[1], hasGetValue, hasSetValue, hasIsReadable, hasIsWritable, usesMagicCall, hasExceptionHandling, issues };
}

export function listPropertyAccessUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: PropertyAccessUsage[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parsePropertyAccess(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No Symfony PropertyAccess usage found.' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Symfony PropertyAccess Usage\n${'='.repeat(55)}\n\nFiles: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [r.hasGetValue ? 'getValue' : '', r.hasSetValue ? 'setValue' : '', r.hasIsReadable ? 'isReadable' : '', r.hasIsWritable ? 'isWritable' : '', r.hasExceptionHandling ? 'try/catch' : ''].filter(Boolean).join('  ');
      text += `\n  ${r.class ?? '(file)'}  ${flags}  (${r.file})\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPropertyAccessStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: PropertyAccessUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parsePropertyAccess(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `Symfony PropertyAccess Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using PropertyAccess: ${results.length}\n  getValue: ${results.filter(r => r.hasGetValue).length}\n  setValue: ${results.filter(r => r.hasSetValue).length}\n  With readable/writable check: ${results.filter(r => r.hasIsReadable || r.hasIsWritable).length}\n  With exception handling: ${results.filter(r => r.hasExceptionHandling).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPropertyAccessTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_property_access', description: 'Detect Symfony PropertyAccessor usage: getValue/setValue calls, isReadable/isWritable guards, exception handling, MAGIC_CALL mode, unguarded getValue/setValue warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_property_access_stats', description: 'Symfony PropertyAccess statistics: file count, getValue/setValue counts, guard coverage, exception handling coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
