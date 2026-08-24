// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP 8.4 Native Lazy Objects Inspector
 *
 * Scans src/**\/*.php for PHP 8.4 lazy object patterns:
 * ReflectionClass::newLazyGhost, newLazyProxy, initializeLazyObject,
 * isUninitializedLazyObject, markLazyObjectAsInitialized, resetAsLazyGhost,
 * resetAsLazyProxy.
 *
 * Also checks composer.json for PHP version requirement to flag compatibility.
 *
 * Pure static analysis — no process execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface LazyObjectFinding {
  file: string;
  line: number;
  pattern: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function safeReadAbs(filePath: string): string | null {
  try { return fs.readFileSync(path.resolve(filePath), 'utf-8'); } catch { return null; }
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

function getMinPhpVersion(appPath: string): string | null {
  const composerPath = path.join(appPath, 'composer.json');
  const raw = safeReadAbs(composerPath);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const req = obj['require'] as Record<string, unknown> | undefined;
    if (!req) return null;
    const phpReq = req['php'];
    if (typeof phpReq !== 'string') return null;
    // Extract first version number like >=8.1, ^8.2, ~8.3
    const m = /[>=^~]{0,2}(\d+\.\d+)/.exec(phpReq);
    return m ? m[1] : null;
  } catch { return null; }
}

const LAZY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /ReflectionClass\s*::\s*newLazyGhost\s*\(/,          label: 'ReflectionClass::newLazyGhost(' },
  { re: /ReflectionClass\s*::\s*newLazyProxy\s*\(/,          label: 'ReflectionClass::newLazyProxy(' },
  { re: /->initializeLazyObject\s*\(/,                        label: '->initializeLazyObject(' },
  { re: /->isUninitializedLazyObject\s*\(/,                   label: '->isUninitializedLazyObject(' },
  { re: /->markLazyObjectAsInitialized\s*\(/,                 label: '->markLazyObjectAsInitialized(' },
  { re: /->resetAsLazyGhost\s*\(/,                            label: '->resetAsLazyGhost(' },
  { re: /->resetAsLazyProxy\s*\(/,                            label: '->resetAsLazyProxy(' },
  { re: /#\[SkipLazyInitialization\]/,                        label: '#[SkipLazyInitialization]' },
];

function analyseFile(filePath: string, base: string, php84Compat: boolean): LazyObjectFinding[] {
  const content = safeRead(filePath, base);
  if (!content) return [];
  const findings: LazyObjectFinding[] = [];
  const lines = content.split('\n');

  // Collect constructor side-effect heuristics: constructor with non-trivial body
  const hasConstructorSideEffect = /function\s+__construct\s*\([^)]{0,300}\)\s*\{[^}]{20,}/.test(content);
  const hasSkipAttr = content.includes('#[SkipLazyInitialization]');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    for (const { re, label } of LAZY_PATTERNS) {
      if (!re.test(line)) continue;

      let issue: string | null = null;

      if (!php84Compat) {
        issue = 'PHP 8.4 lazy objects require php >= 8.4 in composer.json — current requirement may be lower';
      } else if (label === 'ReflectionClass::newLazyGhost(') {
        if (hasConstructorSideEffect && !hasSkipAttr) {
          issue = 'Lazy ghost used on class with constructor side effects and no #[SkipLazyInitialization] on sensitive properties — side effects run on first property access';
        }
      } else if (label === 'ReflectionClass::newLazyProxy(') {
        if (!hasSkipAttr) {
          issue = 'Lazy proxy without #[SkipLazyInitialization] on identity-sensitive properties — proxy and real instance differ by identity (===)';
        }
      } else if (label === '->resetAsLazyGhost(' || label === '->resetAsLazyProxy(') {
        issue = 'Resetting an already-initialized object as lazy — ensure callers handle the object becoming uninitialized again';
      }

      findings.push({ file: filePath, line: lineNo, pattern: label, issue });
    }
  }

  return findings;
}

function loadFindings(appPath: string): LazyObjectFinding[] {
  const srcDir = path.join(appPath, 'src');
  const phpVer = getMinPhpVersion(appPath);
  const php84Compat = phpVer !== null && parseFloat(phpVer) >= 8.4;
  const files = collectPhpFiles(srcDir, srcDir);
  const findings: LazyObjectFinding[] = [];
  for (const f of files) findings.push(...analyseFile(f, srcDir, php84Compat));
  return findings;
}

export function listPhpLazyObjects(appPath: string): McpToolResult {
  try {
    const phpVer = getMinPhpVersion(appPath);
    const findings = loadFindings(appPath);
    if (findings.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP 8.4 native lazy object patterns found in src/.\n\nExample:\n  $ref = new \\ReflectionClass(MyService::class);\n  $obj = $ref->newLazyGhost(fn($o) => $o->__construct(...$deps));' }] };
    }
    const issues = findings.filter(f => f.issue !== null);
    let text = `PHP 8.4 Lazy Objects\n${'='.repeat(55)}\n\n`;
    text += `PHP version in composer.json: ${phpVer ?? 'not detected'}\nFindings: ${findings.length}  Issues: ${issues.length}\n`;
    for (const f of findings) {
      const rel = path.relative(appPath, f.file);
      text += `\n  ${rel}:${f.line}  [${f.pattern}]\n`;
      if (f.issue) text += `    ⚠ ${f.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpLazyObjectsStats(appPath: string): McpToolResult {
  try {
    const phpVer = getMinPhpVersion(appPath);
    const findings = loadFindings(appPath);
    const byPattern: Record<string, number> = {};
    for (const f of findings) byPattern[f.pattern] = (byPattern[f.pattern] ?? 0) + 1;
    const issues = findings.filter(f => f.issue !== null);
    let text = `PHP 8.4 Lazy Objects Statistics\n${'='.repeat(40)}\n\n`;
    text += `PHP version requirement: ${phpVer ?? 'not detected'}\nTotal findings: ${findings.length}\nWith issues: ${issues.length}\n\nBy pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) text += `  ${pat}: ${count}\n`;
    const files = new Set(findings.map(f => f.file));
    text += `\nFiles using lazy objects: ${files.size}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpLazyObjectsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_lazy_objects', description: 'Scan src/**/*.php for PHP 8.4 native lazy object patterns: newLazyGhost/newLazyProxy/initializeLazyObject/resetAsLazy* — flags PHP < 8.4 usage, missing SkipLazyInitialization, constructor side effects', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_lazy_objects_stats', description: 'Statistics for PHP 8.4 lazy object usage: total findings, issues, breakdown by pattern, files affected', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
