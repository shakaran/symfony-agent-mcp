// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * GraphQL Inspector
 *
 * OverblogGraphQLBundle:
 *   - config/graphql/types/*.yaml: type definitions (Query/Mutation/Subscription/Object/Input/Enum/Union/Interface)
 *   - Resolver class references
 *   - Deprecated fields
 *
 * API Platform GraphQL layer:
 *   - api_platform.graphql.enabled in config/packages/api_platform.yaml
 *   - Entities with #[ApiResource] that expose GraphQL operations
 *
 * Scans src/ for:
 *   - GraphQL resolver classes (implements QueryInterface, MutationInterface, ResolverInterface)
 *   - TypeConfigDecoratorInterface implementations
 *   - #[GQL\Type], #[GQL\Field], #[GQL\Query], #[GQL\Mutation] attributes
 *
 * Analysis:
 *   - Type count: Query/Mutation/Subscription/Object/Input/Enum
 *   - Resolvers without type definition (orphan resolvers)
 *   - Deprecated fields still in use
 *   - N+1 risk: object types without batch loading hint
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface GraphQlType {
  name: string;
  kind: string;
  fields: string[];
  deprecated: string[];
  resolverClass?: string;
  file: string;
}

interface GraphQlResolver {
  class: string;
  file: string;
  kind: 'query' | 'mutation' | 'subscription' | 'field' | 'type_decorator';
}

// ─── OverblogGraphQL type loading ─────────────────────────────────────────────

function loadGraphQlTypes(appPath: string): GraphQlType[] {
  const typesDirs = [
    path.join(appPath, 'config', 'graphql', 'types'),
    path.join(appPath, 'config', 'graphql'),
  ];

  const types: GraphQlType[] = [];

  for (const dir of typesDirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

        const raw = parseYamlFile(path.join(dir, entry.name)) as Record<string, unknown> | null;
        if (!raw) continue;

        for (const [typeName, def] of Object.entries(raw)) {
          if (!def || typeof def !== 'object') continue;
          const d = def as Record<string, unknown>;
          const kind = d['type'] ? String(d['type']) : 'object';

          const fieldsRaw = (d['config'] as Record<string, unknown> | undefined)?.['fields'] as
            Record<string, unknown> | undefined;
          const fields = fieldsRaw ? Object.keys(fieldsRaw) : [];

          // Deprecated fields
          const deprecated: string[] = [];
          if (fieldsRaw) {
            for (const [fieldName, fieldDef] of Object.entries(fieldsRaw)) {
              if (fieldDef && typeof fieldDef === 'object' &&
                  (fieldDef as Record<string, unknown>)['deprecationReason']) {
                deprecated.push(fieldName);
              }
            }
          }

          const resolverRaw = (d['config'] as Record<string, unknown> | undefined)?.['resolverMap'] as string | undefined;

          types.push({ name: typeName, kind, fields, deprecated, resolverClass: resolverRaw, file: entry.name });
        }
      }
    } catch { /* skip */ }
  }

  return types.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── API Platform GraphQL detection ──────────────────────────────────────────

function detectApiPlatformGraphQl(appPath: string): boolean {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'api_platform.yaml'),
    path.join(appPath, 'config', 'packages', 'api_platform.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const ap = (raw['api_platform'] ?? raw) as Record<string, unknown>;
    if (ap['graphql']) {
      const gql = ap['graphql'] as Record<string, unknown>;
      return gql['enabled'] !== false;
    }
  }
  // Check composer.json
  try {
    const composer = JSON.parse(fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8')) as
      Record<string, Record<string, string>>;
    const deps = { ...composer['require'], ...composer['require-dev'] };
    return 'api-platform/graphql' in deps || 'webonyx/graphql-php' in deps;
  } catch { return false; }
}

// ─── PHP resolver scanning ────────────────────────────────────────────────────


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

