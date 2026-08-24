// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface TurboFrameInfo {
  file: string;
  type: 'turbo-frame' | 'turbo-stream' | 'response' | 'csrf';
  pattern: string;
  issues: string[];
}

function getAllFiles(dir: string, ext: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllFiles(full, ext));
      else if (e.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function readFileSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function buildSymfonyUxTurboFrameInfos(appPath: string): TurboFrameInfo[] {
  const results: TurboFrameInfo[] = [];
  let turboFrameInTemplates = false;

  // Scan Twig templates
  const templatesDir = path.join(appPath, 'templates');
  if (fs.existsSync(templatesDir)) {
    for (const file of getAllFiles(templatesDir, '.twig')) {
      const content = readFileSafe(file);
      const rel = path.relative(appPath, file);

      if (content.includes('<turbo-frame')) {
        turboFrameInTemplates = true;
        const issues: string[] = [];
        // Check for turbo-frame without id attribute
        if (/<turbo-frame(?![^>]*\bid=)/.test(content)) {
          issues.push('turbo-frame element without id attribute — all turbo-frame elements must have unique IDs for Turbo to target them correctly');
        }
        results.push({ file: rel, type: 'turbo-frame', pattern: '<turbo-frame>', issues });
      }

      if (content.includes('turbo_stream(')) {
        const actions = ['append', 'prepend', 'replace', 'update', 'remove'];
        const foundActions = actions.filter((a) => content.includes(`turbo_stream('${a}'`) || content.includes(`turbo_stream("${a}"`));
        results.push({ file: rel, type: 'turbo-stream', pattern: `turbo_stream (${foundActions.join(', ') || 'unknown'})`, issues: [] });
      }
    }
  }

  // Scan PHP files for TurboStreamResponse
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllFiles(srcDir, '.php')) {
      const content = readFileSafe(file);
      const rel = path.relative(appPath, file);

      if (content.includes('TurboStreamResponse')) {
        const issues: string[] = [];
        // Check for POST action returning TurboStreamResponse without CSRF check
        if (content.includes('Request $request') && !content.includes('isCsrfTokenValid') && !content.includes('_token')) {
          issues.push('TurboStreamResponse without CSRF validation — Turbo form submissions should include CSRF tokens; ensure Symfony\'s form component handles this');
        }
        results.push({ file: rel, type: 'response', pattern: 'TurboStreamResponse', issues });
      }
    }
  }

  // Check composer.json for symfony/ux-turbo
  const composerJson = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerJson)) {
    const content = readFileSafe(composerJson);
    if (!content.includes('symfony/ux-turbo') && turboFrameInTemplates) {
      results.push({ file: 'composer.json', type: 'csrf', pattern: 'symfony/ux-turbo missing', issues: ['turbo-frame elements in templates but symfony/ux-turbo not in composer.json — install with: composer require symfony/ux-turbo'] });
    }
  }

  return results;
}

export function listSymfonyUxTurboFrames(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyUxTurboFrameInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Turbo Frame usage found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony UX Turbo Frame Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyUxTurboFrameStats(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyUxTurboFrameInfos(appPath);
    let text = `Symfony UX Turbo Frame Statistics\n${'='.repeat(40)}\n\n`;
    text += `Turbo-frame:   ${infos.filter((i) => i.type === 'turbo-frame').length}\n`;
    text += `Turbo-stream:  ${infos.filter((i) => i.type === 'turbo-stream').length}\n`;
    text += `Response:      ${infos.filter((i) => i.type === 'response').length}\n`;
    text += `CSRF:          ${infos.filter((i) => i.type === 'csrf').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyUxTurboFrameTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_ux_turbo_frames', description: 'Analyze Symfony UX Turbo Frame usage: turbo-frame/turbo-stream in templates, TurboStreamResponse in PHP, CSRF validation, missing ux-turbo package', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_ux_turbo_frame_stats', description: 'Statistics for Symfony UX Turbo: counts by type (turbo-frame/turbo-stream/response/csrf) and total issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
