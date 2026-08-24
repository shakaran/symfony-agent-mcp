// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface FileUploadUsage {
  file: string;
  class?: string;
  usesUploadedFile: boolean;
  hasGuessExtension: boolean;
  hasMoveWithAbsolutePath: boolean;
  hasMimeValidation: boolean;
  hasSizeValidation: boolean;
  issues: string[];
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

function parseFileUpload(filePath: string, appPath: string): FileUploadUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('UploadedFile') && !content.includes('$request->files')) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const usesUploadedFile = content.includes('UploadedFile');
  const hasGuessExtension = content.includes('->guessExtension(');
  const hasMoveWithAbsolutePath = /->move\s*\(\s*['"]\//.test(content);
  const hasMimeValidation = content.includes('getMimeType') || content.includes('File]') || content.includes('Mime]') || content.includes('mimeTypes:');
  const hasSizeValidation = content.includes('getMaxFilesize') || content.includes('maxSize') || content.includes('File]') || content.includes('getSize');
  const issues: string[] = [];
  if (hasGuessExtension && !hasMimeValidation) issues.push('guessExtension() used without MIME type validation — attacker can change extension by manipulating file content');
  if (hasMoveWithAbsolutePath) issues.push('move() with absolute path — not portable; use kernel.project_dir or ParameterBagInterface');
  if (usesUploadedFile && !hasMimeValidation) issues.push('UploadedFile without MIME type validation — validate allowed MIME types with #[Assert\\File(mimeTypes: [...])]');
  return { file: path.relative(appPath, filePath), class: classM?.[1], usesUploadedFile, hasGuessExtension, hasMoveWithAbsolutePath, hasMimeValidation, hasSizeValidation, issues };
}

export function listFileUploadUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: FileUploadUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseFileUpload(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No file upload handling found.' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `File Upload Handling\n${'='.repeat(55)}\n\nFiles with upload logic: ${usages.length}  Issues: ${totalIssues}\n`;
    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [u.hasMimeValidation ? '✓ MIME' : '⚠ no MIME', u.hasSizeValidation ? '✓ size' : '⚠ no size'].join('  ');
      text += `\n  ${u.class ?? '(file)'}  ${flags}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFileUploadStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: FileUploadUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseFileUpload(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `File Upload Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with uploads: ${usages.length}\n  With MIME validation: ${usages.filter((u) => u.hasMimeValidation).length}\n  With size validation: ${usages.filter((u) => u.hasSizeValidation).length}\n  Absolute move paths: ${usages.filter((u) => u.hasMoveWithAbsolutePath).length}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFileUploadTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_file_upload_usage', description: 'Show file upload handling: UploadedFile usage, MIME type validation, size validation, guessExtension() without MIME check (security), move() with absolute path (portability)', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_file_upload_stats', description: 'Show file upload statistics: file count, MIME/size validation coverage, absolute path count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
