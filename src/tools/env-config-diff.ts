/**
 * Multi-environment Config Diff
 *
 * Compares Symfony config files across environments:
 *   - config/packages/{dev,prod,test}/*.yaml vs config/packages/*.yaml (base)
 *   - Shows which packages have per-env overrides
 *   - Lists top-level keys that differ between environments
 *   - Detects env-specific bundles (config/bundles.php)
 *   - Reports missing env-specific configs (e.g. no prod/ override for a package)
 *
 * Answers: "what's different between dev and prod?"
 * Pure static analysis — no YAML merging executed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

type Env = 'dev' | 'prod' | 'test';

interface EnvOverride {
  package: string;
  env: Env;
  overriddenKeys: string[];
  file: string;
}

interface PackageCoverage {
  package: string;
  hasBase: boolean;
  envs: Env[];
}

// ─── File discovery ─────────────────────────────────────────────────────────

function listYamlFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => f.replace(/\.(yaml|yml)$/, ''));
  } catch {
    return [];
  }
}

function loadTopLevelKeys(filePath: string): string[] {
  const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
  if (!raw) return [];
  return Object.keys(raw);
}

// ─── Diff computation ───────────────────────────────────────────────────────

function computeOverrides(appPath: string): EnvOverride[] {
  const overrides: EnvOverride[] = [];
  const pkgDir = path.join(appPath, 'config', 'packages');
  const envs: Env[] = ['dev', 'prod', 'test'];

  for (const env of envs) {
    const envDir = path.join(pkgDir, env);
    const envPackages = listYamlFiles(envDir);

    for (const pkg of envPackages) {
      const envFile = path.join(envDir, `${pkg}.yaml`);
      const baseFile = path.join(pkgDir, `${pkg}.yaml`);

      const envKeys = loadTopLevelKeys(envFile);
      const baseKeys = loadTopLevelKeys(baseFile);

      // Keys present in env override (whether or not they exist in base)
      const overriddenKeys = envKeys.filter((k) => !baseKeys.includes(k) || true);

      overrides.push({
        package: pkg,
        env,
        overriddenKeys,
        file: path.relative(appPath, envFile),
      });
    }
  }

  return overrides;
}

function computeCoverage(appPath: string): PackageCoverage[] {
  const pkgDir = path.join(appPath, 'config', 'packages');
  const basePackages = listYamlFiles(pkgDir);
  const envs: Env[] = ['dev', 'prod', 'test'];

  return basePackages.map((pkg) => {
    const presentEnvs = envs.filter((env) =>
      fs.existsSync(path.join(pkgDir, env, `${pkg}.yaml`)) ||
      fs.existsSync(path.join(pkgDir, env, `${pkg}.yml`))
    );
    return { package: pkg, hasBase: true, envs: presentEnvs };
  });
}

// ─── Bundle per-env detection ───────────────────────────────────────────────

interface BundleEnvEntry {
  bundle: string;
  envs: string[];
}

function parseBundlesEnvs(appPath: string): BundleEnvEntry[] {
  const bundlesFile = path.join(appPath, 'config', 'bundles.php');
  try {
    const stat = fs.statSync(bundlesFile);
    if (stat.size > 512 * 1024) return [];
    const content = fs.readFileSync(bundlesFile, 'utf-8');
    const entries: BundleEnvEntry[] = [];

    // Use a non-backtracking pattern: [A-Za-z_][\w\\]* avoids nested quantifiers
    for (const m of content.matchAll(/([A-Za-z_][\w\\]*)::class\s*=>\s*\[([^\]]+)\]/g)) {
      const bundle = m[1].split('\\').pop() ?? m[1];
      const envBlock = m[2];
      const envs: string[] = [];
      for (const em of envBlock.matchAll(/'(\w+)'\s*=>\s*true/g)) {
        envs.push(em[1]);
      }
      if (envs.length > 0 && !(envs.length === 1 && envs[0] === 'all')) {
        entries.push({ bundle, envs });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listEnvConfigDiff(appPath: string): McpToolResult {
  try {
    const pkgDir = path.join(appPath, 'config', 'packages');
    if (!fs.existsSync(pkgDir)) {
      return {
        content: [{ type: 'text', text: 'config/packages/ not found. Not a Symfony application?' }],
      };
    }

    const overrides = computeOverrides(appPath);
    const coverage = computeCoverage(appPath);
    const bundleEnvs = parseBundlesEnvs(appPath);

    if (overrides.length === 0 && bundleEnvs.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No per-environment config overrides found.\n\nCreate env-specific overrides:\n  config/packages/dev/monolog.yaml\n  config/packages/prod/monolog.yaml',
        }],
      };
    }

    let text = `Multi-environment Config Diff\n${'='.repeat(60)}\n`;

    // Group by package
    const byPackage = new Map<string, EnvOverride[]>();
    for (const o of overrides) {
      const list = byPackage.get(o.package) ?? [];
      list.push(o);
      byPackage.set(o.package, list);
    }

    text += `\nPackages with per-env overrides (${byPackage.size}):\n`;
    for (const [pkg, envOverrides] of [...byPackage.entries()].sort()) {
      const envList = envOverrides.map((o) => o.env).join(', ');
      text += `  ${pkg.padEnd(35)} [${envList}]\n`;
      for (const o of envOverrides) {
        if (o.overriddenKeys.length > 0) {
          text += `    ${o.env}: ${o.overriddenKeys.slice(0, 5).join(', ')}\n`;
        }
      }
    }

    // Packages only in base (no env overrides)
    const overriddenPkgSet = new Set(overrides.map((o) => o.package));
    const baseOnly = coverage.filter((c) => c.envs.length === 0 && !overriddenPkgSet.has(c.package));
    if (baseOnly.length > 0) {
      text += `\nPackages with no per-env overrides (${baseOnly.length}):\n`;
      text += '  ' + baseOnly.map((c) => c.package).join(', ') + '\n';
    }

    // Bundles registered only for specific envs
    if (bundleEnvs.length > 0) {
      text += `\nBundles registered for specific environments:\n`;
      for (const { bundle, envs } of bundleEnvs) {
        text += `  ${bundle.padEnd(40)} [${envs.join(', ')}]\n`;
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

export function getEnvConfigDiffStats(appPath: string): McpToolResult {
  try {
    const overrides = computeOverrides(appPath);
    const coverage = computeCoverage(appPath);
    const bundleEnvs = parseBundlesEnvs(appPath);

    const byEnv: Partial<Record<Env, number>> = {};
    for (const o of overrides) {
      byEnv[o.env] = (byEnv[o.env] ?? 0) + 1;
    }

    let text = `Env Config Diff Statistics\n${'='.repeat(40)}\n\n`;
    text += `Base packages:          ${coverage.length}\n`;
    text += `With dev overrides:     ${byEnv['dev'] ?? 0}\n`;
    text += `With prod overrides:    ${byEnv['prod'] ?? 0}\n`;
    text += `With test overrides:    ${byEnv['test'] ?? 0}\n`;
    text += `Env-restricted bundles: ${bundleEnvs.length}\n`;

    const devOnly = coverage.filter((c) => c.envs.includes('dev') && !c.envs.includes('prod'));
    if (devOnly.length > 0) {
      text += `\nPackages with dev override but no prod override:\n`;
      for (const c of devOnly) text += `  ${c.package}\n`;
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

export function getEnvConfigDiffTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_env_config_diff',
      description: 'Show which config packages have dev/prod/test overrides, what top-level keys differ, and which bundles are env-restricted',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_env_config_diff_stats',
      description: 'Show environment config diff statistics: override count per env, packages with dev-only overrides (potential prod gaps)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
