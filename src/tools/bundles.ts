// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Bundle Registry Inspector
 *
 * Reads config/bundles.php to list all registered Symfony bundles:
 *   - Bundle class name and short name
 *   - Active environments (all, dev, test, prod)
 *   - Bundle category (framework, doctrine, security, api, debug, etc.)
 *   - Whether the bundle is dev-only or test-only
 *
 * Also reads composer.json to correlate bundle classes with packages.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface Bundle {
  class: string;
  shortName: string;
  environments: string[];
  isDevOnly: boolean;
  isTestOnly: boolean;
  category: string;
  package?: string;
}

// ─── Category detection ────────────────────────────────────────────────────

const BUNDLE_CATEGORIES: Array<[RegExp, string]> = [
  [/Doctrine/, 'Doctrine / Database'],
  [/ApiPlatform/, 'API Platform'],
  [/Lexik|NelmioApiDoc|Nelmio/, 'API'],
  [/Security|JWTAuth|LexikJWT/, 'Security'],
  [/Twig/, 'Twig / Templating'],
  [/Messenger|Enqueue|Bernard/, 'Messenger / Queue'],
  [/Monolog|Log/, 'Logging'],
  [/Mailer|Swift|Mandrill|Mailgun/, 'Mailer'],
  [/Translation|JMSTranslation/, 'Translation'],
  [/Serializer|JMSSerializer/, 'Serializer'],
  [/Validator/, 'Validator'],
  [/Form/, 'Forms'],
  [/Asset|WebpackEncore|Encore/, 'Assets / Frontend'],
  [/Debug|Profiler|WebProfiler|Stopwatch/, 'Debug / Profiling'],
  [/Cache|Redis|Memcache/, 'Cache'],
  [/HttpClient|Http/, 'HTTP Client'],
  [/Workflow/, 'Workflow'],
  [/Scheduler|Cron/, 'Scheduler'],
  [/Notifier/, 'Notifier'],
  [/FrameworkBundle/, 'Symfony Core'],
  [/Console/, 'Console'],
  [/Routing/, 'Routing'],
];

function detectCategory(bundleClass: string): string {
  for (const [pattern, category] of BUNDLE_CATEGORIES) {
    if (pattern.test(bundleClass)) return category;
  }
  return 'Other';
}

// ─── bundles.php parsing ───────────────────────────────────────────────────

function parseBundlesPhp(filePath: string): Bundle[] {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const bundles: Bundle[] = [];

  // Pattern: App\Bundle\FooBundle::class => ['all' => true]
  // Or:      Symfony\Bundle\FrameworkBundle\FrameworkBundle::class => ['all' => true]
  const pattern = /([\w\\]+Bundle)::class\s*=>\s*\[([\s\S]*?)\]/g;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(content)) !== null) {
    const bundleClass = m[1];
    const envBlock = m[2];

    const environments: string[] = [];

    // Parse environment keys: 'all' => true, 'dev' => true, 'test' => true
    for (const em of envBlock.matchAll(/['"](\w+)['"]\s*=>\s*true/g)) {
      environments.push(em[1]);
    }

    // Normalize: if 'all', replace with all envs
    const finalEnvs = environments.includes('all')
      ? ['all (prod, dev, test)']
      : environments;

    const isDevOnly = environments.length > 0 && !environments.includes('all') &&
                      !environments.includes('prod') &&
                      (environments.includes('dev') || environments.includes('test'));
    const isTestOnly = environments.length === 1 && environments[0] === 'test';

    const shortName = bundleClass.split('\\').pop() ?? bundleClass;

    bundles.push({
      class: bundleClass,
      shortName,
      environments: finalEnvs,
      isDevOnly,
      isTestOnly,
      category: detectCategory(bundleClass),
    });
  }

  return bundles;
}

function correlateWithComposer(bundles: Bundle[], appPath: string): void {
  try {
    const composerJson = JSON.parse(
      fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8')
    ) as Record<string, unknown>;

    const installedJson = path.join(appPath, 'vendor', 'composer', 'installed.json');
    let installed: Array<Record<string, unknown>> = [];

    try {
      const raw = JSON.parse(fs.readFileSync(installedJson, 'utf-8')) as unknown;
      installed = Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)['packages'] as typeof installed ?? []);
    } catch { /* skip */ }

    for (const bundle of bundles) {
      // Find the package that provides this bundle class
      const pkg = installed.find((p) => {
        const autoload = p['autoload'] as Record<string, unknown> | undefined;
        const psr4 = autoload?.['psr-4'] as Record<string, string> | undefined;
        if (!psr4) return false;
        return Object.keys(psr4).some((ns) => bundle.class.startsWith(ns.replace(/\\\\/g, '\\')));
      });

      if (pkg) {
        bundle.package = String(pkg['name'] ?? '');
      }
    }
    void composerJson;
  } catch { /* skip */ }
}

