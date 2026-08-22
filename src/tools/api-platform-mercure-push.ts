/**
 * API Platform + Mercure Push Integration Inspector
 *
 * Distinct from mercure.ts (Mercure hub configuration) and api-platform.ts (general resources).
 * Focuses on the API Platform → Mercure push notification integration:
 *
 * Resource-level Mercure config (API Platform 3.x):
 *   #[ApiResource(mercure: true)]
 *   #[ApiResource(mercure: ['private' => true])]
 *   #[ApiResource(mercure: ['topics' => ['/custom/{id}']])]
 *
 * Property-level push:
 *   #[ApiProperty(push: true)]  — pushed in Mercure update
 *
 * Hub configuration (api_platform.yaml):
 *   api_platform:
 *     mercure:
 *       hub_url: 'https://mercure.example.com/.well-known/mercure'
 *
 * Update publication:
 *   - IriConverterInterface → getIriFromResource()
 *   - HubInterface::publish(new Update($topic, $data))
 *   - MercureEventListener (built-in listener in AP 3.x)
 *
 * PHP scan:
 *   - HubInterface injection
 *   - Update class instantiation
 *   - publish() calls
 *
 * Analysis:
 *   - mercure: true on resource without hub configured in api_platform.yaml
 *   - mercure: ['private' => true] without JWT configuration (private topics require auth)
 *   - HubInterface::publish() called without try/catch (transport failure uncaught)
 *   - Static topic string (everyone receives all updates — no per-user filtering)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface MercurePushResource {
  class: string;
  file: string;
  mercureEnabled: boolean;
  isPrivate: boolean;
  customTopics: string[];
  issues: string[];
}

interface HubUsage {
  file: string;
  hasTryCatch: boolean;
  staticTopics: boolean;
}

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

function loadMercureHubConfig(appPath: string): boolean {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'api_platform.yaml'),
    path.join(appPath, 'config', 'packages', 'mercure.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const ap  = (raw['api_platform'] ?? raw) as Record<string, unknown>;
    const merc = (ap['mercure'] ?? {}) as Record<string, unknown>;
    if (merc['hub_url'] || merc['enabled']) return true;
    const hub = (raw['mercure'] ?? {}) as Record<string, unknown>;
    if (hub['hub_url'] || hub['default_hub']) return true;
  }
  // Check .env
  try {
    const envContent = fs.readFileSync(path.join(appPath, '.env'), 'utf-8');
    if (envContent.includes('MERCURE_URL') || envContent.includes('MERCURE_PUBLIC_URL')) return true;
  } catch { /* skip */ }
  return false;
}

function parseResourceMercure(filePath: string, appPath: string): MercurePushResource | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('mercure')) return null;
  if (!content.includes('#[ApiResource') && !content.includes('ApiResource(')) return null;
  if (content.includes('namespace ApiPlatform\\') || content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  // Check mercure attribute on ApiResource
  const apiResM = /#\[ApiResource\s*\(([\s\S]{0,1500}?)\)\]/.exec(content);
  const block   = apiResM?.[1] ?? '';

  if (!block.includes('mercure')) return null;

  const mercureEnabled = block.includes('mercure');
  const isPrivate      = block.includes("'private' => true") || block.includes('"private" => true');

  const customTopics: string[] = [];
  const topicsM = /topics\s*=>\s*\[([^\]]+)\]/.exec(block);
  if (topicsM) {
    for (const m of topicsM[1].matchAll(/['"]([^'"]+)['"]/g)) customTopics.push(m[1]);
  }

  const issues: string[] = [];
  if (isPrivate) {
    issues.push('mercure: [private => true] — private topics require JWT authorization; verify hub is configured for private updates');
  }
  if (customTopics.some((t) => !t.includes('{') && !t.includes('%'))) {
    issues.push('Static Mercure topic (no {id} placeholder) — all subscribers receive all resource updates');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    mercureEnabled,
    isPrivate,
    customTopics,
    issues,
  };
}

