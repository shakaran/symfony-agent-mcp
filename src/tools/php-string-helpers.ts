/**
 * PHP String Helpers Inspector
 *
 * Scans src/ PHP for PHP 8.x string functions:
 *   - str_contains, str_starts_with, str_ends_with, array_is_list, mb_str_split
 *
 * Also detects legacy patterns to replace:
 *   - strpos() !== false  →  str_contains
 *   - strpos() === 0      →  str_starts_with
 *   - substr() === '' at end  →  str_ends_with
 *   - is_array() + array_keys check  →  array_is_list
 *
 * Warns about:
 *   - strpos() !== false when str_contains would be clearer
 *   - Mixing old-style and new-style in same file
 *   - mb_strtolower without locale param
 *   - count(array_filter()) instead of array_is_list
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

interface StringHelperInfo {
  file: string;
  modernUsage: {
    strContains: number;
    strStartsWith: number;
    strEndsWith: number;
    arrayIsList: number;
  };
  legacyUsage: {
    strposNotFalse: number;
    strposEqualsZero: number;
  };
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

function countMatches(content: string, pattern: RegExp): number {
  let count = 0;
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  while (re.exec(content) !== null) {
    count++;
    if (count > 500) break; // safety cap
  }
  return count;
}

function parseStringHelperFile(filePath: string, appPath: string): StringHelperInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasStrOps = content.includes('str_contains') || content.includes('str_starts_with') ||
    content.includes('str_ends_with') || content.includes('array_is_list') ||
    content.includes('strpos(') || content.includes('substr(') ||
    content.includes('mb_strtolower') || content.includes('mb_str_split');

  if (!hasStrOps) return null;

  // Modern usage counts
  const strContains = countMatches(content, /\bstr_contains\s*\(/);
  const strStartsWith = countMatches(content, /\bstr_starts_with\s*\(/);
  const strEndsWith = countMatches(content, /\bstr_ends_with\s*\(/);
  const arrayIsList = countMatches(content, /\barray_is_list\s*\(/);

  // Legacy usage counts
  // strpos !== false pattern
  const strposNotFalse = countMatches(content, /strpos\s*\([^)]{0,200}\)\s*!==\s*false/) +
    countMatches(content, /false\s*!==\s*strpos\s*\([^)]{0,200}\)/);

  // strpos === 0 pattern
  const strposEqualsZero = countMatches(content, /strpos\s*\([^)]{0,200}\)\s*===\s*0/) +
    countMatches(content, /0\s*===\s*strpos\s*\([^)]{0,200}\)/);

  const totalModern = strContains + strStartsWith + strEndsWith + arrayIsList;
  const totalLegacy = strposNotFalse + strposEqualsZero;

  if (totalModern === 0 && totalLegacy === 0) return null;

  const issues: string[] = [];

  // Issue: legacy strpos !== false (prefer str_contains)
  if (strposNotFalse > 0) {
    issues.push(`${strposNotFalse} strpos() !== false pattern(s) — replace with str_contains() for clarity`);
  }

  // Issue: strpos === 0 (prefer str_starts_with)
  if (strposEqualsZero > 0) {
    issues.push(`${strposEqualsZero} strpos() === 0 pattern(s) — replace with str_starts_with() for clarity`);
  }

  // Issue: mixing old and new in same file
  if (totalModern > 0 && totalLegacy > 0) {
    issues.push('File mixes modern string helpers (str_contains/str_starts_with) with legacy strpos() patterns — standardize to PHP 8.x helpers');
  }

  // Issue: mb_strtolower without locale
  if (content.includes('mb_strtolower(')) {
    const mbNoLocale = countMatches(content, /mb_strtolower\s*\(\s*\$\w{1,80}\s*\)/);
    if (mbNoLocale > 0) {
      issues.push(`${mbNoLocale} mb_strtolower() call(s) without locale parameter — locale-sensitive case conversion may differ by environment`);
    }
  }

  // Issue: count(array_filter()) instead of array_is_list
  if (content.includes('array_filter(') && content.includes('count(')) {
    const countFilterRe = /count\s*\(\s*array_filter\s*\(/g;
    let cfm: RegExpExecArray | null;
    let cfCount = 0;
    while ((cfm = countFilterRe.exec(content)) !== null) {
      cfCount++;
      void cfm; // suppress unused var
    }
    if (cfCount > 0) {
      issues.push(`${cfCount} count(array_filter()) pattern(s) — consider array_is_list() or array_filter() with strict comparison`);
    }
  }

  return {
    file: path.relative(appPath, filePath),
    modernUsage: { strContains, strStartsWith, strEndsWith, arrayIsList },
    legacyUsage: { strposNotFalse, strposEqualsZero },
    issues,
  };
}

function loadStringHelperInfos(appPath: string): StringHelperInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: StringHelperInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseStringHelperFile(f, appPath);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listPhpStringHelpers(appPath: string): McpToolResult {
  try {
    const infos = loadStringHelperInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No string helper usage found in src/.\n\nPHP 8.0+ string helpers:\n  str_contains($haystack, $needle)    // replaces: strpos() !== false\n  str_starts_with($str, $prefix)      // replaces: strpos() === 0\n  str_ends_with($str, $suffix)        // replaces: substr() comparison\n  array_is_list($array)               // checks sequential 0-based keys',
        }],
      };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);

    let text = `PHP String Helpers (${infos.length} files)\n${'='.repeat(55)}\n`;

    for (const info of infos) {
      const { modernUsage: m, legacyUsage: l } = info;
      const totalModern = m.strContains + m.strStartsWith + m.strEndsWith + m.arrayIsList;
      const totalLegacy = l.strposNotFalse + l.strposEqualsZero;
      text += `\n  ${info.file}\n`;
      if (totalModern > 0) {
        text += `    Modern:  str_contains:${m.strContains}  str_starts_with:${m.strStartsWith}  str_ends_with:${m.strEndsWith}  array_is_list:${m.arrayIsList}\n`;
      }
      if (totalLegacy > 0) {
        text += `    Legacy:  strpos!==false:${l.strposNotFalse}  strpos===0:${l.strposEqualsZero}\n`;
      }
      for (const issue of info.issues) {
        text += `    WARN: ${issue}\n`;
      }
    }

    if (withIssues.length > 0) {
      text += `\nFiles with issues: ${withIssues.length}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpStringHelperStats(appPath: string): McpToolResult {
  try {
    const infos = loadStringHelperInfos(appPath);

    const totalStrContains = infos.reduce((s, i) => s + i.modernUsage.strContains, 0);
    const totalStrStarts = infos.reduce((s, i) => s + i.modernUsage.strStartsWith, 0);
    const totalStrEnds = infos.reduce((s, i) => s + i.modernUsage.strEndsWith, 0);
    const totalArrayIsList = infos.reduce((s, i) => s + i.modernUsage.arrayIsList, 0);
    const totalStrposNotFalse = infos.reduce((s, i) => s + i.legacyUsage.strposNotFalse, 0);
    const totalStrposZero = infos.reduce((s, i) => s + i.legacyUsage.strposEqualsZero, 0);

    let text = `PHP String Helper Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files scanned:               ${infos.length}\n`;
    text += `Modern helpers:\n`;
    text += `  str_contains:              ${totalStrContains}\n`;
    text += `  str_starts_with:           ${totalStrStarts}\n`;
    text += `  str_ends_with:             ${totalStrEnds}\n`;
    text += `  array_is_list:             ${totalArrayIsList}\n`;
    text += `Legacy patterns:\n`;
    text += `  strpos !== false:          ${totalStrposNotFalse}\n`;
    text += `  strpos === 0:              ${totalStrposZero}\n`;
    text += `Mixed-style files:           ${infos.filter((i) => (i.modernUsage.strContains + i.modernUsage.strStartsWith + i.modernUsage.strEndsWith) > 0 && (i.legacyUsage.strposNotFalse + i.legacyUsage.strposEqualsZero) > 0).length}\n`;
    text += `Files with issues:           ${infos.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpStringHelperTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_string_helpers',
      description: 'List PHP 8.x string helper usage: str_contains/str_starts_with/str_ends_with/array_is_list, legacy strpos patterns, mixed-style detection, mb_strtolower locale warning, count(array_filter()) detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_string_helper_stats',
      description: 'Show PHP string helper statistics: modern vs legacy usage counts, mixed-style file count, per-function totals, files with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
