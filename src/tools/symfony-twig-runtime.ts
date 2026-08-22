/**
 * Symfony Twig Runtime Inspector
 *
 * Distinct from twig-extensions.ts (general extension analysis) and twig.ts (template scanning).
 * Focuses on Twig RuntimeExtensionInterface usage and lazy-loading patterns:
 *
 * - Scans src/ PHP for RuntimeExtensionInterface implementations
 * - Detects classes registered via addRuntimeLoader() or TwigExtensionSet::setRuntime()
 * - Detects #[AsTaggedItem] on Twig runtime classes
 * - Detects Twig extensions that inject heavy services in constructor (should use runtime)
 *
 * Warnings:
 *   - Twig extension with heavy constructor dependencies (DB, HTTP client) not using runtime
 *   - RuntimeExtensionInterface class not registered in container
 *   - Extension using getRuntime() for class not implementing RuntimeExtensionInterface
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface TwigRuntimeInfo {
  file: string;
  class: string;
  isRuntime: boolean;
  isExtension: boolean;
  hasHeavyDeps: boolean;
  isRegistered: boolean;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

const HEAVY_DEP_PATTERNS = [
  'EntityManagerInterface',
  'EntityManager',
  'Connection',
  'HttpClientInterface',
  'HttpClient',
  'ClientInterface',
  'ManagerRegistry',
  'Repository',
  'StorageInterface',
  'FilesystemInterface',
];

function parseRuntimeFile(filePath: string): TwigRuntimeInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isRuntime = content.includes('RuntimeExtensionInterface') ||
    content.includes('addRuntimeLoader') ||
    content.includes('TwigExtensionSet') ||
    (content.includes('getRuntime(') && content.includes('class '));

  const isExtension = content.includes('AbstractExtension') ||
    content.includes('ExtensionInterface') ||
    content.includes('getFilters()') ||
    content.includes('getFunctions()') ||
    content.includes('getTests()');

  if (!isRuntime && !isExtension) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasHeavyDeps = HEAVY_DEP_PATTERNS.some((dep) => {
    const constructorBlock = /public function __construct\s*\([^)]{0,500}\)/.exec(content);
    if (constructorBlock) return constructorBlock[0].includes(dep);
    return false;
  });

  const isAsTaggedItem = content.includes('#[AsTaggedItem') || content.includes('@AsTaggedItem');
  const isRegistered = isAsTaggedItem ||
    content.includes('twig.runtime') ||
    content.includes('addRuntimeLoader') ||
    (isRuntime && content.includes('#[AutoconfigureTag'));

  const getRuntimeUsage: string[] = [];
  const getRuntimeMatches = content.matchAll(/getRuntime\s*\(\s*([A-Z]\w{0,80})::class\s*\)/g);
  for (const m of getRuntimeMatches) {
    getRuntimeUsage.push(m[1]);
  }

  const issues: string[] = [];

  if (isExtension && hasHeavyDeps && !isRuntime) {
    issues.push('Extension has heavy constructor dependencies (DB/HTTP) — extract to RuntimeExtensionInterface for lazy loading');
  }

  if (isRuntime && !isRegistered) {
    issues.push('RuntimeExtensionInterface class not tagged as twig.runtime — runtime may never be created');
  }

  if (isExtension && !content.includes('AbstractExtension') && !isRuntime) {
    issues.push('Extension does not extend AbstractExtension — may not be auto-discovered');
  }

  if (getRuntimeUsage.length > 0) {
    for (const runtimeClass of getRuntimeUsage) {
      if (!content.includes(`${runtimeClass} implements`) &&
        !content.includes(`${runtimeClass} extends`) &&
        !content.includes(`RuntimeExtensionInterface`)) {
        issues.push(`getRuntime(${runtimeClass}::class) — verify ${runtimeClass} implements RuntimeExtensionInterface`);
      }
    }
  }

  return {
    file: path.basename(filePath),
    class: classM[1],
    isRuntime,
    isExtension,
    hasHeavyDeps,
    isRegistered,
    issues,
  };
}

export function listTwigRuntime(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: TwigRuntimeInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseRuntimeFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No Twig extensions or runtime classes found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `Twig Runtime Analysis\n${'='.repeat(55)}\n`;
    text += `\nClasses: ${results.length}  Issues: ${totalIssues}\n`;

    const runtimes = results.filter((r) => r.isRuntime);
    const extensions = results.filter((r) => r.isExtension && !r.isRuntime);

    if (runtimes.length > 0) {
      text += `\nRuntime classes (${runtimes.length}):\n`;
      for (const r of runtimes) {
        const registered = r.isRegistered ? ' [registered]' : ' [NOT registered]';
        text += `  ${r.class.padEnd(45)} (${r.file})${registered}\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (extensions.length > 0) {
      text += `\nExtension classes (${extensions.length}):\n`;
      for (const r of extensions) {
        const heavy = r.hasHeavyDeps ? ' [heavy-deps]' : '';
        text += `  ${r.class.padEnd(45)} (${r.file})${heavy}\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
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

export function getTwigRuntimeStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: TwigRuntimeInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseRuntimeFile(file);
      if (info) results.push(info);
    }

    let text = `Twig Runtime Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes:         ${results.length}\n`;
    text += `  Runtime classes:     ${results.filter((r) => r.isRuntime).length}\n`;
    text += `  Extension classes:   ${results.filter((r) => r.isExtension).length}\n`;
    text += `  Registered:          ${results.filter((r) => r.isRegistered).length}\n`;
    text += `  Heavy dependencies:  ${results.filter((r) => r.hasHeavyDeps).length}\n`;
    text += `Issues:                ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTwigRuntimeTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_twig_runtime',
      description: 'Show Twig RuntimeExtensionInterface implementations and lazy-loading analysis: runtime classes with registration status, extensions with heavy constructor dependencies that should use runtime pattern; warns on unregistered runtimes, heavy-dep extensions, getRuntime() for non-runtime classes',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_twig_runtime_stats',
      description: 'Show Twig runtime statistics: total classes, runtime vs extension count, registered count, heavy-dependency count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
