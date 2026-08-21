/**
 * Symfony Runtime Environment Inspector
 *
 * Checks composer.json for symfony/runtime and runtime-specific packages:
 *   runtime/frankenphp-symfony, runtime/roadrunner-symfony-nyholm,
 *   runtime/reactphp, runtime/amphp, runtime/swoole
 *
 * Reads .env or .env.local for APP_RUNTIME env var.
 * Checks config/bootstrap.php or public/index.php for Runtime usage.
 *
 * Detects:
 *   - Runtime class configured vs packages installed (mismatch)
 *   - FrankenPHP vs RoadRunner vs ReactPHP config
 *
 * Warns:
 *   - symfony/runtime installed without APP_RUNTIME configured (uses GenericRuntime)
 *   - FrankenPHP runtime without opcache.preload configured
 *   - RoadRunner without worker restart limit config (memory leak risk)
 *   - Multiple runtime packages installed (ambiguous)
 *   - APP_RUNTIME in .env (should be in .env.local or server env, not committed)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RuntimeEnvInfo {
  hasSymfonyRuntime: boolean;
  configuredRuntime?: string;
  runtimePackages: string[];
  appRuntimeSource?: string;
  issues: string[];
}

// ─── Known runtime packages ───────────────────────────────────────────────────

const RUNTIME_PACKAGES: Record<string, string> = {
  'runtime/frankenphp-symfony':      'FrankenPHP',
  'runtime/roadrunner-symfony-nyholm': 'RoadRunner',
  'runtime/reactphp':                'ReactPHP',
  'runtime/amphp':                   'AmpHP',
  'runtime/swoole':                  'Swoole',
  'baldinof/road-runner-bundle':     'RoadRunner',
  'spiral/roadrunner-symfony-nyholm': 'RoadRunner',
};

// ─── Composer reading ─────────────────────────────────────────────────────────

function readComposerPackages(appPath: string): { hasSymfonyRuntime: boolean; runtimePackages: string[] } {
  try {
    const raw = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const allDeps = {
      ...(json['require'] as Record<string, unknown> ?? {}),
      ...(json['require-dev'] as Record<string, unknown> ?? {}),
    };
    const hasSymfonyRuntime = 'symfony/runtime' in allDeps;
    const runtimePackages = Object.keys(RUNTIME_PACKAGES).filter((pkg) => pkg in allDeps);
    return { hasSymfonyRuntime, runtimePackages };
  } catch {
    return { hasSymfonyRuntime: false, runtimePackages: [] };
  }
}

// ─── APP_RUNTIME env reading ──────────────────────────────────────────────────

interface RuntimeEnvResult {
  value?: string;
  source?: string;
}

function readAppRuntime(appPath: string): RuntimeEnvResult {
  const candidates: Array<{ file: string; committed: boolean }> = [
    { file: '.env.local', committed: false },
    { file: '.env', committed: true },
  ];

  for (const { file, committed } of candidates) {
    try {
      const content = fs.readFileSync(path.join(appPath, file), 'utf-8');
      const m = /^APP_RUNTIME\s*=\s*(.{1,200})/m.exec(content);
      if (m) {
        return {
          value: m[1].trim().replace(/^["']|["']$/g, ''),
          source: committed ? file + ' (committed — should be server env)' : file,
        };
      }
    } catch { /* try next */ }
  }
  return {};
}

// ─── Bootstrap / index.php check ─────────────────────────────────────────────

function checkBootstrapRuntime(appPath: string): boolean {
  const candidates = [
    path.join(appPath, 'config', 'bootstrap.php'),
    path.join(appPath, 'public', 'index.php'),
  ];
  for (const f of candidates) {
    try {
      const content = fs.readFileSync(f, 'utf-8');
      if (content.includes('Runtime') || content.includes('runtime')) return true;
    } catch { /* skip */ }
  }
  return false;
}

// ─── Opcache preload detection ────────────────────────────────────────────────

function hasOpcachePreload(appPath: string): boolean {
  const candidates = ['config/preload.php', 'var/cache/prod/App_KernelProdContainer.preload.php'];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(appPath, candidate))) return true;
  }
  // Check php.ini equivalent in config
  try {
    const phpIni = fs.readFileSync(path.join(appPath, 'php.ini'), 'utf-8');
    return /opcache\.preload\s*=/.test(phpIni);
  } catch { return false; }
}

// ─── RoadRunner config check ──────────────────────────────────────────────────

function hasRoadRunnerRestartLimit(appPath: string): boolean {
  const candidates = ['.rr.yaml', '.rr.yml', 'rr.yaml', 'rr.yml'];
  for (const name of candidates) {
    try {
      const content = fs.readFileSync(path.join(appPath, name), 'utf-8');
      return /max_jobs\s*:|max_worker_memory\s*:/.test(content);
    } catch { /* try next */ }
  }
  return false;
}

