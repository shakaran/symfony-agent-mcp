// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpDateIntervalInfo {
  file: string;
  line: number;
  pattern: string;
  issue: string;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildPhpDateIntervalInfos(appPath: string): PhpDateIntervalInfo[] {
  const results: PhpDateIntervalInfo[] = [];

  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');

  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasDateInterval =
      content.includes('DateInterval') ||
      content.includes('DatePeriod') ||
      content.includes('->diff(') ||
      content.includes('createFromDateString(');

    if (!hasDateInterval) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // new DateInterval('P...') — ISO 8601 format usage (informational, no issue unless problematic pattern)
      const isoIntervalM = /new\s+DateInterval\s*\(\s*'(P[A-Z0-9T]{1,40})'\s*\)/.exec(line);
      if (isoIntervalM) {
        const spec = isoIntervalM[1];
        // new DateInterval(0) — wrong, should be 'PT0S'
        // This won't match due to format, handled separately
        results.push({
          file: relFile,
          line: lineNum,
          pattern: `new DateInterval('${spec}')`,
          issue: 'no issue — valid ISO 8601 interval specification',
        });
      }

      // new DateInterval(0) — common mistake
      if (/new\s+DateInterval\s*\(\s*0\s*\)/.test(line) || /new\s+DateInterval\s*\(\s*['"]0['"]\s*\)/.test(line)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'new DateInterval(0)',
          issue: 'new DateInterval(0) is invalid — zero interval must be expressed as "PT0S" (zero seconds); passing 0 will throw an exception at runtime',
        });
      }

      // Dynamic interval construction — potential injection
      if (/new\s+DateInterval\s*\(\s*['"]PT['"]\s*\.\s*\$/.test(line) || /new\s+DateInterval\s*\(\s*'P[^']*'\s*\.\s*\$/.test(line)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'new DateInterval(\'PT\' . $variable)',
          issue: 'Dynamic DateInterval construction using string concatenation with a variable — if the variable is user-supplied, this allows injection of arbitrary interval specs; validate/cast to integer before interpolating (e.g., (int)$hours)',
        });
      }

      // More general dynamic interval detection
      if (/new\s+DateInterval\s*\(\s*\$/.test(line)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'new DateInterval($variable)',
          issue: 'DateInterval constructed from a variable — ensure the variable is built from validated/integer values and not from user input; invalid ISO 8601 strings throw exceptions',
        });
      }

      // PT24H vs P1D — DST issue
      if (/new\s+DateInterval\s*\(\s*'PT24H'\s*\)/.test(line)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: "new DateInterval('PT24H')",
          issue: "PT24H interval does not respect DST transitions — on clocks-change days there are 23 or 25 hours; use P1D (1 calendar day) instead of PT24H to correctly advance by one day across DST boundaries",
        });
      }

      // PT48H, PT72H, etc. — same DST issue
      const ptHoursM = /new\s+DateInterval\s*\(\s*'PT([0-9]{2,4})H'\s*\)/.exec(line);
      if (ptHoursM && parseInt(ptHoursM[1], 10) >= 24) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: `new DateInterval('PT${ptHoursM[1]}H')`,
          issue: `PT${ptHoursM[1]}H (${parseInt(ptHoursM[1], 10) / 24} days in hours) does not account for DST transitions — use P${Math.floor(parseInt(ptHoursM[1], 10) / 24)}D for day-granularity intervals to avoid DST drift`,
        });
      }

      // $interval->days vs $interval->d confusion
      if (/\$[A-Za-z_][A-Za-z0-9_]{0,50}->days\b/.test(line) && content.includes('->diff(')) {
        // ->days gives total span in days; ->d gives the days component only
        results.push({
          file: relFile,
          line: lineNum,
          pattern: '$interval->days',
          issue: '$interval->days gives the total number of days across the entire interval (correct for "how many days between dates"); $interval->d gives only the days component (e.g., 1 month 5 days → d=5); verify you are using the right property for your use case',
        });
      }

      // DateTimeImmutable::diff() / DateTime::diff()
      if (/(?:DateTimeImmutable|DateTime|DateTimeInterface)::\s*diff\s*\(/.test(line) || /->diff\s*\(/.test(line)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: '->diff()',
          issue: 'no issue — diff() returns a DateInterval; check $result->invert property to determine direction (1 = negative/past), and use ->days for total day count',
        });
      }

      // new DatePeriod(
      if (/new\s+DatePeriod\s*\(/.test(line)) {
        const contextStart = Math.max(0, i - 1);
        const contextEnd = Math.min(lines.length - 1, i + 5);
        const context = lines.slice(contextStart, contextEnd + 1).join('\n');
        const hasExcludeStart = context.includes('EXCLUDE_START_DATE') || context.includes('DatePeriod::EXCLUDE_START_DATE');
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'new DatePeriod()',
          issue: !hasExcludeStart
            ? 'new DatePeriod() without DatePeriod::EXCLUDE_START_DATE flag — by default the start date IS included in the period; if you want to exclude the start date (e.g., for "next N occurrences after today"), pass DatePeriod::EXCLUDE_START_DATE as the 4th argument'
            : 'no issue — DatePeriod::EXCLUDE_START_DATE flag present',
        });
      }

      // createFromDateString('1 month') etc. — locale/timezone dependent
      if (/DateInterval::createFromDateString\s*\(/.test(line)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'DateInterval::createFromDateString()',
          issue: 'createFromDateString() is locale and timezone dependent — "1 month" is calendar-aware and may give unexpected results across DST transitions; ensure the application timezone is explicitly set and document expected behaviour',
        });
      }

      // DateInterval addition across DST transition — detect add() near DST dates
      if (/->add\s*\(\s*new\s+DateInterval\s*\(/.test(line)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: '->add(new DateInterval())',
          issue: 'DateTime::add() with a DateInterval across DST transition dates: adding P1D is safe (calendar day), but be aware that PT24H-based intervals will not adjust for DST; use DateTimeImmutable to avoid mutation side effects',
        });
      }
    }
  }

  return results;
}

