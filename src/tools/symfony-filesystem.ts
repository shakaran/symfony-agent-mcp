import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface FilesystemUsage {
  file: string;
  class?: string;
  methods: string[];
  usesAtomicWrite: boolean;
  usesTempFile: boolean;
  usesAbsolutePath: boolean;
  issues: string[];
}

const FS_METHODS = ['mkdir', 'copy', 'dumpFile', 'appendToFile', 'rename', 'remove', 'symlink', 'hardlink', 'mirror', 'touch', 'chmod', 'chown', 'chgrp'];

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

function parseFilesystemUsage(filePath: string, appPath: string): FilesystemUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const hasSymfonyFs = content.includes('Filesystem') || content.includes('new Filesystem');
  if (!hasSymfonyFs) return null;
  if (content.includes('namespace Symfony\\Component\\Filesystem')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const found: string[] = [];
  for (const method of FS_METHODS) {
    if (content.includes(`->${method}(`) || content.includes(`$filesystem->${method}(`)) found.push(method);
  }
  if (found.length === 0 && !content.includes('Filesystem')) return null;
  const usesAtomicWrite = content.includes('dumpFile') || content.includes('AtomicDumper');
  const usesTempFile = content.includes('tempnam') || content.includes('sys_get_temp_dir');
  const usesAbsolutePath = /new\s+Filesystem\s*\(\s*\)\s*;[^}]{0,500}['"]\//.test(content) || /->(?:dumpFile|copy|mkdir)\s*\(\s*['"]\//.test(content);
  const issues: string[] = [];
  if (content.includes('file_put_contents') && content.includes('Filesystem')) issues.push('Mixing file_put_contents() with Symfony Filesystem — prefer dumpFile() for atomic writes');
  if (content.includes('mkdir(') && !content.includes('->mkdir(')) issues.push('Using native mkdir() instead of Symfony Filesystem::mkdir() — missing recursive/permissions handling');
  if (usesTempFile) issues.push('tempnam()/sys_get_temp_dir() usage — ensure temp files are cleaned up (use try/finally)');
  if (usesAbsolutePath) issues.push('Absolute paths in Filesystem calls — prefer %kernel.project_dir% parameter for portability');
  return { file: path.relative(appPath, filePath), class: classM?.[1], methods: found, usesAtomicWrite, usesTempFile, usesAbsolutePath, issues };
}

export function listFilesystemUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: FilesystemUsage[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseFilesystemUsage(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No Symfony Filesystem component usage found.' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Symfony Filesystem Usage\n${'='.repeat(55)}\n\nFiles: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.class ?? '(file)'}  methods: ${r.methods.join(', ')}  (${r.file})\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFilesystemStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: FilesystemUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseFilesystemUsage(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `Symfony Filesystem Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using Filesystem: ${results.length}\n  Atomic writes (dumpFile): ${results.filter(r => r.usesAtomicWrite).length}\n  Temp file usage: ${results.filter(r => r.usesTempFile).length}\n  Absolute paths: ${results.filter(r => r.usesAbsolutePath).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFilesystemTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_filesystem', description: 'Detect Symfony Filesystem component usage: mkdir/copy/dumpFile/appendToFile/mirror calls, atomic write detection, temp file cleanup risk, native mkdir() vs Filesystem::mkdir() warning, absolute path portability warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_filesystem_stats', description: 'Symfony Filesystem statistics: file count, atomic write count, temp file count, absolute path count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
