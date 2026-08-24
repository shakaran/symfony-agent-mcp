// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Twig Global Variables Inspector
 *
 * Distinct from twig.ts (general Twig config), twig-extensions.ts (functions/filters/tests).
 * Focuses on variables available globally in all Twig templates:
 *
 * twig.yaml globals:
 *   twig:
 *     globals:
 *       ga_tracking: '%env(GA_TRACKING_ID)%'
 *       site_name: 'My Application'
 *       app_version: '%app.version%'
 *
 * PHP addGlobal() calls:
 *   - TwigExtension::getGlobals() return array
 *   - $twig->addGlobal('key', $value) call sites
 *
 * Service globals:
 *   - Globals pointing to services (performance: service resolved on every request)
 *   - Globals exposing entire service objects (security risk: may expose internal state)
 *
 * Analysis:
 *   - Global variable name conflicts (same name in YAML and PHP extension)
 *   - Global pointing to '@service_id' (pulls full service into every template)
 *   - Very many globals (> 10) — consider passing data via controller context instead
 *   - Global named 'app' — conflicts with Symfony's built-in 'app' global (AppVariable)
 *   - Boolean/scalar globals that rarely change (better as Twig constants or parameters)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface TwigGlobal {
  name: string;
  value: string;
  source: 'yaml' | 'php';
  isService: boolean;
  isParameter: boolean;
  isEnvVar: boolean;
}

function loadYamlGlobals(appPath: string): TwigGlobal[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'twig.yaml'),
    path.join(appPath, 'config', 'packages', 'twig.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const twig    = (raw['twig'] ?? raw) as Record<string, unknown>;
    const globals = (twig['globals'] ?? {}) as Record<string, unknown>;

    return Object.entries(globals).map(([name, val]) => {
      const value      = String(val);
      const isService  = value.startsWith('@');
      const isParameter = /^%[^%]+%$/.test(value);
      const isEnvVar   = value.includes('%env(');
      return { name, value, source: 'yaml' as const, isService, isParameter, isEnvVar };
    });
  }
  return [];
}

const SENSITIVE_GLOBAL_PATTERN = /password|secret|token|key|api_key|private|credential|auth|\bpass\b|\bcert\b|\bdsn\b/i;

function maskGlobalValue(name: string, value: string): string {
  if (SENSITIVE_GLOBAL_PATTERN.test(name)) return '***';
  return value.slice(0, 60);
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function loadPhpGlobals(appPath: string): TwigGlobal[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const globals: TwigGlobal[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('getGlobals') && !content.includes('addGlobal')) continue;

    // getGlobals() return array
    const globalsM = /function\s+getGlobals[^{]*\{([\s\S]{0,600})/.exec(content);
    if (globalsM) {
      for (const m of globalsM[1].matchAll(/['"](\w+)['"]\s*=>\s*([^,\n\]]+)/g)) {
        const name  = m[1];
        const value = m[2].trim();
        globals.push({ name, value, source: 'php', isService: false, isParameter: false, isEnvVar: false });
      }
    }

    // addGlobal calls
    for (const m of content.matchAll(/addGlobal\s*\(\s*['"](\w+)['"]/g)) {
      if (!globals.some((g) => g.name === m[1])) {
        globals.push({ name: m[1], value: '(dynamic)', source: 'php', isService: false, isParameter: false, isEnvVar: false });
      }
    }
  }
  return globals;
}

export function listTwigGlobals(appPath: string): McpToolResult {
  try {
    const yamlGlobals = loadYamlGlobals(appPath);
    const phpGlobals  = loadPhpGlobals(appPath);
    const allGlobals  = [...yamlGlobals, ...phpGlobals];

    if (allGlobals.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Twig globals found.\n\nConfigure in twig.yaml:\n  twig:\n    globals:\n      site_name: \'My App\'\n      ga_tracking: \'%env(GA_TRACKING_ID)%\'\n      # Or a service:\n      # app_config: \'@App\\\\Service\\\\AppConfig\'',
        }],
      };
    }

    const issues: string[] = [];
    const yamlNames = new Set(yamlGlobals.map((g) => g.name));

    for (const g of phpGlobals) {
      if (yamlNames.has(g.name)) issues.push(`Duplicate global "${g.name}": defined in both twig.yaml and PHP`);
    }
    for (const g of yamlGlobals) {
      if (g.isService) issues.push(`Global "${g.name}" injects full service "${g.value}" — resolves on every request`);
      if (g.name === 'app') issues.push(`Global "app" conflicts with Symfony's built-in AppVariable`);
    }
    if (allGlobals.length > 10) {
      issues.push(`${allGlobals.length} globals — many globals slow template context; pass data via controllers instead`);
    }

    let text = `Twig Global Variables\n${'='.repeat(55)}\n`;
    text += `\nTotal globals: ${allGlobals.length}  (YAML: ${yamlGlobals.length}  PHP: ${phpGlobals.length})\n`;

    if (yamlGlobals.length > 0) {
      text += `\nYAML globals (twig.yaml):\n`;
      for (const g of yamlGlobals) {
        const type = g.isService ? '  [service]' : g.isEnvVar ? '  [env]' : g.isParameter ? '  [param]' : '';
        text += `  ${g.name.padEnd(25)} = ${maskGlobalValue(g.name, g.value)}${type}\n`;
      }
    }

    if (phpGlobals.length > 0) {
      text += `\nPHP globals (getGlobals/addGlobal):\n`;
      for (const g of phpGlobals) {
        text += `  ${g.name.padEnd(25)} = ${maskGlobalValue(g.name, g.value)}\n`;
      }
    }

    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
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

export function getTwigGlobalStats(appPath: string): McpToolResult {
  try {
    const yamlGlobals = loadYamlGlobals(appPath);
    const phpGlobals  = loadPhpGlobals(appPath);

    let text = `Twig Global Statistics\n${'='.repeat(40)}\n\n`;
    text += `YAML globals:    ${yamlGlobals.length}\n`;
    text += `  Service refs:  ${yamlGlobals.filter((g) => g.isService).length}\n`;
    text += `  Env vars:      ${yamlGlobals.filter((g) => g.isEnvVar).length}\n`;
    text += `  Parameters:    ${yamlGlobals.filter((g) => g.isParameter).length}\n`;
    text += `PHP globals:     ${phpGlobals.length}\n`;
    text += `Total:           ${yamlGlobals.length + phpGlobals.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTwigGlobalTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_twig_globals',
      description: 'Show Twig global variables: twig.yaml globals (service/env/parameter), PHP getGlobals()/addGlobal() sources, duplicate name detection, service injection warning, "app" name conflict, too many globals warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_twig_global_stats',
      description: 'Show Twig global statistics: YAML global count (service/env/param breakdown), PHP global count, total',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
