/**
 * Symfony Serializer Groups Inspector
 *
 * Scans entity, DTO, and model classes for Symfony Serializer attributes:
 *   - #[Groups(['group:read', 'group:write'])]  — which groups expose a property
 *   - #[SerializedName('snake_case')]            — custom serialized key name
 *   - #[Ignore]                                  — excluded from serialization
 *   - #[Context([...])]                          — per-property context
 *   - #[MaxDepth(N)]                             — circular reference depth
 *
 * Provides:
 *   - List of all groups defined in the project
 *   - Per-group property map (which properties appear in each group)
 *   - Per-class serialization profile
 *   - Properties exposed to ALL groups (no #[Groups] = always serialized)
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface SerializerProperty {
  name: string;
  serializedName?: string;
  groups: string[];
  ignored: boolean;
  maxDepth?: number;
  type?: string;
}

interface SerializerClass {
  class: string;
  file: string;
  properties: SerializerProperty[];
  allGroups: string[];
  hasIgnored: boolean;
  ungroupedProperties: string[];
}

// ─── File scanning ─────────────────────────────────────────────────────────

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

function extractClassName(content: string): string {
  const m = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  return m ? m[1] : '';
}

function extractNamespace(content: string): string {
  const m = /^namespace\s+([\w\\]+)\s*;/m.exec(content);
  return m ? m[1] : '';
}

// ─── Attribute parsing ─────────────────────────────────────────────────────

function parseGroups(attrBlock: string): string[] {
  const groups: string[] = [];
  // #[Groups(['group1', 'group2'])] or #[Groups(["group1"])]
  const listMatch = /Groups\s*\(\s*\[([^\]]+)\]/.exec(attrBlock);
  if (listMatch) {
    for (const m of listMatch[1].matchAll(/['"]([^'"]+)['"]/g)) {
      groups.push(m[1]);
    }
  }
  return groups;
}

function parsePropertyBlock(block: string, propName: string, propType: string): SerializerProperty {
  const groups = parseGroups(block);

  const serializedNameMatch = /SerializedName\s*\(\s*['"]([^'"]+)['"]/.exec(block);
  const ignoredMatch = /#\[Ignore\]/.test(block) || /\[Ignore\]/.test(block);
  const maxDepthMatch = /MaxDepth\s*\(\s*(\d+)\s*\)/.exec(block);

  return {
    name: propName,
    serializedName: serializedNameMatch?.[1],
    groups,
    ignored: ignoredMatch,
    maxDepth: maxDepthMatch ? parseInt(maxDepthMatch[1], 10) : undefined,
    type: propType || undefined,
  };
}

function parseSerializerFile(filePath: string): SerializerClass | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  // Quick check: must use at least one serializer attribute
  if (!content.includes('#[Groups') &&
      !content.includes('#[SerializedName') &&
      !content.includes('#[Ignore') &&
      !content.includes('#[MaxDepth')) {
    return null;
  }

  const className = extractClassName(content);
  if (!className) return null;
  const namespace = extractNamespace(content);

  const properties: SerializerProperty[] = [];
  const allGroups = new Set<string>();

  // Match property declarations preceded by attributes
  // Pattern: attribute lines + optional visibility/type + $propName
  const propPattern =
    /((?:#\[(?:Groups|SerializedName|Ignore|MaxDepth|Context)[^\]]*\]\s*)+)(?:(?:private|protected|public|readonly)\s+)+(?:[\w\\?|]+\s+)?\$(\w+)/g;

  let m: RegExpExecArray | null;
  while ((m = propPattern.exec(content)) !== null) {
    const attrBlock = m[1];
    const propName = m[2];

    // Extract type hint from context around the match
    const typeMatch = /(?:private|protected|public|readonly)\s+(?:readonly\s+)?([\w\\?|]+)\s+\$\w+/.exec(
      content.slice(m.index, m.index + m[0].length + 50)
    );
    const propType = typeMatch?.[1] ?? '';

    const prop = parsePropertyBlock(attrBlock, propName, propType);
    properties.push(prop);
    prop.groups.forEach((g) => allGroups.add(g));
  }

  // Also scan constructor promoted properties
  const ctorMatch = /function\s+__construct\s*\(([^)]+)\)/s.exec(content);
  if (ctorMatch) {
    const ctorBody = ctorMatch[1];
    const promotedPattern =
      /((?:#\[(?:Groups|SerializedName|Ignore|MaxDepth)[^\]]*\]\s*)+)(?:private|protected|public|readonly)\s+(?:readonly\s+)?(?:[\w\\?|]+\s+)?\$(\w+)/g;
    while ((m = promotedPattern.exec(ctorBody)) !== null) {
      const attrBlock = m[1];
      const propName = m[2];
      const alreadyAdded = properties.some((p) => p.name === propName);
      if (!alreadyAdded) {
        const prop = parsePropertyBlock(attrBlock, propName, '');
        properties.push(prop);
        prop.groups.forEach((g) => allGroups.add(g));
      }
    }
  }

  if (properties.length === 0) return null;

  const ungrouped = properties
    .filter((p) => !p.ignored && p.groups.length === 0)
    .map((p) => p.name);

  return {
    class: namespace ? `${namespace}\\${className}` : className,
    file: path.basename(filePath),
    properties,
    allGroups: Array.from(allGroups).sort(),
    hasIgnored: properties.some((p) => p.ignored),
    ungroupedProperties: ungrouped,
  };
}

function loadSerializerClasses(appPath: string): SerializerClass[] {
  const scanDirs = [
    path.join(appPath, 'src', 'Entity'),
    path.join(appPath, 'src', 'Dto'),
    path.join(appPath, 'src', 'DTO'),
    path.join(appPath, 'src', 'Model'),
    path.join(appPath, 'src', 'ApiResource'),
    path.join(appPath, 'src'),
  ];

  const seen = new Set<string>();
  const classes: SerializerClass[] = [];

  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const sc = parseSerializerFile(file);
      if (sc) classes.push(sc);
    }
  }

  return classes.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listSerializerGroups(appPath: string): McpToolResult {
  try {
    const classes = loadSerializerClasses(appPath);

    if (classes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No classes with Symfony Serializer groups (#[Groups]) found.\n\nAdd to entities: use Symfony\\Component\\Serializer\\Annotation\\Groups;',
        }],
      };
    }

    // Build group → properties map
    const groupMap = new Map<string, Array<{ class: string; prop: string }>>();
    for (const cls of classes) {
      for (const prop of cls.properties) {
        for (const group of prop.groups) {
          const entries = groupMap.get(group) ?? [];
          entries.push({ class: cls.class.split('\\').pop() ?? cls.class, prop: prop.name });
          groupMap.set(group, entries);
        }
      }
    }

    if (groupMap.size === 0) {
      return { content: [{ type: 'text', text: 'No serialization groups defined.' }] };
    }

    let text = `Serializer Groups (${groupMap.size})\n${'='.repeat(50)}\n`;

    for (const [group, entries] of Array.from(groupMap.entries()).sort(([a], [b]) => a.localeCompare(b))) {
      text += `\n  ${group}  (${entries.length} properties)\n`;
      // Group by class
      const byClass: Record<string, string[]> = {};
      for (const e of entries) {
        (byClass[e.class] ??= []).push(e.prop);
      }
      for (const [cls, props] of Object.entries(byClass).sort()) {
        text += `    ${cls}: ${props.join(', ')}\n`;
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

export function getClassSerializerProfile(appPath: string, className: string): McpToolResult {
  try {
    const classes = loadSerializerClasses(appPath);
    const cls = classes.find(
      (c) =>
        c.class.toLowerCase().includes(className.toLowerCase()) ||
        c.file.toLowerCase().includes(className.toLowerCase())
    );

    if (!cls) {
      const names = classes.map((c) => c.class.split('\\').pop()).join(', ');
      return {
        content: [{ type: 'text', text: `Class "${className}" not found.\n\nAvailable: ${names || 'none'}` }],
        isError: true,
      };
    }

    const shortClass = cls.class.split('\\').pop() ?? cls.class;
    let text = `Serializer Profile: ${shortClass}\n${'='.repeat(50)}\n\n`;
    text += `Class: ${cls.class}\n`;
    text += `File:  ${cls.file}\n`;
    text += `Groups used: ${cls.allGroups.join(', ') || '(none)'}\n`;

    if (cls.ungroupedProperties.length > 0) {
      text += `\n⚠ Properties exposed to ALL groups (no #[Groups]):\n`;
      for (const p of cls.ungroupedProperties) text += `  - ${p}\n`;
    }

    text += `\nProperties (${cls.properties.length}):\n`;
    for (const prop of cls.properties) {
      if (prop.ignored) {
        text += `  ${prop.name.padEnd(30)} [IGNORED]\n`;
        continue;
      }
      const displayName = prop.serializedName ? ` → "${prop.serializedName}"` : '';
      const depth = prop.maxDepth ? ` [maxDepth:${prop.maxDepth}]` : '';
      const groups = prop.groups.length > 0 ? prop.groups.join(', ') : '(all groups)';
      text += `  ${prop.name.padEnd(30)} ${groups}${displayName}${depth}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function searchSerializerGroups(appPath: string, groupName: string): McpToolResult {
  try {
    const classes = loadSerializerClasses(appPath);
    const lq = groupName.toLowerCase();

    const results: Array<{ class: string; file: string; properties: SerializerProperty[] }> = [];

    for (const cls of classes) {
      const matchedProps = cls.properties.filter(
        (p) => p.groups.some((g) => g.toLowerCase().includes(lq))
      );
      if (matchedProps.length > 0) {
        results.push({ class: cls.class, file: cls.file, properties: matchedProps });
      }
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No properties found in group matching "${groupName}".` }] };
    }

    const totalProps = results.reduce((s, r) => s + r.properties.length, 0);
    let text = `Properties in groups matching "${groupName}" (${totalProps} properties across ${results.length} classes):\n\n`;

    for (const r of results) {
      const shortClass = r.class.split('\\').pop() ?? r.class;
      text += `  ${shortClass}  (${r.file})\n`;
      for (const prop of r.properties) {
        const matchedGroups = prop.groups.filter((g) => g.toLowerCase().includes(lq));
        const sn = prop.serializedName ? ` → "${prop.serializedName}"` : '';
        text += `    ${prop.name.padEnd(30)} [${matchedGroups.join(', ')}]${sn}\n`;
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

export function getSerializerStats(appPath: string): McpToolResult {
  try {
    const classes = loadSerializerClasses(appPath);

    if (classes.length === 0) {
      return { content: [{ type: 'text', text: 'No classes with serializer annotations found.' }] };
    }

    const allGroups = new Set<string>();
    let totalProps = 0;
    let ignoredProps = 0;
    let ungroupedProps = 0;
    let renamedProps = 0;

    for (const cls of classes) {
      cls.allGroups.forEach((g) => allGroups.add(g));
      totalProps += cls.properties.length;
      ignoredProps += cls.properties.filter((p) => p.ignored).length;
      ungroupedProps += cls.ungroupedProperties.length;
      renamedProps += cls.properties.filter((p) => p.serializedName).length;
    }

    let text = `Serializer Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with groups:     ${classes.length}\n`;
    text += `Total properties:        ${totalProps}\n`;
    text += `Distinct groups:         ${allGroups.size}\n`;
    text += `Ignored properties:      ${ignoredProps}\n`;
    text += `Ungrouped properties:    ${ungroupedProps}${ungroupedProps > 0 ? '  ⚠ exposed to all groups' : ''}\n`;
    text += `Renamed properties:      ${renamedProps}\n`;

    text += `\nAll groups (${allGroups.size}):\n`;
    for (const g of Array.from(allGroups).sort()) {
      text += `  ${g}\n`;
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

export function getSerializerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_serializer_groups',
      description: 'List all Symfony Serializer groups (#[Groups]) across entities and DTOs, showing which properties belong to each group',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_class_serializer_profile',
      description: 'Show the full serialization profile for a class: all properties, their groups, renamed names (#[SerializedName]), ignored (#[Ignore]), and ungrouped (exposed to all)',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          class_name: { type: 'string', description: 'Class name or partial match (e.g. User, ProductDto)' },
        },
        required: ['app_path', 'class_name'],
      },
    },
    {
      name: 'search_serializer_groups',
      description: 'Find all properties exposed in groups matching a search query (e.g. "read", "admin")',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          group_name: { type: 'string', description: 'Group name or partial match' },
        },
        required: ['app_path', 'group_name'],
      },
    },
    {
      name: 'get_serializer_stats',
      description: 'Show serializer statistics: class count, total properties, distinct groups, ignored/ungrouped/renamed property counts',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
