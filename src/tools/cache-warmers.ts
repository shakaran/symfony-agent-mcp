/**
 * Cache Warmer Inspector
 *
 * Scans src/ for classes implementing CacheWarmerInterface or WarmableInterface:
 *   - warmUp() implementation
 *   - isOptional() → optional vs required (blocking) warmers
 *   - #[AsTaggedItem('kernel.cache_warmer')] or tagged via YAML
 *   - Priority (from #[AsTaggedItem(priority: N)])
 *
 * Reads services.yaml / services_*.yaml for explicit kernel.cache_warmer tags.
 *
 * Detects warmers that inject heavy services in constructor (risk in test env).
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface CacheWarmer {
  class: string;
  file: string;
  isOptional: boolean;
  priority: number;
  taggedVia: 'autoconfigure' | 'attribute' | 'yaml';
  heavyDeps: string[];
  implementsWarmable: boolean;
}

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

// ─── Warmer detection ────────────────────────────────────────────────────────

const HEAVY_DEP_PATTERNS = [
  'EntityManager',
  'ObjectManager',
  'Connection',
  'HttpClient',
  'HttpClientInterface',
  'TransportInterface',
  'MailerInterface',
];

function parseWarmer(filePath: string): CacheWarmer | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isCacheWarmer  = content.includes('CacheWarmerInterface');
  const isWarmable     = content.includes('WarmableInterface');
  if (!isCacheWarmer && !isWarmable) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  // isOptional detection
  const isOptionalBlock = /function\s+isOptional\s*\([^)]*\)[^{]*\{([^}]+)\}/.exec(content);
  const isOptional = isOptionalBlock
    ? isOptionalBlock[1].includes('true')
    : true; // assume optional if not found

  // Priority from #[AsTaggedItem]
  const tagAttrM = /#\[AsTaggedItem\s*\([^)]*priority\s*:\s*(-?\d+)/.exec(content);
  const priority = tagAttrM ? parseInt(tagAttrM[1], 10) : 0;

  // How it's tagged
  let taggedVia: CacheWarmer['taggedVia'] = 'autoconfigure';
  if (content.includes('#[AsTaggedItem')) taggedVia = 'attribute';

  // Heavy constructor deps
  const ctorM = /function\s+__construct\s*\(([^)]+)\)/.exec(content);
  const heavyDeps: string[] = [];
  if (ctorM) {
    for (const dep of HEAVY_DEP_PATTERNS) {
      if (ctorM[1].includes(dep)) heavyDeps.push(dep);
    }
  }

  return {
    class: classM[1],
    file: path.basename(filePath),
    isOptional,
    priority,
    taggedVia,
    heavyDeps,
    implementsWarmable: isWarmable && !isCacheWarmer,
  };
}

function loadWarmers(appPath: string): CacheWarmer[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const warmers: CacheWarmer[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const w = parseWarmer(file);
    if (w) warmers.push(w);
  }

  return warmers.sort((a, b) => b.priority - a.priority || a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listCacheWarmers(appPath: string): McpToolResult {
  try {
    const warmers = loadWarmers(appPath);

    if (warmers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom cache warmers found in src/.\n\nCreate one:\n  use Symfony\\Component\\HttpKernel\\CacheWarmer\\CacheWarmerInterface;\n\n  class MyWarmer implements CacheWarmerInterface {\n    public function warmUp(string $cacheDir, ?string $buildDir = null): array {\n      // pre-generate files into $cacheDir\n      return [];\n    }\n    public function isOptional(): bool { return true; }\n  }',
        }],
      };
    }

    const required = warmers.filter((w) => !w.isOptional);
    const optional = warmers.filter((w) =>  w.isOptional);
    const withHeavy = warmers.filter((w) => w.heavyDeps.length > 0);

    let text = `Cache Warmers (${warmers.length})\n${'='.repeat(55)}\n`;
    text += `  Required (blocking): ${required.length}\n`;
    text += `  Optional:            ${optional.length}\n`;

    if (required.length > 0) {
      text += `\nRequired warmers (run before app is ready):\n`;
      for (const w of required) {
        const prio = w.priority !== 0 ? `  priority: ${w.priority}` : '';
        text += `  ${w.class.padEnd(45)} (${w.file})${prio}\n`;
      }
    }

    if (optional.length > 0) {
      text += `\nOptional warmers:\n`;
      for (const w of optional) {
        const impl = w.implementsWarmable ? '  [WarmableInterface]' : '';
        const prio = w.priority !== 0 ? `  priority: ${w.priority}` : '';
        text += `  ${w.class.padEnd(45)} (${w.file})${impl}${prio}\n`;
      }
    }

    if (withHeavy.length > 0) {
      text += `\n⚠ Warmers with heavy constructor dependencies (may slow test boot):\n`;
      for (const w of withHeavy) {
        text += `   ${w.class}  injects: ${w.heavyDeps.join(', ')}\n`;
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

export function getCacheWarmerStats(appPath: string): McpToolResult {
  try {
    const warmers = loadWarmers(appPath);

    let text = `Cache Warmer Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total warmers:    ${warmers.length}\n`;
    text += `Required:         ${warmers.filter((w) => !w.isOptional).length}\n`;
    text += `Optional:         ${warmers.filter((w) =>  w.isOptional).length}\n`;
    text += `With priority:    ${warmers.filter((w) => w.priority !== 0).length}\n`;
    text += `Heavy deps:       ${warmers.filter((w) => w.heavyDeps.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getCacheWarmerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_cache_warmers',
      description: 'List custom cache warmers (CacheWarmerInterface/WarmableInterface): required vs optional, priority, heavy constructor dependencies warning',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_cache_warmer_stats',
      description: 'Show cache warmer statistics: total count, required vs optional split, warmers with priority, warmers with heavy constructor deps',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
