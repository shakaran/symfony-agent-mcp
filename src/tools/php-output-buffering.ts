import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface OutputBufferingInfo {
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

function buildOutputBufferingInfos(appPath: string): OutputBufferingInfo[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);
  const results: OutputBufferingInfo[] = [];

  for (const filePath of files) {
    const content = safeRead(filePath, appPath);
    if (content === null) continue;

    // Quick pre-filter
    if (!content.includes('ob_start(') && !content.includes('ob_flush(')) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    // File-level counts
    const obStartCount = (content.match(/ob_start\s*\(/g) ?? []).length;
    const obEndCount =
      (content.match(/ob_end_clean\s*\(/g) ?? []).length +
      (content.match(/ob_end_flush\s*\(/g) ?? []).length +
      (content.match(/ob_get_clean\s*\(/g) ?? []).length;
    const hasObGetLevel = content.includes('ob_get_level(');

    // Flag unmatched ob_start at file level (report on line 1)
    if (obStartCount > obEndCount) {
      results.push({
        file: relFile,
        line: 1,
        pattern: 'unmatched-ob_start',
        issue: `ob_start() called ${obStartCount} time(s) but ob_end_clean/ob_end_flush/ob_get_clean only ${obEndCount} time(s) in this file — leaked output buffer may cause memory growth or corrupt HTTP responses`,
      });
    }

    // Flag missing ob_get_level safety check when nesting ob_start calls
    if (obStartCount > 1 && !hasObGetLevel) {
      results.push({
        file: relFile,
        line: 1,
        pattern: 'missing-ob_get_level',
        issue: `Multiple ob_start() calls (${obStartCount}) without ob_get_level() safety check — nested buffering without level inspection risks double-flush or unmatched end calls`,
      });
    }

    // Per-line checks
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      // Skip comment lines
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

      const lineNum = i + 1;

      // ob_flush inside a loop: look back up to 5 lines for for/while/foreach
      if (trimmed.includes('ob_flush(')) {
        const lookbackStart = Math.max(0, i - 5);
        const lookbackSlice = lines.slice(lookbackStart, i);
        const inLoop = lookbackSlice.some((l) => /\b(for|while|foreach)\s*\(/.test(l));
        if (inLoop) {
          results.push({
            file: relFile,
            line: lineNum,
            pattern: 'ob_flush-in-loop',
            issue: 'ob_flush() inside a loop — flushing the output buffer on every iteration causes excessive system calls and degrades performance; flush once after the loop',
          });
        }
      }

      // ob_start in destructor or catch block: look back up to 10 lines
      if (trimmed.includes('ob_start(')) {
        const lookbackStart = Math.max(0, i - 10);
        const lookbackSlice = lines.slice(lookbackStart, i);
        const inDestructorOrCatch = lookbackSlice.some((l) => /__destruct\s*\(/.test(l) || /\bcatch\s*\(/.test(l));
        if (inDestructorOrCatch) {
          results.push({
            file: relFile,
            line: lineNum,
            pattern: 'ob_start-in-destructor-or-catch',
            issue: 'ob_start() inside a destructor or catch block — if an exception is thrown during buffering, the buffer may never be flushed or cleaned, leaking memory and corrupting output',
          });
        }
      }
    }
  }

  return results;
}

export function listPhpOutputBuffering(appPath: string): McpToolResult {
  try {
    const infos = buildOutputBufferingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No output buffering issues found in src/.' }] };
    }

    let text = `PHP Output Buffering Analysis\n${'='.repeat(55)}\n\n`;
    text += `Total findings: ${infos.length}\n\n`;

    for (const info of infos) {
      text += `  [${info.pattern}] ${info.file}:${info.line}\n`;
      text += `    ${info.issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpOutputBufferingStats(appPath: string): McpToolResult {
  try {
    const infos = buildOutputBufferingInfos(appPath);

    const byPattern: Record<string, number> = {
      'unmatched-ob_start': 0,
      'missing-ob_get_level': 0,
      'ob_flush-in-loop': 0,
      'ob-start-in-destructor-or-catch': 0,
    };
    for (const info of infos) {
      const key = info.pattern === 'ob_start-in-destructor-or-catch' ? 'ob-start-in-destructor-or-catch' : info.pattern;
      byPattern[key] = (byPattern[key] ?? 0) + 1;
    }
    const filesAffected = new Set(infos.map((i) => i.file)).size;

    let text = `PHP Output Buffering Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings:                     ${infos.length}\n`;
    text += `Files affected:                     ${filesAffected}\n\n`;
    text += `By pattern:\n`;
    text += `  unmatched-ob_start:               ${byPattern['unmatched-ob_start']}\n`;
    text += `  missing-ob_get_level:             ${byPattern['missing-ob_get_level']}\n`;
    text += `  ob_flush-in-loop:                 ${byPattern['ob_flush-in-loop']}\n`;
    text += `  ob_start-in-destructor-or-catch:  ${byPattern['ob-start-in-destructor-or-catch']}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpOutputBufferingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_output_buffering',
      description: 'Scan PHP source for output buffering issues: unmatched ob_start/ob_end pairs, ob_flush inside loops, ob_start in destructors or catch blocks, and missing ob_get_level safety checks for nested buffers',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_output_buffering_stats',
      description: 'Statistics for PHP output buffering findings: total count, files affected, and breakdown by pattern (unmatched-ob_start, missing-ob_get_level, ob_flush-in-loop, ob_start-in-destructor-or-catch)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
