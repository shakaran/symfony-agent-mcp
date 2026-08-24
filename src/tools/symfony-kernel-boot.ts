// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface KernelBootInfo {
  type: 'bundle' | 'pass' | 'extension' | 'warmup';
  name: string;
  order: number;
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

function buildKernelBootInfos(appPath: string): KernelBootInfo[] {
  const results: KernelBootInfo[] = [];

  const bundlesFile = path.join(appPath, 'config', 'bundles.php');
  if (fs.existsSync(bundlesFile)) {
    let content = '';
    try { content = fs.readFileSync(bundlesFile, 'utf-8'); } catch { /* ignore */ }

    const bundleMatches = content.matchAll(/(\w{1,100}Bundle)::class/g);
    let order = 0;
    const bundles: string[] = [];
    for (const m of bundleMatches) {
      bundles.push(m[1]);
      order++;
    }

    const frameworkIdx = bundles.indexOf('FrameworkBundle');
    const doctrineIdx = bundles.indexOf('DoctrineBundle');
    const securityIdx = bundles.indexOf('SecurityBundle');

    if (frameworkIdx > 0) {
      results.push({ type: 'bundle', name: 'FrameworkBundle', order: frameworkIdx, issues: ['FrameworkBundle is not the first bundle — other bundles may fail to find framework services during their build()'] });
    } else if (frameworkIdx === 0) {
      results.push({ type: 'bundle', name: 'FrameworkBundle', order: 0, issues: [] });
    }

    if (doctrineIdx >= 0 && securityIdx >= 0 && doctrineIdx > securityIdx) {
      results.push({ type: 'bundle', name: 'DoctrineBundle', order: doctrineIdx, issues: ['DoctrineBundle registered after SecurityBundle — UserProvider may not have EntityManager available if it loads before Doctrine'] });
    }

    results.push({ type: 'bundle', name: `Total: ${order} bundles`, order, issues: order > 30 ? [`${order} bundles registered — high bundle count increases boot time; consider profiling with Blackfire`] : [] });
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      if (content.includes('addCompilerPass(') || content.includes('CompilerPassInterface')) {
        const classMatch = /class\s+(\w{1,100})/.exec(content);
        const name = classMatch ? classMatch[1] : path.basename(file, '.php');

        if (content.includes('addCompilerPass(') && !content.includes('PassConfig::')) {
          issues.push(`Compiler pass "${name}" registered without priority argument — runs in default order (may execute before its dependencies)`);
        }
        results.push({ type: 'pass', name, order: 0, issues });
      }

      if (content.includes('CacheWarmerInterface') || content.includes('kernel.cache_warmer')) {
        const classMatch = /class\s+(\w{1,100})/.exec(content);
        const name = classMatch ? classMatch[1] : path.basename(file, '.php');

        const isOptional = content.includes('isOptional()') && /isOptional\(\)[^{]{0,50}return\s+false/.test(content);
        const hasHeavyWork = content.includes('findAll(') || content.includes('getRepository(') || content.includes('executeQuery(');

        if (!isOptional && hasHeavyWork) {
          issues.push(`Non-optional cache warmer "${name}" (${relFile}) performs database queries — blocks kernel boot on cache:warmup`);
        }
        results.push({ type: 'warmup', name, order: 0, issues });
      }

      if (content.includes('PrependExtensionInterface') && content.includes('prepend(')) {
        const classMatch = /class\s+(\w{1,100})/.exec(content);
        const name = classMatch ? classMatch[1] : path.basename(file, '.php');
        results.push({ type: 'extension', name, order: 0, issues: [] });
      }
    }
  }

  return results;
}

export function listSymfonyKernelBoot(appPath: string): McpToolResult {
  try {
    const infos = buildKernelBootInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No kernel boot analysis data found (no bundles.php, compiler passes, or cache warmers).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Kernel Boot Analysis\n${'='.repeat(50)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.name}`;
      if (info.order > 0 && info.type === 'bundle') text += `  (position: ${info.order})`;
      text += '\n';
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyKernelBootStats(appPath: string): McpToolResult {
  try {
    const infos = buildKernelBootInfos(appPath);
    let text = `Kernel Boot Statistics\n${'='.repeat(40)}\n\n`;
    text += `Bundles:         ${infos.filter((i) => i.type === 'bundle').length}\n`;
    text += `Compiler passes: ${infos.filter((i) => i.type === 'pass').length}\n`;
    text += `Cache warmers:   ${infos.filter((i) => i.type === 'warmup').length}\n`;
    text += `Extensions:      ${infos.filter((i) => i.type === 'extension').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyKernelBootTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_kernel_boot', description: 'Analyze Symfony kernel boot sequence; warns on FrameworkBundle not first, DoctrineBundle after SecurityBundle, compiler pass without priority, non-optional cache warmer with DB queries', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_kernel_boot_stats', description: 'Statistics for kernel boot: bundle/compiler-pass/cache-warmer/extension count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
