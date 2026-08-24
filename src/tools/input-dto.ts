// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Input DTO / Request Mapping Inspector (Symfony 6.2+)
 *
 * Scans controllers for PHP 8 attribute-based request mapping:
 *   - #[MapRequestPayload] — maps JSON/form body to a DTO
 *   - #[MapQueryString]    — maps query string to a DTO
 *   - #[MapQueryParameter] — maps a single query param to a typed scalar
 *   - #[MapUploadedFile]   — maps uploaded files
 *
 * Shows which controller actions use each attribute, what type they map to,
 * and whether validation groups are specified.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

type MappingType = 'MapRequestPayload' | 'MapQueryString' | 'MapQueryParameter' | 'MapUploadedFile';

interface MappedAction {
  controller: string;
  action: string;
  file: string;
  mappings: Array<{
    attribute: MappingType;
    paramName: string;
    typeName?: string;
    validationGroups?: string[];
  }>;
}

// ─── File scanning ──────────────────────────────────────────────────────────


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

// ─── Attribute parsing ──────────────────────────────────────────────────────

const MAPPING_ATTRS: MappingType[] = [
  'MapRequestPayload',
  'MapQueryString',
  'MapQueryParameter',
  'MapUploadedFile',
];

function extractValidationGroups(attrOptions: string): string[] {
  const m = /validationGroups\s*:\s*\[([^\]]+)\]/.exec(attrOptions);
  if (!m) return [];
  return m[1].split(',').map((g) => g.trim().replace(/['"]/g, '')).filter(Boolean);
}

function parseController(filePath: string): MappedAction | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasMapping = MAPPING_ATTRS.some((a) => content.includes(`#[${a}`));
  if (!hasMapping) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const mappings: MappedAction['mappings'] = [];

  // For each mapping attribute, find the parameter it decorates
  for (const attr of MAPPING_ATTRS) {
    const re = new RegExp(`#\\[${attr}(?:\\s*\\(([^)]*)\\))?\\]\\s*(?:\\n\\s*)?(?:(\\??(\\w+(?:\\\\\\w+)*)\\s+))?\\$(\\w+)`, 'g');
    for (const m of content.matchAll(re)) {
      const attrOptions = m[1] ?? '';
      const typeName = m[3] ? m[3].split('\\').pop() : undefined;
      const paramName = m[4];
      const groups = extractValidationGroups(attrOptions);

      mappings.push({
        attribute: attr,
        paramName,
        typeName,
        validationGroups: groups.length > 0 ? groups : undefined,
      });
    }
  }

  if (mappings.length === 0) return null;

  // Find a representative action name (the first public function after #[Route])
  const actionM = /public\s+function\s+(\w+)\s*\(/.exec(content);

  return {
    controller: classM[1],
    action: actionM?.[1] ?? '(unknown)',
    file: path.basename(filePath),
    mappings,
  };
}

function loadMappedActions(appPath: string): MappedAction[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const actions: MappedAction[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const a = parseController(file);
    if (a) actions.push(a);
  }
  return actions.sort((a, b) => a.controller.localeCompare(b.controller));
}

// ─── Tool functions ─────────────────────────────────────────────────────────

const ATTR_DESCRIPTIONS: Record<MappingType, string> = {
  MapRequestPayload:  'Maps JSON/form body → DTO',
  MapQueryString:     'Maps full query string → DTO',
  MapQueryParameter:  'Maps single query param → scalar',
  MapUploadedFile:    'Maps uploaded file(s)',
};

export function listInputDtos(appPath: string): McpToolResult {
  try {
    const actions = loadMappedActions(appPath);

    if (actions.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No #[MapRequestPayload] / #[MapQueryString] / #[MapQueryParameter] found.\n\nRequires Symfony 6.2+:\n\n  use Symfony\\Component\\HttpKernel\\Attribute\\MapRequestPayload;\n\n  #[Route(\'/api/orders\', methods: [\'POST\'])]\n  public function create(#[MapRequestPayload] CreateOrderDto $dto): Response { ... }',
        }],
      };
    }

    const attrCount: Partial<Record<MappingType, number>> = {};
    for (const a of actions) {
      for (const m of a.mappings) {
        attrCount[m.attribute] = (attrCount[m.attribute] ?? 0) + 1;
      }
    }

    let text = `Input DTO / Request Mapping  (${actions.length} controllers)\n${'='.repeat(60)}\n`;

    text += `\nAttribute usage:\n`;
    for (const [attr, count] of Object.entries(attrCount) as [MappingType, number][]) {
      text += `  #[${attr}]  ${count}x  — ${ATTR_DESCRIPTIONS[attr]}\n`;
    }

    text += `\nPer controller:\n`;
    for (const a of actions) {
      text += `\n  ${a.controller}  (${a.file})\n`;
      for (const m of a.mappings) {
        const type = m.typeName ? `  → ${m.typeName}` : '';
        const groups = m.validationGroups ? `  groups: [${m.validationGroups.join(', ')}]` : '';
        text += `    #[${m.attribute}] $${m.paramName}${type}${groups}\n`;
      }
    }

    // List all unique DTO types
    const dtoTypes = [...new Set(actions.flatMap((a) => a.mappings.map((m) => m.typeName).filter(Boolean)))];
    if (dtoTypes.length > 0) {
      text += `\nDTO types used (${dtoTypes.length}):\n`;
      for (const t of dtoTypes.sort()) text += `  ${t}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getInputDtoStats(appPath: string): McpToolResult {
  try {
    const actions = loadMappedActions(appPath);

    const attrCount: Partial<Record<MappingType, number>> = {};
    for (const a of actions) {
      for (const m of a.mappings) {
        attrCount[m.attribute] = (attrCount[m.attribute] ?? 0) + 1;
      }
    }

    const withGroups = actions.filter((a) => a.mappings.some((m) => m.validationGroups)).length;
    const dtoTypes = new Set(actions.flatMap((a) => a.mappings.map((m) => m.typeName).filter(Boolean)));

    let text = `Input DTO Statistics\n${'='.repeat(40)}\n\n`;
    text += `Controllers with mapping: ${actions.length}\n`;
    text += `Distinct DTO types:       ${dtoTypes.size}\n`;
    text += `With validation groups:   ${withGroups}\n`;

    for (const [attr, count] of Object.entries(attrCount) as [MappingType, number][]) {
      text += `#[${attr}]:`.padEnd(28) + `${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getInputDtoTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_input_dtos',
      description: 'List controller actions using #[MapRequestPayload], #[MapQueryString], #[MapQueryParameter] (Symfony 6.2+) with DTO types and validation groups',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_input_dto_stats',
      description: 'Show input DTO statistics: controller count, distinct DTO types, attribute usage breakdown, validation group usage',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
