/**
 * PHP Static Analysis Suppression Inspector
 *
 * Scans src/ PHP for inline suppression comments:
 *   - @phpstan-ignore, @phpstan-ignore-next-line
 *   - @psalm-suppress
 *   - @phpcs:ignore, @phpcs:disable
 *   - @SuppressWarnings
 *
 * Also reads phpstan.neon ignoreErrors count, psalm.xml suppressions.
 *
 * Detects:
 *   - Suppressions per file
 *   - Suppressions without explanation comment
 *   - Same suppression repeated many times (pattern issue)
 *
 * Warns:
 *   - File with >10 suppressions (technical debt)
 *   - @phpstan-ignore without reason code (ignores everything)
 *   - @psalm-suppress MixedAssignment more than 5 times
 *   - @phpcs:disable without corresponding @phpcs:enable
 *   - Same type of suppression in >10 files (systematic issue)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface SuppressionEntry {
  type: string;
  reason?: string;
  issues: string[];
}

interface StaticAnalysisIgnoreInfo {
  file: string;
  suppressions: SuppressionEntry[];
  totalCount: number;
  issues: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── Suppression patterns ─────────────────────────────────────────────────────

interface SuppressionMatch {
  type: string;
  reason?: string;
}

const SUPPRESSION_PATTERNS: Array<{ re: RegExp; type: string }> = [
  { re: /@phpstan-ignore-next-line(?:\s+([^\n]{0,120}))?/g,     type: 'phpstan-ignore-next-line' },
  { re: /@phpstan-ignore(?:\s+([^\n]{0,120}))?/g,               type: 'phpstan-ignore' },
  { re: /@psalm-suppress\s+([\w]{1,80})(?:\s+([^\n]{0,100}))?/g, type: 'psalm-suppress' },
  { re: /@phpcs:ignore(?:\s+([^\n]{0,120}))?/g,                  type: 'phpcs:ignore' },
  { re: /@phpcs:disable(?:\s+([^\n]{0,120}))?/g,                 type: 'phpcs:disable' },
  { re: /@phpcs:enable(?:\s+([^\n]{0,120}))?/g,                  type: 'phpcs:enable' },
  { re: /@SuppressWarnings\s*\(\s*"([^"]{1,80})"\s*\)/g,        type: 'SuppressWarnings' },
];

function extractSuppressions(content: string): SuppressionMatch[] {
  const matches: SuppressionMatch[] = [];
  for (const { re, type } of SUPPRESSION_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      matches.push({ type, reason: m[1]?.trim() || undefined });
    }
  }
  return matches;
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string): StaticAnalysisIgnoreInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const raw = extractSuppressions(content);
  if (raw.length === 0) return null;

  const issues: string[] = [];
  const suppMap = new Map<string, number>();

  const suppressions: SuppressionEntry[] = raw.map((s): SuppressionEntry => {
    const entryIssues: string[] = [];

    if (s.type === 'phpstan-ignore-next-line' && !s.reason) {
      entryIssues.push('@phpstan-ignore-next-line without rule code — suppresses all PHPStan errors on next line.');
    }
    if (s.type === 'phpstan-ignore' && !s.reason) {
      entryIssues.push('@phpstan-ignore without rule code — suppresses all PHPStan errors.');
    }

    suppMap.set(s.type, (suppMap.get(s.type) ?? 0) + 1);
    return { type: s.type, reason: s.reason, issues: entryIssues };
  });

  if (raw.length > 10) {
    issues.push(
      `File has ${raw.length} suppressions (>10). ` +
      `This indicates significant technical debt — fix root causes.`,
    );
  }

  // psalm-suppress MixedAssignment repeated >5 times
  const mixedCount = raw.filter(
    (s) => s.type === 'psalm-suppress' && s.reason?.startsWith('Mixed'),
  ).length;
  if (mixedCount > 5) {
    issues.push(
      `${mixedCount} @psalm-suppress MixedAssignment-style suppressions — type-unsafe code pattern.`,
    );
  }

  // phpcs:disable without phpcs:enable
  const disableCount = raw.filter((s) => s.type === 'phpcs:disable').length;
  const enableCount  = raw.filter((s) => s.type === 'phpcs:enable').length;
  if (disableCount > enableCount) {
    issues.push(
      `@phpcs:disable (${disableCount}) without matching @phpcs:enable (${enableCount}). ` +
      `Disables code style checks for the rest of the file.`,
    );
  }

  return {
    file: path.basename(filePath),
    suppressions,
    totalCount: raw.length,
    issues,
  };
}

// ─── Config file scanning ─────────────────────────────────────────────────────

function readPhpStanIgnoreCount(appPath: string): number {
  const neon = path.join(appPath, 'phpstan.neon');
  try {
    const content = fs.readFileSync(neon, 'utf-8');
    const matches = content.match(/ignoreErrors\s*:/g) ?? [];
    // Count array items under ignoreErrors
    const section = /ignoreErrors\s*:\s*\n((?:\s{0,10}-[^\n]{0,200}\n){0,200})/.exec(content);
    if (section) return (section[1].match(/^\s{0,10}-/gm) ?? []).length;
    return matches.length;
  } catch { return 0; }
}

function readPsalmSuppressCount(appPath: string): number {
  const xml = path.join(appPath, 'psalm.xml');
  try {
    const content = fs.readFileSync(xml, 'utf-8');
    return (content.match(/<suppress\b/g) ?? []).length;
  } catch { return 0; }
}

// ─── Main analysis ────────────────────────────────────────────────────────────

function analyzeAll(appPath: string): {
  files: StaticAnalysisIgnoreInfo[];
  phpstanIgnoreCount: number;
  psalmSuppressCount: number;
} {
  const srcDir = path.join(appPath, 'src');
  const files: StaticAnalysisIgnoreInfo[] = [];

  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      const info = analyzeFile(file);
      if (info) files.push(info);
    }
  }

  return {
    files: files.sort((a, b) => b.totalCount - a.totalCount || a.file.localeCompare(b.file)),
    phpstanIgnoreCount: readPhpStanIgnoreCount(appPath),
    psalmSuppressCount: readPsalmSuppressCount(appPath),
  };
}

// ─── Systematic issue detection ───────────────────────────────────────────────

function findSystematicIssues(files: StaticAnalysisIgnoreInfo[]): string[] {
  const typeFileCount = new Map<string, number>();
  for (const f of files) {
    const seen = new Set<string>();
    for (const s of f.suppressions) {
      if (!seen.has(s.type)) {
        seen.add(s.type);
        typeFileCount.set(s.type, (typeFileCount.get(s.type) ?? 0) + 1);
      }
    }
  }
  const systematic: string[] = [];
  for (const [type, count] of typeFileCount) {
    if (count > 10) {
      systematic.push(
        `"${type}" appears in ${count} files — systematic issue, fix the root cause rather than suppressing.`,
      );
    }
  }
  return systematic;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listStaticAnalysisIgnores(appPath: string): McpToolResult {
  try {
    const { files, phpstanIgnoreCount, psalmSuppressCount } = analyzeAll(appPath);

    const totalSuppressions = files.reduce((s, f) => s + f.totalCount, 0);
    const systematic = findSystematicIssues(files);

    if (files.length === 0 && phpstanIgnoreCount === 0 && psalmSuppressCount === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No static analysis suppressions found.\n\nGood — clean codebase without inline suppressions.',
        }],
      };
    }

    const withIssues = files.filter((f) => f.issues.length > 0);

    let text = `Static Analysis Suppression Audit\n${'='.repeat(55)}\n`;
    text += `  Files with suppressions: ${files.length}\n`;
    text += `  Total inline suppressions: ${totalSuppressions}\n`;
    text += `  phpstan.neon ignoreErrors: ${phpstanIgnoreCount}\n`;
    text += `  psalm.xml suppressions:    ${psalmSuppressCount}\n`;
    text += `  Files with issues:         ${withIssues.length}\n\n`;

    if (systematic.length > 0) {
      text += `Systematic issues:\n`;
      for (const s of systematic) text += `  WARN: ${s}\n`;
      text += '\n';
    }

    for (const f of files) {
      text += `${f.file} (${f.totalCount} suppressions)\n`;
      const typeSummary = new Map<string, number>();
      for (const s of f.suppressions) {
        typeSummary.set(s.type, (typeSummary.get(s.type) ?? 0) + 1);
      }
      for (const [type, count] of typeSummary) {
        text += `  ${type}: ${count}\n`;
      }
      for (const issue of f.issues) {
        text += `  WARN: ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getStaticAnalysisIgnoreStats(appPath: string): McpToolResult {
  try {
    const { files, phpstanIgnoreCount, psalmSuppressCount } = analyzeAll(appPath);

    const totalSuppressions = files.reduce((s, f) => s + f.totalCount, 0);
    const systematic        = findSystematicIssues(files);

    let text = `Static Analysis Suppression Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with suppressions:   ${files.length}\n`;
    text += `Total inline suppressions: ${totalSuppressions}\n`;
    text += `phpstan.neon ignoreErrors: ${phpstanIgnoreCount}\n`;
    text += `psalm.xml suppressions:    ${psalmSuppressCount}\n`;
    text += `Files with >10 suppressions: ${files.filter((f) => f.totalCount > 10).length}\n`;
    text += `Files with issues:         ${files.filter((f) => f.issues.length > 0).length}\n`;
    text += `Systematic type issues:    ${systematic.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getStaticAnalysisIgnoreTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_static_analysis_ignores',
      description: 'List static analysis suppressions: @phpstan-ignore, @psalm-suppress, @phpcs:disable per file, systematic suppression patterns, phpstan.neon/psalm.xml counts',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_static_analysis_ignore_stats',
      description: 'Show static analysis suppression statistics: total suppressions, files with >10, systematic issues, config file ignore counts',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
