import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PcreSecurityInfo {
  file: string;
  type: 'redos' | 'backtrack-limit' | 'catastrophic' | 'user-input' | 'flags';
  pattern: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function isLikelyCatastrophic(regex: string): boolean {
  if (/\([^)]{1,200}\+\)\+/.test(regex)) return true;
  if (/\([^)]{1,200}\*\)\*/.test(regex)) return true;
  if (/\([^)]{1,200}\+\)\*/.test(regex)) return true;
  if (/\([^)]{1,200}\*\)\+/.test(regex)) return true;
  if (/\[[^\]]{1,100}\]\+\+/.test(regex)) return true;
  if (/\([^)]{1,100}\|[^)]{1,100}\)\+/.test(regex)) return true;
  return false;
}

function buildPcreInfos(appPath: string): PcreSecurityInfo[] {
  const results: PcreSecurityInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath); if (content === null) continue;

    if (!content.includes('preg_match') && !content.includes('preg_replace') && !content.includes('preg_split')) continue;

    const relFile = path.relative(appPath, file);

    const regexLiterals = content.matchAll(/preg_(?:match|replace|split)\s*\(\s*(['"`])([^'"` ]{4,200})\1/g);
    for (const m of regexLiterals) {
      const regex = m[2];
      const issues: string[] = [];

      if (isLikelyCatastrophic(regex)) {
        issues.push(`Potentially catastrophic backtracking in regex "${regex.substring(0, 80)}" — patterns like (a+)+ or (.+)+ cause exponential backtracking; use possessive quantifiers or atomic groups`);
      }

      if (/\.[*+]/.test(regex) && !/\.[*+][?]/.test(regex)) {
        issues.push(`Unbounded .* or .+ in regex without lazy modifier — can cause excessive backtracking on long inputs; use lazy .*? or .*+ (possessive)`);
      }

      if (issues.length > 0) {
        results.push({ file: relFile, type: 'redos', pattern: regex.substring(0, 80), issues });
      }
    }

    if (content.includes('preg_match(') || content.includes('preg_replace(')) {
      const userPatterns = ['$_GET', '$_POST', '$_REQUEST', '$_COOKIE', '$request->get(', '$request->query', '$request->request'];
      const hasUserInput = userPatterns.some((p) => content.includes(p));

      const hasRegexWithVar = /preg_(?:match|replace|split)\s*\(\s*\$/.test(content);
      if (hasRegexWithVar && hasUserInput) {
        results.push({ file: relFile, type: 'user-input', pattern: 'preg with user-supplied pattern', issues: ['User-controlled regex pattern — allows ReDoS via crafted input; always use a fixed hardcoded pattern or validate/sanitize before using as regex'] });
      }

      const hasSubjectVar = /preg_match\s*\([^,]{1,200},\s*\$_(GET|POST|REQUEST)/.test(content);
      if (hasSubjectVar) {
        results.push({ file: relFile, type: 'user-input', pattern: 'preg_match with user subject', issues: ['Regex applied to raw user input — if regex is complex, craft a long input to cause catastrophic backtracking (ReDoS denial of service)'] });
      }
    }

    if (content.includes('ini_set') && content.includes('pcre.backtrack_limit')) {
      const m = /ini_set\s*\(\s*['"]pcre\.backtrack_limit['"]\s*,\s*['"]?(\d{1,20})['"]?\s*\)/.exec(content);
      if (m) {
        const limit = parseInt(m[1], 10);
        if (limit > 10_000_000) {
          results.push({ file: relFile, type: 'backtrack-limit', pattern: `pcre.backtrack_limit=${m[1]}`, issues: [`pcre.backtrack_limit=${m[1]} is very high — increasing the limit delays catastrophic backtracking failure, making ReDoS attacks longer-lived`] });
        }
        if (limit === -1 || limit === 0) {
          results.push({ file: relFile, type: 'backtrack-limit', pattern: `pcre.backtrack_limit=${m[1]}`, issues: [`pcre.backtrack_limit=${m[1]} disables limit — unlimited backtracking allows ReDoS to consume 100% CPU indefinitely`] });
        }
      }
    }

    const hasMFlag = /preg_match\([^)]{1,200}\/[gmsi]{1,4}[msigu]{0,4}'\)/.test(content);
    if (hasMFlag && content.includes('/.*$/m') || content.includes('/^.*$/')) {
      results.push({ file: relFile, type: 'flags', pattern: 'multiline unbounded regex', issues: ['Unbounded multiline pattern — .* in multiline mode can backtrack across all lines, not just the current one'] });
    }
  }

  return results;
}

export function listPhpPcreSecurity(appPath: string): McpToolResult {
  try {
    const infos = buildPcreInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PCRE security issues detected (no catastrophic backtracking patterns or user-controlled regexes).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PCRE/ReDoS Security Analysis\n${'='.repeat(50)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpPcreSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = buildPcreInfos(appPath);
    let text = `PCRE Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `ReDoS patterns:     ${infos.filter((i) => i.type === 'redos').length}\n`;
    text += `User-input regex:   ${infos.filter((i) => i.type === 'user-input').length}\n`;
    text += `Backtrack issues:   ${infos.filter((i) => i.type === 'backtrack-limit').length}\n`;
    text += `Issues:             ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpPcreSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_pcre_security', description: 'Detect PCRE/ReDoS vulnerabilities in PHP regex patterns; warns on catastrophic backtracking ((a+)+), unbounded .* without lazy modifier, user-controlled regex patterns, excessive pcre.backtrack_limit', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_pcre_security_stats', description: 'Statistics for PCRE security: redos/user-input/backtrack count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
