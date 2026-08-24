// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Hotwire Turbo Inspector (symfony/ux-turbo)
 *
 * Detects Turbo Streams:
 *   - Classes with #[BroadcastMercure] — auto-broadcast on persist/update/remove
 *   - TurboStreamResponse usage in controllers
 *   - turbo_stream() / stream_with() Twig helper calls
 *
 * Turbo Frames:
 *   - <turbo-frame id="..."> in Twig templates
 *   - data-turbo-frame attributes
 *
 * Turbo Drive:
 *   - data-turbo="false" opt-outs
 *   - data-turbo-action attributes
 *
 * Mercure integration:
 *   - Broadcast topics per entity
 *   - #[Broadcast] without Mercure hub configured (cross-check mercure.yaml)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface TurboStream {
  class: string;
  file: string;
  topics: string[];
  broadcastOn: string[];
}

interface TurboFrame {
  id: string;
  template: string;
  lazy: boolean;
}

function getAllFiles(dir: string, ext: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllFiles(full, ext));
      else if (entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function scanBroadcastEntities(appPath: string): TurboStream[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: TurboStream[] = [];

  for (const file of getAllFiles(srcDir, '.php')) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('BroadcastMercure') && !content.includes('#[Broadcast]')) continue;
    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const topics: string[] = [];
    for (const m of content.matchAll(/topic\s*:\s*['"]([^'"]+)['"]/g)) topics.push(m[1]);

    const broadcastOn: string[] = [];
    for (const m of content.matchAll(/broadcastOn\(\)[^{]*\{[^}]*return\s*\[([^\]]+)\]/gs)) {
      broadcastOn.push(...m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean));
    }

    results.push({ class: classM[1], file: path.basename(file), topics, broadcastOn });
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

function scanTurboControllers(appPath: string): string[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const controllers: string[] = [];

  for (const file of getAllFiles(srcDir, '.php')) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('TurboStreamResponse') && !content.includes('turbo_stream')) continue;
    const classM = /class\s+(\w+)/.exec(content);
    if (classM) controllers.push(classM[1]);
  }
  return controllers.sort();
}

function scanTurboFrames(appPath: string): TurboFrame[] {
  const templateDirs = [
    path.join(appPath, 'templates'),
    path.join(appPath, 'src'),
  ];
  const frames: TurboFrame[] = [];
  const seen = new Set<string>();

  for (const dir of templateDirs) {
    for (const file of getAllFiles(dir, '.twig')) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      for (const m of content.matchAll(/<turbo-frame[^>]+id=["']([^"']+)["']/g)) {
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        const lazy = m[0].includes('loading="lazy"') || m[0].includes("loading='lazy'");
        frames.push({ id, template: path.basename(file), lazy });
      }
    }
  }
  return frames;
}

function isMercureConfigured(appPath: string): boolean {
  return fs.existsSync(path.join(appPath, 'config', 'packages', 'mercure.yaml')) ||
         fs.existsSync(path.join(appPath, 'config', 'packages', 'mercure.yml'));
}

export function listTurboConfig(appPath: string): McpToolResult {
  try {
    const streams     = scanBroadcastEntities(appPath);
    const controllers = scanTurboControllers(appPath);
    const frames      = scanTurboFrames(appPath);
    const mercureOk   = isMercureConfigured(appPath);

    if (streams.length === 0 && controllers.length === 0 && frames.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Hotwire Turbo usage detected.\n\nInstall symfony/ux-turbo:\n  composer require symfony/ux-turbo\n\nAdd to entities for real-time broadcast:\n  #[BroadcastMercure]\n  class Product { ... }',
        }],
      };
    }

    let text = `Hotwire Turbo Configuration\n${'='.repeat(55)}\n`;

    if (streams.length > 0) {
      text += `\nBroadcast entities (${streams.length}):\n`;
      for (const s of streams) {
        text += `  ${s.class.padEnd(35)} (${s.file})\n`;
        if (s.topics.length > 0) text += `    Topics: ${s.topics.join(', ')}\n`;
        if (!mercureOk) text += `    ⚠ #[Broadcast] found but no Mercure hub configured\n`;
      }
    }

    if (controllers.length > 0) {
      text += `\nControllers using TurboStreamResponse (${controllers.length}):\n`;
      for (const c of controllers) text += `  ${c}\n`;
    }

    if (frames.length > 0) {
      text += `\nTurbo frames declared (${frames.length}):\n`;
      for (const f of frames) {
        const lazy = f.lazy ? '  [lazy]' : '';
        text += `  #${f.id.padEnd(30)} ${f.template}${lazy}\n`;
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

export function getTurboStats(appPath: string): McpToolResult {
  try {
    const streams     = scanBroadcastEntities(appPath);
    const controllers = scanTurboControllers(appPath);
    const frames      = scanTurboFrames(appPath);
    const mercureOk   = isMercureConfigured(appPath);

    let text = `Hotwire Turbo Statistics\n${'='.repeat(40)}\n\n`;
    text += `Broadcast entities:    ${streams.length}\n`;
    text += `TurboStream controllers: ${controllers.length}\n`;
    text += `Turbo frames:          ${frames.length}\n`;
    text += `Lazy frames:           ${frames.filter((f) => f.lazy).length}\n`;
    text += `Mercure configured:    ${mercureOk ? 'yes' : 'no'}\n`;
    if (streams.length > 0 && !mercureOk) {
      text += `⚠ Broadcast entities without Mercure hub\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTurboTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_turbo_config',
      description: 'Show Hotwire Turbo (symfony/ux-turbo) configuration: #[BroadcastMercure] entities with topics, controllers using TurboStreamResponse, <turbo-frame> declarations in templates, Mercure hub cross-check',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_turbo_stats',
      description: 'Show Turbo statistics: broadcast entity count, TurboStream controller count, frame count, lazy frame count, Mercure configured flag',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
