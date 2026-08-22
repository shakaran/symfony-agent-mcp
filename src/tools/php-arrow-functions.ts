import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ArrowFunctionUsage {
  file: string;
  class?: string;
  arrowFunctionCount: number;
  closureCount: number;
  nestedArrowCount: number;
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

function parseArrowFunctions(filePath: string, appPath: string): ArrowFunctionUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const arrowFunctionCount = [...content.matchAll(/\bfn\s*\([^)]{0,200}\)\s*(?::\s*\w[\w|&?\\]{0,50})?\s*=>/g)].length;
  const closureCount = [...content.matchAll(/\bfunction\s*\([^)]{0,200}\)\s*(?:use\s*\([^)]{0,200}\))?\s*\{/g)].length;
  if (arrowFunctionCount + closureCount === 0) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const nestedArrowCount = [...content.matchAll(/fn\s*\([^)]{0,200}\)\s*=>[^,;)]{0,200}fn\s*\(/g)].length;
  const issues: string[] = [];
  if (nestedArrowCount > 0) issues.push(`${nestedArrowCount} nested arrow function(s) — deeply nested fn() can reduce readability; consider extracting to method`);
  if (closureCount > 3 && arrowFunctionCount === 0) issues.push(`${closureCount} closures without arrow functions — consider fn() for simple value-returning lambdas (PHP 7.4+)`);
  return { file: path.relative(appPath, filePath), class: classM?.[1], arrowFunctionCount, closureCount, nestedArrowCount, issues };
}

export function listPhpArrowFunctions(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: ArrowFunctionUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseArrowFunctions(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No arrow functions or closures found.' }] };
    const totalArrow = usages.reduce((s, u) => s + u.arrowFunctionCount, 0);
    const totalClosure = usages.reduce((s, u) => s + u.closureCount, 0);
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `PHP Arrow Functions\n${'='.repeat(55)}\n\nFiles: ${usages.length}  Arrow fn(): ${totalArrow}  Closures: ${totalClosure}  Issues: ${totalIssues}\n`;
    for (const u of usages.filter((x) => x.issues.length > 0)) {
      text += `\n  ${u.class ?? '(file)'}  fn(): ${u.arrowFunctionCount}  closure: ${u.closureCount}  nested: ${u.nestedArrowCount}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpArrowFunctionStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: ArrowFunctionUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseArrowFunctions(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `PHP Arrow Function Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files: ${usages.length}\nArrow functions (fn): ${usages.reduce((s, u) => s + u.arrowFunctionCount, 0)}\nClosures: ${usages.reduce((s, u) => s + u.closureCount, 0)}\nNested arrow: ${usages.reduce((s, u) => s + u.nestedArrowCount, 0)}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpArrowFunctionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_arrow_functions', description: 'Show PHP fn() arrow function usage: count vs closures, nested arrow functions, files using only closures where arrow functions would be simpler', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_arrow_function_stats', description: 'Show PHP arrow function statistics: file count, fn() count, closure count, nested count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
