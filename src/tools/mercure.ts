// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Mercure Inspector
 *
 * Reads config/packages/mercure.yaml:
 *   - Hub URL (masked)
 *   - JWT algorithm and secret presence
 *   - Public/anonymous hub flag
 *   - Multiple hub definitions
 *
 * Scans src/ for Mercure usage:
 *   - new Update(topics, data) — published topics
 *   - HubInterface / Hub injection
 *   - #[AsMessageHandler] dispatching updates (indirect)
 *
 * Pure static analysis — no SSE connections opened.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface MercureHub {
  name: string;
  url: string;
  maskedUrl: string;
  public?: boolean;
  jwtAlgorithm?: string;
  hasSecret: boolean;
  isDefault: boolean;
}

interface MercureUpdate {
  class: string;
  file: string;
  topics: string[];
  isPrivate: boolean;
}

// ─── URL masking ────────────────────────────────────────────────────────────

function maskUrl(url: string): string {
  return url
    .replace(/%[^%]+%/g, '%***%')
    .replace(/\/\/[^@]+@/, '//*:*@');
}

// ─── Config loading ─────────────────────────────────────────────────────────

function loadMercureConfig(appPath: string): MercureHub[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'mercure.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const fw = raw['framework'] as Record<string, unknown> | undefined;
    const mercureSection = (fw?.['mercure'] ?? raw['mercure']) as Record<string, unknown> | undefined;
    if (!mercureSection) continue;

    const hubs: MercureHub[] = [];

    // Single hub (url at top level)
    if (mercureSection['url']) {
      const url = String(mercureSection['url']);
      const jwt = mercureSection['jwt_config'] as Record<string, unknown> | undefined;
      hubs.push({
        name: 'default',
        url,
        maskedUrl: maskUrl(url),
        public: Boolean(mercureSection['public']),
        jwtAlgorithm: jwt?.['algorithm'] ? String(jwt['algorithm']) : undefined,
        hasSecret: Boolean(mercureSection['jwt_secret'] ?? mercureSection['jwt'] ?? mercureSection['jwt_config']),
        isDefault: true,
      });
    }

    // Multiple hubs
    const hubsRaw = mercureSection['hubs'] as Record<string, unknown> | undefined;
    if (hubsRaw) {
      const defaultName = String(mercureSection['default_hub'] ?? Object.keys(hubsRaw)[0] ?? 'default');
      for (const [name, def] of Object.entries(hubsRaw)) {
        if (!def || typeof def !== 'object') continue;
        const d = def as Record<string, unknown>;
        const url = String(d['url'] ?? '');
        const jwt = d['jwt_config'] as Record<string, unknown> | undefined;
        hubs.push({
          name,
          url,
          maskedUrl: maskUrl(url),
          public: Boolean(d['public']),
          jwtAlgorithm: jwt?.['algorithm'] ? String(jwt['algorithm']) : undefined,
          hasSecret: Boolean(d['jwt_secret'] ?? d['jwt'] ?? d['jwt_config']),
          isDefault: name === defaultName,
        });
      }
    }

    if (hubs.length > 0) return hubs;
  }

  return [];
}

