// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Environment Variable Processors Inspector
 *
 * Distinct from env-config-diff.ts (env var differences across environments)
 * and env-diff.ts (env file comparison).
 * Focuses on the env var processor system:
 *
 * Built-in processors (found in YAML config files):
 *   - %env(json:MY_VAR)%        — parse JSON string
 *   - %env(base64:MY_VAR)%      — base64 decode
 *   - %env(csv:MY_VAR)%         — split CSV string into array
 *   - %env(resolve:MY_VAR)%     — resolve nested %env()% in value
 *   - %env(trim:MY_VAR)%        — trim whitespace
 *   - %env(require:MY_FILE)%    — require PHP file returning value
 *   - %env(key:some_key:MY_VAR)% — extract key from JSON-decoded value
 *   - %env(default:fallback:MY_VAR)% — default value if var is empty
 *   - %env(not:MY_VAR)%         — negate boolean
 *   - %env(int:MY_VAR)%         — cast to int
 *   - %env(float:MY_VAR)%       — cast to float
 *   - %env(bool:MY_VAR)%        — cast to bool
 *   - %env(string:MY_VAR)%      — explicit string cast
 *   - %env(upper:MY_VAR)%       — uppercase (Symfony 6.4+)
 *   - %env(lower:MY_VAR)%       — lowercase (Symfony 6.4+)
 *
 * Custom processors (EnvVarProcessorInterface):
 *   - getProvidedTypes(): array<string, string>
 *   - getEnv(string $prefix, string $name, Closure $getEnv): mixed
 *
 * Usage scan across all YAML config files.
 *
 * Analysis:
 *   - %env(require:...)% (executes PHP files — potential code execution if file is writable)
 *   - %env(resolve:...)% with user-controlled content (SSRF/injection if env contains URLs)
 *   - Chained processors: %env(json:base64:MY_VAR)% — hard to debug
 *   - Custom processor registered but never used
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface EnvProcessorUsage {
  processor: string;
  varName: string;
  location: string;
  isChained: boolean;
  isBuiltIn: boolean;
}

interface CustomProcessor {
  class: string;
  file: string;
  types: string[];
}

const BUILTIN_PROCESSORS = new Set([
  'json', 'base64', 'csv', 'resolve', 'trim', 'require', 'key', 'default',
  'not', 'int', 'float', 'bool', 'string', 'upper', 'lower', 'url', 'query_string',
  'shuffle', 'file', 'const',
]);

const HIGH_RISK_PROCESSORS = new Set(['require', 'resolve']);

function getAllYamlFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
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

function scanProcessorUsages(appPath: string): EnvProcessorUsage[] {
  const configDir = path.join(appPath, 'config');
  const usages: EnvProcessorUsage[] = [];

  for (const yamlFile of getAllYamlFiles(configDir)) {
    let content = '';
    try { content = fs.readFileSync(yamlFile, 'utf-8'); } catch { continue; }
    if (!content.includes('%env(')) continue;

    const relPath = path.relative(appPath, yamlFile);
    for (const m of content.matchAll(/%env\(([^)]+)\)%/g)) {
      const inner    = m[1];
      const parts    = inner.split(':');
      const processor = parts[0] ?? 'string';
      const varName   = parts[parts.length - 1] ?? inner;
      const isChained = parts.length > 2;
      const isBuiltIn = BUILTIN_PROCESSORS.has(processor);

      usages.push({ processor, varName, location: relPath, isChained, isBuiltIn });
    }
  }
  return usages;
}

