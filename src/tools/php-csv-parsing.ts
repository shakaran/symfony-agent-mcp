/**
 * PHP CSV Parsing Inspector
 *
 * Scans src/**\/*.php for CSV parsing patterns and common pitfalls.
 *
 * Detection:
 * - fgetcsv(): checks for missing encoding handling (no mb_convert_encoding/iconv nearby)
 * - str_getcsv() on file_get_contents() — entire file loaded into memory
 * - while + fgetcsv() pushing all results to array — unbounded memory growth
 * - League CSV: Reader::createFromPath/String — checks for setHeaderOffset(), charset handling
 * - Non-standard delimiter (;) without comment
 * - explode(',', $line) used as CSV parser — wrong, doesn't handle quoted fields
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpCsvParsingInfo {
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

function getContext(lines: string[], idx: number, before: number, after: number): string {
  const start = Math.max(0, idx - before);
  const end = Math.min(lines.length - 1, idx + after);
  return lines.slice(start, end + 1).join('\n').slice(0, 1000);
}

function scanPhpFile(filePath: string, appPath: string): PhpCsvParsingInfo[] {
  const raw = safeRead(filePath, appPath);
  if (!raw) return [];
  const relFile = path.relative(appPath, filePath);
  const lines = raw.split('\n');
  const results: PhpCsvParsingInfo[] = [];

  // Track state across lines
  let inWhileFgetcsv = false;
  let whileStartLine = -1;
  let pushingToArray = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].slice(0, 400);
    const lineNum = idx + 1;
    const trimmed = line.trim();

    // ---- fgetcsv() ----
    if (/\bfgetcsv\s*\(/.test(line)) {
      // Check for encoding handling in surrounding ±10 lines
      const context = getContext(lines, idx, 10, 10);
      const hasEncoding = /\bmb_convert_encoding\s*\(/.test(context)
        || /\biconv\s*\(/.test(context)
        || /setCharset\s*\(/.test(context)
        || /addStreamFilter\s*\(/.test(context);

      if (!hasEncoding) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'fgetcsv',
          issue: 'fgetcsv() without nearby encoding handling (mb_convert_encoding or iconv) — CSV files with non-UTF-8 encoding (e.g. Windows-1252/ISO-8859-1) will produce garbled output; add stream filter or convert before parsing',
          severity: 'medium',
        });
      }

      // Check for non-standard delimiter (;) without a comment explaining why
      if (/fgetcsv\s*\([^,)]{0,80},\s*\d{0,10},\s*['"]\s*;\s*['"]/.test(line)) {
        // Look back 5 lines for a comment
        const preceding = lines.slice(Math.max(0, idx - 5), idx).join('\n');
        const hasComment = /\/\/|\/\*|#/.test(preceding);
        if (!hasComment) {
          results.push({
            file: relFile,
            line: lineNum,
            pattern: 'fgetcsv-nonstandard-delimiter',
            issue: 'fgetcsv() with semicolon delimiter — non-standard CSV format; add a comment explaining why (e.g. // European locale CSV uses ; as delimiter)',
            severity: 'low',
          });
        }
      }

      // Detect while + fgetcsv
      if (/\bwhile\s*\(/.test(trimmed) || (idx > 0 && /\bwhile\s*\(/.test(lines[idx - 1].slice(0, 400)))) {
        inWhileFgetcsv = true;
        whileStartLine = lineNum;
        pushingToArray = false;
      }
    }

    // Detect array push inside a while+fgetcsv block
    if (inWhileFgetcsv) {
      if (/\[\s*\]\s*=/.test(line) || /array_push\s*\(/.test(line)) {
        pushingToArray = true;
      }
      // End of while block heuristic: closing brace at low indent
      if (/^\s*\}/.test(line) && idx > whileStartLine + 1) {
        if (pushingToArray) {
          results.push({
            file: relFile,
            line: whileStartLine,
            pattern: 'fgetcsv-unbounded-array',
            issue: 'while + fgetcsv() pushing all rows to array — unbounded memory growth for large files; process rows incrementally (yield, chunk, or limit with a max-row counter) instead of collecting all rows',
            severity: 'high',
          });
        }
        inWhileFgetcsv = false;
        pushingToArray = false;
        whileStartLine = -1;
      }
    }

    // ---- str_getcsv() ----
    if (/\bstr_getcsv\s*\(/.test(line)) {
      // Check if file_get_contents is in surrounding ±5 lines
      const context = getContext(lines, idx, 5, 2);
      if (/\bfile_get_contents\s*\(/.test(context) || /\bfile\s*\(/.test(context)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'str_getcsv-file-get-contents',
          issue: 'str_getcsv() on file_get_contents() output — entire CSV file loaded into memory at once; for large files use fgetcsv() with streaming fopen() instead',
          severity: 'high',
        });
      }
    }

    // ---- explode(',', $line) as CSV parsing ----
    // Match explode(',', ... or explode(";", ...
    if (/\bexplode\s*\(\s*['"][,;]['"]\s*,\s*\$/.test(line)) {
      // Check if this is in a context that looks like CSV row parsing
      const context = getContext(lines, idx, 5, 5);
      if (/\bfgets\s*\(/.test(context) || /\bfgetcsv\s*\(/.test(context)
          || /\.csv/i.test(context) || /\bcsv\b/i.test(context)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'explode-csv',
          issue: 'explode() used for CSV parsing — does not handle quoted fields containing commas or newlines; use fgetcsv() or str_getcsv() which correctly parse RFC 4180 CSV',
          severity: 'high',
        });
      }
    }

    // Also catch explode(',', $line) where variable is named $line/$row/$record
    if (/\bexplode\s*\(\s*['"],['"]\s*,\s*\$(line|row|record|csv)[^)]{0,60}\)/.test(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'explode-csv-variable',
        issue: 'explode(",", $row) for CSV row parsing — does not handle quoted fields; replace with str_getcsv($row) or use fgetcsv() on a file handle',
        severity: 'high',
      });
    }

    // ---- League CSV: Reader::createFromPath / Reader::createFromString ----
    if (/Reader::createFromPath\s*\(/.test(line) || /Reader::createFromString\s*\(/.test(line)) {
      const context = getContext(lines, idx, 2, 20);

      const hasHeaderOffset = /->setHeaderOffset\s*\(/.test(context);
      const hasCharset = /->setCharset\s*\(/.test(context) || /->addStreamFilter\s*\(/.test(context);

      if (!hasHeaderOffset) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'league-csv-no-header-offset',
          issue: 'League CSV Reader without setHeaderOffset() — the first row will be treated as data, not as column headers; add ->setHeaderOffset(0) to map rows to named keys',
          severity: 'medium',
        });
      }

      if (!hasCharset) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'league-csv-no-charset',
          issue: 'League CSV Reader without charset/stream filter handling — non-UTF-8 CSV files will produce garbled data; add ->addStreamFilter("convert.iconv.ISO-8859-1/UTF-8") or ->setCharset() as appropriate',
          severity: 'medium',
        });
      }

      if (hasHeaderOffset && hasCharset) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'league-csv',
          issue: 'League CSV Reader with header offset and charset handling configured (good practice)',
          severity: 'low',
        });
      }
    }
  }

  return results;
}

function buildPhpCsvParsingInfos(appPath: string): PhpCsvParsingInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: PhpCsvParsingInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  for (const f of getAllPhpFiles(srcDir)) {
    results.push(...scanPhpFile(f, appPath));
  }

  return results;
}

export function listPhpCsvParsing(appPath: string): McpToolResult {
  try {
    const infos = buildPhpCsvParsingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No CSV parsing patterns found in src/ PHP files.' }] };
    }

    const highSeverity = infos.filter((i) => i.severity === 'high');
    const mediumSeverity = infos.filter((i) => i.severity === 'medium');
    const lowSeverity = infos.filter((i) => i.severity === 'low');

    let text = `PHP CSV Parsing Analysis\n${'='.repeat(55)}\n\n`;
    text += `Findings: ${infos.length}  (high: ${highSeverity.length}, medium: ${mediumSeverity.length}, low: ${lowSeverity.length})\n\n`;

    for (const info of [...highSeverity, ...mediumSeverity, ...lowSeverity]) {
      const badge = info.severity === 'high' ? '[HIGH]  ' : info.severity === 'medium' ? '[MED]   ' : '[LOW]   ';
      text += `${badge} ${info.file}:${info.line}  pattern: ${info.pattern}\n`;
      text += `         ${info.issue}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpCsvParsingStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpCsvParsingInfos(appPath);

    const highCount = infos.filter((i) => i.severity === 'high').length;
    const medCount = infos.filter((i) => i.severity === 'medium').length;
    const lowCount = infos.filter((i) => i.severity === 'low').length;

    const patternCounts: Record<string, number> = {};
    for (const info of infos) {
      patternCounts[info.pattern] = (patternCounts[info.pattern] ?? 0) + 1;
    }

    const unboundedArray = infos.filter((i) => i.pattern === 'fgetcsv-unbounded-array').length;
    const strGetcsvMemory = infos.filter((i) => i.pattern === 'str_getcsv-file-get-contents').length;
    const explodeCsv = infos.filter((i) => i.pattern.startsWith('explode-csv')).length;
    const noEncoding = infos.filter((i) => i.pattern === 'fgetcsv' && i.issue.includes('encoding')).length;
    const leagueCsvIssues = infos.filter((i) => i.pattern.startsWith('league-csv') && i.severity !== 'low').length;

    let text = `PHP CSV Parsing Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings:            ${infos.length}\n`;
    text += `  High severity:           ${highCount}\n`;
    text += `  Medium severity:         ${medCount}\n`;
    text += `  Low / informational:     ${lowCount}\n`;
    text += `\nPattern breakdown:\n`;
    text += `  Unbounded while+fgetcsv: ${unboundedArray}\n`;
    text += `  str_getcsv+file_get_contents: ${strGetcsvMemory}\n`;
    text += `  explode() as CSV parser: ${explodeCsv}\n`;
    text += `  fgetcsv missing encoding:${noEncoding}\n`;
    text += `  League CSV issues:       ${leagueCsvIssues}\n`;

    const uniqueFiles = new Set(infos.map((i) => i.file)).size;
    text += `\nFiles with CSV patterns:   ${uniqueFiles}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpCsvParsingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_csv_parsing',
      description: 'Scan src/ PHP files for CSV parsing patterns: unbounded while+fgetcsv memory growth, str_getcsv on full file_get_contents, explode() misused as CSV parser, missing encoding handling, League CSV missing setHeaderOffset/charset',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_csv_parsing_stats',
      description: 'Show PHP CSV parsing statistics: total findings by severity, breakdown by pattern type (unbounded array, str_getcsv memory risk, explode-as-CSV, missing encoding, League CSV issues), unique files affected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
