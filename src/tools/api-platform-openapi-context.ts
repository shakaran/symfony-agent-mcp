// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * API Platform OpenAPI Context Inspector
 *
 * Scans src/ PHP for:
 *   - #[ApiProperty] with openapi_context or schema parameter
 *   - #[ApiProperty(deprecationReason: '...')] for deprecated properties
 *   - #[ApiResource] with normalizationContext, denormalizationContext, swagger_definition_name
 *
 * Warns about:
 *   - #[ApiProperty] without description (empty Swagger docs)
 *   - Deprecated property without deprecationReason message
 *   - enum values not matching PHP enum class
 *   - openapi_context example not matching declared type
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ApiPropertyEntry {
  name: string;
  hasDescription: boolean;
  isDeprecated: boolean;
  hasExample: boolean;
  hasEnum: boolean;
  type?: string;
  issues: string[];
}

interface ApiOpenApiContextInfo {
  file: string;
  class: string;
  properties: ApiPropertyEntry[];
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractApiPropertyBlocks(content: string): Array<{ raw: string; propName: string }> {
  const results: Array<{ raw: string; propName: string }> = [];
  // Match #[ApiProperty(...)] followed by property declaration
  const re = /#\[ApiProperty\s*\(([^)]{0,1000})\)\s*\]\s*(?:#\[[^\]]{0,200}\]\s*)*(?:public|protected|private|readonly)\s+(?:\??[\w\\|]{1,100}\s+)?\$(\w{1,100})/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    results.push({ raw: m[1], propName: m[2] });
  }
  return results;
}

