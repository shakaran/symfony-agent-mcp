import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ComplexityResult {
  file: string;
  class?: string;
  method: string;
  complexity: number;
  lineCount: number;
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

function estimateComplexity(body: string): number {
  let cc = 1;
  const decisions = [...body.matchAll(/\b(if|elseif|else\s+if|for|foreach|while|do|case|catch|&&|\|\||match|throw\s+new)\b/g)].length;
  const ternary = [...body.matchAll(/\?(?![?=])/g)].length;
  cc += decisions + ternary;
  return cc;
}

function extractMethods(content: string): Array<{ name: string; body: string; lineStart: number }> {
  const methods: Array<{ name: string; body: string; lineStart: number }> = [];
  const methodPattern = /(?:public|protected|private|static|abstract|final|\s)+function\s+(\w+)\s*\([^)]{0,200}\)[^{;]{0,100}\{/g;
  let m: RegExpExecArray | null;
  while ((m = methodPattern.exec(content)) !== null) {
    const name = m[1];
    const start = m.index + m[0].length - 1;
    let depth = 1;
    let i = start + 1;
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    const body = content.slice(start, Math.min(i, start + 5000));
    const lineStart = content.slice(0, m.index).split('\n').length;
    methods.push({ name, body, lineStart });
  }
  return methods;
}

export function listPhpComplexity(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const highComplexity: ComplexityResult[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const classM = /class\s+(\w+)/.exec(content);
      const methods = extractMethods(content);
      for (const method of methods) {
        const cc = estimateComplexity(method.body);
        const lineCount = method.body.split('\n').length;
        if (cc >= 5) {
          highComplexity.push({ file: path.relative(appPath, file), class: classM?.[1], method: method.name, complexity: cc, lineCount });
        }
      }
    }
    if (highComplexity.length === 0) return { content: [{ type: 'text', text: 'No high-complexity methods found (threshold: cyclomatic complexity ≥ 5).' }] };
    highComplexity.sort((a, b) => b.complexity - a.complexity);
    const worst = highComplexity.slice(0, 30);
    let text = `PHP Cyclomatic Complexity (estimate)\n${'='.repeat(55)}\n\nMethods with CC ≥ 5: ${highComplexity.length}  (showing top ${worst.length})\n\nThreshold: CC ≥ 10 = refactor candidate, CC ≥ 20 = high risk\n`;
    for (const r of worst) {
      const risk = r.complexity >= 20 ? '⚠ HIGH' : r.complexity >= 10 ? '⚠ refactor' : '';
      text += `\n  CC:${r.complexity}  ${r.class ?? '(file)'}::${r.method}()  ${r.lineCount} lines  ${risk}  (${r.file})\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpComplexityStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: ComplexityResult[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        let content = '';
        try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
        const classM = /class\s+(\w+)/.exec(content);
        for (const method of extractMethods(content)) {
          const cc = estimateComplexity(method.body);
          results.push({ file: path.relative(appPath, file), class: classM?.[1], method: method.name, complexity: cc, lineCount: method.body.split('\n').length });
        }
      }
    }
    const high = results.filter((r) => r.complexity >= 10).length;
    const veryHigh = results.filter((r) => r.complexity >= 20).length;
    let text = `PHP Complexity Statistics\n${'='.repeat(40)}\n\n`;
    text += `Methods analyzed: ${results.length}\n  CC < 5: ${results.filter((r) => r.complexity < 5).length}\n  CC 5-9: ${results.filter((r) => r.complexity >= 5 && r.complexity < 10).length}\n  CC ≥ 10 (refactor): ${high}\n  CC ≥ 20 (high risk): ${veryHigh}\n`;
    if (results.length > 0) {
      const avg = results.reduce((s, r) => s + r.complexity, 0) / results.length;
      text += `Average CC: ${avg.toFixed(1)}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpComplexityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_complexity', description: 'Show PHP cyclomatic complexity estimates: methods with CC ≥ 5, top-30 most complex, refactor candidates (CC ≥ 10) and high-risk (CC ≥ 20) warnings', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_complexity_stats', description: 'Show PHP complexity statistics: method count by CC band, average CC, refactor/high-risk counts', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
