// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Runtime Inspector (symfony/runtime)
 *
 * Distinct from kernel.ts (Kernel class) and symfony-kernel-events.ts (kernel events).
 * Focuses on the Symfony Runtime component (symfony/runtime):
 *
 * Runtime component:
 *   Enables composable, reusable front controllers without index.php boilerplate.
 *
 * GenericRuntime / SymfonyRuntime (in composer.json extra):
 *   "extra": {
 *     "runtime": {
 *       "class": "Symfony\\Component\\Runtime\\GenericRuntime",
 *       "env_var_name": "APP_ENV",
 *       "dotenv_path": ".env",
 *       "prod_envs": ["prod"],
 *       "test_envs": ["test"],
 *       "disable_dotenv": false,
 *     }
 *   }
 *
 * Custom RuntimeInterface implementations:
 *   class MyRuntime implements RuntimeInterface
 *   {
 *     public function getRunner(?object $application): RunnerInterface { ... }
 *     public function getResolver(Closure $factory, ?\ReflectionFunction $reflector = null): ResolverInterface { ... }
 *   }
 *
 * index.php pattern with runtime:
 *   <?php
 *   use App\Kernel;
 *   require_once dirname(__DIR__).'/vendor/autoload_runtime.php';
 *   return function (array $context) { return new Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']); };
 *
 * Analysis:
 *   - composer.json runtime class configuration
 *   - Custom RuntimeInterface implementations
 *   - index.php using autoload_runtime.php vs traditional kernel.php
 *   - Missing autoload_runtime.php (runtime not installed or not configured)
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

interface RuntimeConfig {
  runtimeClass: string;
  envVarName: string;
  dotenvPath: string;
  prodEnvs: string[];
  testEnvs: string[];
  dotenvDisabled: boolean;
}

interface CustomRuntime {
  class: string;
  file: string;
  implementsRuntime: boolean;
  implementsRunner: boolean;
  implementsResolver: boolean;
}

function loadComposerRuntimeConfig(appPath: string): RuntimeConfig | null {
  const composerPath = path.join(appPath, 'composer.json');
  try {
    const raw    = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
    const extra  = (raw['extra'] ?? {}) as Record<string, unknown>;
    const runtime = (extra['runtime'] ?? null) as Record<string, unknown> | null;
    if (!runtime) return null;
    return {
      runtimeClass:   String(runtime['class'] ?? 'Symfony\\Component\\Runtime\\SymfonyRuntime'),
      envVarName:     String(runtime['env_var_name'] ?? 'APP_ENV'),
      dotenvPath:     String(runtime['dotenv_path'] ?? '.env'),
      prodEnvs:       (runtime['prod_envs'] as string[] | undefined) ?? ['prod'],
      testEnvs:       (runtime['test_envs'] as string[] | undefined) ?? ['test'],
      dotenvDisabled: Boolean(runtime['disable_dotenv'] ?? false),
    };
  } catch { return null; }
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

function scanCustomRuntimes(appPath: string): CustomRuntime[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const result: CustomRuntime[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const implementsRuntime  = content.includes('RuntimeInterface');
    const implementsRunner   = content.includes('RunnerInterface');
    const implementsResolver = content.includes('ResolverInterface');

    if (!implementsRuntime && !implementsRunner && !implementsResolver) continue;
    if (content.includes('namespace Symfony\\')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    result.push({
      class: classM[1],
      file: path.relative(appPath, file),
      implementsRuntime,
      implementsRunner,
      implementsResolver,
    });
  }
  return result;
}

function checkIndexPhp(appPath: string): { usesRuntime: boolean; usesAutoloadRuntime: boolean } {
  const publicDir = path.join(appPath, 'public', 'index.php');
  try {
    const content = fs.readFileSync(publicDir, 'utf-8');
    const usesAutoloadRuntime = content.includes('autoload_runtime.php');
    const usesRuntime = usesAutoloadRuntime || content.includes('RuntimeInterface');
    return { usesRuntime, usesAutoloadRuntime };
  } catch {
    return { usesRuntime: false, usesAutoloadRuntime: false };
  }
}

export function listRuntimeConfig(appPath: string): McpToolResult {
  try {
    const config         = loadComposerRuntimeConfig(appPath);
    const customRuntimes = scanCustomRuntimes(appPath);
    const indexPhp       = checkIndexPhp(appPath);

    const autoloadRuntimeExists = fs.existsSync(path.join(appPath, 'vendor', 'autoload_runtime.php'));

    let text = `Symfony Runtime Component\n${'='.repeat(55)}\n`;

    if (!config && customRuntimes.length === 0 && !indexPhp.usesRuntime) {
      text += `\nRuntime component not configured.\n`;
      text += `\nInstall with:\n  composer require symfony/runtime\n`;
      text += `\nThen configure composer.json extra:\n`;
      text += `  "extra": { "runtime": { "class": "Symfony\\\\Component\\\\Runtime\\\\SymfonyRuntime" } }\n`;
      return { content: [{ type: 'text', text }] };
    }

    text += `\ncomposer.json runtime config: ${config ? '✓' : '✗ not found'}\n`;
    text += `vendor/autoload_runtime.php:   ${autoloadRuntimeExists ? '✓' : '✗ missing — run composer install'}\n`;
    text += `public/index.php uses runtime: ${indexPhp.usesRuntime ? '✓' : '✗'}\n`;
    text += `public/index.php autoload_runtime.php: ${indexPhp.usesAutoloadRuntime ? '✓' : '✗'}\n`;

    if (config) {
      text += `\nRuntime Configuration:\n`;
      text += `  class:          ${config.runtimeClass}\n`;
      text += `  env_var_name:   ${config.envVarName}\n`;
      text += `  dotenv_path:    ${config.dotenvPath}\n`;
      text += `  prod_envs:      ${config.prodEnvs.join(', ')}\n`;
      text += `  test_envs:      ${config.testEnvs.join(', ')}\n`;
      text += `  disable_dotenv: ${config.dotenvDisabled}\n`;
    }

    if (customRuntimes.length > 0) {
      text += `\nCustom Runtime classes (${customRuntimes.length}):\n`;
      for (const r of customRuntimes) {
        const ifaces = [
          r.implementsRuntime  ? 'RuntimeInterface'  : '',
          r.implementsRunner   ? 'RunnerInterface'   : '',
          r.implementsResolver ? 'ResolverInterface' : '',
        ].filter(Boolean).join(', ');
        text += `  ${r.class}  implements: ${ifaces}  (${r.file})\n`;
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

export function getRuntimeStats(appPath: string): McpToolResult {
  try {
    const config             = loadComposerRuntimeConfig(appPath);
    const customRuntimes     = scanCustomRuntimes(appPath);
    const indexPhp           = checkIndexPhp(appPath);
    const autoloadRuntimeExists = fs.existsSync(path.join(appPath, 'vendor', 'autoload_runtime.php'));

    let text = `Runtime Statistics\n${'='.repeat(40)}\n\n`;
    text += `Runtime configured:          ${config ? 'yes' : 'no'}\n`;
    text += `autoload_runtime.php exists: ${autoloadRuntimeExists ? 'yes' : 'no'}\n`;
    text += `index.php uses runtime:      ${indexPhp.usesRuntime ? 'yes' : 'no'}\n`;
    text += `Custom RuntimeInterface:     ${customRuntimes.filter((r) => r.implementsRuntime).length}\n`;
    text += `Custom RunnerInterface:      ${customRuntimes.filter((r) => r.implementsRunner).length}\n`;
    text += `Custom ResolverInterface:    ${customRuntimes.filter((r) => r.implementsResolver).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyRuntimeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_runtime_config',
      description: 'Show Symfony Runtime component configuration: composer.json extra.runtime class/env_var_name/dotenv_path/prod_envs/test_envs, vendor/autoload_runtime.php existence, index.php runtime pattern detection, custom RuntimeInterface/RunnerInterface/ResolverInterface implementations',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_runtime_stats',
      description: 'Show runtime statistics: configured flag, autoload_runtime.php existence, index.php uses runtime, custom Runtime/Runner/Resolver counts',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
