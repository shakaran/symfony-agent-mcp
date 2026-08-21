/**
 * Service Tag Audit
 *
 * Scans src/ for custom service tags:
 *   - #[AutoconfigureTag('my.tag')] on classes
 *   - #[AsTaggedItem('my.tag')] on classes
 *   - Symfony built-in tags used on custom classes
 *
 * Scans config/services.yaml (and services_*.yaml) for:
 *   - Services with explicit tags:
 *   - Tagged service iterators / locators (!tagged_iterator, !tagged_locator)
 *
 * Analysis:
 *   - Custom tag inventory: how many services use each tag
 *   - Tags consumed by CompilerPass (cross-reference with compiler-passes.ts data)
 *   - Orphan tags: defined but not consumed by any known CompilerPass or Symfony kernel
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TaggedService {
  class: string;
  file: string;
  tags: string[];
  via: 'attribute' | 'yaml';
  priority?: number;
}

interface TagConsumer {
  tag: string;
  consumer: string;
  via: 'tagged_iterator' | 'tagged_locator' | 'compiler_pass';
}

// ─── Known Symfony built-in tags ─────────────────────────────────────────────

const SYMFONY_BUILTIN_TAGS = new Set([
  'kernel.event_listener',
  'kernel.event_subscriber',
  'kernel.cache_warmer',
  'kernel.cache_clearer',
  'twig.extension',
  'twig.runtime',
  'doctrine.event_listener',
  'doctrine.event_subscriber',
  'doctrine.orm.entity_listener',
  'messenger.message_handler',
  'validator.constraint_validator',
  'form.type',
  'form.type_extension',
  'security.voter',
  'serializer.normalizer',
  'serializer.encoder',
  'monolog.processor',
  'routing.loader',
  'translation.loader',
  'translation.extractor',
  'translation.dumper',
  'console.command',
  'controller.argument_value_resolver',
  'http_client.client',
  'rate_limiter',
  'scheduler.task',
]);

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── PHP attribute scanning ──────────────────────────────────────────────────

function scanPhpTags(appPath: string): TaggedService[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const services: TaggedService[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath) ?? '';
    if (!content) continue;

    const hasTags =
      content.includes('AutoconfigureTag') ||
      content.includes('AsTaggedItem');
    if (!hasTags) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const tags: string[] = [];
    for (const m of content.matchAll(/#\[AutoconfigureTag\s*\(\s*['"]([^'"]+)['"]/g)) {
      tags.push(m[1]);
    }
    for (const m of content.matchAll(/#\[AsTaggedItem\s*\(\s*['"]([^'"]+)['"]/g)) {
      tags.push(m[1]);
    }

    // Priority from #[AutoconfigureTag(priority: N)] or #[AsTaggedItem(..., priority: N)]
    const prioM = /priority\s*:\s*(-?\d+)/.exec(content);

    if (tags.length > 0) {
      services.push({
        class: classM[1],
        file: path.basename(file),
        tags,
        via: 'attribute',
        priority: prioM ? parseInt(prioM[1], 10) : undefined,
      });
    }
  }

  return services;
}

// ─── YAML services scanning ──────────────────────────────────────────────────

function scanYamlTags(appPath: string): { services: TaggedService[]; consumers: TagConsumer[] } {
  const configDir = path.join(appPath, 'config');
  const services: TaggedService[] = [];
  const consumers: TagConsumer[] = [];

  const yamlFiles: string[] = [];
  const servicesDir = path.join(configDir, 'services.yaml');
  if (fs.existsSync(servicesDir)) yamlFiles.push(servicesDir);

  // Also scan config/ root
  try {
    for (const f of fs.readdirSync(configDir)) {
      if ((f.startsWith('services') || f.startsWith('service')) && (f.endsWith('.yaml') || f.endsWith('.yml'))) {
        const fp = path.join(configDir, f);
        if (!yamlFiles.includes(fp)) yamlFiles.push(fp);
      }
    }
  } catch { /* skip */ }

  for (const yamlFile of yamlFiles) {
    const raw = parseYamlFile(yamlFile) as Record<string, unknown> | null;
    if (!raw) continue;

    const servicesRaw = raw['services'] as Record<string, unknown> | undefined;
    if (!servicesRaw) continue;

    for (const [serviceId, def] of Object.entries(servicesRaw)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;

      // Explicit tags
      const tagsRaw = d['tags'] as unknown[] | undefined;
      if (tagsRaw && Array.isArray(tagsRaw)) {
        const tagNames: string[] = [];
        for (const tag of tagsRaw) {
          if (typeof tag === 'string') tagNames.push(tag);
          else if (tag && typeof tag === 'object') {
            const tagDef = tag as Record<string, unknown>;
            if (tagDef['name']) tagNames.push(String(tagDef['name']));
          }
        }
        if (tagNames.length > 0) {
          services.push({
            class: serviceId.split('\\').pop() ?? serviceId,
            file: path.basename(yamlFile),
            tags: tagNames,
            via: 'yaml',
          });
        }
      }

      // tagged_iterator / tagged_locator consumption
      const rawStr = JSON.stringify(d);
      const iterM = /"tagged_iterator"\s*:\s*"([^"]+)"/.exec(rawStr);
      const locM  = /"tagged_locator"\s*:\s*"([^"]+)"/.exec(rawStr);
      if (iterM) consumers.push({ tag: iterM[1], consumer: serviceId, via: 'tagged_iterator' });
      if (locM)  consumers.push({ tag: locM[1],  consumer: serviceId, via: 'tagged_locator'  });
    }
  }

  return { services, consumers };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function buildTagMap(services: TaggedService[]): Map<string, TaggedService[]> {
  const map = new Map<string, TaggedService[]>();
  for (const svc of services) {
    for (const tag of svc.tags) {
      const list = map.get(tag) ?? [];
      list.push(svc);
      map.set(tag, list);
    }
  }
  return map;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listContainerTags(appPath: string): McpToolResult {
  try {
    const phpServices  = scanPhpTags(appPath);
    const { services: yamlServices, consumers } = scanYamlTags(appPath);
    const allServices  = [...phpServices, ...yamlServices];
    const tagMap       = buildTagMap(allServices);

    if (tagMap.size === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom service tags found.\n\nAdd a tag:\n  #[AutoconfigureTag(\'my.handler\')]\n  class MyHandler { ... }\n\nOr in services.yaml:\n  App\\MyService:\n    tags: [my.handler]',
        }],
      };
    }

    const customTags   = [...tagMap.keys()].filter((t) => !SYMFONY_BUILTIN_TAGS.has(t));
    const builtinUsed  = [...tagMap.keys()].filter((t) =>  SYMFONY_BUILTIN_TAGS.has(t));
    const consumedTags = new Set(consumers.map((c) => c.tag));
    const orphanTags   = customTags.filter((t) => !consumedTags.has(t));

    let text = `Service Tag Audit\n${'='.repeat(55)}\n`;
    text += `  Custom tags:      ${customTags.length}\n`;
    text += `  Built-in tags:    ${builtinUsed.length}\n`;
    text += `  Tag consumers:    ${consumers.length}\n`;
    text += `  Orphan tags:      ${orphanTags.length}\n\n`;

    if (customTags.length > 0) {
      text += `Custom tags:\n`;
      for (const tag of customTags.sort()) {
        const svcs = tagMap.get(tag) ?? [];
        const consumed = consumedTags.has(tag);
        const orphan = !consumed ? '  ⚠ orphan' : '';
        text += `  ${tag.padEnd(45)} ${svcs.length} service${svcs.length > 1 ? 's' : ''}${orphan}\n`;
        for (const svc of svcs) {
          const prio = svc.priority !== undefined ? `  priority: ${svc.priority}` : '';
          text += `    → ${svc.class}  [${svc.via}]${prio}\n`;
        }
      }
    }

    if (builtinUsed.length > 0) {
      text += `\nSymfony built-in tags used on custom classes:\n`;
      for (const tag of builtinUsed.sort()) {
        const svcs = tagMap.get(tag) ?? [];
        text += `  ${tag.padEnd(45)} ${svcs.length} service${svcs.length > 1 ? 's' : ''}\n`;
      }
    }

    if (consumers.length > 0) {
      text += `\nTagged iterators / locators:\n`;
      for (const c of consumers) {
        text += `  ${c.tag.padEnd(40)} consumed by ${c.consumer}  [${c.via}]\n`;
      }
    }

    if (orphanTags.length > 0) {
      text += `\n⚠ Orphan tags (no tagged_iterator/locator or known consumer):\n`;
      for (const tag of orphanTags) {
        text += `   ${tag}\n`;
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

export function getContainerTagStats(appPath: string): McpToolResult {
  try {
    const phpServices  = scanPhpTags(appPath);
    const { services: yamlServices, consumers } = scanYamlTags(appPath);
    const allServices  = [...phpServices, ...yamlServices];
    const tagMap       = buildTagMap(allServices);

    const customTags   = [...tagMap.keys()].filter((t) => !SYMFONY_BUILTIN_TAGS.has(t));
    const consumedTags = new Set(consumers.map((c) => c.tag));
    const orphanTags   = customTags.filter((t) => !consumedTags.has(t));

    let text = `Container Tag Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total unique tags:  ${tagMap.size}\n`;
    text += `Custom tags:        ${customTags.length}\n`;
    text += `Built-in tags:      ${tagMap.size - customTags.length}\n`;
    text += `Tagged services:    ${allServices.length}\n`;
    text += `Via PHP attributes: ${phpServices.length}\n`;
    text += `Via YAML:           ${yamlServices.length}\n`;
    text += `Tag consumers:      ${consumers.length}\n`;
    text += `Orphan custom tags: ${orphanTags.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getContainerTagTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_container_tags',
      description: 'List service tags: custom vs built-in tags, services per tag, tagged_iterator/locator consumers, orphan tags with no consumer',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_container_tag_stats',
      description: 'Show service tag statistics: unique tag count, custom vs built-in, tagged service count, attribute vs YAML origin, orphan tag count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
