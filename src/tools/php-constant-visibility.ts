/**
 * PHP 8.3 Class Constant Visibility Inspector
 *
 * Scans src/**\/*.php for PHP 8.3 class constant visibility patterns:
 *   - private const override in class implementing interface (PHP fatal error risk)
 *   - final const in non-final class (unusual pattern)
 *   - private const inside trait (unsupported before PHP 8.2)
 *   - #[Override] attribute missing on overriding const
 *   - Interface const without explicit public keyword
 *
 * Pure static analysis — no process execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ConstantVisibilityInfo {
  file: string;
  line: number;
  pattern: string;
  severity: 'high' | 'medium' | 'low';
  issue: string;
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
): ConstantVisibilityInfo[] {
  const content = safeRead(filePath, base);
  if (!content) return [];

  const findings: ConstantVisibilityInfo[] = [];
  const lines = content.split('\n');
  const relFile = path.relative(base, filePath);

  const isInterface = /\binterface\s+\w/.test(content);
  const hasImplements = /\bclass\s+\w[^{]*\bimplements\b/.test(content);
  const hasExtends = /\bclass\s+\w[^{]*\bextends\b/.test(content);
  const hasFinalClass = /\bfinal\s+class\b/.test(content);
  const isInTrait = /\btrait\s+\w/.test(content);

  // Collect interface constants (name -> line) for cross-file check (same-file only)
  const interfaceConstants = new Set<string>();
  if (isInterface) {
    for (let i = 0; i < lines.length; i++) {
      const m = /\bconst\s+([A-Z_][A-Z0-9_]{0,80})\b/.exec(lines[i]);
      if (m) interfaceConstants.add(m[1]);
    }
  }

  // Collect class constants for parent-child same-file check
  const classConstants = new Map<string, number>();

  // Track block context: interface, class, trait
  let braceDepth = 0;
  const contextStack: Array<'interface' | 'class' | 'trait' | 'other'> = [];
  let currentContext: 'interface' | 'class' | 'trait' | 'other' = 'other';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();

    // Detect context declarations
    if (/\binterface\s+\w/.test(trimmed)) {
      contextStack.push(currentContext);
      currentContext = 'interface';
    } else if (/\btrait\s+\w/.test(trimmed)) {
      contextStack.push(currentContext);
      currentContext = 'trait';
    } else if (/\b(?:abstract\s+|final\s+)?class\s+\w/.test(trimmed)) {
      contextStack.push(currentContext);
      currentContext = 'class';
    }

    // Track brace depth
    for (const ch of trimmed) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0 && contextStack.length > 0) {
          currentContext = contextStack.pop() ?? 'other';
        }
      }
    }

    // Pattern 1: private const in class with implements -> MEDIUM risk
    if (currentContext === 'class' && hasImplements) {
      const m = /\bprivate\s+const\s+([A-Z_][A-Z0-9_]{0,80})\b/.exec(line);
      if (m) {
        findings.push({
          file: relFile,
          line: lineNo,
          pattern: 'private-const-implements',
          severity: 'medium',
          issue: `private const ${m[1]} in a class implementing an interface — if the interface declares the same constant, PHP will throw a fatal error (interface constants cannot be overridden with private visibility)`,
        });
      }
    }

    // Pattern 2: final const in non-final class -> LOW risk
    if (currentContext === 'class' && !hasFinalClass) {
      const m = /\bfinal\s+const\s+([A-Z_][A-Z0-9_]{0,80})\b/.exec(line);
      if (m) {
        findings.push({
          file: relFile,
          line: lineNo,
          pattern: 'final-const-non-final-class',
          severity: 'low',
          issue: `final const ${m[1]} declared in a non-final class — unusual pattern; consider making the class final or removing the final modifier from the constant`,
        });
      }
    }

    // Pattern 3: private const inside trait (unsupported before PHP 8.2) -> HIGH if PHP < 8.2
    if (currentContext === 'trait' || (isInTrait && currentContext !== 'interface')) {
      const m = /\bprivate\s+const\s+([A-Z_][A-Z0-9_]{0,80})\b/.exec(line);
      if (m) {
        const phpTooLow = phpVersionConstraint ? isPhpVersionBelow(phpVersionConstraint, 8, 2) : false;
        findings.push({
          file: relFile,
          line: lineNo,
          pattern: 'private-const-in-trait',
          severity: phpTooLow ? 'high' : 'medium',
          issue: `private const ${m[1]} inside a trait — this requires PHP >= 8.2${phpVersionConstraint ? ` (project requires ${phpVersionConstraint})` : ''}; fatal error on older PHP versions`,
        });
      }
    }

    // Pattern 4: const in class with extends, same name in file without #[Override] -> LOW risk
    // Collect class constants to detect override pattern
    if (currentContext === 'class') {
      const constMatch = /\b(?:public\s+|protected\s+|private\s+)?const\s+([A-Z_][A-Z0-9_]{0,80})\b/.exec(line);
      if (constMatch) {
        const constName = constMatch[1];
        if (classConstants.has(constName) && hasExtends) {
          // Check for #[Override] attribute on the previous few lines
          const prevLines = lines.slice(Math.max(0, i - 3), i).join('\n');
          const hasOverrideAttr = /#\[Override\]/.test(prevLines);
          if (!hasOverrideAttr) {
            findings.push({
              file: relFile,
              line: lineNo,
              pattern: 'missing-override-attribute',
              severity: 'low',
              issue: `const ${constName} appears to override a parent constant in the same file but is missing the #[Override] attribute (PHP 8.3+)`,
            });
          }
        } else {
          classConstants.set(constName, lineNo);
        }
      }
    }

    // Pattern 5: interface constant without explicit public keyword -> LOW risk
    if (currentContext === 'interface') {
      // Detect: const SOMETHING without public/protected/private prefix
      const m = /^\s*(?!(?:public|protected|private|final)\s)const\s+([A-Z_][A-Z0-9_]{0,80})\b/.exec(line);
      if (m) {
        findings.push({
          file: relFile,
          line: lineNo,
          pattern: 'interface-const-implicit-public',
          severity: 'low',
          issue: `Interface constant ${m[1]} has no explicit visibility modifier — should be declared public const for clarity (PHP 8.1+ allows interface constant visibility)`,
        });
      }
    }
  }

  return findings;
}

function buildInfos(appPath: string): ConstantVisibilityInfo[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, srcDir);
  const phpVersion = readMinPhpVersion(appPath);
  const findings: ConstantVisibilityInfo[] = [];
  for (const f of files) findings.push(...analyseFile(f, srcDir, phpVersion));
  return findings;
}

export function listPhpConstantVisibility(appPath: string): McpToolResult {
  try {
    const infos = buildInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP constant visibility issues found in src/.' }] };
    }
    let text = `PHP 8.3 Constant Visibility Issues\n${'='.repeat(50)}\n\nTotal: ${infos.length}\n\n`;
    for (const info of infos) {
      text += `  [${info.severity.toUpperCase()}] [${info.pattern}] ${info.file}:${info.line}\n`;
      text += `    ${info.issue}\n\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpConstantVisibilityStats(appPath: string): McpToolResult {
  try {
    const infos = buildInfos(appPath);
    const stats = {
      total: infos.length,
      filesAffected: new Set(infos.map(i => i.file)).size,
      bySeverity: { high: 0, medium: 0, low: 0 } as Record<string, number>,
      byPattern: {} as Record<string, number>,
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

export function getPhpConstantVisibilityTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Absolute path to the Symfony application root' } };
  return [
    {
      name: 'list_php_constant_visibility',
      description: 'Scan src/**/*.php for PHP 8.3 class constant visibility issues: private const overriding interface const (fatal error risk), final const in non-final class, private const in trait (PHP < 8.2 incompatibility), missing #[Override] attribute on overriding constants, interface constants without explicit public keyword',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_constant_visibility_stats',
      description: 'Statistics for PHP constant visibility issues: total count, files affected, breakdown by severity (high/medium/low) and by pattern type',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
