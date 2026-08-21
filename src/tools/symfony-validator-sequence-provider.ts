/**
 * Symfony Validator GroupSequenceProvider Inspector
 *
 * Scans src/**\/*.php for classes implementing GroupSequenceProviderInterface,
 * #[GroupSequenceProvider] attribute usage, GroupSequence creation,
 * and related issues such as missing Default group and circular references.
 *
 * Pure static analysis — no process execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SequenceProviderFinding {
  file: string;
  class: string;
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

// Extract array elements from a GroupSequence constructor call (shallow parse)
function extractGroupNames(segment: string): string[] {
  const groups: string[] = [];
  // Match string literals: 'Group' or "Group"
  const re = /['"]([A-Za-z][A-Za-z0-9_]{0,80})['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    groups.push(m[1]);
  }
  return groups;
}

function analyseFile(filePath: string, base: string): SequenceProviderFinding[] {
  const content = safeRead(filePath, base);
  if (!content) return [];

  const hasGroupSequenceProvider = content.includes('GroupSequenceProviderInterface') || content.includes('#[GroupSequenceProvider]');
  const hasGroupSequence = content.includes('GroupSequence');

  if (!hasGroupSequenceProvider && !hasGroupSequence) return [];

  const findings: SequenceProviderFinding[] = [];
  const lines = content.split('\n');

  const classMatch = /class\s+([A-Za-z_][A-Za-z0-9_]{0,80})/.exec(content);
  const className = classMatch ? classMatch[1] : path.basename(filePath, '.php');

  // #[GroupSequenceProvider] attribute
  if (content.includes('#[GroupSequenceProvider]')) {
    // Check if class also has getGroupSequence method
    const hasMethod = /function\s+getGroupSequence\s*\(/.test(content);
    const issue = hasMethod ? null : 'Class has #[GroupSequenceProvider] attribute but no getGroupSequence() method — must implement GroupSequenceProviderInterface';
    findings.push({ file: filePath, class: className, pattern: '#[GroupSequenceProvider]', issue });
  }

  // GroupSequenceProviderInterface
  if (content.includes('GroupSequenceProviderInterface')) {
    const hasMethod = /function\s+getGroupSequence\s*\(/.test(content);
    const issue = hasMethod ? null : 'Class implements GroupSequenceProviderInterface but getGroupSequence() method not found in this file';
    findings.push({ file: filePath, class: className, pattern: 'GroupSequenceProviderInterface', issue });
  }

  // Deprecated #[Assert\GroupSequence]
  if (/#\[Assert\\GroupSequence\]/.test(content) || /Assert\\GroupSequence/.test(content)) {
    findings.push({ file: filePath, class: className, pattern: '#[Assert\\GroupSequence]', issue: '#[Assert\\GroupSequence] is deprecated in Symfony 7.x — use #[GroupSequenceProvider] attribute on the class instead' });
  }

  // new GroupSequence([...]) usage
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/new\s+GroupSequence\s*\(/.test(line)) continue;

    // Grab content between first [ and matching ]
    const startIdx = line.indexOf('[');
    if (startIdx === -1) continue;
    const segment = line.slice(startIdx);
    const groups = extractGroupNames(segment);

    let issue: string | null = null;
    if (groups.length === 0) {
      issue = 'new GroupSequence([]) — empty sequence; add at minimum [\'Default\'] to preserve default constraints';
    } else if (!groups.includes('Default')) {
      issue = `GroupSequence [${groups.join(', ')}] does not include 'Default' group — constraints in Default group will be skipped`;
    }

    findings.push({ file: filePath, class: className, pattern: 'new GroupSequence([...])', issue });
  }

  // getGroupSequence() — flag complex conditions for review
  const getGroupSeqMatch = /function\s+getGroupSequence\s*\([^)]{0,200}\)\s*\{([^}]{0,2000})\}/s.exec(content);
  if (getGroupSeqMatch) {
    const body = getGroupSeqMatch[1];
    const conditionCount = (body.match(/\bif\b|\bswitch\b|\bmatch\b/g) ?? []).length;
    if (conditionCount > 3) {
      findings.push({ file: filePath, class: className, pattern: 'getGroupSequence() complex conditions', issue: `getGroupSequence() has ${conditionCount} conditional branches — complex state-based group sequences are hard to reason about; consider a dedicated validator or simpler group structure` });
    }

    // Circular reference heuristic: group string that appears as another group's name
    const allGroups: string[] = [];
    const re = /['"]([A-Za-z][A-Za-z0-9_]{0,80})['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) allGroups.push(m[1]);
    const seen = new Set<string>();
    const duplicates = allGroups.filter(g => {
      if (seen.has(g)) return true;
      seen.add(g);
      return false;
    });
    if (duplicates.length > 0) {
      findings.push({ file: filePath, class: className, pattern: 'duplicate group names in sequence', issue: `Group(s) [${[...new Set(duplicates)].join(', ')}] appear more than once in group sequence — may indicate circular reference or unintentional duplication` });
    }
  }

  return findings;
}

function loadFindings(appPath: string): SequenceProviderFinding[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, srcDir);
  const findings: SequenceProviderFinding[] = [];
  for (const f of files) findings.push(...analyseFile(f, srcDir));
  return findings;
}

export function listSymfonyValidatorSequenceProvider(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    if (findings.length === 0) {
      return { content: [{ type: 'text', text: 'No GroupSequenceProvider patterns found in src/.\n\nExample:\n  #[GroupSequenceProvider]\n  class MyEntity implements GroupSequenceProviderInterface {\n    public function getGroupSequence(): GroupSequence|array {\n      return new GroupSequence([\'Default\', \'Extra\']);\n    }\n  }' }] };
    }
    const issues = findings.filter(f => f.issue !== null);
    let text = `Symfony Validator GroupSequenceProvider\n${'='.repeat(55)}\n\nFindings: ${findings.length}  Issues: ${issues.length}\n`;
    for (const f of findings) {
      const rel = path.relative(appPath, f.file);
      text += `\n  ${f.class}  [${rel}]  pattern: ${f.pattern}\n`;
      if (f.issue) text += `    ⚠ ${f.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyValidatorSequenceProviderStats(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    const byPattern: Record<string, number> = {};
    for (const f of findings) byPattern[f.pattern] = (byPattern[f.pattern] ?? 0) + 1;
    const issues = findings.filter(f => f.issue !== null);
    let text = `Symfony Validator GroupSequenceProvider Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings: ${findings.length}\nWith issues: ${issues.length}\n\nBy pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) text += `  ${pat}: ${count}\n`;
    const files = new Set(findings.map(f => f.file));
    text += `\nFiles with GroupSequence usage: ${files.size}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyValidatorSequenceProviderTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_validator_sequence_provider', description: 'Scan src/**/*.php for GroupSequenceProvider pattern: GroupSequenceProviderInterface, #[GroupSequenceProvider], new GroupSequence() — flags missing Default group, circular references, deprecated #[Assert\\GroupSequence], complex conditional sequences', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_validator_sequence_provider_stats', description: 'Statistics for GroupSequenceProvider usage: findings count, issues count, breakdown by pattern, files affected', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
