/**
 * Kernel Configuration Analysis
 *
 * Reads src/Kernel.php (or src/*Kernel.php):
 *   - MicroKernelTrait usage
 *   - build() method: addCompilerPass() calls registered directly in Kernel
 *   - configureContainer() / configureRoutes() customizations
 *   - Custom getCacheDir() / getLogDir() overrides
 *   - Extension registrations in build()
 *
 * Reads config/bundles.php:
 *   - All registered bundles with their env restrictions
 *   - Bundles loaded only in dev/test/prod
 *   - Bundle count per environment
 *   - Detects common bundles (DebugBundle, WebProfilerBundle in prod — risk)
 *
 * Combined view: full picture of what the kernel loads and when.
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface BundleRegistration {
  class: string;
  shortName: string;
  envs: string[];
  isAllEnvs: boolean;
}

interface KernelFeatures {
  file: string;
  usesMicroKernel: boolean;
  hasCustomBuild: boolean;
  hasCustomCacheDir: boolean;
  hasCustomLogDir: boolean;
  compilerPassesInBuild: string[];
  hasConfigureContainer: boolean;
  hasConfigureRoutes: boolean;
}

// ─── bundles.php parsing ─────────────────────────────────────────────────────

function loadBundles(appPath: string): BundleRegistration[] {
  const bundlesFile = path.join(appPath, 'config', 'bundles.php');
  let content = '';
  try { content = fs.readFileSync(bundlesFile, 'utf-8'); } catch { return []; }

  const bundles: BundleRegistration[] = [];

  // Pattern: Vendor\BundleClass::class => ['all' => true]
  // or       Vendor\BundleClass::class => ['dev' => true, 'test' => true]
  const bundleRe = /([A-Za-z\\]+Bundle(?:::class)?)\s*=>\s*\[([^\]]+)\]/g;

  for (const m of content.matchAll(bundleRe)) {
    const rawClass = m[1].replace(/::class$/, '').trim();
    const envBlock = m[2];

    const envs: string[] = [];
    for (const em of envBlock.matchAll(/'([^']+)'\s*=>\s*true/g)) {
      envs.push(em[1]);
    }

    const isAllEnvs = envs.includes('all');
    bundles.push({
      class: rawClass,
      shortName: rawClass.split('\\').pop() ?? rawClass,
      envs: isAllEnvs ? ['all'] : envs,
      isAllEnvs,
    });
  }

  return bundles.sort((a, b) => a.shortName.localeCompare(b.shortName));
}

// ─── Kernel.php parsing ──────────────────────────────────────────────────────

function findKernelFile(appPath: string): string | null {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return null;

  // Prefer Kernel.php
  const direct = path.join(srcDir, 'Kernel.php');
  if (fs.existsSync(direct)) return direct;

  // Scan for *Kernel.php
  try {
    for (const f of fs.readdirSync(srcDir)) {
      if (f.endsWith('Kernel.php')) return path.join(srcDir, f);
    }
  } catch { /* skip */ }
  return null;
}

