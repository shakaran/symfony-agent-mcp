// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP File Upload Validation Inspector
 *
 * Scans src/**\/*.php for raw $_FILES handling security issues:
 * 1. $_FILES[...]['type'] used for MIME validation (spoofable) — HIGH
 * 2. move_uploaded_file destination from $_FILES[...]['name'] without basename() — HIGH (path traversal)
 * 3. File stored under public/ or web/ directory — MEDIUM
 * 4. Missing is_uploaded_file() check — MEDIUM
 * 5. Only MIME type checked with no extension whitelist — MEDIUM
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FileUploadValidationInfo {
  file: string;
  line: number;
  pattern: string;
  severity: 'high' | 'medium' | 'low';
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

function analyseFileUploadFile(content: string, relFile: string): FileUploadValidationInfo[] {
  const infos: FileUploadValidationInfo[] = [];
  const lines = content.split('\n');

  // Detect whether the file deals with $_FILES at all
  if (!content.includes('$_FILES')) return infos;

  // Pattern 1: $_FILES[...]['type'] used for MIME validation (HIGH)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match $_FILES['something']['type'] or $_FILES[$var]['type']
    if (/\$_FILES\s*[['"]?[^]]*['"]]?\s*\[\s*['"]type['"]\s*]/.test(line) || /\$_FILES\[[^\]]*]\s*\[\s*['"]type['"]\s*]/.test(line)) {
      infos.push({
        file: relFile,
        line: i + 1,
        pattern: 'files-type-mime-spoofable',
        severity: 'high',
        issue: '$_FILES[...][\'type\'] is controlled by the client HTTP header and can be spoofed — use finfo_file() or mime_content_type() on the actual file to validate MIME type',
      });
    }
  }

  // Pattern 2: move_uploaded_file destination built from $_FILES[...]['name'] without basename() (HIGH)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bmove_uploaded_file\s*\(/.test(line)) {
      // Look in a window of a few lines before for the destination being built from ['name']
      const windowStart = Math.max(0, i - 8);
      const window = lines.slice(windowStart, i + 2).join('\n');

      const usesFileName = /\$_FILES\[[^\]]*]\s*\[\s*['"]name['"]\s*]/.test(window);
      const hasBasename = /\bbasename\s*\(/.test(window);

      if (usesFileName && !hasBasename) {
        infos.push({
          file: relFile,
          line: i + 1,
          pattern: 'move-uploaded-file-path-traversal',
          severity: 'high',
          issue: 'move_uploaded_file() destination uses $_FILES[...][\'name\'] without basename() — attacker can supply \'../../../etc/passwd\' as filename causing path traversal; wrap with basename()',
        });
      }
    }
  }

  // Pattern 3: File stored under public/ or web/ directory (MEDIUM)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bmove_uploaded_file\s*\(/.test(line)) {
      // Check this line and a few following for the destination argument
      const windowEnd = Math.min(lines.length - 1, i + 3);
      const window = lines.slice(i, windowEnd + 1).join('\n');
      if (/['"].*[/]public[/]|['"].*[/]web[/]|public[/]uploads|web[/]uploads/.test(window)) {
        infos.push({
          file: relFile,
          line: i + 1,
          pattern: 'upload-to-public-directory',
          severity: 'medium',
          issue: 'move_uploaded_file() stores uploaded file under public/ or web/ — uploaded files are directly web-accessible; store outside the webroot and serve via a controller that validates access',
        });
      }
    }
  }

  // Pattern 4: Missing is_uploaded_file() check — files block without is_uploaded_file (MEDIUM)
  // Find function blocks that reference $_FILES but do not call is_uploaded_file
  const functionBlocks: Array<{ start: number; end: number }> = [];
  let braceDepth = 0;
  let inFunction = false;
  let funcStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFunction && /\bfunction\s+\w+\s*\(/.test(line)) {
      inFunction = true;
      funcStart = i;
      braceDepth = 0;
    }
    if (inFunction) {
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }
      if (braceDepth <= 0 && line.includes('}')) {
        functionBlocks.push({ start: funcStart, end: i });
        inFunction = false;
      }
    }
  }

  for (const block of functionBlocks) {
    const blockLines = lines.slice(block.start, block.end + 1);
    const blockText = blockLines.join('\n');
    if (blockText.includes('$_FILES') && !/\bis_uploaded_file\s*\(/.test(blockText)) {
      // Find the first $_FILES reference line in this block for reporting
      let firstFilesLine = block.start;
      for (let j = block.start; j <= block.end; j++) {
        if (lines[j].includes('$_FILES')) {
          firstFilesLine = j;
          break;
        }
      }
      infos.push({
        file: relFile,
        line: firstFilesLine + 1,
        pattern: 'missing-is-uploaded-file',
        severity: 'medium',
        issue: '$_FILES processed without is_uploaded_file() check in the same function — without this check an attacker may substitute an arbitrary server-side file path; always verify with is_uploaded_file() before processing',
      });
    }
  }

  // Pattern 5: Only MIME type checked with no extension whitelist (MEDIUM)
  // Detect files that use $_FILES and check MIME but have no array of allowed extensions
  const hasMimeCheck = /finfo_file\s*\(|mime_content_type\s*\(|\$_FILES\[[^\]]*]\s*\[\s*['"]type['"]\s*]/.test(content);
  const hasExtensionWhitelist = /\bpathinfo\s*\(|PATHINFO_EXTENSION|\bstrtolower\s*\(.*ext|allowed.*ext|whitelist.*ext|ext.*whitelist|\[['"]jpg['"]|['"]png['"]|['"]gif['"]|['"]pdf['"]/.test(content);

  if (hasMimeCheck && !hasExtensionWhitelist) {
    // Find a good line number — first $_FILES occurrence
    let firstLine = 1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('$_FILES')) {
        firstLine = i + 1;
        break;
      }
    }
    // Avoid duplicate if already reported on same line from pattern 1
    const alreadyReported = infos.some((inf) => inf.file === relFile && inf.line === firstLine && inf.pattern === 'mime-only-no-extension-whitelist');
    if (!alreadyReported) {
      infos.push({
        file: relFile,
        line: firstLine,
        pattern: 'mime-only-no-extension-whitelist',
        severity: 'medium',
        issue: 'File upload validates MIME type but no extension whitelist array found — MIME checks alone can be bypassed; also validate the file extension against an explicit whitelist (e.g. [\'jpg\', \'png\', \'pdf\'])',
      });
    }
  }

  return infos;
}

function buildFileUploadValidationInfos(appPath: string): FileUploadValidationInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: FileUploadValidationInfo[] = [];
  const files = collectPhpFiles(srcDir, appPath);
  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    const infos = analyseFileUploadFile(content, path.relative(appPath, file));
    results.push(...infos);
  }
  return results;
}

export function listPhpFileUploadValidation(appPath: string): McpToolResult {
  try {
    const infos = buildFileUploadValidationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP file upload validation issues found in src/.' }] };
    }
    let text = `PHP File Upload Validation Issues\n${'='.repeat(50)}\n\nTotal: ${infos.length}\n\n`;
    for (const info of infos) {
      text += `  [${info.severity.toUpperCase()}] [${info.pattern}] ${info.file}:${info.line}\n`;
      text += `    ${info.issue}\n\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFileUploadValidationStats(appPath: string): McpToolResult {
  try {
    const infos = buildFileUploadValidationInfos(appPath);
    const stats = {
      total: infos.length,
      filesAffected: new Set(infos.map((i) => i.file)).size,
      bySeverity: { high: 0, medium: 0, low: 0 } as Record<string, number>,
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

export function getPhpFileUploadValidationTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Absolute path to the Symfony application root' } };
  return [
    {
      name: 'list_php_file_upload_validation',
      description: 'Scan PHP source files for raw $_FILES handling security issues: spoofable MIME type check via $_FILES[...][\'type\'] (HIGH), path traversal from $_FILES[...][\'name\'] without basename() (HIGH), uploads stored in public/web directories (MEDIUM), missing is_uploaded_file() check (MEDIUM), MIME-only validation without extension whitelist (MEDIUM)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_file_upload_validation_stats',
      description: 'Statistics for PHP file upload validation issues: total findings, files affected, counts by severity and by pattern name',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
