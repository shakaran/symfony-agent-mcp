/**
 * PHP DateTime Usage Inspector
 *
 * Scans src/ PHP for DateTime, DateTimeImmutable, Carbon, and procedural date functions.
 *
 * Warnings:
 *   - new DateTime() without timezone argument (non-reproducible)
 *   - DateTime mutated after passing to function (shared mutation)
 *   - Comparing DateTime with == (object comparison)
 *   - date() with 'U' (use time() instead)
 *   - strtotime() for relative dates (fragile)
 *   - date() instead of DateTimeImmutable::format() (procedural style)
 *   - Mixing DateTime and DateTimeImmutable (incompatible)
 *   - createFromFormat() without error check
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DateTimeUsage {
  class: 'DateTime' | 'DateTimeImmutable' | 'Carbon' | 'procedural';
  hasTimezone: boolean;
  issues: string[];
}

interface PhpDateTimeInfo {
  file: string;
  usages: DateTimeUsage[];
  mutableCount: number;
  immutableCount: number;
  proceduralCount: number;
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

function parseDateTimeFile(filePath: string): PhpDateTimeInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasDateTimeUse = content.includes('new DateTime(') ||
    content.includes('new DateTimeImmutable(') ||
    content.includes('Carbon::') ||
    content.includes('date(') ||
    content.includes('time()') ||
    content.includes('strtotime(') ||
    content.includes('new DateInterval(') ||
    content.includes('new DateTimeZone(') ||
    content.includes('createFromFormat(');

  if (!hasDateTimeUse) return null;

  const usages: DateTimeUsage[] = [];
  const fileIssues: string[] = [];

  // Detect new DateTime() usages
  const dtMatches = content.matchAll(/new\s+DateTime\s*\(([^)]{0,200})\)/g);
  for (const m of dtMatches) {
    const args = m[1].trim();
    const hasTimezone = args.includes('TimeZone') || args.includes('DateTimeZone') ||
      /,\s*\$\w{1,80}/.test(args) || args.includes("'UTC'") || args.includes('"UTC"') ||
      args.includes("'Europe") || args.includes('"Europe') || args.includes("'America");
    const u: DateTimeUsage = { class: 'DateTime', hasTimezone, issues: [] };
    if (!hasTimezone) {
      u.issues.push('new DateTime() without timezone — relies on server default (non-reproducible)');
    }
    usages.push(u);
  }

  // Detect new DateTimeImmutable() usages
  const dtiMatches = content.matchAll(/new\s+DateTimeImmutable\s*\(([^)]{0,200})\)/g);
  for (const m of dtiMatches) {
    const args = m[1].trim();
    const hasTimezone = args.includes('TimeZone') || args.includes('DateTimeZone') ||
      /,\s*\$\w{1,80}/.test(args) || args.includes("'UTC'") || args.includes('"UTC"') ||
      args.includes("'Europe") || args.includes('"Europe') || args.includes("'America");
    usages.push({ class: 'DateTimeImmutable', hasTimezone, issues: [] });
    if (!hasTimezone && args !== '') {
      // Only warn if a date string is passed (not default now)
    }
  }

  // Detect Carbon usages
  const carbonCount = (content.match(/Carbon::\w{1,80}\s*\(/g) ?? []).length;
  for (let ci = 0; ci < carbonCount; ci++) {
    usages.push({ class: 'Carbon', hasTimezone: true, issues: [] });
  }

  // Detect procedural date() usages
  const dateMatches = content.matchAll(/\bdate\s*\(\s*['"]([^'"]{0,50})['"]/g);
  for (const m of dateMatches) {
    const format = m[1];
    const u: DateTimeUsage = { class: 'procedural', hasTimezone: false, issues: [] };
    if (format.includes('U')) {
      u.issues.push("date() with 'U' format — use time() directly for Unix timestamp");
    }
    u.issues.push('date() is procedural style — prefer DateTimeImmutable::createFromFormat()::format()');
    usages.push(u);
  }

  // Detect strtotime() usage
  const strtotimeCount = (content.match(/\bstrtotime\s*\([^)]{0,100}\)/g) ?? []).length;
  for (let si = 0; si < strtotimeCount; si++) {
    usages.push({ class: 'procedural', hasTimezone: false, issues: ['strtotime() for relative dates is fragile — use DateInterval instead'] });
  }

  // File-level issues

  // DateTime mutated after passing to function
  const hasMutableDt = content.includes('new DateTime(');
  const dtPassedToFunc = /function\s+\w{1,80}\s*\([^)]{0,200}DateTime\s+\$\w{1,80}/.test(content);
  const dtModified = /\$\w{1,80}->(modify|setDate|setTime|setTimestamp|add|sub)\s*\(/.test(content);
  if (hasMutableDt && dtPassedToFunc && dtModified) {
    fileIssues.push('DateTime may be mutated after passing to function — causes shared state mutation; prefer DateTimeImmutable');
  }

  // Comparing DateTime with ==
  const dtCompareEq = /\$\w{1,80}\s*==\s*\$\w{1,80}/.test(content);
  if ((content.includes('DateTime') || content.includes('DateTimeImmutable')) && dtCompareEq) {
    fileIssues.push('DateTime compared with == — use DateTime::format() comparison or $a->getTimestamp() === $b->getTimestamp()');
  }

  // Mixing DateTime and DateTimeImmutable
  if (content.includes('new DateTime(') && content.includes('new DateTimeImmutable(')) {
    fileIssues.push('Mixing mutable DateTime and DateTimeImmutable — incompatible in comparisons and type hints');
  }

  // createFromFormat() without error check
  const createFromFormatMatches = content.matchAll(/createFromFormat\s*\([^)]{0,200}\)/g);
  for (const m of createFromFormatMatches) {
    const idx = content.indexOf(m[0]);
    const surrounding = content.slice(idx, idx + 200);
    const hasErrorCheck = surrounding.includes('=== false') ||
      surrounding.includes('!== false') ||
      surrounding.includes('getLastErrors') ||
      surrounding.includes('false ===');
    if (!hasErrorCheck) {
      fileIssues.push('createFromFormat() without error check — returns false on failure; check result !== false');
    }
  }

  const mutableCount = usages.filter((u) => u.class === 'DateTime').length;
  const immutableCount = usages.filter((u) => u.class === 'DateTimeImmutable').length;
  const proceduralCount = usages.filter((u) => u.class === 'procedural').length;

  if (usages.length === 0 && fileIssues.length === 0) return null;

  return {
    file: path.basename(filePath),
    usages,
    mutableCount,
    immutableCount,
    proceduralCount,
    issues: fileIssues,
  };
}

export function listPhpDateTime(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: PhpDateTimeInfo[] = [];

    for (const f of getAllPhpFiles(srcDir)) {
      const info = parseDateTimeFile(f);
      if (info) results.push(info);
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No DateTime usage found in src/.' }] };
    }

    results.sort((a, b) => a.file.localeCompare(b.file));
    const totalIssues = results.reduce((s, r) => s + r.issues.length + r.usages.reduce((si, u) => si + u.issues.length, 0), 0);

    let text = `PHP DateTime Usage Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Issues: ${totalIssues}\n`;

    for (const r of results) {
      text += `\n  ${r.file}\n`;
      text += `    DateTime: ${r.mutableCount}  DateTimeImmutable: ${r.immutableCount}  procedural: ${r.proceduralCount}\n`;
      for (const u of r.usages) {
        for (const issue of u.issues) text += `    ! [${u.class}] ${issue}\n`;
      }
      for (const issue of r.issues) text += `    ! ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpDateTimeStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: PhpDateTimeInfo[] = [];

    for (const f of getAllPhpFiles(srcDir)) {
      const info = parseDateTimeFile(f);
      if (info) results.push(info);
    }

    const mutableTotal = results.reduce((s, r) => s + r.mutableCount, 0);
    const immutableTotal = results.reduce((s, r) => s + r.immutableCount, 0);
    const proceduralTotal = results.reduce((s, r) => s + r.proceduralCount, 0);
    const totalIssues = results.reduce((s, r) => s + r.issues.length + r.usages.reduce((si, u) => si + u.issues.length, 0), 0);

    let text = `PHP DateTime Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with DateTime usage:      ${results.length}\n`;
    text += `Mutable DateTime instances:     ${mutableTotal}\n`;
    text += `Immutable DateTimeImmutable:    ${immutableTotal}\n`;
    text += `Procedural date()/strtotime():  ${proceduralTotal}\n`;
    text += `Total issues:                   ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpDateTimeTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_date_time',
      description: 'Scan PHP files for DateTime/DateTimeImmutable/Carbon/procedural date usage; warns on timezone-unaware creation, shared mutation, == comparison, date() with U format, strtotime() fragility, mixing mutable/immutable, createFromFormat() without error check',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_date_time_stats',
      description: 'Get statistics on PHP DateTime usage: mutable vs immutable vs procedural counts, files with DateTime usage, total issues detected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
