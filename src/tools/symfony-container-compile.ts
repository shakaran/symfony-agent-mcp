// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Container Compilation Inspector
 *
 * Scans Symfony container compilation configuration:
 *   - config/services.yaml: _instanceof: heavy usage (many entries → slow compilation)
 *   - src/Kernel.php (or src/{env}/Kernel.php): getCacheDir() / getBuildDir() overrides
 *   - config/packages/framework.yaml: cache.system_clearer, build_dir, cache_dir settings
 *   - .env* files: APP_ENV values — warns if APP_ENV=prod missing in .env.prod
 *   - config/packages/: warmup: false on cache pools
 *   - var/cache/ directory existence and environment-specific cache dirs
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ContainerCompileEntry {
  file: string;
  key: string;
  value: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function getAllYamlFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllYamlFiles(full));
      else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function countInstanceofEntries(content: string): number {
  const blockRe = /^[ \t]*_instanceof:\s*\n([\s\S]*?)(?=^[^\s#]|(?![\s\S]))/m;
  const blockM = blockRe.exec(content);
  if (!blockM) return 0;
  const block = blockM[1];
  const entryRe = /^[ \t]{4,8}\S[^\n:]{0,200}:/gm;
  return (block.match(entryRe) ?? []).length;
}

function analyzeServicesYaml(appPath: string): ContainerCompileEntry[] {
  const entries: ContainerCompileEntry[] = [];
  const servicesPath = path.join(appPath, 'config', 'services.yaml');
  const content = safeRead(servicesPath, appPath);
  if (!content) return entries;

  const relPath = path.relative(appPath, servicesPath);
  const instanceofCount = countInstanceofEntries(content);
  if (instanceofCount > 0) {
    entries.push({
      file: relPath,
      key: '_instanceof entries',
      value: String(instanceofCount),
      issue: instanceofCount > 10
        ? `${instanceofCount} _instanceof entries — large counts slow container compilation; consider using tags or compiler passes instead`
        : instanceofCount > 5
        ? `${instanceofCount} _instanceof entries — moderate; monitor compilation time`
        : null,
    });
  }

  // Check for lazy: true on many services
  const lazyMatches = (content.match(/^\s+lazy:\s*true/gm) ?? []).length;
  if (lazyMatches > 0) {
    entries.push({
      file: relPath,
      key: 'lazy: true services',
      value: String(lazyMatches),
      issue: null,
    });
  }

  // Detect shared: false (prototype services) used heavily
  const sharedFalse = (content.match(/shared:\s*false/g) ?? []).length;
  if (sharedFalse > 0) {
    entries.push({
      file: relPath,
      key: 'shared: false services',
      value: String(sharedFalse),
      issue: sharedFalse > 20
        ? `${sharedFalse} non-shared (shared: false) services — each injection creates a new instance; may affect performance`
        : null,
    });
  }

  return entries;
}

function findKernelFiles(appPath: string): string[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  return getAllPhpFiles(srcDir).filter((f) => f.endsWith('Kernel.php'));
}

function analyzeKernel(appPath: string): ContainerCompileEntry[] {
  const entries: ContainerCompileEntry[] = [];
  const kernelFiles = findKernelFiles(appPath);

  for (const kernelPath of kernelFiles) {
    const content = safeRead(kernelPath, appPath);
    if (!content) continue;
    const relPath = path.relative(appPath, kernelPath);

    if (/function\s+getCacheDir\s*\(/.test(content)) {
      const bodyM = /function\s+getCacheDir\s*\([^)]{0,100}\)[^{]{0,50}\{([^}]{0,500})/.exec(content);
      const val = bodyM ? bodyM[1].replace(/\s+/g, ' ').trim().slice(0, 100) : '(override present)';
      entries.push({
        file: relPath,
        key: 'getCacheDir() override',
        value: val,
        issue: 'Custom getCacheDir() — ensure var/cache/{env} path is writable and included in deployment cache-clear commands',
      });
    }

    if (/function\s+getBuildDir\s*\(/.test(content)) {
      const bodyM = /function\s+getBuildDir\s*\([^)]{0,100}\)[^{]{0,50}\{([^}]{0,500})/.exec(content);
      const val = bodyM ? bodyM[1].replace(/\s+/g, ' ').trim().slice(0, 100) : '(override present)';
      entries.push({
        file: relPath,
        key: 'getBuildDir() override',
        value: val,
        issue: 'Custom getBuildDir() — ensure path is writable; used for generated container and proxies',
      });
    }

    if (/function\s+getLogDir\s*\(/.test(content)) {
      entries.push({
        file: relPath,
        key: 'getLogDir() override',
        value: '(override present)',
        issue: null,
      });
    }
  }

  return entries;
}

function analyzeFrameworkYaml(appPath: string): ContainerCompileEntry[] {
  const entries: ContainerCompileEntry[] = [];
  const frameworkPath = path.join(appPath, 'config', 'packages', 'framework.yaml');
  const content = safeRead(frameworkPath, appPath);
  if (!content) return entries;

  const relPath = path.relative(appPath, frameworkPath);

  const cacheDirM = /cache_dir:\s*([^\n]{1,200})/.exec(content);
  if (cacheDirM) {
    entries.push({
      file: relPath,
      key: 'framework.cache_dir',
      value: cacheDirM[1].trim(),
      issue: 'Explicit cache_dir override — verify path is environment-specific and writable',
    });
  }

  const buildDirM = /build_dir:\s*([^\n]{1,200})/.exec(content);
  if (buildDirM) {
    entries.push({
      file: relPath,
      key: 'framework.build_dir',
      value: buildDirM[1].trim(),
      issue: 'Explicit build_dir override — ensure build artifacts are environment-isolated',
    });
  }

  if (/system_clearer:\s*false/.test(content)) {
    entries.push({
      file: relPath,
      key: 'cache.system_clearer',
      value: 'false',
      issue: 'cache.system_clearer disabled — system cache will not be cleared on cache:clear; may cause stale container',
    });
  }

  if (/cache_clearer:\s*false/.test(content)) {
    entries.push({
      file: relPath,
      key: 'cache_clearer',
      value: 'false',
      issue: 'cache_clearer disabled — app cache pool not cleared on cache:clear',
    });
  }

  return entries;
}

function analyzeEnvFiles(appPath: string): ContainerCompileEntry[] {
  const entries: ContainerCompileEntry[] = [];
  const envFiles = [
    { name: '.env', path: path.join(appPath, '.env') },
    { name: '.env.local', path: path.join(appPath, '.env.local') },
    { name: '.env.prod', path: path.join(appPath, '.env.prod') },
    { name: '.env.dev', path: path.join(appPath, '.env.dev') },
  ];

  for (const ef of envFiles) {
    const content = safeRead(ef.path, appPath);
    if (!content) continue;

    const appEnvM = /^APP_ENV=([^\n]{1,50})/m.exec(content);
    if (appEnvM) {
      const val = appEnvM[1].trim();
      let issue: string | null = null;
      if (ef.name === '.env.prod' && val !== 'prod') {
        issue = `APP_ENV=${val} in .env.prod — should be "prod" for production`;
      } else if (ef.name === '.env.dev' && val !== 'dev') {
        issue = `APP_ENV=${val} in .env.dev — should be "dev"`;
      }
      entries.push({ file: ef.name, key: 'APP_ENV', value: val, issue });
    }

    const appDebugM = /^APP_DEBUG=([^\n]{1,10})/m.exec(content);
    if (appDebugM) {
      const val = appDebugM[1].trim();
      let issue: string | null = null;
      if (ef.name === '.env.prod' && (val === '1' || val.toLowerCase() === 'true')) {
        issue = 'APP_DEBUG=true in .env.prod — debug mode must be disabled in production';
      }
      entries.push({ file: ef.name, key: 'APP_DEBUG', value: val, issue });
    }
  }

  return entries;
}

function analyzeWarmupSettings(appPath: string): ContainerCompileEntry[] {
  const entries: ContainerCompileEntry[] = [];
  const pkgDir = path.join(appPath, 'config', 'packages');
  if (!fs.existsSync(pkgDir)) return entries;

  for (const filePath of getAllYamlFiles(pkgDir)) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (!content.includes('warmup')) continue;

    if (/warmup:\s*false/.test(content)) {
      entries.push({
        file: path.relative(appPath, filePath),
        key: 'warmup: false',
        value: 'false',
        issue: 'warmup: false found — pool/warmer excluded from cache warmup; ensure this is intentional',
      });
    }
  }

  return entries;
}

function analyzeVarCache(appPath: string): ContainerCompileEntry[] {
  const entries: ContainerCompileEntry[] = [];
  const varCacheDir = path.join(appPath, 'var', 'cache');

  try {
    const stat = fs.statSync(varCacheDir);
    if (stat.isDirectory()) {
      let envDirs: string[] = [];
      try {
        envDirs = fs.readdirSync(varCacheDir).filter((d) => {
          try { return fs.statSync(path.join(varCacheDir, d)).isDirectory(); } catch { return false; }
        });
      } catch { /* skip */ }

      entries.push({
        file: 'var/cache',
        key: 'cache directory',
        value: `exists (env dirs: ${envDirs.join(', ') || 'none'})`,
        issue: envDirs.includes('prod') && envDirs.includes('dev')
          ? 'Both prod and dev cache dirs exist — ensure only the relevant env is deployed in production'
          : null,
      });
    }
  } catch { /* var/cache does not exist — normal in CI or fresh clone */ }

  return entries;
}

function buildContainerCompileEntries(appPath: string): ContainerCompileEntry[] {
  return [
    ...analyzeServicesYaml(appPath),
    ...analyzeKernel(appPath),
    ...analyzeFrameworkYaml(appPath),
    ...analyzeEnvFiles(appPath),
    ...analyzeWarmupSettings(appPath),
    ...analyzeVarCache(appPath),
  ];
}

export function listSymfonyContainerCompile(appPath: string): McpToolResult {
  try {
    const entries = buildContainerCompileEntries(appPath);

    if (entries.length === 0) {
      return { content: [{ type: 'text', text: 'No container compilation configuration found. Expected config/services.yaml, config/packages/framework.yaml, src/Kernel.php, or .env* files.' }] };
    }

    let text = `Symfony Container Compilation Inspector\n${'='.repeat(55)}\n\n`;
    text += `Configuration entries: ${entries.length}  Issues: ${entries.filter((e) => e.issue !== null).length}\n\n`;

    const withIssues = entries.filter((e) => e.issue !== null);
    const clean = entries.filter((e) => e.issue === null);

    if (withIssues.length > 0) {
      text += `Issues (${withIssues.length}):\n`;
      for (const e of withIssues) {
        text += `  [${e.file}] ${e.key}: ${e.value}\n`;
        text += `    Issue: ${e.issue}\n`;
      }
      text += '\n';
    }

    if (clean.length > 0) {
      text += `Configuration found (${clean.length}):\n`;
      for (const e of clean) {
        text += `  [${e.file}] ${e.key}: ${e.value}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyContainerCompileStats(appPath: string): McpToolResult {
  try {
    const entries = buildContainerCompileEntries(appPath);

    let text = `Symfony Container Compile Statistics\n${'='.repeat(45)}\n\n`;

    const withIssues = entries.filter((e) => e.issue !== null).length;
    const instanceofEntry = entries.find((e) => e.key === '_instanceof entries');
    const kernelOverrides = entries.filter((e) => e.key.includes('override')).length;
    const envIssues = entries.filter((e) => e.issue?.includes('APP_ENV') || e.issue?.includes('APP_DEBUG')).length;
    const warmupDisabled = entries.filter((e) => e.key === 'warmup: false').length;

    text += `Total config entries found: ${entries.length}\n`;
    text += `Entries with issues:         ${withIssues}\n`;
    text += `_instanceof entries:         ${instanceofEntry ? instanceofEntry.value : '0'}\n`;
    text += `Kernel method overrides:     ${kernelOverrides}\n`;
    text += `Env file issues:             ${envIssues}\n`;
    text += `warmup: false occurrences:   ${warmupDisabled}\n`;

    const varEntry = entries.find((e) => e.key === 'cache directory');
    text += `var/cache exists:            ${varEntry ? 'yes' : 'no'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyContainerCompileTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_container_compile',
      description: 'Inspect Symfony container compilation configuration: _instanceof heavy usage, Kernel getCacheDir/getBuildDir overrides, framework build_dir/cache_dir/system_clearer, APP_ENV/APP_DEBUG env values, warmup: false settings, var/cache directory state',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_container_compile_stats',
      description: 'Show Symfony container compilation statistics: config entry count, issue count, _instanceof entry count, Kernel override count, env file issues, warmup disabled count, var/cache presence',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
