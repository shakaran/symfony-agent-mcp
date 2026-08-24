// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface AutoloadOptimizeInfo {
  type: 'psr-4' | 'psr-0' | 'classmap' | 'files';
  namespace: string;
  path: string;
  recommendation: string;
}

function buildAutoloadOptimizeInfos(appPath: string): AutoloadOptimizeInfo[] {
  const results: AutoloadOptimizeInfo[] = [];
  const composerPath = path.join(appPath, 'composer.json');
  const resolvedComposer = path.resolve(composerPath);
  if (!resolvedComposer.startsWith(path.resolve(appPath) + path.sep) && resolvedComposer !== path.resolve(appPath)) {
    return results;
  }

  let composerJson: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(composerPath, 'utf-8');
    composerJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return results;
  }

  function processAutoloadSection(section: unknown, sectionName: string): void {
    if (!section || typeof section !== 'object') return;
    const autoload = section as Record<string, unknown>;

    // Check for psr-0 (deprecated)
    if (autoload['psr-0'] && typeof autoload['psr-0'] === 'object') {
      for (const [ns, nsPath] of Object.entries(autoload['psr-0'] as Record<string, string>)) {
        results.push({
          type: 'psr-0',
          namespace: ns,
          path: String(nsPath),
          recommendation: `PSR-0 is deprecated — migrate "${ns}" to PSR-4 in ${sectionName}`,
        });
      }
    }

    // Check psr-4 namespaces
    if (autoload['psr-4'] && typeof autoload['psr-4'] === 'object') {
      const psr4 = autoload['psr-4'] as Record<string, string | string[]>;
      const hasClassmap = Array.isArray(autoload['classmap']) && (autoload['classmap'] as string[]).length > 0;
      for (const [ns, nsPath] of Object.entries(psr4)) {
        const pathStr = Array.isArray(nsPath) ? nsPath.join(', ') : String(nsPath);
        if (!hasClassmap && sectionName === 'autoload') {
          results.push({
            type: 'psr-4',
            namespace: ns,
            path: pathStr,
            recommendation: `PSR-4 namespace "${ns}" lacks a classmap fallback — add "classmap" or run "composer dump-autoload -o" for production`,
          });
        } else {
          results.push({
            type: 'psr-4',
            namespace: ns,
            path: pathStr,
            recommendation: `PSR-4 namespace "${ns}" detected in ${sectionName} — ensure "composer dump-autoload --optimize" is run in CI/CD`,
          });
        }
      }
    }

    // Check classmap
    if (autoload['classmap'] && Array.isArray(autoload['classmap'])) {
      for (const cmPath of autoload['classmap'] as string[]) {
        results.push({
          type: 'classmap',
          namespace: '(classmap)',
          path: String(cmPath),
          recommendation: `Classmap entry "${cmPath}" in ${sectionName} — verify it does not include test or generated directories`,
        });
      }
    }

    // Check files[] for side effects
    if (autoload['files'] && Array.isArray(autoload['files'])) {
      for (const filePath of autoload['files'] as string[]) {
        results.push({
          type: 'files',
          namespace: '(files)',
          path: String(filePath),
          recommendation: `files[] entry "${filePath}" in ${sectionName} is loaded on every request — move side-effect code to lazy-loaded services`,
        });
      }
    }
  }

  processAutoloadSection(composerJson['autoload'], 'autoload');
  processAutoloadSection(composerJson['autoload-dev'], 'autoload-dev');

  return results;
}

export function listPhpComposerAutoloadOptimize(appPath: string): McpToolResult {
  try {
    const infos = buildAutoloadOptimizeInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No autoload optimization issues found in composer.json.' }] };
    }
    const lines = infos.map(i => `[${i.type}] ${i.namespace} => ${i.path}\n  Recommendation: ${i.recommendation}`);
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpComposerAutoloadOptimizeStats(appPath: string): McpToolResult {
  try {
    const infos = buildAutoloadOptimizeInfos(appPath);
    const stats = {
      total: infos.length,
      byType: {} as Record<string, number>,
    };
    for (const i of infos) {
      stats.byType[i.type] = (stats.byType[i.type] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpComposerAutoloadOptimizeTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_php_composer_autoload_optimize',
      description: 'List autoload optimization issues in composer.json: deprecated PSR-0, missing classmap fallback, files[] side-effect entries, and PSR-4 namespaces needing --optimize.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    },
    {
      name: 'get_php_composer_autoload_optimize_stats',
      description: 'Get statistics for composer autoload optimization issues grouped by type (psr-4, psr-0, classmap, files).',
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
