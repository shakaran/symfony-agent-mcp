import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RegexInjectionInfo {
  file: string;
  line: number;
  pattern: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  issue: string;
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

// User-controlled input superglobals
const SUPERGLOBALS_RE = /\$_(GET|POST|REQUEST)/;

// preg_match with a variable pattern (first arg is $var)
const PREG_MATCH_VAR_RE = /preg_match\s*\(\s*\$[a-zA-Z_]/;

// preg_replace with a variable pattern (first arg is $var)
const PREG_REPLACE_VAR_RE = /preg_replace\s*\(\s*\$[a-zA-Z_]/;

// preg_replace /e modifier — CRITICAL: string literal first arg ending with e delimiter
// Match both single-quoted and double-quoted strings like '/pattern/e' or "/pattern/e"
const PREG_E_MODIFIER_RE = /preg_replace\s*\(\s*["'][^"']{0,300}[/][a-zA-Z]*e[a-zA-Z]*["']/;

// preg_split with a variable pattern (first arg is $var)
const PREG_SPLIT_VAR_RE = /preg_split\s*\(\s*\$[a-zA-Z_]/;

// Simpler alternate for dynamic concat: '/' . $someVar or "/" . $someVar at start of pattern
const DYNAMIC_CONCAT_RE = /['"]\s*[/]\s*['"]\s*\.\s*\$[a-zA-Z_]/;

function analyzeLineForRegexInjection(
  line: string,
  lineNum: number,
  relFile: string,
  lines: string[],
  lineIdx: number,
): RegexInjectionInfo | null {
  const trimmed = line.trim();

  // Skip comment lines
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return null;

  // Pattern 3 (CRITICAL): /e modifier in preg_replace — check first before variable patterns
  if (PREG_E_MODIFIER_RE.test(trimmed)) {
    return {
      file: relFile,
      line: lineNum,
      pattern: 'preg-replace-e-modifier',
      severity: 'critical',
      issue: 'preg_replace() uses /e modifier — this evaluates the replacement as PHP code; removed in PHP 8 but dangerous in PHP 5/7 and can be bypassed via preg_replace_callback; remove /e and use preg_replace_callback() instead',
    };
  }

  // Pattern 1 (HIGH): preg_match with variable pattern near user input
  if (PREG_MATCH_VAR_RE.test(trimmed)) {
    // Check current line and 5 surrounding lines for superglobal usage
    const start = Math.max(0, lineIdx - 5);
    const end = Math.min(lines.length - 1, lineIdx + 2);
    let hasUserInput = SUPERGLOBALS_RE.test(trimmed);
    if (!hasUserInput) {
      for (let i = start; i <= end; i++) {
        if (i !== lineIdx && SUPERGLOBALS_RE.test(lines[i])) {
          hasUserInput = true;
          break;
        }
      }
    }
    if (hasUserInput) {
      return {
        file: relFile,
        line: lineNum,
        pattern: 'preg-match-user-controlled-pattern',
        severity: 'high',
        issue: 'preg_match() called with variable pattern ($var) near $_GET/$_POST/$_REQUEST — user-controlled regex enables ReDoS and potential injection; validate pattern with preg_match() return value check or use a fixed whitelist',
      };
    }
  }

  // Pattern 2 (HIGH): preg_replace with variable pattern near user input
  if (PREG_REPLACE_VAR_RE.test(trimmed)) {
    const start = Math.max(0, lineIdx - 5);
    const end = Math.min(lines.length - 1, lineIdx + 2);
    let hasUserInput = SUPERGLOBALS_RE.test(trimmed);
    if (!hasUserInput) {
      for (let i = start; i <= end; i++) {
        if (i !== lineIdx && SUPERGLOBALS_RE.test(lines[i])) {
          hasUserInput = true;
          break;
        }
      }
    }
    if (hasUserInput) {
      return {
        file: relFile,
        line: lineNum,
        pattern: 'preg-replace-user-controlled-pattern',
        severity: 'high',
        issue: 'preg_replace() called with variable pattern ($var) near $_GET/$_POST/$_REQUEST — user-controlled regex enables ReDoS; use a fixed replacement pattern or sanitise the pattern with preg_quote()',
      };
    }
  }

  // Pattern 4 (HIGH): preg_split with variable pattern near user input
  if (PREG_SPLIT_VAR_RE.test(trimmed)) {
    const start = Math.max(0, lineIdx - 5);
    const end = Math.min(lines.length - 1, lineIdx + 2);
    let hasUserInput = SUPERGLOBALS_RE.test(trimmed);
    if (!hasUserInput) {
      for (let i = start; i <= end; i++) {
        if (i !== lineIdx && SUPERGLOBALS_RE.test(lines[i])) {
          hasUserInput = true;
          break;
        }
      }
    }
    if (hasUserInput) {
      return {
        file: relFile,
        line: lineNum,
        pattern: 'preg-split-user-controlled-pattern',
        severity: 'high',
        issue: 'preg_split() called with variable pattern ($var) near $_GET/$_POST/$_REQUEST — user-controlled regex enables ReDoS; use a fixed delimiter or wrap user input with preg_quote()',
      };
    }
  }

  // Pattern 5 (HIGH): dynamic regex built from user input via '/' . $var . '/'
  if (DYNAMIC_CONCAT_RE.test(trimmed) && SUPERGLOBALS_RE.test(trimmed)) {
    return {
      file: relFile,
      line: lineNum,
      pattern: 'dynamic-regex-from-user-input',
      severity: 'high',
      issue: "Dynamic regex constructed from user input using '/' . $var . '/' pattern — allows arbitrary regex injection and ReDoS; use preg_quote($var) before embedding user input in a regex",
    };
  }

  return null;
}

function buildRegexInjectionInfos(appPath: string): RegexInjectionInfo[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);
  const results: RegexInjectionInfo[] = [];

  for (const filePath of files) {
    const content = safeRead(filePath, appPath);
    if (content === null) continue;

    // Quick pre-filter: must contain at least one relevant token
    const hasPregFunc =
      content.includes('preg_match') ||
      content.includes('preg_replace') ||
      content.includes('preg_split');
    if (!hasPregFunc) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const info = analyzeLineForRegexInjection(lines[i], i + 1, relFile, lines, i);
      if (info !== null) results.push(info);
    }
  }

  return results;
}

export function listPhpRegexInjection(appPath: string): McpToolResult {
  try {
    const infos = buildRegexInjectionInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No regex injection risks found in src/.' }] };
    }

    const critical = infos.filter((i) => i.severity === 'critical');
    const high = infos.filter((i) => i.severity === 'high');
    const medium = infos.filter((i) => i.severity === 'medium');
    const low = infos.filter((i) => i.severity === 'low');

    let text = `PHP Regex Injection Analysis\n${'='.repeat(55)}\n\n`;
    text += `Total findings: ${infos.length}\n`;
    text += `  Critical (code execution via /e):    ${critical.length}\n`;
    text += `  High     (user-controlled pattern):  ${high.length}\n`;
    text += `  Medium   (indirect variable regex):  ${medium.length}\n`;
    text += `  Low      (potentially risky regex):  ${low.length}\n`;

    if (critical.length > 0) {
      text += `\nCRITICAL SEVERITY — Code Execution Risk:\n`;
      for (const i of critical) {
        text += `  [${i.pattern}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }
    if (high.length > 0) {
      text += `\nHIGH SEVERITY — User-Controlled Regex Pattern:\n`;
      for (const i of high) {
        text += `  [${i.pattern}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }
    if (medium.length > 0) {
      text += `\nMEDIUM SEVERITY — Indirect Variable Regex:\n`;
      for (const i of medium) {
        text += `  [${i.pattern}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }
    if (low.length > 0) {
      text += `\nLOW SEVERITY — Potentially Risky Regex:\n`;
      for (const i of low) {
        text += `  [${i.pattern}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpRegexInjectionStats(appPath: string): McpToolResult {
  try {
    const infos = buildRegexInjectionInfos(appPath);

    const stats = {
      total: infos.length,
      filesAffected: new Set(infos.map((i) => i.file)).size,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>,
      byPattern: {} as Record<string, number>,
    };

    for (const i of infos) {
      stats.bySeverity[i.severity] = (stats.bySeverity[i.severity] ?? 0) + 1;
      stats.byPattern[i.pattern] = (stats.byPattern[i.pattern] ?? 0) + 1;
    }

    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpRegexInjectionTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Absolute path to the Symfony application root' } };
  return [
    {
      name: 'list_php_regex_injection',
      description: 'Scan PHP src/ for user-controlled regex injection and ReDoS: preg_match/preg_replace/preg_split with variable patterns near $_GET/$_POST/$_REQUEST (high), /e modifier in preg_replace (critical), dynamic regex via string concatenation with user input (high)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_regex_injection_stats',
      description: 'Statistics for PHP regex injection findings: JSON with total, bySeverity (critical/high/medium/low), byPattern, filesAffected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