function loadBundles(appPath: string): Bundle[] {
  const candidates = [
    path.join(appPath, 'config', 'bundles.php'),
    path.join(appPath, 'app', 'AppKernel.php'), // Symfony 3 legacy
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const bundles = parseBundlesPhp(file);
    if (bundles.length > 0) {
      correlateWithComposer(bundles, appPath);
      return bundles;
    }
  }

  return [];
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listBundles(appPath: string): McpToolResult {
  try {
    const bundles = loadBundles(appPath);

    if (bundles.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No bundles found in config/bundles.php.\n\nExpected file: config/bundles.php',
        }],
      };
    }

    // Group by category
    const categories: Record<string, Bundle[]> = {};
    for (const b of bundles) {
      (categories[b.category] ??= []).push(b);
    }

    const prodCount = bundles.filter((b) => !b.isDevOnly && !b.isTestOnly).length;
    const devOnlyCount = bundles.filter((b) => b.isDevOnly).length;

    let text = `Symfony Bundles (${bundles.length} total — ${prodCount} prod, ${devOnlyCount} dev-only)\n${'='.repeat(60)}\n`;

    for (const [category, group] of Object.entries(categories).sort()) {
      text += `\n  ${category}\n`;
      for (const b of group.sort((a, b) => a.shortName.localeCompare(b.shortName))) {
        const env = b.isTestOnly ? '[test only]' : b.isDevOnly ? '[dev/test] ' : '[all envs] ';
        const pkg = b.package ? `  (${b.package})` : '';
        text += `    ${env} ${b.shortName}${pkg}\n`;
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

export function getBundleStats(appPath: string): McpToolResult {
  try {
    const bundles = loadBundles(appPath);

    if (bundles.length === 0) {
      return { content: [{ type: 'text', text: 'No bundles found.' }] };
    }

    const prodBundles = bundles.filter((b) => !b.isDevOnly && !b.isTestOnly);
    const devBundles = bundles.filter((b) => b.isDevOnly && !b.isTestOnly);
    const testBundles = bundles.filter((b) => b.isTestOnly);

    const categories: Record<string, number> = {};
    for (const b of bundles) {
      categories[b.category] = (categories[b.category] ?? 0) + 1;
    }

    let text = `Bundle Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total bundles:    ${bundles.length}\n`;
    text += `Production:       ${prodBundles.length}\n`;
    text += `Dev-only:         ${devBundles.length}\n`;
    text += `Test-only:        ${testBundles.length}\n`;

    text += `\nBy category:\n`;
    for (const [cat, count] of Object.entries(categories).sort()) {
      text += `  ${cat.padEnd(30)} ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getBundleTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_bundles',
      description: 'List all Symfony bundles from config/bundles.php grouped by category, showing active environments (all/dev/test)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_bundle_stats',
      description: 'Show bundle statistics: total count by environment (prod/dev/test) and category breakdown',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