function parseKernel(kernelPath: string): KernelFeatures {
  let content = '';
  try { content = fs.readFileSync(kernelPath, 'utf-8'); } catch {
    return {
      file: path.basename(kernelPath),
      usesMicroKernel: false,
      hasCustomBuild: false,
      hasCustomCacheDir: false,
      hasCustomLogDir: false,
      compilerPassesInBuild: [],
      hasConfigureContainer: false,
      hasConfigureRoutes: false,
    };
  }

  // Extract addCompilerPass calls in build()
  const buildBlock = /function\s+build\s*\([^)]*\)[^{]*\{([\s\S]*?)(?=\n {4}(?:public|protected|private)\s+function|\n\})/.exec(content)?.[1] ?? '';
  const compilerPasses: string[] = [];
  for (const m of buildBlock.matchAll(/addCompilerPass\s*\(\s*new\s+(\w+)/g)) {
    compilerPasses.push(m[1]);
  }

  return {
    file: path.basename(kernelPath),
    usesMicroKernel: content.includes('MicroKernelTrait'),
    hasCustomBuild: content.includes('function build('),
    hasCustomCacheDir: content.includes('getCacheDir'),
    hasCustomLogDir: content.includes('getLogDir'),
    compilerPassesInBuild: compilerPasses,
    hasConfigureContainer: content.includes('configureContainer'),
    hasConfigureRoutes: content.includes('configureRoutes'),
  };
}

// ─── Risk detection ──────────────────────────────────────────────────────────

const DEV_ONLY_BUNDLES = [
  'DebugBundle',
  'WebProfilerBundle',
  'MakerBundle',
];

function findRiskyBundles(bundles: BundleRegistration[]): BundleRegistration[] {
  return bundles.filter((b) =>
    DEV_ONLY_BUNDLES.some((devBundle) => b.shortName.includes(devBundle)) &&
    (b.isAllEnvs || b.envs.includes('prod'))
  );
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listKernelConfig(appPath: string): McpToolResult {
  try {
    const bundles = loadBundles(appPath);
    const kernelPath = findKernelFile(appPath);
    const kernel = kernelPath ? parseKernel(kernelPath) : null;
    const riskyBundles = findRiskyBundles(bundles);

    let text = `Kernel Configuration\n${'='.repeat(55)}\n`;

    // Kernel.php
    if (kernel) {
      text += `\nKernel: ${kernel.file}\n`;
      if (kernel.usesMicroKernel)       text += `  MicroKernelTrait: yes\n`;
      if (kernel.hasCustomCacheDir)     text += `  Custom getCacheDir(): yes\n`;
      if (kernel.hasCustomLogDir)       text += `  Custom getLogDir(): yes\n`;
      if (kernel.hasConfigureContainer) text += `  configureContainer(): overridden\n`;
      if (kernel.hasConfigureRoutes)    text += `  configureRoutes(): overridden\n`;
      if (kernel.compilerPassesInBuild.length > 0) {
        text += `  Compiler passes in build(): ${kernel.compilerPassesInBuild.join(', ')}\n`;
      }
    } else {
      text += `\nKernel.php: not found in src/\n`;
    }

    // Bundles summary
    if (bundles.length === 0) {
      text += `\nconfig/bundles.php: not found or empty\n`;
    } else {
      const allEnvBundles  = bundles.filter((b) => b.isAllEnvs);
      const devOnlyBundles = bundles.filter((b) => !b.isAllEnvs && b.envs.includes('dev') && !b.envs.includes('prod'));
      const prodOnly       = bundles.filter((b) => !b.isAllEnvs && b.envs.includes('prod') && !b.envs.includes('dev'));
      const testOnly       = bundles.filter((b) => !b.isAllEnvs && b.envs.length === 1 && b.envs[0] === 'test');

      text += `\nRegistered bundles (${bundles.length}):\n`;
      text += `  All environments (${allEnvBundles.length}):\n`;
      for (const b of allEnvBundles) text += `    ${b.shortName}\n`;

      if (devOnlyBundles.length > 0) {
        text += `  Dev only (${devOnlyBundles.length}):\n`;
        for (const b of devOnlyBundles) text += `    ${b.shortName}\n`;
      }
      if (testOnly.length > 0) {
        text += `  Test only (${testOnly.length}):\n`;
        for (const b of testOnly) text += `    ${b.shortName}\n`;
      }
      if (prodOnly.length > 0) {
        text += `  Prod only (${prodOnly.length}):\n`;
        for (const b of prodOnly) text += `    ${b.shortName}\n`;
      }

      const mixed = bundles.filter(
        (b) => !b.isAllEnvs && b.envs.length > 1 && !(devOnlyBundles.includes(b) || prodOnly.includes(b))
      );
      if (mixed.length > 0) {
        text += `  Partial envs (${mixed.length}):\n`;
        for (const b of mixed) text += `    ${b.shortName}  [${b.envs.join('+')}]\n`;
      }
    }

    if (riskyBundles.length > 0) {
      text += `\n⚠ Dev-only bundles loaded in prod:\n`;
      for (const b of riskyBundles) {
        text += `   ${b.shortName}  [envs: ${b.envs.join(', ')}]\n`;
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

export function getKernelStats(appPath: string): McpToolResult {
  try {
    const bundles = loadBundles(appPath);
    const kernelPath = findKernelFile(appPath);
    const kernel = kernelPath ? parseKernel(kernelPath) : null;
    const riskyBundles = findRiskyBundles(bundles);

    const byEnv: Record<string, number> = {};
    for (const b of bundles) {
      const envList = b.isAllEnvs ? ['all'] : b.envs;
      for (const env of envList) byEnv[env] = (byEnv[env] ?? 0) + 1;
    }

    let text = `Kernel Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total bundles:     ${bundles.length}\n`;
    for (const [env, count] of Object.entries(byEnv)) {
      text += `  ${env.padEnd(10)} ${count}\n`;
    }
    text += `MicroKernelTrait:  ${kernel?.usesMicroKernel ? 'yes' : 'no'}\n`;
    text += `Custom build():    ${kernel?.hasCustomBuild ? 'yes' : 'no'}\n`;
    text += `Risky bundles:     ${riskyBundles.length}\n`;

    if (riskyBundles.length > 0) {
      text += `  ⚠ ${riskyBundles.map((b) => b.shortName).join(', ')} active in prod\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getKernelAnalysisTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_kernel_config',
      description: 'Show Kernel configuration: MicroKernelTrait, build() compiler passes, all registered bundles by environment, dev-only bundles loaded in prod warning',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_kernel_stats',
      description: 'Show Kernel statistics: total bundles, bundles per environment, MicroKernelTrait, custom build(), risky dev bundles in prod',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