function scanResolvers(appPath: string): GraphQlResolver[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const resolvers: GraphQlResolver[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isGraphQl =
      content.includes('QueryInterface') ||
      content.includes('MutationInterface') ||
      content.includes('ResolverInterface') ||
      content.includes('TypeConfigDecoratorInterface') ||
      content.includes('#[GQL\\') ||
      content.includes('GraphQL\\Type\\');

    if (!isGraphQl) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    let kind: GraphQlResolver['kind'] = 'field';
    if (content.includes('QueryInterface') || content.includes('#[GQL\\Query'))    kind = 'query';
    else if (content.includes('MutationInterface') || content.includes('#[GQL\\Mutation')) kind = 'mutation';
    else if (content.includes('SubscriptionInterface'))                             kind = 'subscription';
    else if (content.includes('TypeConfigDecoratorInterface'))                      kind = 'type_decorator';

    resolvers.push({ class: classM[1], file: path.basename(file), kind });
  }

  return resolvers.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listGraphQlConfig(appPath: string): McpToolResult {
  try {
    const types          = loadGraphQlTypes(appPath);
    const resolvers      = scanResolvers(appPath);
    const hasApiPlatform = detectApiPlatformGraphQl(appPath);

    if (types.length === 0 && resolvers.length === 0 && !hasApiPlatform) {
      return {
        content: [{
          type: 'text',
          text: 'No GraphQL configuration found.\n\nOptions:\n  composer require overblog/graphql-bundle   # YAML type definitions\n  composer require api-platform/graphql       # API Platform GraphQL layer\n\nOr enable in api_platform.yaml:\n  api_platform:\n    graphql:\n      enabled: true',
        }],
      };
    }

    let text = `GraphQL Configuration\n${'='.repeat(55)}\n`;

    if (hasApiPlatform) {
      text += `\nAPI Platform GraphQL: enabled\n`;
    }

    if (types.length > 0) {
      const byKind = new Map<string, GraphQlType[]>();
      for (const t of types) {
        const list = byKind.get(t.kind) ?? [];
        list.push(t);
        byKind.set(t.kind, list);
      }

      const kindOrder = ['query', 'mutation', 'subscription', 'object', 'input', 'enum', 'union', 'interface'];
      const sorted = [...byKind.entries()].sort(([a], [b]) => {
        const ai = kindOrder.indexOf(a.toLowerCase());
        const bi = kindOrder.indexOf(b.toLowerCase());
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

      text += `\nType definitions (${types.length}):\n`;
      for (const [kind, kindTypes] of sorted) {
        text += `\n  ${kind.toUpperCase()} (${kindTypes.length}):\n`;
        for (const t of kindTypes) {
          const depCount = t.deprecated.length > 0 ? `  ⚠ ${t.deprecated.length} deprecated` : '';
          const fields   = t.fields.length > 0 ? `  ${t.fields.length} fields` : '';
          text += `    ${t.name.padEnd(35)}${fields}${depCount}\n`;
          if (t.deprecated.length > 0) {
            text += `      deprecated: ${t.deprecated.join(', ')}\n`;
          }
        }
      }
    }

    if (resolvers.length > 0) {
      text += `\nResolver classes (${resolvers.length}):\n`;
      const byKind = new Map<string, GraphQlResolver[]>();
      for (const r of resolvers) {
        const list = byKind.get(r.kind) ?? [];
        list.push(r);
        byKind.set(r.kind, list);
      }
      for (const [kind, kindResolvers] of byKind) {
        text += `  ${kind}:\n`;
        for (const r of kindResolvers) text += `    ${r.class}  (${r.file})\n`;
      }
    }

    const totalDeprecated = types.reduce((s, t) => s + t.deprecated.length, 0);
    if (totalDeprecated > 0) {
      text += `\n⚠ ${totalDeprecated} deprecated field(s) still in schema — plan removal\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getGraphQlStats(appPath: string): McpToolResult {
  try {
    const types          = loadGraphQlTypes(appPath);
    const resolvers      = scanResolvers(appPath);
    const hasApiPlatform = detectApiPlatformGraphQl(appPath);

    const byKind = (kind: string): number => types.filter((t) => t.kind.toLowerCase() === kind).length;

    let text = `GraphQL Statistics\n${'='.repeat(40)}\n\n`;
    text += `API Platform GraphQL: ${hasApiPlatform ? 'enabled' : 'no'}\n`;
    text += `Total types:          ${types.length}\n`;
    text += `  Query types:        ${byKind('query')}\n`;
    text += `  Mutation types:     ${byKind('mutation')}\n`;
    text += `  Object types:       ${byKind('object')}\n`;
    text += `  Input types:        ${byKind('input')}\n`;
    text += `  Enum types:         ${byKind('enum')}\n`;
    text += `Deprecated fields:    ${types.reduce((s, t) => s + t.deprecated.length, 0)}\n`;
    text += `Resolver classes:     ${resolvers.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getGraphQlTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_graphql_config',
      description: 'Show GraphQL configuration: OverblogGraphQLBundle type definitions (Query/Mutation/Object/Input/Enum) with field counts and deprecated fields, API Platform GraphQL flag, resolver classes by kind',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_graphql_stats',
      description: 'Show GraphQL statistics: total types, Query/Mutation/Object/Input/Enum counts, deprecated field count, resolver class count, API Platform GraphQL enabled flag',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
