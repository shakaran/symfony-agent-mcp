import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface WeakMapInfo {
  file: string;
  usage: string;
  pattern: string;
  recommendation: string;
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full, base));
    } else if (entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

function buildWeakMapInfos(appPath: string): WeakMapInfo[] {
  const results: WeakMapInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);

  // Check composer.json for PHP version constraint
  const composerPath = path.join(appPath, 'composer.json');
  const resolvedComposer = path.resolve(composerPath);
  let phpVersionConstraint = '';
  if (resolvedComposer.startsWith(path.resolve(appPath) + path.sep) || resolvedComposer === path.resolve(appPath)) {
    try {
      const raw = fs.readFileSync(composerPath, 'utf-8');
      const composerJson = JSON.parse(raw) as Record<string, unknown>;
      const requireMap = (composerJson['require'] ?? {}) as Record<string, string>;
      phpVersionConstraint = requireMap['php'] ?? '';
    } catch { /* skip */ }
  }

  for (const file of files) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasWeakMap = content.includes('new WeakMap(') || content.includes('WeakMap(');
    const hasWeakReference = content.includes('WeakReference::create(') || content.includes('WeakReference::');

    if (!hasWeakMap && !hasWeakReference) continue;

    if (hasWeakMap) {
      const usage = 'WeakMap instantiation';
      let pattern = 'new WeakMap()';
      let recommendation = 'WeakMap requires PHP 8.0+ — verify PHP version constraint in composer.json';

      // Check if used as a cache
      const surroundingIdx = content.indexOf('new WeakMap(');
      if (surroundingIdx !== -1) {
        const surroundingSlice = content.slice(Math.max(0, surroundingIdx - 200), Math.min(content.length, surroundingIdx + 300));

        if (surroundingSlice.includes('cache') || surroundingSlice.includes('Cache') ||
            surroundingSlice.includes('memoize') || surroundingSlice.includes('memo')) {
          pattern = 'WeakMap used as cache';
          recommendation = 'WeakMap as cache is correct for object-keyed memoization — keys are automatically removed when objects are garbage collected';
        } else if (surroundingSlice.includes('track') || surroundingSlice.includes('observer') ||
                   surroundingSlice.includes('listener') || surroundingSlice.includes('attach')) {
          pattern = 'WeakMap for object tracking';
          recommendation = 'WeakMap for tracking object lifetimes is idiomatic PHP 8.0+ — ensures no memory leaks from dangling references';
        } else {
          recommendation = 'WeakMap detected — requires PHP 8.0+; good for associating data with objects without preventing GC';
        }
      }

      // Flag if PHP version constraint does not guarantee 8.0+
      if (phpVersionConstraint && !phpVersionConstraint.includes('8.') &&
          !phpVersionConstraint.includes('^8') && !phpVersionConstraint.includes('>=8')) {
        recommendation += ` WARNING: composer.json PHP constraint "${phpVersionConstraint}" may not guarantee PHP 8.0+`;
      }

      results.push({
        file: path.relative(appPath, file),
        usage,
        pattern,
        recommendation,
      });
    }

    if (hasWeakReference) {
      const recommendation = content.includes('new WeakMap(')
        ? 'Both WeakReference and WeakMap used — prefer WeakMap when associating data with multiple objects; use WeakReference for single-object non-owning references'
        : 'WeakReference::create() detected — consider WeakMap if you need to associate additional data with the referenced object (PHP 8.0+)';

      results.push({
        file: path.relative(appPath, file),
        usage: 'WeakReference usage',
        pattern: 'WeakReference::create()',
        recommendation,
      });
    }
  }

  return results;
}

export function listPhpWeakMap(appPath: string): McpToolResult {
  try {
    const infos = buildWeakMapInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP WeakMap or WeakReference patterns found.' }] };
    }
    const lines = infos.map(i =>
      `${i.file}\n  Usage: ${i.usage}\n  Pattern: ${i.pattern}\n  Recommendation: ${i.recommendation}`
    );
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpWeakMapStats(appPath: string): McpToolResult {
  try {
    const infos = buildWeakMapInfos(appPath);
    const stats = {
      total: infos.length,
      byPattern: {} as Record<string, number>,
      byFile: {} as Record<string, number>,
    };
    for (const i of infos) {
      stats.byPattern[i.pattern] = (stats.byPattern[i.pattern] ?? 0) + 1;
      stats.byFile[i.file] = (stats.byFile[i.file] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpWeakMapTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_php_weak_map',
      description: 'List PHP WeakMap and WeakReference usage patterns — detects cache and object-tracking use cases, flags PHP 8.0+ requirement, and recommends WeakMap over WeakReference where appropriate.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    },
    {
      name: 'get_php_weak_map_stats',
      description: 'Get statistics for PHP WeakMap and WeakReference usage: total occurrences grouped by detected pattern and file.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    }
  ];
}
