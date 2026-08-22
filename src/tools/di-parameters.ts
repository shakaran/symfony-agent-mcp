/**
 * Symfony DI Parameter Inspector
 *
 * Extracts all %parameter% bindings from:
 *   - config/services.yaml — parameters: section
 *   - config/packages/*.yaml — extension-contributed parameters
 *   - .env / .env.local — for cross-referencing %env(VAR)% usage
 *
 * Reports parameter names, values (with secret masking), and
 * which services inject them via $param binding or constructor arg.
 *
 * Pure static analysis — no PHP execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface DiParameter {
  name: string;
  value: string;
  source: string;
  isSensitive: boolean;
  isEnvRef: boolean;
  envVar?: string;
}

const SENSITIVE_PATTERNS = [
  /secret/i, /password/i, /passwd/i, /token/i, /key/i,
  /dsn/i, /api_key/i, /auth/i, /private/i, /salt/i,
  /\bpass\b/i, /cert/i,
];

function isSensitive(name: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(name));
}

function maskValue(value: string, sensitive: boolean): string {
  if (!sensitive) return value;
  if (typeof value === 'string' && value.length > 4) {
    return value.slice(0, 3) + '***';
  }
  return '***';
}

// ─── YAML parameter extraction ─────────────────────────────────────────────

function flattenParameters(
  obj: Record<string, unknown>,
  prefix: string = '',
  source: string = ''
): DiParameter[] {
  const params: DiParameter[] = [];

  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      params.push(...flattenParameters(val as Record<string, unknown>, fullKey, source));
    } else {
      const strVal = Array.isArray(val) ? JSON.stringify(val) : String(val ?? '');
      const isEnvRef = strVal.startsWith('%env(') || strVal.startsWith('env_');
      const envVar = isEnvRef ? /%env\((\w+)\)%/.exec(strVal)?.[1] : undefined;
      const sensitive = isSensitive(fullKey);

      params.push({
        name: fullKey,
        value: maskValue(strVal, sensitive),
        source,
        isSensitive: sensitive,
        isEnvRef,
        envVar,
      });
    }
  }

  return params;
}

function loadDiParameters(appPath: string): DiParameter[] {
  const params: DiParameter[] = [];
  const seen = new Set<string>();

  const addParams = (newParams: DiParameter[]): void => {
    for (const p of newParams) {
      if (!seen.has(p.name)) {
        seen.add(p.name);
        params.push(p);
      }
    }
  };

  // 1. config/services.yaml — parameters: block
  const servicesFile = path.join(appPath, 'config', 'services.yaml');
  const servicesRaw = parseYamlFile(servicesFile) as Record<string, unknown> | null;
  if (servicesRaw?.['parameters'] && typeof servicesRaw['parameters'] === 'object') {
    addParams(flattenParameters(
      servicesRaw['parameters'] as Record<string, unknown>,
      '',
      'config/services.yaml'
    ));
  }

  // 2. config/packages/*.yaml — scan for parameters: blocks
  const packagesDir = path.join(appPath, 'config', 'packages');
  try {
    for (const file of fs.readdirSync(packagesDir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const raw = parseYamlFile(path.join(packagesDir, file)) as Record<string, unknown> | null;
      if (!raw) continue;

      if (raw['parameters'] && typeof raw['parameters'] === 'object') {
        addParams(flattenParameters(
          raw['parameters'] as Record<string, unknown>,
          '',
          `config/packages/${file}`
        ));
      }
    }
  } catch { /* skip */ }

  // 3. config/services_*.yaml (env-specific overrides)
  const configDir = path.join(appPath, 'config');
  try {
    for (const file of fs.readdirSync(configDir)) {
      if (!file.startsWith('services') || (!file.endsWith('.yaml') && !file.endsWith('.yml'))) continue;
      if (file === 'services.yaml') continue;
      const raw = parseYamlFile(path.join(configDir, file)) as Record<string, unknown> | null;
      if (!raw?.['parameters']) continue;
      addParams(flattenParameters(
        raw['parameters'] as Record<string, unknown>,
        '',
        `config/${file}`
      ));
    }
  } catch { /* skip */ }

  return params.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Service injection scan ────────────────────────────────────────────────

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

