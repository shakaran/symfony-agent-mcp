import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface StringInterpolationInfo {
  file: string;
  type: 'interpolation' | 'format-string' | 'eval' | 'extract';
  pattern: string;
  issues: string[];
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

function buildPhpStringInterpolationSecurityInfos(appPath: string): StringInterpolationInfo[] {
  const srcDir = path.join(appPath, 'src');
  const phpFiles = getAllPhpFiles(srcDir);
  const results: StringInterpolationInfo[] = [];

  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (content === null) continue;

    const relFile = path.relative(appPath, filePath);

    if (/preg_replace\s*\([^,]*\/e/.test(content)) {
      results.push({
        file: relFile,
        type: 'eval',
        pattern: 'preg_replace with /e modifier',
        issues: ['preg_replace() with /e modifier executes PHP code — this is deprecated since PHP 5.5 and removed in PHP 7.0; use preg_replace_callback() instead'],
      });
    }

    if (/\beval\s*\(/.test(content)) {
      results.push({
        file: relFile,
        type: 'eval',
        pattern: 'eval() call',
        issues: ['eval() call detected — executes PHP code from a string; this is extremely dangerous with any user input and should be avoided entirely in web applications'],
      });
    }

    if (/\bcreate_function\s*\(/.test(content)) {
      results.push({
        file: relFile,
        type: 'eval',
        pattern: 'create_function() call',
        issues: ['create_function() is deprecated and equivalent to eval() — use anonymous functions (function() {}) or closures instead'],
      });
    }

    if (/\bextract\s*\(\s*\$_/.test(content)) {
      results.push({
        file: relFile,
        type: 'extract',
        pattern: 'extract() with superglobal',
        issues: ['extract() with superglobal ($_GET, $_POST, $_REQUEST) — overwrites existing variables with user-controlled values; this can lead to variable injection attacks; use explicit assignment'],
      });
    }

    if (/sprintf\s*\(\s*\$/.test(content)) {
      results.push({
        file: relFile,
        type: 'format-string',
        pattern: 'sprintf() with variable format string',
        issues: ['sprintf() with user-controlled format string — format string injection allows memory reads and unexpected behavior; always use a static format string as first argument'],
      });
    }

    if (/"\$\{[^}]+\}"/.test(content) && /\$_(GET|POST|REQUEST)/.test(content)) {
      results.push({
        file: relFile,
        type: 'interpolation',
        pattern: 'Complex variable interpolation with request data',
        issues: ['Complex variable interpolation with request data in double-quoted string — prefer explicit concatenation or use single-quoted strings to avoid accidental variable expansion'],
      });
    }
  }

  return results;
}

export function listPhpStringInterpolationSecurity(appPath: string): McpToolResult {
  try {
    const infos = buildPhpStringInterpolationSecurityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No string interpolation security issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP String Interpolation Security Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpStringInterpolationSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpStringInterpolationSecurityInfos(appPath);
    let text = `PHP String Interpolation Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `Interpolation: ${infos.filter((i) => i.type === 'interpolation').length}\n`;
    text += `Format-string: ${infos.filter((i) => i.type === 'format-string').length}\n`;
    text += `Eval:          ${infos.filter((i) => i.type === 'eval').length}\n`;
    text += `Extract:       ${infos.filter((i) => i.type === 'extract').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpStringInterpolationSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_string_interpolation_security', description: 'Analyze PHP string interpolation for eval, extract, format-string injection, and interpolation security issues', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_string_interpolation_security_stats', description: 'Statistics for PHP string interpolation security: counts by type and issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