function scanHubUsages(appPath: string): HubUsage[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const usages: HubUsage[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('->publish(') && !content.includes('HubInterface')) continue;

    const hasTryCatch   = content.includes('->publish(') && content.includes('try {');
    const staticTopics  = /new\s+Update\s*\(\s*['"]\/[^{'"]+['"]\s*,/.test(content);

    usages.push({ file: path.relative(appPath, file), hasTryCatch, staticTopics });
  }
  return usages;
}

export function listMercurePushConfig(appPath: string): McpToolResult {
  try {
    const srcDir   = path.join(appPath, 'src');
    const resources: MercurePushResource[] = [];

    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseResourceMercure(file, appPath);
        if (r) resources.push(r);
      }
    }

    const hubConfigured = loadMercureHubConfig(appPath);
    const hubUsages     = scanHubUsages(appPath);
    const totalIssues   = resources.reduce((s, r) => s + r.issues.length, 0);

    if (resources.length === 0 && hubUsages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No API Platform Mercure push configuration found.\n\nEnable on a resource:\n  #[ApiResource(mercure: true)]\n  class Product { ... }\n\nOr with private topics:\n  #[ApiResource(mercure: [\'private\' => true, \'topics\' => [\'/products/{id}\']])]\n  class Order { ... }',
        }],
      };
    }

    let text = `API Platform Mercure Push\n${'='.repeat(55)}\n`;
    text += `\nHub configured:      ${hubConfigured ? '✓ yes' : '⚠ not found'}\n`;
    text += `Resources with push: ${resources.length}  Direct HubInterface usage: ${hubUsages.length}  Issues: ${totalIssues}\n`;

    if (!hubConfigured && resources.length > 0) {
      text += `\n⚠ Mercure hub URL not found in api_platform.yaml / mercure.yaml / .env — push will fail\n`;
    }

    for (const r of resources.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
      const priv = r.isPrivate ? '  private' : '';
      const topics = r.customTopics.length > 0 ? `  topics: ${r.customTopics.join(', ')}` : '';
      text += `\n  ${r.class}${priv}${topics}  (${r.file})\n`;
      for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
    }

    if (hubUsages.length > 0) {
      text += `\nDirect HubInterface publish() usages:\n`;
      for (const u of hubUsages) {
        const tryCatch    = u.hasTryCatch ? '✓ try/catch' : '⚠ no try/catch';
        const staticTopic = u.staticTopics ? '  ⚠ static topic' : '';
        text += `  ${u.file}  ${tryCatch}${staticTopic}\n`;
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

export function getMercurePushStats(appPath: string): McpToolResult {
  try {
    const srcDir    = path.join(appPath, 'src');
    const resources: MercurePushResource[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseResourceMercure(file, appPath);
        if (r) resources.push(r);
      }
    }
    const hubUsages = scanHubUsages(appPath);

    let text = `Mercure Push Statistics\n${'='.repeat(40)}\n\n`;
    text += `Hub configured:        ${loadMercureHubConfig(appPath) ? 'yes' : 'no'}\n`;
    text += `Resources with push:   ${resources.length}\n`;
    text += `  Private topics:      ${resources.filter((r) => r.isPrivate).length}\n`;
    text += `  Custom topics:       ${resources.filter((r) => r.customTopics.length > 0).length}\n`;
    text += `Direct hub publish():  ${hubUsages.length}\n`;
    text += `  With try/catch:      ${hubUsages.filter((u) => u.hasTryCatch).length}\n`;
    text += `Issues:                ${resources.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMercurePushTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_mercure_push_config',
      description: 'Show API Platform Mercure push integration: mercure:true/#[ApiResource(mercure:...)] per resource, private topics, custom topic patterns, hub URL configuration, direct HubInterface::publish() usages, try/catch around publish, static topic warning, hub-not-configured warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_mercure_push_stats',
      description: 'Show Mercure push statistics: hub configured, resource push count, private/custom topic counts, direct publish count, try/catch count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
