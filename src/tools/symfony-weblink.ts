// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface WebLinkUsage {
  file: string;
  class?: string;
  addLinkCount: number;
  preloadCount: number;
  prefetchCount: number;
  preconnectCount: number;
  hasWebLinkManager: boolean;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseWebLink(filePath: string, appPath: string): WebLinkUsage | null {
  const srcDir = path.join(appPath, 'src');
  const content = safeRead(filePath, srcDir);
  if (content === null) return null;
  const hasAny = content.includes('WebLink') || content.includes('addLink(') || content.includes('WebLinkManager');
  if (!hasAny) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const addLinkCount = [...content.matchAll(/->addLink\s*\(/g)].length;
  const preloadCount = [...content.matchAll(/['"](preload|modulepreload)['"]/g)].length;
  const prefetchCount = [...content.matchAll(/['"]prefetch['"]/g)].length;
  const preconnectCount = [...content.matchAll(/['"]preconnect['"]/g)].length;
  const hasWebLinkManager = content.includes('WebLinkManager');
  const issues: string[] = [];
  if (addLinkCount > 0 && !content.includes('as=')) issues.push('Link header without as= attribute — preload hints without resource type may be ignored by browsers');
  return { file: path.relative(appPath, filePath), class: classM?.[1], addLinkCount, preloadCount, prefetchCount, preconnectCount, hasWebLinkManager, issues };
}

export function listWebLinkUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: WebLinkUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseWebLink(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No WebLink component usage found.\n\nInstall: composer require symfony/web-link\n\nExample:\n  use Symfony\\Component\\WebLink\\Link;\n  $response->headers->set(\'Link\', (string) (new Link(\'preload\', \'/styles.css\'))->withAttribute(\'as\', \'style\'));' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Symfony WebLink Component\n${'='.repeat(55)}\n\nFiles: ${usages.length}  Issues: ${totalIssues}\n`;
    text += `  preload: ${usages.reduce((s, u) => s + u.preloadCount, 0)}  prefetch: ${usages.reduce((s, u) => s + u.prefetchCount, 0)}  preconnect: ${usages.reduce((s, u) => s + u.preconnectCount, 0)}\n`;
    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${u.class ?? '(file)'}  addLink: ${u.addLinkCount}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getWebLinkStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: WebLinkUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseWebLink(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `WebLink Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files: ${usages.length}\n  preload: ${usages.reduce((s, u) => s + u.preloadCount, 0)}\n  prefetch: ${usages.reduce((s, u) => s + u.prefetchCount, 0)}\n  preconnect: ${usages.reduce((s, u) => s + u.preconnectCount, 0)}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getWebLinkTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_weblink_usage', description: 'Show Symfony WebLink component usage: addLink() calls, preload/prefetch/preconnect hints, WebLinkManager, missing as= attribute warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_weblink_stats', description: 'Show WebLink statistics: file count, preload/prefetch/preconnect counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