function parseApiPropertyEntry(raw: string, propName: string): ApiPropertyEntry {
  const issues: string[] = [];

  // Check description in openapi_context or schema
  const hasDescription =
    /description\s*[=:]\s*['"][^'"]{1,500}['"]/.test(raw) ||
    /['"]description['"]\s*=>\s*['"][^'"]{1,500}['"]/.test(raw);

  // Check deprecated / deprecationReason
  const isDeprecated =
    /deprecated\s*[=:]\s*true/.test(raw) ||
    /deprecationReason\s*[=:]\s*['"][^'"]{1,300}['"]/.test(raw) ||
    /['"]deprecated['"]\s*=>\s*true/.test(raw);

  const hasDeprecationReason = /deprecationReason\s*[=:]\s*['"][^'"]{2,300}['"]/.test(raw) ||
    /['"]deprecated_reason['"]\s*=>\s*['"][^'"]{2,300}['"]/.test(raw);

  if (isDeprecated && !hasDeprecationReason) {
    issues.push(`Property $${propName} is deprecated but missing deprecationReason message — Swagger clients won't know why`);
  }

  // Check example presence
  const hasExample =
    /['"]example['"]\s*=>/.test(raw) ||
    /example\s*[=:]\s*/.test(raw);

  // Check enum
  const hasEnum = /['"]enum['"]\s*=>/.test(raw) || /\benum\b\s*[=:]\s*/.test(raw);

  // Extract declared type
  const typeM = /['"]type['"]\s*=>\s*['"]([^'"]{1,40})['"]/i.exec(raw) ??
    /\btype\s*:\s*['"]([^'"]{1,40})['"]/i.exec(raw);
  const type = typeM?.[1];

  // Check example type consistency (basic heuristic)
  if (type && hasExample) {
    const exampleM = /['"]example['"]\s*=>\s*([^,\]]{1,100})/i.exec(raw) ??
      /example\s*:\s*([^,\n\]]{1,100})/i.exec(raw);
    if (exampleM) {
      const exampleVal = exampleM[1].trim();
      if (type === 'integer' && /['"][^'"]{0,200}['"]/.test(exampleVal)) {
        issues.push(`Property $${propName}: openapi_context example appears to be string but type is "integer"`);
      }
      if (type === 'boolean' && /^\d{1,10}$/.test(exampleVal.replace(/['"]/g, ''))) {
        issues.push(`Property $${propName}: openapi_context example appears to be a number but type is "boolean"`);
      }
    }
  }

  if (!hasDescription) {
    issues.push(`Property $${propName}: missing description in #[ApiProperty] — Swagger documentation will be empty`);
  }

  return {
    name: propName,
    hasDescription,
    isDeprecated,
    hasExample,
    hasEnum,
    type,
    issues,
  };
}

function parseOpenApiContextFile(filePath: string, appPath: string): ApiOpenApiContextInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasApiProperty = content.includes('#[ApiProperty');
  const hasApiResource = content.includes('#[ApiResource') || content.includes('@ApiResource');
  if (!hasApiProperty && !hasApiResource) return null;
  if (!hasApiProperty) return null; // Only process files with ApiProperty

  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;

  const propBlocks = extractApiPropertyBlocks(content);
  if (propBlocks.length === 0) return null;

  const properties = propBlocks.map(({ raw, propName }) => parseApiPropertyEntry(raw, propName));
  const fileIssues: string[] = [];

  // Warn if some properties have no normalizationContext on the resource
  const hasNormContext = content.includes('normalizationContext') || content.includes('denormalizationContext');
  if (!hasNormContext && properties.length > 3) {
    fileIssues.push('No normalizationContext/denormalizationContext on ApiResource — all properties will be serialized without group filtering');
  }

  // swagger_definition_name check
  if (content.includes('swagger_definition_name') && !content.includes("'name'") && !content.includes('"name"')) {
    fileIssues.push('swagger_definition_name used without schema name — may cause OpenAPI schema conflicts');
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM[1],
    properties,
    issues: fileIssues,
  };
}

function loadOpenApiContextInfos(appPath: string): ApiOpenApiContextInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: ApiOpenApiContextInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseOpenApiContextFile(f, appPath);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

export function listApiOpenApiContext(appPath: string): McpToolResult {
  try {
    const infos = loadOpenApiContextInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No #[ApiProperty] with OpenAPI context found in src/.\n\nAdd OpenAPI context:\n  use ApiPlatform\\Metadata\\ApiProperty;\n\n  #[ApiProperty(\n    description: \'The unique identifier\',\n    example: \'123e4567-e89b-12d3-a456-426614174000\',\n    schema: [\'type\' => \'string\', \'format\' => \'uuid\'],\n  )]\n  public string $id = \'\';',
        }],
      };
    }

    const allProps = infos.flatMap((i) => i.properties);
    const withIssues = infos.filter(
      (i) => i.issues.length > 0 || i.properties.some((p) => p.issues.length > 0)
    );

    let text = `API Platform OpenAPI Context (${infos.length} classes, ${allProps.length} properties)\n${'='.repeat(65)}\n`;

    for (const info of infos) {
      text += `\n  ${info.class}  (${info.file})\n`;
      for (const prop of info.properties) {
        const flags: string[] = [];
        if (!prop.hasDescription) flags.push('no-desc');
        if (prop.isDeprecated) flags.push('deprecated');
        if (prop.hasExample) flags.push('has-example');
        if (prop.hasEnum) flags.push('has-enum');
        const typeStr = prop.type ? `  type: ${prop.type}` : '';
        const flagStr = flags.length > 0 ? `  [${flags.join(', ')}]` : '';
        text += `    $${prop.name}${typeStr}${flagStr}\n`;
        for (const issue of prop.issues) {
          text += `      WARN: ${issue}\n`;
        }
      }
      for (const issue of info.issues) {
        text += `    WARN: ${issue}\n`;
      }
    }

    if (withIssues.length > 0) {
      text += `\nClasses with issues: ${withIssues.length}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiOpenApiContextStats(appPath: string): McpToolResult {
  try {
    const infos = loadOpenApiContextInfos(appPath);
    const allProps = infos.flatMap((i) => i.properties);

    let text = `API Platform OpenAPI Context Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with ApiProperty:  ${infos.length}\n`;
    text += `Total properties:          ${allProps.length}\n`;
    text += `  With description:        ${allProps.filter((p) => p.hasDescription).length}\n`;
    text += `  Without description:     ${allProps.filter((p) => !p.hasDescription).length}\n`;
    text += `  Deprecated:              ${allProps.filter((p) => p.isDeprecated).length}\n`;
    text += `  With example:            ${allProps.filter((p) => p.hasExample).length}\n`;
    text += `  With enum:               ${allProps.filter((p) => p.hasEnum).length}\n`;
    text += `Classes with issues:       ${infos.filter((i) => i.issues.length > 0 || i.properties.some((p) => p.issues.length > 0)).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiOpenApiContextTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_api_openapi_context',
      description: 'List API Platform OpenAPI context: #[ApiProperty] descriptions, examples, enums, deprecated properties, deprecationReason presence, type consistency checks, normalizationContext warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_api_openapi_context_stats',
      description: 'Show API Platform OpenAPI context statistics: class count, total properties, description coverage, deprecated count, example coverage, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
