/**
 * PHP Date/Timezone Handling Inspector
 *
 * Scans src/ PHP files for timezone handling issues:
 *   - date_default_timezone_set( — global side-effect
 *   - new DateTime( / new \DateTime( without adjacent DateTimeZone
 *   - new DateTimeImmutable( without adjacent DateTimeZone
 *   - strtotime( — ambiguous/locale-dependent
 *   - date( function — uses global default timezone
 *   - mktime( — deprecated patterns
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DateTimezoneInfo {
  file: string;
  line: number;
  pattern: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
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

function hasDateTimeZoneNearby(lines: string[], centerIdx: number, radius: number): boolean {
  const start = Math.max(0, centerIdx - radius);
  const end = Math.min(lines.length - 1, centerIdx + radius);
  for (let i = start; i <= end; i++) {
    if (/DateTimeZone/.test(lines[i])) return true;
  }
  return false;
}

function buildDateTimezoneInfos(appPath: string): DateTimezoneInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: DateTimezoneInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  for (const file of collectPhpFiles(srcDir, appPath)) {
    const content = safeRead(file, appPath);
    if (!content) continue;

    const lines = content.split('\n');
    const relFile = path.relative(appPath, file);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // date_default_timezone_set( — global side-effect, high severity
      if (/\bdate_default_timezone_set\s*\(/.test(trimmed)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'date_default_timezone_set',
          issue: 'date_default_timezone_set() mutates global timezone state — use new DateTimeZone() per object instance instead; global state is not safe in async/worker contexts',
          severity: 'high',
        });
      }

      // new DateTime( / new \DateTime( without nearby DateTimeZone
      if (/new\s+\\?DateTime\s*\(/.test(trimmed) && !/new\s+\\?DateTimeImmutable/.test(trimmed)) {
        if (!hasDateTimeZoneNearby(lines, i, 1)) {
          results.push({
            file: relFile,
            line: lineNum,
            pattern: 'new DateTime',
            issue: 'new DateTime() without explicit DateTimeZone — relies on date.timezone ini or date_default_timezone_set(); pass new DateTimeZone(\'UTC\') as second arg; also prefer DateTimeImmutable',
            severity: 'medium',
          });
        }
      }

      // new DateTimeImmutable( without nearby DateTimeZone
      if (/new\s+\\?DateTimeImmutable\s*\(/.test(trimmed)) {
        if (!hasDateTimeZoneNearby(lines, i, 1)) {
          results.push({
            file: relFile,
            line: lineNum,
            pattern: 'new DateTimeImmutable',
            issue: 'new DateTimeImmutable() without explicit DateTimeZone — relies on global timezone setting; pass new DateTimeZone(\'UTC\') as second arg for unambiguous behavior',
            severity: 'medium',
          });
        }
      }

      // strtotime( — ambiguous parsing
      if (/\bstrtotime\s*\(/.test(trimmed)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'strtotime',
          issue: 'strtotime() parses strings ambiguously and uses global timezone — replace with DateTimeImmutable::createFromFormat() with explicit format and DateTimeZone',
          severity: 'medium',
        });
      }

      // date( function call (not class method, not date_*)
      // Match standalone date( not preceded by -> or :: and not date_
      if (/(?<![->:_a-zA-Z0-9])\bdate\s*\(/.test(trimmed)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'date',
          issue: 'date() uses the global default timezone — use DateTimeImmutable::format() with explicit DateTimeZone for reliable cross-environment output',
          severity: 'low',
        });
      }

      // mktime( usage
      if (/\bmktime\s*\(/.test(trimmed)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'mktime',
          issue: 'mktime() creates timestamps using global timezone and has inconsistent DST handling — use DateTimeImmutable::createFromFormat() or DateTimeImmutable constructor instead',
          severity: 'medium',
        });
      }
    }
  }

  return results;
}

export function listPhpDateTimezone(appPath: string): McpToolResult {
  try {
    const infos = buildDateTimezoneInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No timezone handling issues found in src/ PHP files.' }] };
    }

    // Sort: high first, then medium, then low
    const severityOrder = { high: 0, medium: 1, low: 2 };
    infos.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    let text = `PHP Date/Timezone Handling Issues\n${'='.repeat(55)}\n\n`;
    text += `Total issues found: ${infos.length}\n`;
    text += `  High:   ${infos.filter((i) => i.severity === 'high').length}\n`;
    text += `  Medium: ${infos.filter((i) => i.severity === 'medium').length}\n`;
    text += `  Low:    ${infos.filter((i) => i.severity === 'low').length}\n\n`;

    for (const info of infos.slice(0, 60)) {
      text += `  [${info.severity.toUpperCase()}]  [${info.pattern}]  ${info.file}:${info.line}\n`;
      text += `    Issue: ${info.issue}\n\n`;
    }

    if (infos.length > 60) {
      text += `  ... and ${infos.length - 60} more issues\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDateTimezoneStats(appPath: string): McpToolResult {
  try {
    const infos = buildDateTimezoneInfos(appPath);

    const byPattern = new Map<string, number>();
    for (const info of infos) {
      byPattern.set(info.pattern, (byPattern.get(info.pattern) ?? 0) + 1);
    }

    const byFile = new Map<string, number>();
    for (const info of infos) {
      byFile.set(info.file, (byFile.get(info.file) ?? 0) + 1);
    }
    const topFiles = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    let text = `PHP Date/Timezone Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total issues: ${infos.length}\n`;
    text += `  High severity:    ${infos.filter((i) => i.severity === 'high').length}\n`;
    text += `  Medium severity:  ${infos.filter((i) => i.severity === 'medium').length}\n`;
    text += `  Low severity:     ${infos.filter((i) => i.severity === 'low').length}\n\n`;
    text += `By pattern:\n`;
    for (const [pattern, count] of [...byPattern.entries()].sort((a, b) => b[1] - a[1])) {
      text += `  ${String(count).padEnd(4)} ${pattern}\n`;
    }

    if (topFiles.length > 0) {
      text += `\nTop files by issue count:\n`;
      for (const [file, count] of topFiles) {
        text += `  ${count}  ${file}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDateTimezoneTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_date_timezone',
      description: 'List PHP date/timezone issues: date_default_timezone_set global side-effects, DateTime/DateTimeImmutable without explicit timezone, strtotime/date/mktime ambiguous usage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_date_timezone_stats',
      description: 'Show PHP date/timezone statistics: counts by severity (high/medium/low), counts by pattern type, top files by issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
