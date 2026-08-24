// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Resource Handle Leak Scanner
 *
 * Scans src/**\/*.php for resource handle leaks:
 *   - fopen() without matching fclose() in same function/try-finally
 *   - curl_init() without curl_close() in all paths
 *   - imagecreate()/imagecreatefromjpeg()/imagecreatefrompng() without imagedestroy()
 *   - opendir() without closedir()
 *   - zip_open() without zip_close()
 *   - Heuristic: if function has fopen but no fclose, flag it
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ResourceLeakInfo {
  file: string;
  line: number;
  openFn: string;
  closeFn: string;
  issue: string;
}

// ─── File helpers ─────────────────────────────────────────────────────────────

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

// ─── Resource pair definitions ────────────────────────────────────────────────

interface ResourcePair {
  openPattern: RegExp;
  closePattern: RegExp;
  openFn: string;
  closeFn: string;
}

const RESOURCE_PAIRS: ResourcePair[] = [
  {
    openPattern: /\bfopen\s*\(/,
    closePattern: /\bfclose\s*\(/,
    openFn: 'fopen',
    closeFn: 'fclose',
  },
  {
    openPattern: /\bcurl_init\s*\(/,
    closePattern: /\bcurl_close\s*\(/,
    openFn: 'curl_init',
    closeFn: 'curl_close',
  },
  {
    openPattern: /\bimagecreate(?:fromjpeg|frompng|fromgif|fromwebp|fromstring)?\s*\(/,
    closePattern: /\bimagedestroy\s*\(/,
    openFn: 'imagecreate/imagecreatefrom*',
    closeFn: 'imagedestroy',
  },
  {
    openPattern: /\bopendir\s*\(/,
    closePattern: /\bclosedir\s*\(/,
    openFn: 'opendir',
    closeFn: 'closedir',
  },
  {
    openPattern: /\bzip_open\s*\(/,
    closePattern: /\bzip_close\s*\(/,
    openFn: 'zip_open',
    closeFn: 'zip_close',
  },
];

// ─── Function block extractor ─────────────────────────────────────────────────

interface FunctionBlock {
  startLine: number;
  body: string;
}

function extractFunctionBlocks(content: string): FunctionBlock[] {
  const blocks: FunctionBlock[] = [];
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Match function declaration (named or anonymous)
    if (/\bfunction\s*(?:\w+\s*)?\(/.test(line)) {
      const startLine = i + 1;
      // Find opening brace
      let braceStart = -1;
      let searchLine = i;
      while (searchLine < Math.min(i + 5, lines.length)) {
        if (lines[searchLine].includes('{')) {
          braceStart = searchLine;
          break;
        }
        searchLine++;
      }
      if (braceStart === -1) { i++; continue; }

      // Collect body until matching closing brace
      let depth = 0;
      const bodyLines: string[] = [];
      let j = braceStart;
      while (j < lines.length) {
        const l = lines[j];
        for (const ch of l) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        bodyLines.push(l);
        if (depth === 0) break;
        j++;
      }
      blocks.push({ startLine, body: bodyLines.join('\n') });
      i = j + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string, base: string): ResourceLeakInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  const relFile = path.relative(base, filePath);
  const results: ResourceLeakInfo[] = [];
  const blocks = extractFunctionBlocks(content);

  for (const pair of RESOURCE_PAIRS) {
    if (!pair.openPattern.test(content)) continue;

    if (blocks.length > 0) {
      for (const block of blocks) {
        if (!pair.openPattern.test(block.body)) continue;
        if (!pair.closePattern.test(block.body)) {
          // Find the line number of the open call
          const blockLines = block.body.split('\n');
          let openLine = block.startLine;
          for (let idx = 0; idx < blockLines.length; idx++) {
            if (pair.openPattern.test(blockLines[idx])) {
              openLine = block.startLine + idx;
              break;
            }
          }
          results.push({
            file: relFile,
            line: openLine,
            openFn: pair.openFn,
            closeFn: pair.closeFn,
            issue: `${pair.openFn}() called in function without matching ${pair.closeFn}() — resource handle may leak if an exception is thrown or code path doesn't reach close; wrap in try-finally`,
          });
        } else {
          // Check if fclose is inside try-finally (heuristic: look for finally keyword)
          const hasTryFinally = /\btry\s*\{/.test(block.body) && /\bfinally\s*\{/.test(block.body);
          if (!hasTryFinally) {
            const blockLines = block.body.split('\n');
            let openLine = block.startLine;
            for (let idx = 0; idx < blockLines.length; idx++) {
              if (pair.openPattern.test(blockLines[idx])) {
                openLine = block.startLine + idx;
                break;
              }
            }
            results.push({
              file: relFile,
              line: openLine,
              openFn: pair.openFn,
              closeFn: pair.closeFn,
              issue: `${pair.openFn}()/${pair.closeFn}() pair found but not in try-finally block — exception between open and close will leak the resource handle`,
            });
          }
        }
      }
    } else {
      // No function blocks detected — check at file level
      if (pair.openPattern.test(content) && !pair.closePattern.test(content)) {
        const lines = content.split('\n');
        let openLine = 1;
        for (let idx = 0; idx < lines.length; idx++) {
          if (pair.openPattern.test(lines[idx])) { openLine = idx + 1; break; }
        }
        results.push({
          file: relFile,
          line: openLine,
          openFn: pair.openFn,
          closeFn: pair.closeFn,
          issue: `${pair.openFn}() used at file level without ${pair.closeFn}() — resource handle will not be explicitly closed`,
        });
      }
    }
  }

  return results;
}

function loadAll(appPath: string): ResourceLeakInfo[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);
  const results: ResourceLeakInfo[] = [];
  for (const f of files) results.push(...analyzeFile(f, appPath));
  return results;
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listPhpResourceHandleLeaks(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);
    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No resource handle leaks found in src/.\n\n' +
            'Checked pairs: fopen/fclose, curl_init/curl_close, imagecreate*/imagedestroy, opendir/closedir, zip_open/zip_close\n' +
            'Best practice: wrap resource usage in try-finally to guarantee cleanup.',
        }],
      };
    }

    const withoutClose = items.filter((i) => i.issue.includes('without matching'));
    const withoutFinally = items.filter((i) => i.issue.includes('not in try-finally'));

    let text = `PHP Resource Handle Leak Analysis\n${'='.repeat(55)}\n\n`;
    text += `  Total findings:             ${items.length}\n`;
    text += `  Missing close call:         ${withoutClose.length}\n`;
    text += `  Missing try-finally:        ${withoutFinally.length}\n`;
    text += `  Files affected:             ${new Set(items.map((i) => i.file)).size}\n\n`;

    for (const item of items) {
      text += `  [${item.openFn}] ${item.file}:${item.line}\n`;
      text += `    ${item.issue}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpResourceHandleLeaksStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    const byPair: Record<string, number> = {};
    for (const item of items) {
      byPair[item.openFn] = (byPair[item.openFn] ?? 0) + 1;
    }

    let text = `PHP Resource Handle Leak Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings:     ${items.length}\n`;
    text += `Files affected:     ${new Set(items.map((i) => i.file)).size}\n\n`;
    text += `By resource type:\n`;
    for (const [fn, count] of Object.entries(byPair)) {
      text += `  ${fn}: ${count}\n`;
    }
    text += `\nMissing close:      ${items.filter((i) => i.issue.includes('without matching')).length}\n`;
    text += `Missing finally:    ${items.filter((i) => i.issue.includes('not in try-finally')).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function getPhpResourceHandleLeaksTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_resource_handle_leaks',
      description: 'Scan src/**/*.php for resource handle leaks: fopen/fclose, curl_init/curl_close, imagecreate*/imagedestroy, opendir/closedir, zip_open/zip_close — flags missing close calls and open/close pairs not wrapped in try-finally',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_resource_handle_leaks_stats',
      description: 'Statistics for PHP resource handle leaks: total findings, files affected, breakdown by resource type (fopen, curl_init, imagecreate*, opendir, zip_open), missing close vs missing try-finally',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
