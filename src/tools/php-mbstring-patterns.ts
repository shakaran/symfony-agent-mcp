import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MbstringPatternInfo {
  file: string;
  function: string;
  issues: string[];
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full, base));
    } else if (entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

const MB_FUNCTIONS = [
  'mb_strlen',
  'mb_substr',
  'mb_strtolower',
  'mb_strtoupper',
  'mb_convert_encoding',
  'mb_detect_encoding',
  'mb_internal_encoding',
];

const NON_MB_EQUIVALENTS = ['strlen(', 'substr(', 'strtolower(', 'strtoupper(', 'strpos(', 'substr_count('];

function buildMbstringPatternInfos(appPath: string): MbstringPatternInfo[] {
  const results: MbstringPatternInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);

  for (const file of files) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const foundMb: string[] = [];
    for (const fn of MB_FUNCTIONS) {
      if (content.includes(fn + '(')) {
        foundMb.push(fn);
      }
    }

    if (foundMb.length === 0) continue;

    const issues: string[] = [];

    // Flag mb_convert_encoding with auto-detection
    if (content.includes('mb_convert_encoding(')) {
      if (content.includes("'auto'") || content.includes('"auto"') ||
          content.includes("'AUTO'") || content.includes('"AUTO"')) {
        issues.push('mb_convert_encoding with "auto" source encoding — auto-detection is unreliable; specify encoding explicitly');
      }
    }

    // Flag mb_internal_encoding global setting
    if (content.includes('mb_internal_encoding(')) {
      if (content.includes("mb_internal_encoding('UTF-8')") || content.includes('mb_internal_encoding("UTF-8")')) {
        issues.push('mb_internal_encoding() sets global state — prefer per-call encoding arguments instead');
      } else {
        issues.push('mb_internal_encoding() called with non-UTF-8 or dynamic encoding — verify encoding consistency');
      }
    }

    // Flag mixing mb_ and non-mb_ string functions in the same file
    const hasNonMb = NON_MB_EQUIVALENTS.some(fn => content.includes(fn));
    if (hasNonMb && foundMb.length > 0) {
      const nonMbFound = NON_MB_EQUIVALENTS.filter(fn => content.includes(fn));
      issues.push(`Mixing mb_ functions with non-multibyte equivalents (${nonMbFound.join(', ')}) — use mb_ consistently for multibyte safety`);
    }

    // Flag mb_strlen/mb_substr without encoding parameter (heuristic: 2 args only)
    if (content.includes('mb_strlen(')) {
      // Simple heuristic: if mb_strlen appears and no encoding-like string nearby
      const mbStrlenMatches = content.match(/mb_strlen\s*\([^)]{0,200}\)/g) ?? [];
      for (const match of mbStrlenMatches) {
        const commaCount = (match.match(/,/g) ?? []).length;
        if (commaCount === 0) {
          issues.push('mb_strlen() called without explicit encoding argument — add "UTF-8" as second parameter for clarity');
          break;
        }
      }
    }

    if (foundMb.length > 0) {
      results.push({
        file: path.relative(appPath, file),
        function: foundMb.join(', '),
        issues,
      });
    }
  }

  return results;
}

export function listPhpMbstringPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildMbstringPatternInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP mbstring usage patterns found.' }] };
    }
    const lines = infos.map(i =>
      `${i.file}\n  Functions: ${i.function}\n  Issues: ${i.issues.length > 0 ? i.issues.join('; ') : 'none'}`
    );
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpMbstringPatternsStats(appPath: string): McpToolResult {
  try {
    const infos = buildMbstringPatternInfos(appPath);
    const stats = {
      total: infos.length,
      withIssues: infos.filter(i => i.issues.length > 0).length,
      byFunction: {} as Record<string, number>,
    };
    for (const i of infos) {
      for (const fn of i.function.split(', ')) {
        stats.byFunction[fn] = (stats.byFunction[fn] ?? 0) + 1;
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpMbstringPatternsTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_php_mbstring_patterns',
      description: 'List PHP mbstring function usage: mb_strlen, mb_substr, mb_strtolower, mb_convert_encoding, etc. — flags missing encoding parameters, mixing mb_ with non-mb_ functions, and auto-detection in mb_convert_encoding.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    },
    {
      name: 'get_php_mbstring_patterns_stats',
      description: 'Get statistics for PHP mbstring usage: total files, files with issues, breakdown by function name.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    }
  ];
}
