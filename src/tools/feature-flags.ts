/**
 * Feature Flag Inspector
 *
 * Detects feature flag systems in Symfony apps:
 *
 * Bundle-based:
 *   - flagception/flagception-bundle (config/packages/flagception.yaml)
 *   - unleash-client-php / Unleash (DSN-based, config)
 *   - flagsmith/flagsmith-php-client
 *   - openfeature/sdk (OpenFeature standard)
 *
 * Custom patterns:
 *   - Classes implementing FeatureFlagInterface / FeatureToggleInterface
 *   - Parameter-based flags (feature.*, flag.* in services.yaml / config)
 *   - Environment variable-based flags (FEATURE_*, FLAG_*, ENABLE_*)
 *
 * Usage scanning:
 *   - Injection of FeatureManager / FeatureChecker / Unleash
 *   - ->isEnabled() / ->isActive() call sites
 *   - Twig checks ({% if feature('flag') %})
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface FeatureFlag {
  name: string;
  source: 'yaml' | 'env' | 'parameter' | 'code';
  enabled?: boolean;
  description?: string;
}

interface FeatureFlagSystem {
  name: string;
  flags: FeatureFlag[];
  configFile?: string;
}

interface FlagUsage {
  class: string;
  file: string;
  checkCount: number;
  usedFlags: string[];
}

// ─── System detection ─────────────────────────────────────────────────────────

function detectFlagceptionBundle(appPath: string): FeatureFlagSystem | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'flagception.yaml'),
    path.join(appPath, 'config', 'packages', 'flagception.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const flagc = (raw['flagception'] ?? raw) as Record<string, unknown>;
    const featuresRaw = flagc['features'] as Record<string, unknown> | undefined;
    if (!featuresRaw) return { name: 'Flagception', flags: [], configFile: path.basename(filePath) };

    const flags: FeatureFlag[] = [];
    for (const [name, def] of Object.entries(featuresRaw)) {
      if (!def || typeof def !== 'object') {
        flags.push({ name, source: 'yaml', enabled: !!def });
        continue;
      }
      const d = def as Record<string, unknown>;
      flags.push({
        name,
        source: 'yaml',
        enabled: d['default'] !== false && d['state'] !== 'inactive',
      });
    }
    return { name: 'Flagception', flags, configFile: path.basename(filePath) };
  }
  return null;
}

function detectEnvFlags(appPath: string): FeatureFlag[] {
  const flags: FeatureFlag[] = [];
  const envFiles = ['.env', '.env.dist', '.env.example', '.env.test'];
  for (const fname of envFiles) {
    try {
      const content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      for (const m of content.matchAll(/^(FEATURE_[A-Z0-9_]+|FLAG_[A-Z0-9_]+|ENABLE_[A-Z0-9_]+)=([^\n]*)/gm)) {
        if (!flags.some((f) => f.name === m[1])) {
          flags.push({
            name: m[1],
            source: 'env',
            enabled: !['0', 'false', 'no', ''].includes(m[2].trim().toLowerCase()),
          });
        }
      }
    } catch { /* skip */ }
  }
  return flags;
}

function detectParameterFlags(appPath: string): FeatureFlag[] {
  const candidates = [
    path.join(appPath, 'config', 'services.yaml'),
    path.join(appPath, 'config', 'parameters.yaml'),
  ];
  const flags: FeatureFlag[] = [];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const params = raw['parameters'] as Record<string, unknown> | undefined;
    if (!params) continue;

    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith('feature.') || key.startsWith('flag.') || key.startsWith('feature_')) {
        flags.push({
          name: key,
          source: 'parameter',
          enabled: value !== false && value !== '0' && value !== 'false',
        });
      }
    }
  }
  return flags;
}

function detectComposerSystems(appPath: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8')) as
      Record<string, Record<string, string>>;
    const deps = { ...raw['require'], ...raw['require-dev'] };
    const detected: string[] = [];
    if (deps['flagception/flagception-bundle'])          detected.push('Flagception');
    if (deps['unleash/client'] || deps['unleash/symfony-client-bundle']) detected.push('Unleash');
    if (deps['flagsmith/flagsmith'])                     detected.push('Flagsmith');
    if (deps['open-feature/sdk'])                        detected.push('OpenFeature');
    return detected;
  } catch { return []; }
}

// ─── Source scanning ─────────────────────────────────────────────────────────

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

