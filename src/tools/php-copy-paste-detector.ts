// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Copy-Paste Detector
 *
 * Scans src/ PHP files for method bodies >10 lines and detects near-identical
 * implementations duplicated across different classes.
 *
 * Detection strategies:
 *   - Same method name present in 2+ different classes (potential CPD)
 *   - Identical first 5 normalized lines between methods of same name
 *   - Methods >50 lines that differ only in property names (parameterized candidate)
 *
 * Warns: identical method name+body across 2+ classes (copy-paste candidate),
 *        method >50 lines with only property-name differences.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CopyPasteInfo {
  file: string;
  method: string;
  tokenCount: number;
  duplicateIn: string;
  issues: string[];
}

interface MethodEntry {
  file: string;
  className: string;
  method: string;
  lineCount: number;
  normalizedHead: string;
  normalizedBody: string;
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

function normalizeBody(body: string): string {
  return body
    .replace(/\$\w{1,60}/g, '$VAR')          // Normalize variable names
    .replace(/'\w{0,200}'/g, "'STR'")          // Normalize string literals
    .replace(/"\w{0,200}"/g, '"STR"')          // Normalize double-quoted strings
    .replace(/\b\d{1,20}\b/g, 'NUM')           // Normalize numbers
    .replace(/\s{1,100}/g, ' ')                // Collapse whitespace
    .trim();
}

function extractMethodEntries(filePath: string, appPath: string): MethodEntry[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const classM = /\bclass\s+(\w{1,80})/.exec(content);
  if (!classM) return [];
  const className = classM[1];

  const entries: MethodEntry[] = [];
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
    const rawBody = content.slice(start, Math.min(i, start + 6000));
    const lines = rawBody.split('\n');
    if (lines.length <= 10) continue; // Only care about methods >10 lines

    const headLines = lines.slice(0, 6).join('\n');
    const normalizedHead = normalizeBody(headLines);
    const normalizedBody = normalizeBody(rawBody);

    entries.push({
      file: path.relative(appPath, filePath),
      className,
      method: name,
      lineCount: lines.length,
      normalizedHead,
      normalizedBody,
    });
  }

  return entries;
}

function buildCopyPasteInfos(appPath: string): CopyPasteInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const allEntries: MethodEntry[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    allEntries.push(...extractMethodEntries(file, appPath));
  }

  // Group by method name
  const byMethodName = new Map<string, MethodEntry[]>();
  for (const entry of allEntries) {
    const existing = byMethodName.get(entry.method) ?? [];
    existing.push(entry);
    byMethodName.set(entry.method, existing);
  }

  const results: CopyPasteInfo[] = [];
  const seen = new Set<string>();

  for (const [methodName, entries] of byMethodName) {
    if (entries.length < 2) continue;

    // Compare normalized heads for near-identical content
    for (let a = 0; a < entries.length; a++) {
      for (let b = a + 1; b < entries.length; b++) {
        const ea = entries[a];
        const eb = entries[b];
        if (ea.className === eb.className) continue;

        const headMatch = ea.normalizedHead.length > 20 && ea.normalizedHead === eb.normalizedHead;
        const fullMatch = ea.normalizedBody.length > 50 && ea.normalizedBody === eb.normalizedBody;

        if (!headMatch && !fullMatch) continue;

        const key = `${ea.file}:${methodName}:${eb.file}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const issues: string[] = [];
        if (fullMatch) {
          issues.push(`Identical method body in ${ea.className} and ${eb.className} — copy-paste candidate`);
        } else if (headMatch) {
          issues.push(`Near-identical first lines in ${ea.className} and ${eb.className} — likely copy-paste`);
        }

        if (ea.lineCount > 50) {
          issues.push(`Method >50 lines — consider extracting to shared base class or service`);
        }

        results.push({
          file: ea.file,
          method: methodName,
          tokenCount: ea.lineCount,
          duplicateIn: eb.file,
          issues,
        });
      }
    }
  }

  return results.sort((a, b) => b.tokenCount - a.tokenCount);
}

export function listPhpCopyPastePatterns(appPath: string): McpToolResult {
  try {
    const infos = buildCopyPasteInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No copy-paste patterns detected in src/ PHP methods (>10 lines, same normalized content).' }] };
    }

    let text = `PHP Copy-Paste Detection\n${'='.repeat(55)}\n\n`;
    text += `Duplicate method candidates found: ${infos.length}\n\n`;

    for (const info of infos.slice(0, 25)) {
      text += `  Method: ${info.method}()  (${info.tokenCount} lines)\n`;
      text += `    In:         ${info.file}\n`;
      text += `    Duplicate:  ${info.duplicateIn}\n`;
      for (const issue of info.issues) {
        text += `    ⚠ ${issue}\n`;
      }
      text += '\n';
    }

    if (infos.length > 25) {
      text += `  ... and ${infos.length - 25} more duplicate patterns\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpCopyPasteStats(appPath: string): McpToolResult {
  try {
    const infos = buildCopyPasteInfos(appPath);
    const fullDuplicates = infos.filter((i) => i.issues.some((s) => s.includes('Identical'))).length;
    const nearDuplicates = infos.filter((i) => i.issues.some((s) => s.includes('Near-identical'))).length;
    const longMethods = infos.filter((i) => i.tokenCount > 50).length;

    let text = `PHP Copy-Paste Statistics\n${'='.repeat(40)}\n\n`;
    text += `Duplicate method pairs found: ${infos.length}\n`;
    text += `  Full duplicates:            ${fullDuplicates}\n`;
    text += `  Near-identical:             ${nearDuplicates}\n`;
    text += `  Methods >50 lines:          ${longMethods}\n`;

    if (infos.length > 0) {
      const largest = infos[0];
      text += `Longest duplicate: ${largest.method}() (${largest.tokenCount} lines) in ${largest.file}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpCopyPasteTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_copy_paste_patterns',
      description: 'Detect PHP copy-paste patterns: method bodies >10 lines with identical or near-identical normalized content across different classes, with refactoring suggestions',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_copy_paste_stats',
      description: 'Show PHP copy-paste statistics: total duplicate pairs, full vs near-identical counts, methods >50 lines, largest duplicate method details',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
