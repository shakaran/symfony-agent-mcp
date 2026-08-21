/**
 * Symfony ObjectMapper Inspector (Symfony 7.1+)
 *
 * Distinct from serializer.ts (Serializer component) and symfony-serializer-groups.ts.
 * Focuses on the ObjectMapper component (Symfony 7.1+):
 *
 * PHP attributes:
 *   use Symfony\Component\ObjectMapper\Attribute\Map;
 *   use Symfony\Component\ObjectMapper\Attribute\MapFrom;
 *   use Symfony\Component\ObjectMapper\Attribute\MapTo;
 *
 * Usage on properties:
 *   #[Map(target: ProductDto::class)]
 *   class Product { }
 *
 *   class UserDto {
 *     #[MapFrom(source: User::class, property: 'firstName')]
 *     public string $first;
 *
 *     #[MapTo(target: CreateUserInput::class, property: 'email')]
 *     public string $emailAddress;
 *   }
 *
 * Class-level:
 *   #[Map(target: ProductDto::class, if: 'this.isActive()')]
 *   class Product { ... }
 *
 * Service usage:
 *   $dto = $this->objectMapper->map($entity, ProductDto::class);
 *
 * Analysis:
 *   - #[Map] without target class
 *   - #[MapFrom] with non-existent source property name (if detectable)
 *   - Classes using $objectMapper->map() without #[Map] on source class
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

interface ObjectMapperClass {
  class: string;
  file: string;
  mapTargets: string[];
  mapFromCount: number;
  mapToCount: number;
  hasIf: boolean;
  issues: string[];
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

function parseObjectMapper(filePath: string, appPath: string): ObjectMapperClass | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasMapper = content.includes('#[Map') || content.includes('#[MapFrom') || content.includes('#[MapTo');
  if (!hasMapper) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const mapTargets: string[] = [];
  for (const m of content.matchAll(/#\[Map\s*\([^)]{0,300}\)/g)) {
    const block = m[0];
    const targetM = /target\s*:\s*([A-Za-z0-9_\\]+)::class/.exec(block);
    if (targetM) mapTargets.push(targetM[1]);
    else if (!block.includes('target')) {
      // MapFrom or MapTo without target — flagged below
    }
  }

  const mapFromCount = [...content.matchAll(/#\[MapFrom/g)].length;
  const mapToCount   = [...content.matchAll(/#\[MapTo/g)].length;
  const hasIf        = /#\[Map[^[]*if\s*:/.test(content);

  const issues: string[] = [];

  // #[Map] without target
  for (const m of content.matchAll(/#\[Map\s*\([^)]{0,300}\)/g)) {
    const block = m[0];
    if (!block.includes('target') && !block.startsWith('#[MapFrom') && !block.startsWith('#[MapTo')) {
      issues.push('#[Map] without target: parameter — mapping target is ambiguous');
    }
  }

  if (mapTargets.length === 0 && mapFromCount === 0 && mapToCount === 0) return null;

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    mapTargets,
    mapFromCount,
    mapToCount,
    hasIf,
    issues,
  };
}

function scanObjectMapperServiceUsage(appPath: string): number {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    count += [...content.matchAll(/->map\s*\([^,]+,\s*[A-Za-z0-9_\\]+::class/g)].length;
  }
  return count;
}

export function listObjectMapperConfig(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const classes: ObjectMapperClass[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const c = parseObjectMapper(file, appPath);
      if (c) classes.push(c);
    }

    const serviceUsages = scanObjectMapperServiceUsage(appPath);

    if (classes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony ObjectMapper attributes found.\n\nRequires Symfony 7.1+ and symfony/object-mapper package.\n\nExample:\n  use Symfony\\Component\\ObjectMapper\\Attribute\\Map;\n\n  #[Map(target: ProductDto::class)]\n  class Product {\n    #[Map(target: "name")]\n    public string $title;\n  }',
        }],
      };
    }

    const totalIssues = classes.reduce((s, c) => s + c.issues.length, 0);
    const totalTargets = classes.reduce((s, c) => s + c.mapTargets.length, 0);

    let text = `Symfony ObjectMapper (7.1+)\n${'='.repeat(55)}\n`;
    text += `\nClasses with #[Map*]: ${classes.length}  Total targets: ${totalTargets}  Service usages: ${serviceUsages}  Issues: ${totalIssues}\n`;

    for (const c of classes.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
      const targets   = c.mapTargets.length > 0 ? `→ ${c.mapTargets.join(', ')}` : '';
      const fromTo    = `MapFrom:${c.mapFromCount}  MapTo:${c.mapToCount}`;
      const ifStr     = c.hasIf ? '  [conditional]' : '';
      text += `\n  ${c.class}  ${targets}  ${fromTo}${ifStr}  (${c.file})\n`;
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getObjectMapperStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const classes: ObjectMapperClass[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const c = parseObjectMapper(file, appPath);
        if (c) classes.push(c);
      }
    }

    let text = `ObjectMapper Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with #[Map*]:    ${classes.length}\n`;
    text += `  #[Map] targets:        ${classes.reduce((s, c) => s + c.mapTargets.length, 0)}\n`;
    text += `  #[MapFrom] usages:     ${classes.reduce((s, c) => s + c.mapFromCount, 0)}\n`;
    text += `  #[MapTo] usages:       ${classes.reduce((s, c) => s + c.mapToCount, 0)}\n`;
    text += `  With if: condition:    ${classes.filter((c) => c.hasIf).length}\n`;
    text += `Service map() calls:     ${scanObjectMapperServiceUsage(appPath)}\n`;
    text += `Issues:                  ${classes.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getObjectMapperTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_object_mapper_config',
      description: 'Show Symfony 7.1+ ObjectMapper usage: #[Map]/#[MapFrom]/#[MapTo] attributes, target class per attribute, conditional mapping (if:), objectMapper->map() service calls, #[Map] without target warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_object_mapper_stats',
      description: 'Show ObjectMapper statistics: class count, #[Map] target count, #[MapFrom]/#[MapTo] usage count, conditional count, service call count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
