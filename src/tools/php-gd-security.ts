/**
 * PHP GD / Imagick Image Processing Security Inspector
 *
 * Scans src/ PHP files for image processing security issues:
 *   - imagecreatefromstring( — any-format decode, only safe with trusted input
 *   - imagecreatefromjpeg/png/gif/webp( without preceding MIME validation (10-line window)
 *   - new \Imagick( / new Imagick( with variable argument (user-controlled path)
 *   - $_FILES[ used within 5 lines of image creation (upload piped to creation)
 *   - Variable path passed to imagecreatefrom* (path traversal risk)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface GdSecurityInfo {
  file: string;
  line: number;
  fn: string;
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

function windowHasValidation(lines: string[], centerIdx: number, radius: number): boolean {
  const start = Math.max(0, centerIdx - radius);
  const end = Math.min(lines.length - 1, centerIdx + radius);
  for (let i = start; i <= end; i++) {
    const l = lines[i];
    if (/getimagesize\s*\(/.test(l) || /mime_content_type\s*\(/.test(l) || /exif_imagetype\s*\(/.test(l)) {
      return true;
    }
  }
  return false;
}

function windowHasFilesUpload(lines: string[], centerIdx: number, radius: number): boolean {
  const start = Math.max(0, centerIdx - radius);
  const end = Math.min(lines.length - 1, centerIdx + radius);
  for (let i = start; i <= end; i++) {
    if (/\$_FILES\s*\[/.test(lines[i])) return true;
  }
  return false;
}

// Checks whether the argument to imagecreatefrom* looks like a variable (not a literal string)
function argIsVariable(afterFn: string): boolean {
  const argsSection = afterFn.slice(0, 120).split(')')[0] ?? '';
  // If the first non-space char after ( is $ it's a variable
  return /^\s*\$/.test(argsSection);
}

const IMAGE_CREATE_FNS = [
  'imagecreatefromjpeg',
  'imagecreatefrompng',
  'imagecreatefromgif',
  'imagecreatefromwebp',
];

function buildGdSecurityInfos(appPath: string): GdSecurityInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: GdSecurityInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  for (const file of collectPhpFiles(srcDir, appPath)) {
    const content = safeRead(file, appPath);
    if (!content) continue;

    const lines = content.split('\n');
    const relFile = path.relative(appPath, file);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // imagecreatefromstring( — always flag
      if (/\bimagecreatefromstring\s*\(/.test(trimmed)) {
        results.push({
          file: relFile,
          line: lineNum,
          fn: 'imagecreatefromstring',
          issue: 'imagecreatefromstring() decodes any image format from a binary string — use only with trusted/validated input; combined with user uploads this can trigger parser vulnerabilities in libgd',
        });
      }

      // imagecreatefrom{jpeg,png,gif,webp}( without MIME validation in ±10 lines
      for (const fn of IMAGE_CREATE_FNS) {
        const re = new RegExp(`\\b${fn}\\s*\\(`);
        const fnMatch = re.exec(trimmed);
        if (!fnMatch) continue;

        // Check for $_FILES in ±5 lines
        if (windowHasFilesUpload(lines, i, 5)) {
          results.push({
            file: relFile,
            line: lineNum,
            fn,
            issue: `${fn}() called within 5 lines of $_FILES — user-uploaded file piped directly to image creation without intermediate move_uploaded_file()/validation step`,
          });
        }

        // Check for missing MIME validation in ±10 lines
        if (!windowHasValidation(lines, i, 10)) {
          results.push({
            file: relFile,
            line: lineNum,
            fn,
            issue: `${fn}() called without nearby getimagesize()/mime_content_type()/exif_imagetype() validation (checked ±10 lines) — validate image type before processing to prevent polyglot file attacks`,
          });
        }

        // Check if argument is a variable (path traversal risk)
        const afterFn = trimmed.slice(fnMatch.index + fnMatch[0].length);
        if (argIsVariable(afterFn)) {
          results.push({
            file: relFile,
            line: lineNum,
            fn,
            issue: `${fn}() receives a variable path — ensure the path is sanitized with realpath() and validated to stay within the upload directory (path traversal risk)`,
          });
        }
      }

      // new \Imagick( / new Imagick( with variable arg
      const imagickMatch = /\bnew\s+\\?Imagick\s*\(/.exec(trimmed);
      if (imagickMatch) {
        const afterFn = trimmed.slice(imagickMatch.index + imagickMatch[0].length);
        if (argIsVariable(afterFn)) {
          results.push({
            file: relFile,
            line: lineNum,
            fn: 'new Imagick',
            issue: 'new Imagick() constructed with variable path — Imagick supports URL/HTTP/FTP schemes; a user-controlled path can trigger SSRF or read arbitrary files via MSL/MVG interpreters',
          });
        }
      }
    }
  }

  return results;
}

export function listPhpGdSecurity(appPath: string): McpToolResult {
  try {
    const infos = buildGdSecurityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No GD/Imagick security issues found in src/ PHP files.' }] };
    }

    let text = `PHP GD/Imagick Image Processing Security Issues\n${'='.repeat(55)}\n\n`;
    text += `Total issues found: ${infos.length}\n\n`;

    for (const info of infos.slice(0, 50)) {
      text += `  [${info.fn}]  ${info.file}:${info.line}\n`;
      text += `    Issue: ${info.issue}\n\n`;
    }

    if (infos.length > 50) {
      text += `  ... and ${infos.length - 50} more issues\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpGdSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = buildGdSecurityInfos(appPath);

    const fromString = infos.filter((i) => i.fn === 'imagecreatefromstring').length;
    const missingValidation = infos.filter((i) => i.issue.includes('without nearby')).length;
    const filesUpload = infos.filter((i) => i.issue.includes('$_FILES')).length;
    const variablePath = infos.filter((i) => i.issue.includes('variable path') || i.issue.includes('variable path')).length;
    const imagick = infos.filter((i) => i.fn === 'new Imagick').length;

    const byFile = new Map<string, number>();
    for (const info of infos) {
      byFile.set(info.file, (byFile.get(info.file) ?? 0) + 1);
    }
    const topFiles = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    let text = `PHP GD/Imagick Security Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total issues: ${infos.length}\n`;
    text += `  imagecreatefromstring (any-format decode): ${fromString}\n`;
    text += `  Missing MIME validation (±10 lines):       ${missingValidation}\n`;
    text += `  $_FILES piped to image creation (±5 lines): ${filesUpload}\n`;
    text += `  Variable path argument (traversal risk):   ${variablePath}\n`;
    text += `  new Imagick with variable path (SSRF risk): ${imagick}\n\n`;

    if (topFiles.length > 0) {
      text += `Top files by issue count:\n`;
      for (const [file, count] of topFiles) {
        text += `  ${count}  ${file}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpGdSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_gd_security',
      description: 'List PHP GD/Imagick image processing security issues: imagecreatefromstring unsafe use, missing MIME validation, $_FILES piped to image creation, variable paths, new Imagick SSRF risk',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_gd_security_stats',
      description: 'Show PHP GD/Imagick security statistics: counts by issue type (any-format decode/missing validation/$_FILES/traversal/SSRF), top files by issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
