import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TypeJugglingInfo {
  file: string;
  type: 'loose-compare' | 'in-array' | 'switch' | 'json' | 'auth';
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

function buildPhpTypeJugglingInfos(appPath: string): TypeJugglingInfo[] {
  const srcDir = path.join(appPath, 'src');
  const phpFiles = getAllPhpFiles(srcDir);
  const results: TypeJugglingInfo[] = [];

  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (content === null) continue;

    const relFile = path.relative(appPath, filePath);

    if (/\s==\s/.test(content) && /password|hash|token|key\b|(?<!\w)id\b/i.test(content)) {
      results.push({
        file: relFile,
        type: 'loose-compare',
        pattern: 'Loose comparison (==) in security-sensitive context',
        issues: ['Loose comparison (==) in security-sensitive context — use strict comparison (===) to prevent type juggling attacks; \'0e\' prefix strings compare as equal to 0'],
      });
    }

    const inArrayMatches = content.match(/in_array\s*\([^;]+\)/g);
    if (inArrayMatches) {
      for (const match of inArrayMatches) {
        if (!/true\s*\)/.test(match)) {
          results.push({
            file: relFile,
            type: 'in-array',
            pattern: 'in_array() without strict=true',
            issues: ['in_array() without strict=true — loose comparison allows \'0\' to match false, \'\' to match null, etc.; use in_array($needle, $haystack, true)'],
          });
          break;
        }
      }
    }

    if (/json_decode\s*\(/.test(content) && !content.includes('JSON_THROW_ON_ERROR')) {
      results.push({
        file: relFile,
        type: 'json',
        pattern: 'json_decode without JSON_THROW_ON_ERROR',
        issues: ['json_decode() without JSON_THROW_ON_ERROR flag — returns null on invalid JSON which may be confused with valid null data; use json_decode($json, true, 512, JSON_THROW_ON_ERROR)'],
      });
    }

    if (/strcmp\s*\(.*(?:password|hash|token)/i.test(content) || /\$.*password.*==/.test(content)) {
      results.push({
        file: relFile,
        type: 'auth',
        pattern: 'strcmp or loose compare for authentication',
        issues: ['strcmp() or loose compare for authentication — strcmp returns an integer (0=equal), and non-zero truthy values may cause unexpected auth bypass; use hash_equals() for timing-safe string comparison'],
      });
    }

    if (/switch\s*\(/.test(content) && /case\s+0\b|case\s+"0"/.test(content)) {
      results.push({
        file: relFile,
        type: 'switch',
        pattern: 'switch() with case 0 — loose comparison risk',
        issues: ['switch() uses loose comparison — case 0 matches any non-numeric string; use if/elseif with === for security-critical type checks'],
      });
    }
  }

  return results;
}

export function listPhpTypeJuggling(appPath: string): McpToolResult {
  try {
    const infos = buildPhpTypeJugglingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No type juggling issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP Type Juggling Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpTypeJugglingStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpTypeJugglingInfos(appPath);
    let text = `PHP Type Juggling Statistics\n${'='.repeat(40)}\n\n`;
    text += `Loose-compare: ${infos.filter((i) => i.type === 'loose-compare').length}\n`;
    text += `In-array:      ${infos.filter((i) => i.type === 'in-array').length}\n`;
    text += `Switch:        ${infos.filter((i) => i.type === 'switch').length}\n`;
    text += `JSON:          ${infos.filter((i) => i.type === 'json').length}\n`;
    text += `Auth:          ${infos.filter((i) => i.type === 'auth').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpTypeJugglingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_type_juggling', description: 'Analyze PHP code for type juggling vulnerabilities: loose comparisons, in_array without strict, json_decode issues', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_type_juggling_stats', description: 'Statistics for PHP type juggling: counts by type and issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
