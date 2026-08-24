// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Sub-request Inspector
 *
 * Scans src/ PHP for sub-request patterns:
 *   - HttpKernelInterface::SUB_REQUEST
 *   - $kernel->handle( calls
 *   - isMainRequest() / isSubRequest()
 *   - render(controller(...)) in Twig templates
 *   - Services injecting HttpKernelInterface
 *
 * Warns about:
 *   - Sub-request inside loop (N requests per page)
 *   - Sub-request without catching exceptions
 *   - HttpKernelInterface injected in CLI service (null request)
 *   - Sub-request to same controller as parent (potential loop)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface SubrequestInfo {
  file: string;
  class?: string;
  isKernelInjection: boolean;
  hasSUBRequestConstant: boolean;
  insideLoop: boolean;
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

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig') || e.name.endsWith('.html.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function isInsideLoop(content: string, keyword: string): boolean {
  const idx = content.indexOf(keyword);
  if (idx === -1) return false;
  // Look back up to 500 chars for loop keywords
  const before = content.slice(Math.max(0, idx - 500), idx);
  return /\b(foreach|for|while)\s*\(/.test(before);
}

function parseSubrequestFile(filePath: string, appPath: string): SubrequestInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasSUBConst = content.includes('HttpKernelInterface::SUB_REQUEST');
  const hasKernelHandle = content.includes('->handle(');
  const hasMainRequest = content.includes('isMainRequest()') || content.includes('isSubRequest()');
  const isKernelInjection = /implements[^{]{0,300}HttpKernelInterface/.test(content) === false &&
    content.includes('HttpKernelInterface') &&
    /private[^;]{0,100}HttpKernelInterface/.test(content);

  if (!hasSUBConst && !hasKernelHandle && !hasMainRequest && !isKernelInjection) return null;
  if (content.includes('namespace Symfony\\Component\\HttpKernel')) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  const issues: string[] = [];

  const insideLoop = hasSUBConst
    ? isInsideLoop(content, 'HttpKernelInterface::SUB_REQUEST')
    : (hasKernelHandle && isInsideLoop(content, '->handle('));

  if (insideLoop) {
    issues.push('Sub-request inside loop — causes N kernel->handle() calls per page load (performance issue)');
  }

  // Check for exception handling around handle()
  if (hasKernelHandle && hasSUBConst) {
    const handleIdx = content.indexOf('->handle(');
    const snippet = content.slice(Math.max(0, handleIdx - 200), handleIdx + 300);
    const hasCatch = snippet.includes('catch') || snippet.includes('try');
    if (!hasCatch) {
      issues.push('kernel->handle() sub-request without try/catch — exceptions from sub-request propagate to parent');
    }
  }

  // CLI service warning
  if (isKernelInjection) {
    const isCommand = content.includes('extends Command') || content.includes('AsCommand');
    if (isCommand) {
      issues.push('HttpKernelInterface injected in CLI command — Request object will be null/empty in CLI context');
    }
  }

  // Check if handle() target is same controller class
  if (hasKernelHandle && hasSUBConst && classM) {
    const handleM = /->handle\([^,)]{0,100},[^,)]{0,100},[^)]{0,200}(\w{1,100})Controller/.exec(content);
    if (handleM && classM[1].includes(handleM[1])) {
      issues.push(`Sub-request may target same controller "${classM[1]}" — potential infinite loop`);
    }
  }

  if (!hasSUBConst && !hasKernelHandle && !isKernelInjection && issues.length === 0) return null;

  return {
    file: path.relative(appPath, filePath),
    class: classM?.[1],
    isKernelInjection,
    hasSUBRequestConstant: hasSUBConst,
    insideLoop,
    issues,
  };
}

interface TwigSubrequestInfo {
  file: string;
  renderControllerCount: number;
  issues: string[];
}

function parseTwigFile(filePath: string, appPath: string): TwigSubrequestInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const count = (content.match(/render\s*\(\s*controller\s*\(/g) ?? []).length;
  if (count === 0) return null;

  const issues: string[] = [];
  // Detect render(controller()) inside for/while loops in Twig
  if (/\{%\s*(for|while)[^%]{0,300}%\}[^{]{0,1000}render\s*\(\s*controller/.test(content)) {
    issues.push('render(controller(...)) inside Twig loop — triggers N sub-requests per render');
  }

  return {
    file: path.relative(appPath, filePath),
    renderControllerCount: count,
    issues,
  };
}

function loadSubrequestData(appPath: string): { phpInfos: SubrequestInfo[]; twigInfos: TwigSubrequestInfo[] } {
  const srcDir = path.join(appPath, 'src');
  const templatesDir = path.join(appPath, 'templates');

  const phpInfos: SubrequestInfo[] = [];
  if (fs.existsSync(srcDir)) {
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseSubrequestFile(f, appPath);
      if (r) phpInfos.push(r);
    }
  }
  phpInfos.sort((a, b) => a.file.localeCompare(b.file));

  const twigInfos: TwigSubrequestInfo[] = [];
  if (fs.existsSync(templatesDir)) {
    for (const f of getAllTwigFiles(templatesDir)) {
      const r = parseTwigFile(f, appPath);
      if (r) twigInfos.push(r);
    }
  }
  twigInfos.sort((a, b) => a.file.localeCompare(b.file));

  return { phpInfos, twigInfos };
}

export function listSubrequestUsage(appPath: string): McpToolResult {
  try {
    const { phpInfos, twigInfos } = loadSubrequestData(appPath);

    if (phpInfos.length === 0 && twigInfos.length === 0) {
      return { content: [{ type: 'text', text: 'No sub-request usage found in src/ or templates/.' }] };
    }

    const totalIssues = phpInfos.reduce((s, i) => s + i.issues.length, 0) +
      twigInfos.reduce((s, i) => s + i.issues.length, 0);

    let text = `Symfony Sub-request Usage\n${'='.repeat(55)}\n`;
    text += `PHP files: ${phpInfos.length}  Twig files: ${twigInfos.length}  Issues: ${totalIssues}\n`;

    if (phpInfos.length > 0) {
      text += `\nPHP Sub-request Usage:\n`;
      for (const info of phpInfos) {
        text += `\n  ${info.file}`;
        if (info.class) text += `  [${info.class}]`;
        text += '\n';
        const flags = [
          info.isKernelInjection ? 'kernel-injection' : '',
          info.hasSUBRequestConstant ? 'SUB_REQUEST' : '',
          info.insideLoop ? 'inside-loop' : '',
        ].filter(Boolean).join(', ');
        if (flags) text += `    flags: [${flags}]\n`;
        for (const issue of info.issues) text += `    WARN: ${issue}\n`;
      }
    }

    if (twigInfos.length > 0) {
      text += `\nTwig render(controller(...)) Usage:\n`;
      for (const t of twigInfos) {
        text += `\n  ${t.file}  [${t.renderControllerCount} call(s)]\n`;
        for (const issue of t.issues) text += `    WARN: ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSubrequestStats(appPath: string): McpToolResult {
  try {
    const { phpInfos, twigInfos } = loadSubrequestData(appPath);

    let text = `Sub-request Statistics\n${'='.repeat(40)}\n\n`;
    text += `PHP files with sub-requests:   ${phpInfos.length}\n`;
    text += `  Kernel injections:           ${phpInfos.filter((i) => i.isKernelInjection).length}\n`;
    text += `  Using SUB_REQUEST const:     ${phpInfos.filter((i) => i.hasSUBRequestConstant).length}\n`;
    text += `  Inside loops:                ${phpInfos.filter((i) => i.insideLoop).length}\n`;
    text += `Twig render(controller()):     ${twigInfos.reduce((s, t) => s + t.renderControllerCount, 0)} calls in ${twigInfos.length} files\n`;
    const totalIssues = phpInfos.reduce((s, i) => s + i.issues.length, 0) +
      twigInfos.reduce((s, i) => s + i.issues.length, 0);
    text += `Issues:                        ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSubrequestTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_subrequest_usage',
      description: 'List Symfony sub-request usage: HttpKernelInterface::SUB_REQUEST, kernel->handle() calls, isMainRequest/isSubRequest, render(controller()) in Twig; warns about loops, missing exception handling, CLI usage, potential loops',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_subrequest_stats',
      description: 'Show sub-request statistics: PHP file counts, kernel injection/SUB_REQUEST/loop breakdown, Twig render(controller()) count, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
