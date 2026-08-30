// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface UxTypedInfo {
  file: string;
  type: 'controller' | 'twig' | 'config' | 'asset';
  pattern: string;
  issues: string[];
}

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildUxTypedInfos(appPath: string): UxTypedInfo[] {
  const results: UxTypedInfo[] = [];

  let hasUxTyped = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['symfony/ux-typed']) hasUxTyped = true;
    } catch { /* ignore */ }
  }

  const assetsControllersDir = path.join(appPath, 'assets', 'controllers');
  if (fs.existsSync(assetsControllersDir)) {
    try {
      for (const entry of fs.readdirSync(assetsControllersDir)) {
        if (!entry.endsWith('.js') && !entry.endsWith('.ts')) continue;
        let content = '';
        try { content = fs.readFileSync(path.join(assetsControllersDir, entry), 'utf-8'); } catch { continue; }
        if (content.includes('typed') || content.includes('Typed')) {
          results.push({ file: `assets/controllers/${entry}`, type: 'controller', pattern: 'custom typed controller', issues: [] });
        }
      }
    } catch { /* skip */ }
  }

  const controllersJsonPath = path.join(appPath, 'assets', 'controllers.json');
  if (fs.existsSync(controllersJsonPath)) {
    let content = '';
    try { content = fs.readFileSync(controllersJsonPath, 'utf-8'); } catch { /* skip */ }
    if (content.includes('typed') || content.includes('ux-typed')) {
      const issues: string[] = [];
      if (!hasUxTyped) {
        issues.push('UX Typed referenced in controllers.json but symfony/ux-typed not in composer.json — run: composer require symfony/ux-typed');
      }
      results.push({ file: 'assets/controllers.json', type: 'asset', pattern: 'ux-typed registration', issues });
    }
  }

  const templatesDir = path.join(appPath, 'templates');
  if (fs.existsSync(templatesDir)) {
    for (const file of getAllTwigFiles(templatesDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      if (!content.includes('ux-typed') && !content.includes('symfony_ux_typed') && !content.includes("'typed'") || content.includes('"typed"')) continue;

      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      if (content.includes('data-controller="symfony--ux-typed--typed"') || content.includes("data-controller='symfony--ux-typed--typed'")) {
        const hasStrings = content.includes('data-symfony--ux-typed--typed-strings-value');
        if (!hasStrings) {
          issues.push('UX Typed controller without strings value — the animation has nothing to type; add data-symfony--ux-typed--typed-strings-value=\'["Hello", "World"]\'');
        }

        const hasSpeed = content.includes('type-speed') || content.includes('typeSpeed');
        if (!hasSpeed) {
          issues.push('UX Typed without typeSpeed — defaults to 0ms (instant); add data-symfony--ux-typed--typed-type-speed-value="50" for readable animation');
        }

        const hasLoop = content.includes('loop') || content.includes('Loop');
        if (!hasLoop && content.includes('strings')) {
          issues.push('UX Typed animation without loop=true — typed animation plays once then stops; for continuous effect add data-symfony--ux-typed--typed-loop-value="true"');
        }
      }

      results.push({ file: relFile, type: 'twig', pattern: 'UX Typed in template', issues });
    }
  }

  if (!hasUxTyped && results.length === 0) {
    results.push({ file: 'composer.json', type: 'config', pattern: 'symfony/ux-typed not installed', issues: ['symfony/ux-typed not found — install with: composer require symfony/ux-typed'] });
  }

  return results;
}

export function listSymfonyUxTyped(appPath: string): McpToolResult {
  try {
    const infos = buildUxTypedInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No UX Typed patterns found (no symfony/ux-typed or typed controller references).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `UX Typed Analysis\n${'='.repeat(50)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyUxTypedStats(appPath: string): McpToolResult {
  try {
    const infos = buildUxTypedInfos(appPath);
    let text = `UX Typed Statistics\n${'='.repeat(40)}\n\n`;
    text += `Templates: ${infos.filter((i) => i.type === 'twig').length}\n`;
    text += `Issues:    ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyUxTypedTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_ux_typed', description: 'Analyze Symfony UX Typed component usage; warns on typed controller without strings, missing typeSpeed, no loop for continuous animation, controllers.json reference without package', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_ux_typed_stats', description: 'Statistics for UX Typed: template/controller count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