function scanCustomProcessors(appPath: string): CustomProcessor[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const processors: CustomProcessor[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('EnvVarProcessorInterface')) return processors;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const types: string[] = [];
    const typesM = /getProvidedTypes[^{]*\{([\s\S]{0,400})/.exec(content);
    if (typesM) {
      for (const m of typesM[1].matchAll(/['"]([a-z_]+)['"]\s*=>/g)) types.push(m[1]);
    }

    processors.push({ class: classM[1], file: path.relative(appPath, file), types });
  }
  return processors;
}

export function listEnvProcessors(appPath: string): McpToolResult {
  try {
    const usages     = scanProcessorUsages(appPath);
    const custom     = scanCustomProcessors(appPath);

    if (usages.length === 0 && custom.length === 0) {
      return { content: [{ type: 'text', text: 'No env var processors found in config/ YAML files.' }] };
    }

    const freq = new Map<string, number>();
    for (const u of usages) freq.set(u.processor, (freq.get(u.processor) ?? 0) + 1);

    const highRiskUsages = usages.filter((u) => HIGH_RISK_PROCESSORS.has(u.processor));
    const chainedUsages  = usages.filter((u) => u.isChained);
    const unusedCustom   = custom.filter((c) => c.types.some((t) => !usages.some((u) => u.processor === t)));

    let text = `Env Variable Processors\n${'='.repeat(55)}\n`;
    text += `\nTotal usages:      ${usages.length}  Chained: ${chainedUsages.length}\n`;
    text += `Custom processors: ${custom.length}\n`;

    text += `\nProcessor frequency:\n`;
    for (const [proc, count] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
      const risk = HIGH_RISK_PROCESSORS.has(proc) ? '  ⚠ high-risk' : '';
      const bi   = BUILTIN_PROCESSORS.has(proc) ? '' : '  [custom]';
      text += `  ${proc.padEnd(20)} ${count}x${bi}${risk}\n`;
    }

    if (chainedUsages.length > 0) {
      text += `\nChained processors (${chainedUsages.length}):\n`;
      for (const u of chainedUsages.slice(0, 8)) {
        text += `  ${u.processor}:...${u.varName}  (${u.location})\n`;
      }
    }

    const issues: string[] = [];
    if (highRiskUsages.length > 0) {
      issues.push(`${highRiskUsages.length} use(s) of require/resolve processor — review if env values could be attacker-controlled`);
    }
    if (unusedCustom.length > 0) {
      issues.push(`Custom processor(s) types not found in config: ${unusedCustom.map((c) => c.types.join(',')).join(', ')}`);
    }

    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
      for (const issue of issues) text += `  ⚠ ${issue}\n`;
    }

    if (custom.length > 0) {
      text += `\nCustom processors:\n`;
      for (const c of custom) {
        text += `  ${c.class}  types: ${c.types.join(', ') || 'none detected'}  (${c.file})\n`;
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

export function getEnvProcessorStats(appPath: string): McpToolResult {
  try {
    const usages = scanProcessorUsages(appPath);
    const custom = scanCustomProcessors(appPath);
    const freq   = new Map<string, number>();
    for (const u of usages) freq.set(u.processor, (freq.get(u.processor) ?? 0) + 1);

    let text = `Env Processor Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total usages:      ${usages.length}\n`;
    text += `Unique processors: ${freq.size}\n`;
    text += `  Built-in:        ${[...freq.keys()].filter((p) => BUILTIN_PROCESSORS.has(p)).length}\n`;
    text += `  Custom:          ${[...freq.keys()].filter((p) => !BUILTIN_PROCESSORS.has(p)).length}\n`;
    text += `Chained:           ${usages.filter((u) => u.isChained).length}\n`;
    text += `High-risk (require/resolve): ${usages.filter((u) => HIGH_RISK_PROCESSORS.has(u.processor)).length}\n`;
    text += `Custom processors: ${custom.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getEnvProcessorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_env_processors',
      description: 'Show env var processor usage across YAML config files: json/base64/csv/resolve/require/key/default/bool/int/trim/upper/lower, frequency, chained processors, custom EnvVarProcessorInterface implementations, require/resolve high-risk warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_env_processor_stats',
      description: 'Show env processor statistics: total usage count, unique processors, built-in vs custom, chained count, high-risk count, custom processor count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