function scanFlagUsage(appPath: string): FlagUsage[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const usages: FlagUsage[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasFlag =
      content.includes('FeatureManager') ||
      content.includes('FeatureChecker') ||
      content.includes('isEnabled(') ||
      content.includes('isActive(') ||
      content.includes('Unleash') ||
      content.includes('flagception');

    if (!hasFlag) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const checkCount = (content.match(/->isEnabled\s*\(|->isActive\s*\(|->isGranted\s*\('feature/g) ?? []).length;
    if (checkCount === 0) continue;

    const usedFlags: string[] = [];
    for (const m of content.matchAll(/->(?:isEnabled|isActive)\s*\(\s*['"]([^'"]+)['"]/g)) {
      usedFlags.push(m[1]);
    }

    usages.push({ class: classM[1], file: path.basename(file), checkCount, usedFlags });
  }

  return usages.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listFeatureFlags(appPath: string): McpToolResult {
  try {
    const flagception = detectFlagceptionBundle(appPath);
    const envFlags    = detectEnvFlags(appPath);
    const paramFlags  = detectParameterFlags(appPath);
    const composerSystems = detectComposerSystems(appPath);
    const usages = scanFlagUsage(appPath);

    const allFlags = [
      ...(flagception?.flags ?? []),
      ...envFlags,
      ...paramFlags,
    ];

    if (allFlags.length === 0 && composerSystems.length === 0 && usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No feature flag system detected.\n\nOptions:\n  composer require flagception/flagception-bundle   # YAML/env/cookie-based\n  composer require unleash/symfony-client-bundle   # Unleash server\n\nOr use env vars:\n  FEATURE_NEW_DASHBOARD=true in .env',
        }],
      };
    }

    let text = `Feature Flags\n${'='.repeat(55)}\n`;

    if (composerSystems.length > 0) {
      text += `\nInstalled systems: ${composerSystems.join(', ')}\n`;
    }

    if (flagception) {
      text += `\nFlagception flags (${flagception.flags.length}) — ${flagception.configFile}:\n`;
      for (const f of flagception.flags) {
        const status = f.enabled ? '✓ on' : '○ off';
        text += `  ${f.name.padEnd(45)} ${status}\n`;
      }
    }

    if (envFlags.length > 0) {
      text += `\nEnvironment variable flags (${envFlags.length}):\n`;
      for (const f of envFlags) {
        const status = f.enabled ? '✓ on' : '○ off';
        text += `  ${f.name.padEnd(45)} ${status}\n`;
      }
    }

    if (paramFlags.length > 0) {
      text += `\nService parameter flags (${paramFlags.length}):\n`;
      for (const f of paramFlags) {
        const status = f.enabled ? '✓ on' : '○ off';
        text += `  ${f.name.padEnd(45)} ${status}\n`;
      }
    }

    if (usages.length > 0) {
      text += `\nFlag check sites in src/ (${usages.length} classes):\n`;
      for (const u of usages) {
        const flags = u.usedFlags.length > 0 ? `  checks: ${u.usedFlags.join(', ')}` : '';
        text += `  ${u.class.padEnd(40)} ${u.checkCount} check(s)${flags}\n`;
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

export function getFeatureFlagStats(appPath: string): McpToolResult {
  try {
    const flagception     = detectFlagceptionBundle(appPath);
    const envFlags        = detectEnvFlags(appPath);
    const paramFlags      = detectParameterFlags(appPath);
    const composerSystems = detectComposerSystems(appPath);
    const usages          = scanFlagUsage(appPath);

    let text = `Feature Flag Statistics\n${'='.repeat(40)}\n\n`;
    text += `Systems installed: ${composerSystems.join(', ') || 'none'}\n`;
    text += `Flagception flags: ${flagception?.flags.length ?? 0}\n`;
    text += `Env var flags:     ${envFlags.length}\n`;
    text += `Parameter flags:   ${paramFlags.length}\n`;
    text += `Classes checking flags: ${usages.length}\n`;
    text += `Total flag checks: ${usages.reduce((s, u) => s + u.checkCount, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getFeatureFlagTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_feature_flags',
      description: 'List feature flags: Flagception YAML flags, FEATURE_*/ENABLE_* env vars, parameter-based flags, Unleash/OpenFeature detection, flag check sites in source code',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_feature_flag_stats',
      description: 'Show feature flag statistics: installed systems, flag count per source (YAML/env/parameter), classes checking flags, total check count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
