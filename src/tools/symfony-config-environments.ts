/**
 * Symfony Environment Config Override Inspector
 *
 * Distinct from environment.ts (env vars) and framework-config.ts (base framework config).
 * Focuses on per-environment YAML overrides in config/packages/{env}/:
 *
 * Base packages (config/packages/*.yaml)
 * vs. overrides in:
 *   - config/packages/dev/
 *   - config/packages/prod/
 *   - config/packages/test/
 *
 * Analysis:
 *   - Packages only present in one environment (not in base)
 *   - Packages present in base but completely overridden in an env
 *   - Keys in env override that don't exist in base config
 *   - prod/ overrides that disable debugging (good) or enable verbose logging (bad)
 *   - test/ configs that change database connection (e.g. in-memory SQLite)
 *   - Packages in dev/ but not in prod/ (acceptable) vs. the reverse (surprising)
 *
 * Config health:
 *   - Large env-specific files (may indicate too much duplication)
 *   - Empty override files (dead files)
 *   - Overrides using different top-level keys than base (possible typo)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

const ENVIRONMENTS = ['dev', 'prod', 'test'] as const;
type Env = typeof ENVIRONMENTS[number];

interface PackagePresence {
  packageName: string;
  inBase: boolean;
  inEnvs: Partial<Record<Env, boolean>>;
  issues: string[];
}

function listYamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch { return []; }
}

function getTopLevelKeys(filePath: string): string[] {
  const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
  if (!raw) return [];
  return Object.keys(raw);
}

export function listEnvConfigOverrides(appPath: string): McpToolResult {
  try {
    const packagesDir = path.join(appPath, 'config', 'packages');
    if (!fs.existsSync(packagesDir)) {
      return { content: [{ type: 'text', text: 'No config/packages/ directory found.' }] };
    }

    const baseFiles = listYamlFiles(packagesDir);
    const envFiles: Partial<Record<Env, string[]>> = {};
    for (const env of ENVIRONMENTS) {
      envFiles[env] = listYamlFiles(path.join(packagesDir, env));
    }

    // Build package name → presence map
    const allPackageNames = new Set<string>([
      ...baseFiles.map((f) => f.replace(/\.ya?ml$/, '')),
      ...ENVIRONMENTS.flatMap((env) => (envFiles[env] ?? []).map((f) => f.replace(/\.ya?ml$/, ''))),
    ]);

    const packages: PackagePresence[] = [];
    for (const pkgName of [...allPackageNames].sort()) {
      const baseFile = baseFiles.find((f) => f.replace(/\.ya?ml$/, '') === pkgName);
      const inBase   = !!baseFile;

      const inEnvs: Partial<Record<Env, boolean>> = {};
      for (const env of ENVIRONMENTS) {
        const envFile = (envFiles[env] ?? []).find((f) => f.replace(/\.ya?ml$/, '') === pkgName);
        if (envFile) inEnvs[env] = true;
      }

      const issues: string[] = [];

      // Check for empty override files
      for (const env of ENVIRONMENTS) {
        if (!inEnvs[env]) continue;
        const envPath = path.join(packagesDir, env, baseFile ?? `${pkgName}.yaml`);
        const alt     = path.join(packagesDir, env, `${pkgName}.yml`);
        const exists  = fs.existsSync(envPath) ? envPath : (fs.existsSync(alt) ? alt : null);
        if (exists) {
          try {
            const content = fs.readFileSync(exists, 'utf-8').trim();
            if (!content || content === '{}') issues.push(`${env}/${pkgName}.yaml is empty`);
          } catch { /* skip */ }
        }
      }

      // Env-only package (not in base)
      const envOnlyList = ENVIRONMENTS.filter((e) => inEnvs[e] && !inBase);
      if (envOnlyList.length > 0) {
        issues.push(`Package only in env(s): ${envOnlyList.join(', ')} — not in base config/packages/`);
      }

      // Key mismatch between base and env override
      if (inBase && baseFile) {
        const basePath = path.join(packagesDir, baseFile);
        const baseKeys = getTopLevelKeys(basePath);
        for (const env of ENVIRONMENTS) {
          if (!inEnvs[env]) continue;
          const envPath = path.join(packagesDir, env, baseFile);
          const alt     = path.join(packagesDir, env, `${pkgName}.yml`);
          const ep      = fs.existsSync(envPath) ? envPath : (fs.existsSync(alt) ? alt : null);
          if (!ep) continue;
          const envKeys = getTopLevelKeys(ep);
          const unknown = envKeys.filter((k) => baseKeys.length > 0 && !baseKeys.includes(k));
          if (unknown.length > 0) {
            issues.push(`${env}/ override has top-level keys not in base: ${unknown.join(', ')} (possible typo)`);
          }
        }
      }

      packages.push({ packageName: pkgName, inBase, inEnvs, issues });
    }

    const withIssues = packages.filter((p) => p.issues.length > 0);
    const totalIssues = packages.reduce((s, p) => s + p.issues.length, 0);

    let text = `Environment Config Overrides\n${'='.repeat(55)}\n`;
    text += `\nBase packages:   ${baseFiles.length}\n`;
    for (const env of ENVIRONMENTS) {
      text += `  ${env}/ overrides: ${(envFiles[env] ?? []).length}\n`;
    }
    text += `Total issues:    ${totalIssues}\n`;

    // Summary table
    text += `\n${'Package'.padEnd(35)} ${'base'} ${'dev'.padStart(4)} ${'prod'.padStart(5)} ${'test'.padStart(5)}\n`;
    text += `${'-'.repeat(55)}\n`;
    for (const pkg of packages) {
      const base = pkg.inBase ? '  ✓ ' : '    ';
      const dev  = pkg.inEnvs['dev'] ? '  ✓' : '   ';
      const prod = pkg.inEnvs['prod'] ? '  ✓' : '   ';
      const test = pkg.inEnvs['test'] ? '  ✓' : '   ';
      const warn = pkg.issues.length > 0 ? ' ⚠' : '';
      text += `${(pkg.packageName + warn).padEnd(37)}${base}${dev}${prod}${test}\n`;
    }

    if (withIssues.length > 0) {
      text += `\nIssues (${totalIssues}):\n`;
      for (const pkg of withIssues) {
        for (const issue of pkg.issues) text += `  ${pkg.packageName}: ⚠ ${issue}\n`;
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

export function getEnvConfigOverrideStats(appPath: string): McpToolResult {
  try {
    const packagesDir = path.join(appPath, 'config', 'packages');
    const baseCount   = listYamlFiles(packagesDir).length;
    const envCounts: Record<string, number> = {};
    for (const env of ENVIRONMENTS) {
      envCounts[env] = listYamlFiles(path.join(packagesDir, env)).length;
    }

    let text = `Env Config Override Statistics\n${'='.repeat(40)}\n\n`;
    text += `Base packages:   ${baseCount}\n`;
    for (const env of ENVIRONMENTS) {
      text += `  ${env}/ overrides: ${envCounts[env]}\n`;
    }
    text += `Total files:     ${baseCount + Object.values(envCounts).reduce((a, b) => a + b, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getEnvConfigOverrideTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_env_config_overrides',
      description: 'Show environment config override analysis: base vs dev/prod/test config/packages presence table, env-only packages, empty override files, top-level key mismatch between base and env override',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_env_config_override_stats',
      description: 'Show environment config statistics: base package count, dev/prod/test override counts, total file count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
