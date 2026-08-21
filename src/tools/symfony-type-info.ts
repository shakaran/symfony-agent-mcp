/**
 * Symfony TypeInfo Component Inspector
 *
 * Detects Symfony TypeInfo component usage (Symfony 7.x new component).
 * Scans src/ PHP for: use Symfony\Component\TypeInfo, TypeInfoExtractor,
 *   Type::builtin(), Type::object(), Type::union(), Type::intersection(),
 *   Type::list(), Type::array(), TypeResolver.
 *
 * Checks composer.json for symfony/type-info.
 *
 * Warns on:
 *   - TypeInfo used without checking PHP version compatibility (some types require PHP 8.1+)
 *   - TypeInfo in hot path without caching
 *   - custom TypeResolver not implementing TypeResolverInterface
 *   - TypeInfo union type not exhaustive
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

interface TypeInfoUsageInfo {
  file: string;
  className: string;
  typeUsages: string[];
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

function hasTypeInfoPackage(appPath: string): boolean {
  const composerPath = path.join(appPath, 'composer.json');
  try {
    const raw = fs.readFileSync(composerPath, 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const req = (json['require'] ?? {}) as Record<string, string>;
    return 'symfony/type-info' in req;
  } catch { return false; }
}

const TYPE_INFO_APIS = [
  'TypeInfoExtractor',
  'Type::builtin(',
  'Type::object(',
  'Type::union(',
  'Type::intersection(',
  'Type::list(',
  'Type::array(',
  'TypeResolver',
  'TypeResolverInterface',
  'TypeInfoResolver',
];

function parseTypeInfoFile(filePath: string): TypeInfoUsageInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasTypeInfo =
    content.includes('Symfony\\Component\\TypeInfo') ||
    TYPE_INFO_APIS.some((api) => content.includes(api));

  if (!hasTypeInfo) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;

  const className = classM[1];
  const issues: string[] = [];
  const typeUsages: string[] = [];

  for (const api of TYPE_INFO_APIS) {
    if (content.includes(api)) {
      typeUsages.push(api.replace('(', ''));
    }
  }

  // Check PHP version compatibility note
  const hasPhpVersionCheck =
    content.includes('PHP_VERSION') ||
    content.includes('PHP_MAJOR_VERSION') ||
    content.includes('phpversion') ||
    content.includes('version_compare');

  if (!hasPhpVersionCheck && (content.includes('Type::intersection(') || content.includes('Type::union('))) {
    issues.push('TypeInfo union/intersection types used without PHP version check — intersection types require PHP 8.1+; add version guard for older environments');
  }

  // Check for caching in hot paths
  const inHotPath =
    content.includes('function handle(') ||
    content.includes('function __invoke(') ||
    content.includes('function process(') ||
    content.includes('function normalize(') ||
    content.includes('function denormalize(');

  const hasCache =
    content.includes('$this->cache') ||
    content.includes('static $') ||
    content.includes('CacheInterface') ||
    content.includes('array_key_exists') ||
    content.includes('isset($resolved');

  if (inHotPath && !hasCache) {
    issues.push('TypeInfo used in hot-path method (handle/invoke/normalize) without caching — type resolution is expensive; cache results per class/property');
  }

  // Check custom TypeResolver implements interface
  const isCustomResolver =
    content.includes('TypeResolver') &&
    !content.includes('TypeResolverInterface') &&
    (content.includes('class ') && content.includes('Resolver'));

  if (isCustomResolver) {
    issues.push('Custom TypeResolver does not implement TypeResolverInterface — the resolver will not be wired automatically by the TypeInfo component');
  }

  // Check union type exhaustiveness heuristic
  if (content.includes('Type::union(')) {
    if (!content.includes('match(') && !content.includes('instanceof ') && !content.includes('switch (')) {
      issues.push('Type::union() used but no exhaustive match/instanceof check found — union type members may not all be handled');
    }
  }

  return { file: filePath, className, typeUsages, issues };
}

function loadTypeInfoInfos(appPath: string): TypeInfoUsageInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: TypeInfoUsageInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseTypeInfoFile(f);
    if (r) {
      r.file = path.relative(appPath, r.file);
      results.push(r);
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listSymfonyTypeInfo(appPath: string): McpToolResult {
  try {
    const infos = loadTypeInfoInfos(appPath);
    const hasPackage = hasTypeInfoPackage(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No Symfony TypeInfo component usages found in src/.\n` +
            `symfony/type-info package: ${hasPackage ? 'installed' : 'not found in composer.json'}`,
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony TypeInfo Inspector (${infos.length} usages)\n${'='.repeat(55)}\n`;
    text += `symfony/type-info installed: ${hasPackage ? 'yes' : 'not detected'}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}  [${info.className}]\n`;
      if (info.typeUsages.length > 0) {
        text += `    usages: [${info.typeUsages.join(', ')}]\n`;
      }
      for (const issue of info.issues) text += `    WARN: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyTypeInfoStats(appPath: string): McpToolResult {
  try {
    const infos = loadTypeInfoInfos(appPath);
    const hasPackage = hasTypeInfoPackage(appPath);

    let text = `TypeInfo Component Statistics\n${'='.repeat(40)}\n\n`;
    text += `symfony/type-info installed:   ${hasPackage ? 'yes' : 'not detected'}\n`;
    text += `Files using TypeInfo:          ${infos.length}\n`;
    text += `  With union types:            ${infos.filter((i) => i.typeUsages.includes('Type::union')).length}\n`;
    text += `  With intersection types:     ${infos.filter((i) => i.typeUsages.includes('Type::intersection')).length}\n`;
    text += `  With TypeResolver:           ${infos.filter((i) => i.typeUsages.includes('TypeResolver')).length}\n`;
    text += `Issues:                        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyTypeInfoTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_type_info',
      description: 'List Symfony TypeInfo component usages: detects Type::builtin/object/union/intersection/list/array, TypeResolver, TypeInfoExtractor; warns on PHP 8.1+ intersection types without version guard, uncached hot-path type resolution, custom resolver missing TypeResolverInterface, non-exhaustive union type handling',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_type_info_stats',
      description: 'Show TypeInfo statistics: total usages, union/intersection type count, TypeResolver count, symfony/type-info package presence, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