export function listPhpDateInterval(appPath: string): McpToolResult {
  try {
    const infos = buildPhpDateIntervalInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP DateInterval / DatePeriod patterns found in src/.' }] };
    }
    const issues = infos.filter((i) => !i.issue.startsWith('no issue'));
    let text = `PHP DateInterval / DatePeriod Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      const isIssue = !info.issue.startsWith('no issue');
      text += `\n  ${info.file}:${info.line}  [${info.pattern}]\n`;
      if (isIssue) text += `    WARNING: ${info.issue}\n`;
      else text += `    INFO: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDateIntervalStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpDateIntervalInfos(appPath);
    const issues = infos.filter((i) => !i.issue.startsWith('no issue'));
    const patternCounts: Record<string, number> = {};
    for (const info of infos) {
      const key = info.pattern.replace(/\(.*$/, '()').trim();
      patternCounts[key] = (patternCounts[key] ?? 0) + 1;
    }
    let text = `PHP DateInterval Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total patterns: ${infos.length}\n`;
    text += `Issues:         ${issues.length}\n`;
    text += `\nPattern breakdown:\n`;
    for (const [pat, count] of Object.entries(patternCounts)) {
      text += `  ${pat}: ${count}\n`;
    }
    if (issues.length > 0) {
      text += `\nIssue breakdown:\n`;
      for (const info of issues) {
        text += `  - [${info.file}:${info.line}] ${info.pattern}: ${info.issue.slice(0, 120)}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDateIntervalTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_date_interval',
      description: 'Scan src/**/*.php for PHP DateInterval / DatePeriod patterns: new DateInterval ISO 8601 specs, dynamic interval construction (injection risk), DateTime::diff() / DateTimeImmutable::diff(), new DatePeriod() EXCLUDE_START_DATE flag, DST issues (PT24H vs P1D), $interval->days vs $interval->d confusion, DateTime::add() across DST, new DateInterval(0) common mistake, createFromDateString() locale dependency.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_date_interval_stats',
      description: 'Statistics for PHP DateInterval usage: pattern type breakdown and issue count.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
