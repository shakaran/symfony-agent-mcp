// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * CORS Configuration Inspector (NelmioCorsBundle)
 *
 * Reads config/packages/nelmio_cors.yaml:
 *   - allow_origin, allow_methods, allow_headers per path pattern
 *   - allow_credentials, max_age, expose_headers
 *   - Wildcard origin (*) detection
 *   - Dangerous combos: allow_credentials + wildcard origin
 *
 * Pure static analysis.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface CorsPathConfig {
  pattern: string;
  allowOrigin: string[];
  allowMethods: string[];
  allowHeaders: string[];
  exposeHeaders: string[];
  allowCredentials: boolean;
  maxAge?: number;
  originRegex: boolean;
  risks: string[];
}

interface CorsGlobalConfig {
  paths: CorsPathConfig[];
  defaults?: Partial<CorsPathConfig>;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function toStringArray(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') return val.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function detectRisks(cfg: Omit<CorsPathConfig, 'risks'>): string[] {
  const risks: string[] = [];
  const hasWildcard = cfg.allowOrigin.includes('*');

  if (hasWildcard && cfg.allowCredentials) {
    risks.push('CRITICAL: allow_credentials=true with wildcard origin (*) — browsers will block but config is invalid');
  }
  if (hasWildcard && cfg.pattern !== '^/' && !cfg.pattern.includes('public')) {
    risks.push('Wildcard origin (*) on non-public endpoint');
  }
  if (cfg.allowHeaders.includes('*')) {
    risks.push('Wildcard allow_headers — exposes all request headers');
  }
  if (cfg.allowMethods.includes('*') || cfg.allowMethods.length === 0) {
    risks.push('All HTTP methods allowed');
  }
  if (!cfg.maxAge) {
    risks.push('No max_age — preflight requests not cached by browser');
  }
  return risks;
}

function parseCorsConfig(appPath: string): CorsGlobalConfig | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'nelmio_cors.yaml'),
    path.join(appPath, 'config', 'packages', 'nelmio_cors.yml'),
    path.join(appPath, 'config', 'packages', 'cors.yaml'),
    path.join(appPath, 'config', 'packages', 'cors.yml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const root = (raw['nelmio_cors'] ?? raw) as Record<string, unknown>;
    const pathsRaw = root['paths'] as Record<string, unknown> | undefined;
    const defaultsRaw = root['defaults'] as Record<string, unknown> | undefined;

    if (!pathsRaw) continue;

    const paths: CorsPathConfig[] = [];

    for (const [pattern, def] of Object.entries(pathsRaw)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;

      const base: Omit<CorsPathConfig, 'risks'> = {
        pattern,
        allowOrigin:      toStringArray(d['allow_origin']),
        allowMethods:     toStringArray(d['allow_methods']),
        allowHeaders:     toStringArray(d['allow_headers']),
        exposeHeaders:    toStringArray(d['expose_headers']),
        allowCredentials: Boolean(d['allow_credentials']),
        maxAge:           d['max_age'] ? Number(d['max_age']) : undefined,
        originRegex:      Boolean(d['origin_regex']),
      };

      paths.push({ ...base, risks: detectRisks(base) });
    }

    let defaults: Partial<CorsPathConfig> | undefined;
    if (defaultsRaw) {
      defaults = {
        allowOrigin:      toStringArray(defaultsRaw['allow_origin']),
        allowMethods:     toStringArray(defaultsRaw['allow_methods']),
        allowHeaders:     toStringArray(defaultsRaw['allow_headers']),
        allowCredentials: Boolean(defaultsRaw['allow_credentials']),
        maxAge:           defaultsRaw['max_age'] ? Number(defaultsRaw['max_age']) : undefined,
      };
    }

    return { paths, defaults };
  }

  return null;
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listCorsConfig(appPath: string): McpToolResult {
  try {
    const config = parseCorsConfig(appPath);

    if (!config) {
      return {
        content: [{
          type: 'text',
          text: 'NelmioCorsBundle not configured.\n\nInstall:\n  composer require nelmio/cors-bundle\n\nConfigure config/packages/nelmio_cors.yaml:\n  nelmio_cors:\n    defaults:\n      allow_origin: [\'https://example.com\']\n      allow_methods: [\'GET\', \'POST\']\n    paths:\n      \'^/api/\':\n        allow_origin: [\'*\']',
        }],
      };
    }

    const allRisks = config.paths.flatMap((p) => p.risks);

    let text = `CORS Configuration  (${config.paths.length} path patterns)\n${'='.repeat(60)}\n`;

    if (allRisks.length > 0) {
      text += `\nRisks detected (${allRisks.length}):\n`;
      for (const risk of allRisks) {
        text += `  ⚠ ${risk}\n`;
      }
    } else {
      text += `\n✓ No obvious CORS risks detected.\n`;
    }

    if (config.defaults) {
      const d = config.defaults;
      text += `\nDefaults:\n`;
      if (d.allowOrigin?.length)  text += `  allow_origin:      ${d.allowOrigin.join(', ')}\n`;
      if (d.allowMethods?.length) text += `  allow_methods:     ${d.allowMethods.join(', ')}\n`;
      if (d.allowHeaders?.length) text += `  allow_headers:     ${d.allowHeaders.join(', ')}\n`;
      if (d.allowCredentials)     text += `  allow_credentials: true\n`;
      if (d.maxAge)               text += `  max_age:           ${d.maxAge}s\n`;
    }

    text += `\nPath patterns:\n`;
    for (const p of config.paths) {
      text += `\n  ${p.pattern}\n`;
      if (p.allowOrigin.length)  text += `    allow_origin:      ${p.allowOrigin.join(', ')}\n`;
      if (p.allowMethods.length) text += `    allow_methods:     ${p.allowMethods.join(', ')}\n`;
      if (p.allowHeaders.length) text += `    allow_headers:     ${p.allowHeaders.join(', ')}\n`;
      if (p.exposeHeaders.length)text += `    expose_headers:    ${p.exposeHeaders.join(', ')}\n`;
      if (p.allowCredentials)    text += `    allow_credentials: true\n`;
      if (p.maxAge !== undefined) text += `    max_age:           ${p.maxAge}s\n`;
      if (p.originRegex)         text += `    origin_regex:      true\n`;
      for (const r of p.risks)   text += `    ⚠ ${r}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCorsStats(appPath: string): McpToolResult {
  try {
    const config = parseCorsConfig(appPath);

    let text = `CORS Statistics\n${'='.repeat(40)}\n\n`;

    if (!config) {
      text += 'NelmioCorsBundle: not configured\n';
      return { content: [{ type: 'text', text }] };
    }

    const wildcardPaths  = config.paths.filter((p) => p.allowOrigin.includes('*'));
    const credentialPaths = config.paths.filter((p) => p.allowCredentials);
    const allRisks = config.paths.flatMap((p) => p.risks);

    text += `Path patterns:    ${config.paths.length}\n`;
    text += `Wildcard origins: ${wildcardPaths.length}\n`;
    text += `With credentials: ${credentialPaths.length}\n`;
    text += `Risk flags:       ${allRisks.length}\n`;

    const methods = new Set(config.paths.flatMap((p) => p.allowMethods));
    if (methods.size > 0) text += `Methods allowed:  ${[...methods].join(', ')}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getCorsTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_cors_config',
      description: 'Show NelmioCorsBundle CORS configuration: allow_origin/methods/headers per path pattern, credentials, max_age, and dangerous config combinations',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_cors_stats',
      description: 'Show CORS statistics: pattern count, wildcard origin count, credential paths, risk flag count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
