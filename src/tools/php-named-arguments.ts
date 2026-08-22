import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface NamedArgUsage {
  file: string;
  class?: string;
  count: number;
  examples: string[];
  hasVariadicNamed: boolean;
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

function parseNamedArgs(filePath: string, appPath: string): NamedArgUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  // Named args pattern: word: $var or word: value (but not type hints or class members)
  const namedArgRe = /\b(\w{1,60})\s*:\s*(?:\$[\w]{1,60}|(?:true|false|null|\d+|'[^']{0,80}'|"[^"]{0,80}"|new\s))/g;
  // Filter out PHP 8 attributes which look similar
  const withoutAttributes = content.replace(/#\[[^\]]{0,500}\]/g, '');
  const examples: string[] = [];
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = namedArgRe.exec(withoutAttributes)) !== null) {
    const lineStart = withoutAttributes.lastIndexOf('\n', m.index) + 1;
    const lineContent = withoutAttributes.substring(lineStart, Math.min(lineStart + 120, withoutAttributes.length));
    // Must be inside a function call context
    if (!/\([^)]{0,200}$/.test(withoutAttributes.substring(Math.max(0, m.index - 200), m.index))) continue;
    // Skip property/array declarations
    if (/^\s*(public|protected|private|readonly|static|\$|\/\/)/.test(lineContent.trim())) continue;
    count++;
    if (examples.length < 5) examples.push(`${m[1]}: ...`);
  }
  if (count === 0) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace PHPUnit\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const hasVariadicNamed = content.includes('...$') && count > 0;
  const issues: string[] = [];
  if (count > 20) issues.push(`${count} named argument usages — high coupling to parameter names; renaming a parameter is a breaking change`);
  return { file: path.relative(appPath, filePath), class: classM?.[1], count, examples, hasVariadicNamed, issues };
}

export function listPhpNamedArguments(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: NamedArgUsage[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseNamedArgs(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No PHP named argument usage found.' }] };
    const totalCount = results.reduce((s, r) => s + r.count, 0);
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `PHP Named Arguments\n${'='.repeat(55)}\n\nFiles: ${results.length}  Total usages: ${totalCount}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.count - a.count).slice(0, 30)) {
      text += `\n  ${r.class ?? '(file)'}  count: ${r.count}  (${r.file})\n`;
      if (r.examples.length > 0) text += `    examples: ${r.examples.join(', ')}\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpNamedArgumentStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: NamedArgUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseNamedArgs(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `PHP Named Argument Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using named args: ${results.length}\nTotal usages: ${results.reduce((s, r) => s + r.count, 0)}\nWith variadic named args: ${results.filter(r => r.hasVariadicNamed).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpNamedArgumentTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_named_arguments', description: 'Detect PHP 8.0+ named argument usage (param: $value), variadic named args, high-usage files warning (parameter renaming is breaking)', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_named_argument_stats', description: 'PHP named argument statistics: file count, total usage count, variadic count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
