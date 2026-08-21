/**
 * Doctrine Entity Proxy Inspector
 *
 * Detects Doctrine proxy class configuration and issues.
 * Reads doctrine.yaml for proxy config; scans var/cache for proxy files;
 * scans src/ for final entities and private constructors.
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function readFileOr(filePath: string, fallback: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return fallback; }
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function countProxies(proxyDir: string): number {
  let count = 0;
  try {
    for (const e of fs.readdirSync(proxyDir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        count += countProxies(path.join(proxyDir, e.name));
      } else if (e.name.endsWith('.php')) {
        count++;
      }
    }
  } catch { /* skip */ }
  return count;
}

function findDoctrineYaml(appPath: string): string {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'doctrine.yaml'),
    path.join(appPath, 'app', 'config', 'doctrine.yml'),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c);
      return c;
    } catch { /* skip */ }
  }
  return '';
}

function isFinalEntity(content: string): boolean {
  return /^final\s+class\s+/m.test(content) && (
    content.includes('#[ORM\\Entity') ||
    content.includes('@ORM\\Entity') ||
    content.includes('use Doctrine\\ORM\\Mapping') ||
    content.includes('#[Entity')
  );
}

function hasPrivateConstructor(content: string): boolean {
  return /private\s+function\s+__construct\s*\(/m.test(content) && (
    content.includes('#[ORM\\Entity') ||
    content.includes('@ORM\\Entity') ||
    content.includes('use Doctrine\\ORM\\Mapping')
  );
}

export function listDoctrineEntityProxies(appPath: string): McpToolResult {
  try {
    const yamlPath = findDoctrineYaml(appPath);
    const yamlContent = yamlPath ? readFileOr(yamlPath, '') : '';

    let proxyDir = '%kernel.cache_dir%/doctrine/orm/Proxies';
    let proxyNamespace = 'Proxies\\__CG__';
    let autoGenerate = false;

    const proxyDirM = /proxy_dir\s*:\s*(.{1,200})/.exec(yamlContent);
    if (proxyDirM) proxyDir = proxyDirM[1].trim();

    const proxyNsM = /proxy_namespace\s*:\s*(.{1,200})/.exec(yamlContent);
    if (proxyNsM) proxyNamespace = proxyNsM[1].trim();

    const autoGenM = /auto_generate_proxy_classes\s*:\s*(true|false|1|0|'true'|'false')/i.exec(yamlContent);
    if (autoGenM) {
      autoGenerate = autoGenM[1] === 'true' || autoGenM[1] === '1';
    }

    // Find actual proxy dir in var/cache
    const resolvedProxyDir = proxyDir.replace('%kernel.cache_dir%', path.join(appPath, 'var', 'cache', 'prod'));
    const proxyCount = countProxies(resolvedProxyDir);

    const finalEntities: string[] = [];
    const privateConstructorEntities: string[] = [];
    const srcDir = path.join(appPath, 'src');
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const classM = /class\s+(\w{1,100})/.exec(content);
      if (!classM) continue;
      if (isFinalEntity(content)) finalEntities.push(classM[1]);
      if (hasPrivateConstructor(content)) privateConstructorEntities.push(classM[1]);
    }

    const issues: string[] = [];

    if (autoGenerate) {
      issues.push('auto_generate_proxy_classes: true — proxy generation on first access is slow in production; run doctrine:generate:proxies and set to false or EVAL_AND_CACHE');
    }

    const normalizedProxyDir = proxyDir.replace(/\\/g, '/');
    if (!normalizedProxyDir.includes('/var/') && !normalizedProxyDir.includes('cache_dir')) {
      issues.push(`proxy_dir "${proxyDir}" is not under var/ — proxies in src/ or wrong location can break autoloader`);
    }

    if (proxyNamespace && proxyNamespace.length > 0) {
      // Check namespace collision — proxy namespace should not match entity namespace
      const appNsM = /namespace\s+App\\/.exec(readFileOr(path.join(srcDir, 'Kernel.php'), ''));
      if (appNsM && proxyNamespace.startsWith('App\\')) {
        issues.push(`proxy_namespace "${proxyNamespace}" collides with actual App\\ namespace — proxies may shadow real classes`);
      }
    }

    for (const entity of finalEntities) {
      issues.push(`Entity "${entity}" is declared final — Doctrine cannot create a proxy, lazy loading is disabled`);
    }

    for (const entity of privateConstructorEntities) {
      issues.push(`Entity "${entity}" has private constructor — proxy cannot be instantiated by Doctrine`);
    }

    let text = `Doctrine Entity Proxy Configuration\n${'='.repeat(55)}\n\n`;
    text += `Proxy directory:    ${proxyDir}\n`;
    text += `Proxy namespace:    ${proxyNamespace}\n`;
    text += `Auto-generate:      ${autoGenerate ? 'YES (slow in production)' : 'no'}\n`;
    text += `Existing proxies:   ${proxyCount}\n`;
    text += `Final entities:     ${finalEntities.length}\n`;
    text += `Issues:             ${issues.length}\n`;

    if (issues.length > 0) {
      text += `\nIssues:\n`;
      for (const issue of issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineEntityProxyStats(appPath: string): McpToolResult {
  try {
    const yamlPath = findDoctrineYaml(appPath);
    const yamlContent = yamlPath ? readFileOr(yamlPath, '') : '';

    let autoGenerate = false;
    const autoGenM = /auto_generate_proxy_classes\s*:\s*(true|false|1|0)/i.exec(yamlContent);
    if (autoGenM) autoGenerate = autoGenM[1] === 'true' || autoGenM[1] === '1';

    let finalCount = 0;
    let privateCtorCount = 0;
    const srcDir = path.join(appPath, 'src');
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      if (isFinalEntity(content)) finalCount++;
      if (hasPrivateConstructor(content)) privateCtorCount++;
    }

    let text = `Doctrine Entity Proxy Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config found:           ${yamlPath ? 'yes' : 'no'}\n`;
    text += `Auto-generate:          ${autoGenerate ? 'YES' : 'no'}\n`;
    text += `Final entities:         ${finalCount}\n`;
    text += `Private constructor:    ${privateCtorCount}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineEntityProxyTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_entity_proxies',
      description: 'Detect Doctrine proxy class configuration and issues: reads doctrine.yaml for proxy_dir/proxy_namespace/auto_generate_proxy_classes, scans var/cache for existing proxies, scans src/ for final entities and private constructors; warns on auto_generate in production, proxy_dir outside var/, namespace collision, final classes, private constructors',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_entity_proxy_stats',
      description: 'Statistics for Doctrine entity proxies: config presence, auto-generate setting, final entity count, private constructor count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
