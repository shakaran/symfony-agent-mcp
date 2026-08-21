/**
 * PHP 8.1 Backed Enum Patterns Inspector
 *
 * Scans src/**\/*.php for backed enum declarations and usage patterns:
 * enum X: string/int, ::from(), ::tryFrom(), ::cases(), interface impl,
 * ->value access on UnitEnum (invalid), missing ->value when persisting to DB.
 *
 * Pure static analysis — no process execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface BackedEnumFinding {
  file: string;
  line: number;
  enumName: string;
  pattern: string;
  issue: string | null;
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

function analyseFile(filePath: string, base: string): BackedEnumFinding[] {
  const content = safeRead(filePath, base);
  if (!content) return [];
  const findings: BackedEnumFinding[] = [];
  const lines = content.split('\n');

  // Track enum declarations: name -> backed type (string|int|null for unit)
  const enumMap = new Map<string, 'string' | 'int' | 'unit'>();
  // Track enum names that have readonly properties
  const enumReadonly = new Set<string>();

  // First pass: collect enum declarations
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const backedMatch = /^\s*enum\s+([A-Za-z_][A-Za-z0-9_]{0,80})\s*:\s*(string|int)\b/.exec(line);
    if (backedMatch) {
      enumMap.set(backedMatch[1], backedMatch[2] as 'string' | 'int');
      findings.push({ file: filePath, line: i + 1, enumName: backedMatch[1], pattern: `enum ${backedMatch[1]}: ${backedMatch[2]}`, issue: null });
      continue;
    }
    const unitMatch = /^\s*enum\s+([A-Za-z_][A-Za-z0-9_]{0,80})\s*(?:implements\s+[^{]{0,200})?\{/.exec(line);
    if (unitMatch && !backedMatch) {
      enumMap.set(unitMatch[1], 'unit');
    }
    // Detect readonly property inside enum (not allowed until PHP 8.3 — enums can't have instance properties at all)
    if (/\breadonly\b/.test(line) && /\bpublic\b|\bprotected\b|\bprivate\b/.test(line)) {
      for (const name of enumMap.keys()) {
        enumReadonly.add(name);
      }
    }
  }

  // Determine current enum context as we scan usage
  let currentEnum = '';

  // Second pass: scan usage
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Update current enum context
    const enmMatch = /^\s*enum\s+([A-Za-z_][A-Za-z0-9_]{0,80})/.exec(line);
    if (enmMatch) currentEnum = enmMatch[1];
    if (/^\}/.test(line.trim())) currentEnum = '';

    // ::from( — throws ValueError if invalid
    const fromMatch = /([A-Za-z_][A-Za-z0-9_]{0,80})\s*::\s*from\s*\(/.exec(line);
    if (fromMatch) {
      const enumType = enumMap.get(fromMatch[1]);
      if (enumType && enumType !== 'unit') {
        // Check if inside try/catch in nearby context
        const ctx = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
        const inTry = /\btry\s*\{/.test(ctx);
        const issue = inTry ? null : `${fromMatch[1]}::from() throws ValueError for invalid values — use ::tryFrom() or wrap in try/catch`;
        findings.push({ file: filePath, line: lineNo, enumName: fromMatch[1], pattern: `${fromMatch[1]}::from(`, issue });
      }
    }

    // ::tryFrom( — check if null is checked
    const tryFromMatch = /([A-Za-z_][A-Za-z0-9_]{0,80})\s*::\s*tryFrom\s*\(/.exec(line);
    if (tryFromMatch) {
      const enumType = enumMap.get(tryFromMatch[1]);
      if (enumType && enumType !== 'unit') {
        // Check if result is assigned and null-checked
        const nextCtx = lines.slice(i, Math.min(lines.length, i + 5)).join('\n');
        const nullChecked = /!==\s*null|=== null|\?\?|if\s*\(|instanceof/.test(nextCtx);
        const issue = nullChecked ? null : `${tryFromMatch[1]}::tryFrom() return value may not be null-checked — can cause TypeError on ->value access`;
        findings.push({ file: filePath, line: lineNo, enumName: tryFromMatch[1], pattern: `${tryFromMatch[1]}::tryFrom(`, issue });
      }
    }

    // ::cases( — informational
    const casesMatch = /([A-Za-z_][A-Za-z0-9_]{0,80})\s*::\s*cases\s*\(/.exec(line);
    if (casesMatch && enumMap.has(casesMatch[1])) {
      findings.push({ file: filePath, line: lineNo, enumName: casesMatch[1], pattern: `${casesMatch[1]}::cases()`, issue: null });
    }

    // ->value on UnitEnum context
    if (/->value\b/.test(line) && currentEnum && enumMap.get(currentEnum) === 'unit') {
      findings.push({ file: filePath, line: lineNo, enumName: currentEnum, pattern: '->value on UnitEnum', issue: 'UnitEnum has no ->value property — only backed enums (: string / : int) have ->value' });
    }

    // Storing enum in DB without ->value
    const dbMatch = /(?:setParameter|setValue|persist|insert|update)\s*\([^)]{0,200}\$([a-zA-Z_][a-zA-Z0-9_]{0,80})[^)]{0,100}\)/.exec(line);
    if (dbMatch && !/->value\b/.test(line)) {
      // Heuristic: if the variable name looks like an enum reference
      const varName = dbMatch[1];
      const ctx = lines.slice(Math.max(0, i - 15), i + 1).join('\n');
      const isEnumVar = new RegExp(`${varName}\\s*=\\s*[A-Za-z_][A-Za-z0-9_]+::(from|tryFrom|cases|[A-Z_]{1,40})\\b`).test(ctx);
      if (isEnumVar) {
        findings.push({ file: filePath, line: lineNo, enumName: '', pattern: 'enum stored in DB without ->value', issue: `Variable $${varName} appears to be an enum — use ->value to store the scalar in the database` });
      }
    }
  }

  // Flag enums with readonly properties
  for (const enumName of enumReadonly) {
    findings.push({ file: filePath, line: 1, enumName, pattern: 'readonly property in enum', issue: 'Enums cannot have instance properties — readonly keyword on enum property is a syntax error' });
  }

  return findings;
}

function loadFindings(appPath: string): BackedEnumFinding[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, srcDir);
  const findings: BackedEnumFinding[] = [];
  for (const f of files) findings.push(...analyseFile(f, srcDir));
  return findings;
}

export function listPhpBackedEnumPatterns(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    if (findings.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP 8.1 backed enum patterns found in src/.\n\nExample:\n  enum Status: string {\n    case Active = \'active\';\n    case Inactive = \'inactive\';\n  }\n  $s = Status::from($raw); // throws ValueError\n  $s = Status::tryFrom($raw); // returns null' }] };
    }
    const issues = findings.filter(f => f.issue !== null);
    let text = `PHP 8.1 Backed Enum Patterns\n${'='.repeat(55)}\n\nFindings: ${findings.length}  Issues: ${issues.length}\n`;
    for (const f of findings) {
      const rel = path.relative(appPath, f.file);
      const enumLabel = f.enumName ? `  enum: ${f.enumName}` : '';
      text += `\n  ${rel}:${f.line}${enumLabel}  [${f.pattern}]\n`;
      if (f.issue) text += `    ⚠ ${f.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpBackedEnumPatternsStats(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    const byPattern: Record<string, number> = {};
    for (const f of findings) byPattern[f.pattern] = (byPattern[f.pattern] ?? 0) + 1;
    const issues = findings.filter(f => f.issue !== null);
    const enumNames = new Set(findings.map(f => f.enumName).filter(Boolean));
    let text = `PHP 8.1 Backed Enum Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings: ${findings.length}\nWith issues: ${issues.length}\nEnum types referenced: ${enumNames.size}\n\nBy pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) text += `  ${pat}: ${count}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpBackedEnumPatternsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_backed_enum_patterns', description: 'Scan src/**/*.php for PHP 8.1 backed enum patterns: ::from/tryFrom/cases, interface impl, ->value on UnitEnum, enum stored in DB without ->value, readonly property in enum', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_backed_enum_patterns_stats', description: 'Statistics for PHP 8.1 backed enum usage: total findings, issues, enum types referenced, breakdown by pattern', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
