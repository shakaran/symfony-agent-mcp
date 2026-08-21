/**
 * PHP 8.2 Disjunctive Normal Form (DNF) Type Inspector
 *
 * Scans src/**\/*.php for DNF type usage patterns:
 *   - (A&B)|C or (A&B)|null in function signatures
 *   - Intersection types A&B without parentheses (requires PHP 8.1+)
 *   - (Countable&Iterator)|array and similar DNF combinations
 *   - Missing PHPDoc when DNF types used
 *   - never return type misuse (function with return statement)
 *
 * Pure static analysis — no process execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DnfTypeInfo {
  file: string;
  line: number;
  pattern: string;
  severity: 'high' | 'medium' | 'low';
  issue: string;
  phpVersionRequired?: string;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

function readMinPhpVersion(appPath: string): string | null {
  try {
    const composerPath = path.join(appPath, 'composer.json');
    const raw = fs.readFileSync(composerPath, 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const req = json['require'] as Record<string, string> | undefined;
    return req?.['php'] ?? null;
  } catch { return null; }
}

function isPhpVersionBelow(versionConstraint: string, major: number, minor: number): boolean {
  const match = />=?\s*(\d+)\.(\d+)/.exec(versionConstraint);
  if (!match) return false;
  const maj = parseInt(match[1], 10);
  const min = parseInt(match[2], 10);
  return maj < major || (maj === major && min < minor);
}

function analyseFile(
  filePath: string,
  base: string,
  phpVersionConstraint: string | null
): DnfTypeInfo[] {
  const content = safeRead(filePath, base);
  if (!content) return [];

  const findings: DnfTypeInfo[] = [];
  const lines = content.split('\n');
  const relFile = path.relative(base, filePath);

  const phpTooLowFor82 = phpVersionConstraint ? isPhpVersionBelow(phpVersionConstraint, 8, 2) : false;
  const phpTooLowFor81 = phpVersionConstraint ? isPhpVersionBelow(phpVersionConstraint, 8, 1) : false;

  // Track function bodies for 'never' return type check
  // Key: line index where function with 'never' return was detected
  // Value: brace depth at time of detection
  const neverFunctions: Array<{ startLine: number; braceDepthAtOpen: number; funcName: string }> = [];
  let braceDepth = 0;
  let insideNeverFuncDepth = -1;
  let insideNeverFuncName = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Track brace depth
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
    }

    // Pattern 1: DNF type (A&B)|C in function signatures -> HIGH if PHP < 8.2
    // Detect (TypeA&TypeB)|TypeC or (TypeA&TypeB)|null patterns
    if (line.includes('(') && line.includes('&') && line.includes('|')) {
      const dnfMatch = /\([A-Za-z\\]+&[A-Za-z\\]+\)[|][A-Za-z\\]+/.exec(line);
      if (dnfMatch) {
        const severity: 'high' | 'medium' | 'low' = phpTooLowFor82 ? 'high' : 'low';
        findings.push({
          file: relFile,
          line: lineNo,
          pattern: 'dnf-type-signature',
          severity,
          issue: `DNF type ${dnfMatch[0]} in function signature requires PHP >= 8.2${phpVersionConstraint ? ` (project requires ${phpVersionConstraint})` : ''}`,
          phpVersionRequired: '>=8.2',
        });

        // Pattern 4: Missing PHPDoc for DNF type -> LOW risk
        // Look back a few lines for a PHPDoc comment
        const prevLines = lines.slice(Math.max(0, i - 6), i).join('\n');
        const hasPhpDoc = prevLines.includes('@param') || prevLines.includes('@return') || prevLines.includes('/**');
        if (!hasPhpDoc) {
          findings.push({
            file: relFile,
            line: lineNo,
            pattern: 'dnf-type-missing-phpdoc',
            severity: 'low',
            issue: `DNF type ${dnfMatch[0]} has no accompanying @param or @return PHPDoc — complex intersection/union types benefit from documentation`,
          });
        }
      }
    }

    // Pattern 2: Intersection type A&B as parameter type (not wrapped, no |) -> HIGH if PHP < 8.1
    // Detect in function parameter context: function foo(TypeA&TypeB $param)
    // Avoid matching bitwise & in expressions — look for type context before $
    if (line.includes('&') && line.includes('$') && (line.includes('function') || line.includes('('))) {
      // Match intersection types: Word\Word&Word\Word before a $ variable
      const intersectMatch = /\b([A-Za-z\\][A-Za-z0-9\\]{0,80}&[A-Za-z\\][A-Za-z0-9\\]{0,80})\s+\$/.exec(line);
      if (intersectMatch && !line.includes('|')) {
        // Exclude DNF patterns already caught above (those have parentheses)
        const matched = intersectMatch[1];
        if (!matched.startsWith('(')) {
          const severity: 'high' | 'medium' | 'low' = phpTooLowFor81 ? 'high' : 'low';
          findings.push({
            file: relFile,
            line: lineNo,
            pattern: 'intersection-type-parameter',
            severity,
            issue: `Intersection type ${matched} as parameter type requires PHP >= 8.1${phpVersionConstraint ? ` (project requires ${phpVersionConstraint})` : ''}`,
            phpVersionRequired: '>=8.1',
          });
        }
      }
    }

    // Pattern 3: Common DNF patterns like (Countable&Iterator)|array -> flag with note
    if (line.includes('Countable') && line.includes('Iterator') && line.includes('|')) {
      const cntMatch = /\([A-Za-z\\]*Countable[A-Za-z\\]*&[A-Za-z\\]*Iterator[A-Za-z\\]*\)[|][A-Za-z\\]+/.exec(line);
      if (cntMatch) {
        findings.push({
          file: relFile,
          line: lineNo,
          pattern: 'dnf-countable-iterator',
          severity: phpTooLowFor82 ? 'high' : 'low',
          issue: `DNF type ${cntMatch[0]} (Countable&Iterator combination) requires PHP >= 8.2`,
          phpVersionRequired: '>=8.2',
        });
      }
    }

    // Pattern 5: never return type misuse — function declared `: never` with a return statement
    const neverFuncMatch = /function\s+([A-Za-z_][A-Za-z0-9_]{0,80})\s*\([^)]{0,500}\)\s*:\s*never\b/.exec(line);
    if (neverFuncMatch) {
      neverFunctions.push({ startLine: i, braceDepthAtOpen: braceDepth, funcName: neverFuncMatch[1] });
      insideNeverFuncDepth = braceDepth;
      insideNeverFuncName = neverFuncMatch[1];
    }

    // Check if we're inside a never function and find a return statement
    if (insideNeverFuncDepth >= 0) {
      // Detect `return` with a value (not bare `return;` — though even bare return is wrong for `never`)
      const returnMatch = /\breturn\b/.exec(line);
      if (returnMatch && !neverFuncMatch) {
        findings.push({
          file: relFile,
          line: lineNo,
          pattern: 'never-return-misuse',
          severity: 'medium',
          issue: `Function ${insideNeverFuncName}() is declared with return type 'never' but contains a return statement — 'never' functions must throw an exception or call exit(), never return`,
        });
        // Reset to avoid duplicate findings for the same function
        insideNeverFuncDepth = -1;
        insideNeverFuncName = '';
      }
      // Exit never function tracking when brace depth drops back
      if (braceDepth < insideNeverFuncDepth) {
        insideNeverFuncDepth = -1;
        insideNeverFuncName = '';
      }
    }
  }

  // Suppress unused variable warning
  void neverFunctions;

  return findings;
}

function buildInfos(appPath: string): DnfTypeInfo[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, srcDir);
  const phpVersion = readMinPhpVersion(appPath);
  const findings: DnfTypeInfo[] = [];
  for (const f of files) findings.push(...analyseFile(f, srcDir, phpVersion));
  return findings;
}

export function listPhpDnfTypes(appPath: string): McpToolResult {
  try {
    const infos = buildInfos(appPath);
    const phpVersion = readMinPhpVersion(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP 8.2 DNF type issues found in src/.' }] };
    }
    let text = `PHP 8.2 Disjunctive Normal Form (DNF) Type Issues\n${'='.repeat(50)}\n`;
    if (phpVersion) text += `\ncomposer.json PHP requirement: ${phpVersion}\n`;
    text += `\nTotal: ${infos.length}\n\n`;
    for (const info of infos) {
      text += `  [${info.severity.toUpperCase()}] [${info.pattern}] ${info.file}:${info.line}\n`;
      text += `    ${info.issue}\n\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDnfTypeStats(appPath: string): McpToolResult {
  try {
    const infos = buildInfos(appPath);
    const phpVersionRequired = readMinPhpVersion(appPath);
    const stats: {
      total: number;
      filesAffected: number;
      bySeverity: Record<string, number>;
      byPattern: Record<string, number>;
      phpVersionRequired: string | null;
    } = {
      total: infos.length,
      filesAffected: new Set(infos.map(i => i.file)).size,
      bySeverity: { high: 0, medium: 0, low: 0 },
      byPattern: {},
      phpVersionRequired,
    };
    for (const i of infos) {
      stats.bySeverity[i.severity] = (stats.bySeverity[i.severity] ?? 0) + 1;
      stats.byPattern[i.pattern] = (stats.byPattern[i.pattern] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDnfTypesTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Absolute path to the Symfony application root' } };
  return [
    {
      name: 'list_php_dnf_types',
      description: 'Scan src/**/*.php for PHP 8.2 Disjunctive Normal Form (DNF) type patterns: (A&B)|C signatures, bare intersection types A&B (PHP 8.1+), (Countable&Iterator)|array combinations, missing PHPDoc for complex types, never return type misuse (return in never function)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_dnf_type_stats',
      description: 'Statistics for PHP 8.2 DNF type issues: total count, files affected, breakdown by severity (high/medium/low) and by pattern type, PHP version requirement from composer.json',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
