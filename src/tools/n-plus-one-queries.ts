import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface NPlusOneCandidate {
  file: string;
  class?: string;
  line: number;
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

function detectNPlusOne(filePath: string, appPath: string): NPlusOneCandidate[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  if (content.includes('namespace Doctrine\\') || content.includes('namespace Symfony\\')) return [];
  const classM = /class\s+(\w{1,120})/.exec(content);
  const candidates: NPlusOneCandidate[] = [];
  const lines = content.split('\n');
  let inLoop = false;
  let loopDepth = 0;
  let braceDepth = 0;
  const loopStart: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^\s*(?:foreach|for|while)\s*\(/.test(line)) {
      inLoop = true;
      loopDepth = braceDepth;
      loopStart.push(i + 1);
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    braceDepth += opens - closes;
    if (inLoop && braceDepth <= loopDepth) {
      inLoop = false;
      loopStart.pop();
    }
    if (inLoop) {
      const isRepoCall = /->(?:find|findBy|findOneBy|findAll|findByXxx|getRepository)\s*\(/.test(trimmed);
      const isEMCall = /\$(?:em|entityManager|doctrine|repository)->(?:find|findBy|findOneBy|createQuery|createQueryBuilder)\s*\(/.test(trimmed);
      if (isRepoCall || isEMCall) {
        candidates.push({
          file: path.relative(appPath, filePath),
          class: classM?.[1],
          line: i + 1,
          pattern: trimmed.substring(0, 100),
          issues: ['Repository call inside loop — likely N+1 query; use JOIN FETCH or preload collection before loop'],
        });
      }
    }
  }
  return candidates.slice(0, 20);
}

export function listNPlusOnePatterns(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const candidates: NPlusOneCandidate[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      candidates.push(...detectNPlusOne(f, appPath));
    }
    if (candidates.length === 0) return { content: [{ type: 'text', text: 'No obvious N+1 query patterns detected.' }] };
    let text = `N+1 Query Patterns\n${'='.repeat(55)}\n\nSuspected locations: ${candidates.length}\n(Static analysis — verify with Symfony Profiler or blackfire)\n`;
    const byFile = new Map<string, NPlusOneCandidate[]>();
    for (const c of candidates) {
      const key = c.file;
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(c);
    }
    for (const [file, items] of byFile.entries()) {
      text += `\n  ${items[0].class ?? '(file)'}  (${file})\n`;
      for (const item of items) {
        text += `    line ${item.line}: ${item.pattern}\n`;
        for (const i of item.issues) text += `      ⚠ ${i}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNPlusOneStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const candidates: NPlusOneCandidate[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        candidates.push(...detectNPlusOne(f, appPath));
      }
    }
    const files = new Set(candidates.map(c => c.file)).size;
    let text = `N+1 Query Statistics\n${'='.repeat(40)}\n\n`;
    text += `Suspected N+1 locations: ${candidates.length}\nFiles affected: ${files}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNPlusOneTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_n_plus_one_patterns', description: 'Detect suspected N+1 query patterns: repository/EntityManager calls inside foreach/for/while loops, missing JOIN FETCH suggestion (static analysis — verify with Symfony Profiler)', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_n_plus_one_stats', description: 'N+1 query statistics: suspected location count, affected file count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
