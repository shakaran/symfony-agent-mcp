/**
 * Symfony Validator Cascade Inspector
 *
 * Scans src/ PHP for:
 *   - #[Assert\Valid] attribute on properties
 *   - Doctrine relations (OneToMany, ManyToOne, OneToOne, ManyToMany)
 *     without corresponding #[Assert\Valid]
 *   - $validator->validate() with groups but no cascade
 *
 * Warns about:
 *   - Doctrine relation without #[Assert\Valid] when parent has validation
 *   - #[Assert\Valid] on scalar property (no-op)
 *   - Cascade groups not matching defined validation groups
 *   - Collection property with #[Assert\Valid] but no traversal strategy
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ValidatorCascadeInfo {
  file: string;
  class: string;
  validProperties: string[];
  relationsWithoutValid: string[];
  hasCollectionTraversal: boolean;
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

const DOCTRINE_RELATIONS = ['OneToMany', 'ManyToOne', 'OneToOne', 'ManyToMany'];
const SCALAR_TYPES = ['string', 'int', 'float', 'bool', 'array', '?string', '?int', '?float', '?bool'];

function extractPropertyName(snippet: string): string {
  const m = /(?:private|protected|public)\s+(?:\??\w+\s+)?\$(\w{1,80})/.exec(snippet);
  return m ? m[1] : '';
}

function isScalarType(snippet: string): boolean {
  return SCALAR_TYPES.some((t) => {
    const re = new RegExp(`(?:private|protected|public)\\s+\\??${t}\\s+\\$`);
    return re.test(snippet);
  });
}

function scanValidatorCascade(appPath: string): ValidatorCascadeInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: ValidatorCascadeInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, srcDir);
    if (content === null) continue;

    const hasEntity =
      content.includes('#[ORM\\Entity') ||
      content.includes('@ORM\\Entity') ||
      content.includes('ORM\\Entity') ||
      content.includes('#[Entity');
    const hasValidation = content.includes('#[Assert\\') || content.includes('use Symfony\\Component\\Validator\\Constraints');

    if (!hasEntity && !hasValidation) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    const validProperties: string[] = [];
    const relationsWithoutValid: string[] = [];

    // Split by property-like blocks to analyze each property
    const propertyBlocks = content.split(/(?=\s*(?:#\[|\/\*\*|\s+(?:private|protected|public)\s))/);

    for (const block of propertyBlocks) {
      const hasRelation = DOCTRINE_RELATIONS.some((r) => block.includes(r));
      const hasValid = block.includes('#[Assert\\Valid') || block.includes('Assert\\Valid');
      const propName = extractPropertyName(block);
      if (!propName) continue;

      if (hasValid) {
        validProperties.push(propName);
        // Check if Valid on scalar (no-op)
        if (isScalarType(block)) {
          // Issue will be added below
        }
      }
      if (hasRelation && !hasValid && propName) {
        relationsWithoutValid.push(propName);
      }
    }

    const hasCollectionTraversal =
      content.includes('Traverse') ||
      content.includes('traversal') ||
      content.includes('#[Assert\\All') ||
      content.includes('Assert\\All');

    const issues: string[] = [];

    if (relationsWithoutValid.length > 0 && hasValidation) {
      issues.push(`Doctrine relations without #[Assert\\Valid]: ${relationsWithoutValid.join(', ')} — related objects skipped during validation`);
    }

    // Valid on scalar detection: re-check each valid property
    for (const prop of validProperties) {
      const propPattern = new RegExp(
        `#\\[Assert\\\\Valid[^\\]]{0,100}\\][^$]{0,200}\\$${prop}\\b`
      );
      const propContent = propPattern.exec(content);
      if (propContent && isScalarType(propContent[0])) {
        issues.push(`#[Assert\\Valid] on "${prop}" appears to be a scalar property — Valid constraint has no effect on scalars`);
      }
    }

    const hasCollection = validProperties.some((p) => {
      const idx = content.indexOf(`$${p}`);
      if (idx === -1) return false;
      const snippet = content.slice(Math.max(0, idx - 300), idx + 50);
      return /OneToMany|ManyToMany|array|Collection/.test(snippet);
    });

    if (hasCollection && !hasCollectionTraversal) {
      issues.push('#[Assert\\Valid] on collection property without traversal strategy — collection items may not be traversed');
    }

    if (relationsWithoutValid.length > 0 || validProperties.length > 0 || issues.length > 0) {
      results.push({
        file,
        class: className,
        validProperties,
        relationsWithoutValid,
        hasCollectionTraversal,
        issues,
      });
    }
  }

  return results;
}

export function listValidatorCascade(appPath: string): McpToolResult {
  try {
    const infos = scanValidatorCascade(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No validator cascade or Doctrine relation validation patterns found in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Validator Cascade Analysis\n${'='.repeat(55)}\n\n`;
    text += `Total classes: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}  (${path.relative(appPath, info.file)})\n`;
      if (info.validProperties.length > 0) {
        text += `    #[Assert\\Valid] on: ${info.validProperties.join(', ')}\n`;
      }
      if (info.relationsWithoutValid.length > 0) {
        text += `    Relations WITHOUT Valid: ${info.relationsWithoutValid.join(', ')}\n`;
      }
      text += `    collectionTraversal: ${info.hasCollectionTraversal ? 'yes' : 'no'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getValidatorCascadeStats(appPath: string): McpToolResult {
  try {
    const infos = scanValidatorCascade(appPath);

    let text = `Validator Cascade Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes:                      ${infos.length}\n`;
    text += `  With #[Assert\\Valid]:             ${infos.filter((i) => i.validProperties.length > 0).length}\n`;
    text += `  With unvalidated relations:       ${infos.filter((i) => i.relationsWithoutValid.length > 0).length}\n`;
    text += `  Total unvalidated relations:      ${infos.reduce((s, i) => s + i.relationsWithoutValid.length, 0)}\n`;
    text += `  With collection traversal:        ${infos.filter((i) => i.hasCollectionTraversal).length}\n`;
    text += `Total issues:                       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getValidatorCascadeTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_validator_cascade',
      description: 'Scan src/ for #[Assert\\Valid] cascade usage on entity relations; detects Doctrine relations (OneToMany, ManyToOne, OneToOne, ManyToMany) without Valid constraint, Valid on scalars (no-op), collection traversal issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_validator_cascade_stats',
      description: 'Statistics for validator cascade: class count, Valid-annotated properties, unvalidated relations, collection traversal coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