// ─── PHP scanning ───────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function scanMercureUsage(appPath: string): MercureUpdate[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const updates: MercureUpdate[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('new Update') && !content.includes('HubInterface')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // new Update(['topic1', 'topic2'], $data, private: true)
    // new Update('topic', $data)
    for (const m of content.matchAll(/new\s+Update\s*\(\s*([^,)]+)/g)) {
      const topicArg = m[1].trim();
      const topics: string[] = [];

      // Array of topics
      if (topicArg.startsWith('[')) {
        for (const tm of topicArg.matchAll(/['"]([^'"]+)['"]/g)) {
          topics.push(tm[1]);
        }
      } else {
        // Single topic string
        const single = /['"]([^'"]+)['"]/.exec(topicArg);
        if (single) topics.push(single[1]);
        else topics.push('(dynamic)');
      }

      // Check for private flag
      const after = content.slice(m.index ?? 0, (m.index ?? 0) + 300);
      const isPrivate = after.includes('private: true') || after.includes('private:true');

      updates.push({
        class: classM[1],
        file: path.basename(file),
        topics,
        isPrivate,
      });
    }
  }

  return updates.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listMercureConfig(appPath: string): McpToolResult {
  try {
    const hubs = loadMercureConfig(appPath);
    const updates = scanMercureUsage(appPath);

    if (hubs.length === 0 && updates.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'Mercure not configured.\n\nInstall:\n  composer require symfony/mercure-bundle\n\nConfigure config/packages/mercure.yaml:\n  mercure:\n    hubs:\n      default:\n        url: \'%env(MERCURE_URL)%\'\n        jwt_config:\n          secret: \'%env(MERCURE_JWT_SECRET)%\'\n          algorithm: HMAC_SHA256',
        }],
      };
    }

    let text = `Mercure (Server-Sent Events) Inspector\n${'='.repeat(55)}\n`;

    if (hubs.length > 0) {
      text += `\nHubs (${hubs.length}):\n`;
      for (const h of hubs) {
        text += `\n  ${h.name}${h.isDefault ? ' [default]' : ''}${h.public ? ' [public/anonymous]' : ''}\n`;
        text += `    URL:       ${h.maskedUrl}\n`;
        text += `    JWT:       ${h.hasSecret ? 'configured' : 'NOT configured ⚠'}\n`;
        if (h.jwtAlgorithm) text += `    Algorithm: ${h.jwtAlgorithm}\n`;
        if (!h.hasSecret) {
          text += `    ⚠ No JWT secret — hub is not protected!\n`;
        }
      }
    }

    if (updates.length > 0) {
      // Aggregate by class
      const byClass = new Map<string, MercureUpdate[]>();
      for (const u of updates) {
        const list = byClass.get(u.class) ?? [];
        list.push(u);
        byClass.set(u.class, list);
      }

      const allTopics = [...new Set(updates.flatMap((u) => u.topics).filter((t) => t !== '(dynamic)'))];

      text += `\nPublished updates (${updates.length} calls in ${byClass.size} classes):\n`;
      for (const [cls, clsUpdates] of byClass) {
        const file = clsUpdates[0].file;
        text += `\n  ${cls}  (${file})\n`;
        for (const u of clsUpdates) {
          const priv = u.isPrivate ? '  [private]' : '';
          text += `    topics: ${u.topics.join(', ')}${priv}\n`;
        }
      }

      if (allTopics.length > 0) {
        text += `\nAll static topics (${allTopics.length}):\n`;
        for (const t of allTopics.sort()) text += `  ${t}\n`;
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

export function getMercureStats(appPath: string): McpToolResult {
  try {
    const hubs = loadMercureConfig(appPath);
    const updates = scanMercureUsage(appPath);

    let text = `Mercure Statistics\n${'='.repeat(40)}\n\n`;
    text += `Hubs configured:    ${hubs.length}\n`;
    text += `Without JWT:        ${hubs.filter((h) => !h.hasSecret).length}\n`;
    text += `Public hubs:        ${hubs.filter((h) => h.public).length}\n`;
    text += `Update call sites:  ${updates.length}\n`;
    text += `Private updates:    ${updates.filter((u) => u.isPrivate).length}\n`;

    const staticTopics = [...new Set(updates.flatMap((u) => u.topics).filter((t) => t !== '(dynamic)'))];
    text += `Distinct topics:    ${staticTopics.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getMercureTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_mercure_config',
      description: 'Show Mercure hub config (URL masked, JWT presence, public flag), Update() call sites in src/ with topics and private flag',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_mercure_stats',
      description: 'Show Mercure statistics: hub count, hubs without JWT, public hubs, update call sites, distinct topic count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