// ─── Main analysis ────────────────────────────────────────────────────────────

function analyze(appPath: string): RuntimeEnvInfo {
  const { hasSymfonyRuntime, runtimePackages } = readComposerPackages(appPath);
  const envResult = readAppRuntime(appPath);
  const hasBootstrap = checkBootstrapRuntime(appPath);

  const issues: string[] = [];

  if (hasSymfonyRuntime && !envResult.value && !hasBootstrap) {
    issues.push(
      `symfony/runtime is installed but APP_RUNTIME is not configured. ` +
      `The default GenericRuntime will be used — ensure this is intentional.`,
    );
  }

  if (envResult.source?.includes('committed')) {
    issues.push(
      `APP_RUNTIME is set in .env (committed to VCS). ` +
      `Runtime class should be configured in .env.local or as a server environment variable, ` +
      `not committed — it is environment-specific.`,
    );
  }

  if (runtimePackages.length > 1) {
    const names = runtimePackages.map((p) => RUNTIME_PACKAGES[p] ?? p);
    issues.push(
      `Multiple runtime packages installed: ${names.join(', ')}. ` +
      `Only one runtime should be active — ambiguous configuration.`,
    );
  }

  // FrankenPHP without opcache.preload
  if (runtimePackages.includes('runtime/frankenphp-symfony') || envResult.value?.includes('FrankenPHP')) {
    if (!hasOpcachePreload(appPath)) {
      issues.push(
        `FrankenPHP runtime is configured but no opcache.preload is detected. ` +
        `opcache.preload significantly improves FrankenPHP performance.`,
      );
    }
  }

  // RoadRunner without restart limit
  const hasRR = runtimePackages.some((p) => RUNTIME_PACKAGES[p] === 'RoadRunner')
    || envResult.value?.includes('RoadRunner');
  if (hasRR && !hasRoadRunnerRestartLimit(appPath)) {
    issues.push(
      `RoadRunner runtime detected but no worker restart limit (max_jobs/max_worker_memory) found in .rr.yaml. ` +
      `Without a restart limit, long-running workers can leak memory.`,
    );
  }

  const configuredRuntime = envResult.value
    ?? (runtimePackages.length === 1
      ? RUNTIME_PACKAGES[runtimePackages[0]] ?? runtimePackages[0]
      : undefined);

  return {
    hasSymfonyRuntime,
    configuredRuntime,
    runtimePackages,
    appRuntimeSource: envResult.source,
    issues,
  };
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listRuntimeEnv(appPath: string): McpToolResult {
  try {
    const info = analyze(appPath);

    let text = `Symfony Runtime Environment Analysis\n${'='.repeat(55)}\n\n`;
    text += `symfony/runtime installed: ${info.hasSymfonyRuntime ? 'yes' : 'no'}\n`;
    text += `Configured runtime:        ${info.configuredRuntime ?? '(default GenericRuntime)'}\n`;
    text += `APP_RUNTIME source:        ${info.appRuntimeSource ?? 'not set'}\n`;
    text += `Runtime packages:          ${info.runtimePackages.length > 0 ? info.runtimePackages.join(', ') : 'none'}\n`;

    if (info.runtimePackages.length > 0) {
      text += `\nDetected runtimes:\n`;
      for (const pkg of info.runtimePackages) {
        text += `  ${pkg}  →  ${RUNTIME_PACKAGES[pkg] ?? 'unknown'}\n`;
      }
    }

    if (info.issues.length > 0) {
      text += `\nIssues:\n`;
      for (const issue of info.issues) {
        text += `  WARN: ${issue}\n`;
      }
    } else {
      text += `\nNo runtime configuration issues found.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRuntimeEnvStats(appPath: string): McpToolResult {
  try {
    const info = analyze(appPath);

    let text = `Symfony Runtime Environment Statistics\n${'='.repeat(40)}\n\n`;
    text += `symfony/runtime installed: ${info.hasSymfonyRuntime ? 'yes' : 'no'}\n`;
    text += `Runtime packages count:    ${info.runtimePackages.length}\n`;
    text += `APP_RUNTIME configured:    ${info.configuredRuntime ? 'yes' : 'no'}\n`;
    text += `APP_RUNTIME source:        ${info.appRuntimeSource ?? 'not set'}\n`;
    text += `Issues:                    ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getRuntimeEnvTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_runtime_env',
      description: 'List Symfony runtime environment config: FrankenPHP/RoadRunner/ReactPHP detection, APP_RUNTIME source, opcache.preload warning, worker restart limit',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_runtime_env_stats',
      description: 'Show Symfony runtime environment statistics: runtime packages count, APP_RUNTIME configured, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
