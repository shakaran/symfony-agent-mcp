/**
 * PHP Cognitive Complexity Inspector
 *
 * Estimates cognitive complexity per method in src/ PHP files.
 * Cognitive complexity differs from cyclomatic: nesting adds extra weight.
 *
 * Scoring:
 *   - Each if/else if/else:        +1 + nesting level
 *   - Each for/foreach/while/do:   +1 + nesting level
 *   - Each switch:                 +1 + nesting level
 *   - Each catch:                  +1
 *   - Each &&/||/?? operator:      +1
 *   - Each nested function/closure: +1 nesting bonus
 *
 * Warns: cognitive complexity >15 (high, refactor recommended),
 *        cognitive complexity >30 (very high, must refactor).
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface CognitiveComplexityInfo {
  file: string;
  methodName: string;
  complexity: number;
  nestingPenalty: number;
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

function estimateCognitiveComplexity(body: string): { complexity: number; nestingPenalty: number } {
  const lines = body.split('\n');
  let complexity = 0;
  let nestingPenalty = 0;
  let nesting = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Structural increments with nesting bonus
    if (/\bif\s*\(/.test(trimmed)) {
      complexity += 1 + nesting;
      nestingPenalty += nesting;
      nesting++;
    } else if (/\belse\s+if\s*\(/.test(trimmed) || /\belseif\s*\(/.test(trimmed)) {
      complexity += 1 + nesting;
      nestingPenalty += nesting;
    } else if (/^\s*else\s*[{$]/.test(line) || /\belse\s*[{]/.test(trimmed)) {
      complexity += 1;
    } else if (/\bfor\s*\(/.test(trimmed) || /\bforeach\s*\(/.test(trimmed)) {
      complexity += 1 + nesting;
      nestingPenalty += nesting;
      nesting++;
    } else if (/\bwhile\s*\(/.test(trimmed)) {
      complexity += 1 + nesting;
      nestingPenalty += nesting;
      nesting++;
    } else if (/\bdo\s*\{/.test(trimmed)) {
      complexity += 1 + nesting;
      nestingPenalty += nesting;
      nesting++;
    } else if (/\bswitch\s*\(/.test(trimmed)) {
      complexity += 1 + nesting;
      nestingPenalty += nesting;
      nesting++;
    } else if (/\bcatch\s*\(/.test(trimmed)) {
      complexity += 1;
    } else if (/\bfunction\s*\(/.test(trimmed) || /\bfn\s*\(/.test(trimmed)) {
      // Nested function/closure: nesting bonus
      complexity += 1;
      nestingPenalty += 1;
      nesting++;
    }

    // Closing braces reduce nesting
    const openBraces = (trimmed.match(/\{/g) ?? []).length;
    const closeBraces = (trimmed.match(/\}/g) ?? []).length;
    if (closeBraces > openBraces) {
      nesting = Math.max(0, nesting - (closeBraces - openBraces));
    }

    // Logical operators: +1 each occurrence
    const andCount = (trimmed.match(/&&/g) ?? []).length;
    const orCount = (trimmed.match(/\|\|/g) ?? []).length;
    const nullCoalesceCount = (trimmed.match(/\?\?/g) ?? []).length;
    complexity += andCount + orCount + nullCoalesceCount;
  }

  return { complexity, nestingPenalty };
}

function extractMethods(content: string): Array<{ name: string; body: string }> {
  const methods: Array<{ name: string; body: string }> = [];
  const methodPattern = /(?:public|protected|private|static|abstract|final|\s){1,50}function\s+(\w{1,80})\s*\([^)]{0,300}\)[^{;]{0,100}\{/g;
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
    const body = content.slice(start, Math.min(i, start + 8000));
    methods.push({ name, body });
  }
  return methods;
}

function buildCognitiveComplexityInfos(appPath: string): CognitiveComplexityInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: CognitiveComplexityInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const methods = extractMethods(content);
    for (const method of methods) {
      const { complexity, nestingPenalty } = estimateCognitiveComplexity(method.body);
      const issues: string[] = [];
      if (complexity > 30) issues.push('Cognitive complexity >30: must refactor — extract sub-methods');
      else if (complexity > 15) issues.push('Cognitive complexity >15: high — refactor recommended');

      if (complexity > 5) {
        results.push({
          file: path.relative(appPath, file),
          methodName: method.name,
          complexity,
          nestingPenalty,
          issues,
        });
      }
    }
  }

  return results;
}

export function listPhpCognitiveComplexity(appPath: string): McpToolResult {
  try {
    const infos = buildCognitiveComplexityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No high cognitive complexity methods found (threshold: >5).' }] };
    }

    infos.sort((a, b) => b.complexity - a.complexity);
    const worst = infos.slice(0, 30);

    let text = `PHP Cognitive Complexity Analysis\n${'='.repeat(55)}\n\n`;
    text += `Methods with cognitive complexity >5: ${infos.length}  (showing top ${worst.length})\n`;
    text += `Thresholds: >15 = refactor recommended, >30 = must refactor\n\n`;

    for (const info of worst) {
      const severity = info.complexity > 30 ? 'MUST REFACTOR' : info.complexity > 15 ? 'REFACTOR' : '';
      const severityStr = severity ? `  [${severity}]` : '';
      text += `  CC:${String(info.complexity).padEnd(4)} nest:${String(info.nestingPenalty).padEnd(3)} ${info.methodName}()${severityStr}\n`;
      text += `         ${info.file}\n`;
      for (const issue of info.issues) {
        text += `         ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpCognitiveComplexityStats(appPath: string): McpToolResult {
  try {
    const infos = buildCognitiveComplexityInfos(appPath);

    const high = infos.filter((i) => i.complexity > 15 && i.complexity <= 30).length;
    const veryHigh = infos.filter((i) => i.complexity > 30).length;
    const moderate = infos.filter((i) => i.complexity > 5 && i.complexity <= 15).length;

    let text = `PHP Cognitive Complexity Statistics\n${'='.repeat(40)}\n\n`;
    text += `Methods analyzed (CC > 5): ${infos.length}\n`;
    text += `  Moderate (6-15):         ${moderate}\n`;
    text += `  High     (>15):          ${high}\n`;
    text += `  Very High (>30):         ${veryHigh}\n`;

    if (infos.length > 0) {
      const avg = infos.reduce((s, i) => s + i.complexity, 0) / infos.length;
      const maxInfo = infos.reduce((a, b) => (a.complexity > b.complexity ? a : b));
      text += `Average CC (above threshold): ${avg.toFixed(1)}\n`;
      text += `Highest CC: ${maxInfo.complexity}  (${maxInfo.methodName}() in ${maxInfo.file})\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpCognitiveComplexityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_cognitive_complexity',
      description: 'Show PHP cognitive complexity estimates per method: methods with CC >5, top-30 worst, nesting penalty breakdown, warnings for CC >15 (refactor) and CC >30 (must refactor)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_cognitive_complexity_stats',
      description: 'Show PHP cognitive complexity statistics: method counts by severity band (moderate/high/very-high), average CC, highest single-method CC with location',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