function scanParameterUsage(appPath: string, paramNames: string[]): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return usage;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('%')) continue;

    const classMatch = /class\s+(\w+)/.exec(content);
    if (!classMatch) continue;
    const className = classMatch[1];

    for (const name of paramNames) {
      if (content.includes(`%${name}%`)) {
        const users = usage.get(name) ?? [];
        users.push(className);
        usage.set(name, users);
      }
    }
  }

  return usage;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listDiParameters(appPath: string): McpToolResult {
  try {
    const params = loadDiParameters(appPath);

    if (params.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No DI parameters found.\n\nAdd to config/services.yaml:\n  parameters:\n    app.my_param: \'value\'\n    app.some_feature_flag: true',
        }],
      };
    }

    const envRefs = params.filter((p) => p.isEnvRef);
    const sensitive = params.filter((p) => p.isSensitive);

    let text = `DI Parameters (${params.length})\n${'='.repeat(50)}\n`;
    text += `  Env references: ${envRefs.length}   Sensitive: ${sensitive.length}\n`;

    const bySource: Record<string, DiParameter[]> = {};
    for (const p of params) {
      (bySource[p.source] ??= []).push(p);
    }

    for (const [source, group] of Object.entries(bySource).sort()) {
      text += `\n  ${source} (${group.length})\n`;
      for (const p of group) {
        const tag = p.isEnvRef ? `[env:${p.envVar ?? '?'}]` :
                    p.isSensitive ? '[sensitive]' : '';
        text += `    %${p.name}%  =  ${p.value}  ${tag}\n`;
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

export function searchDiParameters(appPath: string, query: string): McpToolResult {
  try {
    const params = loadDiParameters(appPath);
    const q = query.toLowerCase();
    const matches = params.filter(
      (p) => p.name.toLowerCase().includes(q) || p.value.toLowerCase().includes(q)
    );

    if (matches.length === 0) {
      return {
        content: [{ type: 'text', text: `No parameters matching "${query}".` }],
      };
    }

    const usage = scanParameterUsage(appPath, matches.map((p) => p.name));

    let text = `Parameters matching "${query}" (${matches.length})\n${'='.repeat(50)}\n\n`;
    for (const p of matches) {
      const tag = p.isEnvRef ? `  [env:${p.envVar ?? '?'}]` : '';
      text += `  %${p.name}%  =  ${p.value}${tag}\n`;
      text += `    source: ${p.source}\n`;
      const users = usage.get(p.name);
      if (users && users.length > 0) {
        text += `    used by: ${users.slice(0, 5).join(', ')}${users.length > 5 ? ` +${users.length - 5} more` : ''}\n`;
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

export function getDiParameterStats(appPath: string): McpToolResult {
  try {
    const params = loadDiParameters(appPath);

    let text = `DI Parameter Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total parameters:    ${params.length}\n`;
    text += `Env references:      ${params.filter((p) => p.isEnvRef).length}\n`;
    text += `Sensitive values:    ${params.filter((p) => p.isSensitive).length}\n`;
    text += `Boolean flags:       ${params.filter((p) => p.value === 'true' || p.value === 'false').length}\n`;

    const sources: Record<string, number> = {};
    for (const p of params) sources[p.source] = (sources[p.source] ?? 0) + 1;

    text += `\nBy source file:\n`;
    for (const [src, count] of Object.entries(sources).sort()) {
      text += `  ${src.padEnd(40)} ${count}\n`;
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

export function getDiParameterTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_di_parameters',
      description: 'List all Symfony DI %parameters% from services.yaml and config packages, grouped by source file (sensitive values masked)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'search_di_parameters',
      description: 'Search DI parameters by name or value, showing which services use each matched parameter',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          query: { type: 'string', description: 'Search term to match against parameter name or value' },
        },
        required: ['app_path', 'query'],
      },
    },
    {
      name: 'get_di_parameter_stats',
      description: 'Show DI parameter statistics: total count, env references, sensitive values, boolean flags, breakdown by source file',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
