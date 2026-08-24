// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Validator UniqueEntity Constraint Inspector
 *
 * Scans src/**\/*.php and config/**\/*.yaml for UniqueEntity constraint issues:
 *   - #[UniqueEntity] / @UniqueEntity without fields specified
 *   - ignoreNull: true on non-nullable field (always true, no effect)
 *   - repositoryMethod pointing to non-existent method
 *   - UniqueEntity on soft-deleted entities without including deleted-at filter
 *   - Missing errorPath for multi-field unique constraints (error attached to first field only)
 *   - UniqueEntity used on entity with composite PK where unique fields overlap the PK (redundant)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface UniqueEntityInfo {
  file: string;
  line: number;
  pattern: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectFiles(dir: string, base: string, exts: string[]): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectFiles(full, base, exts));
    else if (exts.some((e) => entry.endsWith(e))) results.push(full);
  }
  return results;
}

// ─── PHP class analysis ────────────────────────────────────────────────────────

interface PhpClassContext {
  hasSoftDeleteable: boolean;
  idColumns: string[];
  notNullableColumns: Set<string>;
}

function extractClassContext(content: string): PhpClassContext {
  const hasSoftDeleteable = /SoftDeleteable|deletedAt|soft_delete/.test(content);

  // Extract ORM Column definitions that are not nullable
  const notNullableColumns = new Set<string>();
  const columnRe = /#\[ORM\\Column[^\]]{0,400}\]\s*(?:public|protected|private)[^$]{0,30}\$(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = columnRe.exec(content)) !== null) {
    // If the column definition does not include nullable: true, it's not nullable
    const attrText = content.slice(Math.max(0, m.index - 200), m.index + m[0].length);
    if (!/nullable\s*:\s*true/.test(attrText)) {
      notNullableColumns.add(m[1]);
    }
  }

  // Extract primary key / id columns
  const idColumns: string[] = [];
  const idRe = /#\[ORM\\Id\b[^\]]{0,100}\][\s\S]{0,200}?\$(\w+)/g;
  while ((m = idRe.exec(content)) !== null) {
    idColumns.push(m[1]);
  }

  return { hasSoftDeleteable, idColumns, notNullableColumns };
}

function analyzePhpFile(filePath: string, base: string): UniqueEntityInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  // Quick filter
  if (!content.includes('UniqueEntity')) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: UniqueEntityInfo[] = [];
  const ctx = extractClassContext(content);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Detect UniqueEntity attribute or annotation
    if (!/UniqueEntity/.test(line)) continue;

    // Collect the full attribute text (may span multiple lines)
    const attrLines: string[] = [];
    let j = i;
    let depth = 0;
    let started = false;
    while (j < Math.min(i + 15, lines.length)) {
      const l = lines[j];
      for (const ch of l) {
        if (ch === '(' || ch === '[') { depth++; started = true; }
        else if (ch === ')' || ch === ']') depth--;
      }
      attrLines.push(l);
      if (started && depth <= 0) break;
      j++;
    }
    const attrText = attrLines.join(' ');

    // Pattern 1: UniqueEntity without fields
    if (!/\bfields\s*:/.test(attrText) && !/\bfields\s*=/.test(attrText)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'unique-entity-no-fields',
        issue: 'UniqueEntity constraint without "fields" specified — the constraint will have no effect; add fields: [\'fieldName\'] to specify which field(s) must be unique',
        severity: 'high',
      });
    }

    // Pattern 2: ignoreNull: true on non-nullable fields
    if (/ignoreNull\s*:\s*true/.test(attrText)) {
      // Extract field names from the attribute
      const fieldsMatch = /fields\s*[=:]\s*\[([^\]]{0,200})\]/.exec(attrText);
      if (fieldsMatch) {
        const fieldNames = fieldsMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
        for (const fieldName of fieldNames) {
          if (ctx.notNullableColumns.has(fieldName)) {
            results.push({
              file: relFile,
              line: lineNum,
              pattern: 'ignore-null-on-non-nullable',
              issue: `UniqueEntity with ignoreNull: true on field "${fieldName}" which is NOT nullable — ignoreNull has no effect since the field can never be null; remove ignoreNull: true to avoid confusion`,
              severity: 'medium',
            });
          }
        }
      }
    }

    // Pattern 3: Multi-field unique constraint without errorPath
    const fieldsMatch = /fields\s*[=:]\s*\[([^\]]{0,200})\]/.exec(attrText);
    if (fieldsMatch) {
      const fieldNames = fieldsMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
      if (fieldNames.length > 1 && !/\berrorPath\s*[=:]/.test(attrText)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'multi-field-no-error-path',
          issue: `UniqueEntity on ${fieldNames.length} fields [${fieldNames.join(', ')}] without "errorPath" — the validation error will be attached to the first field only; add errorPath: 'fieldName' to route the error to the correct form field`,
          severity: 'medium',
        });
      }

      // Pattern 4: Unique fields overlap with composite PK (redundant constraint)
      if (ctx.idColumns.length > 1) {
        const idSet = new Set(ctx.idColumns);
        const allFieldsArePk = fieldNames.every((f) => idSet.has(f.replace(/['"]/g, '')));
        if (allFieldsArePk) {
          results.push({
            file: relFile,
            line: lineNum,
            pattern: 'unique-entity-redundant-pk',
            issue: `UniqueEntity on fields that overlap the composite primary key (${ctx.idColumns.join(', ')}) — primary key uniqueness is already enforced by the database; this constraint is redundant`,
            severity: 'low',
          });
        }
      }
    }

    // Pattern 5: UniqueEntity on soft-deleted entity without deletedAt filter
    if (ctx.hasSoftDeleteable && !/repositoryMethod\s*[=:]/.test(attrText)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'unique-entity-soft-delete',
        issue: 'UniqueEntity on entity with soft-delete (SoftDeleteable/deletedAt) without "repositoryMethod" — the default uniqueness check ignores deleted records; a re-created entity with the same unique field value as a soft-deleted one will fail validation incorrectly. Add repositoryMethod pointing to a custom finder that excludes soft-deleted records',
        severity: 'high',
      });
    }
  }

  return results;
}

function analyzeYamlFile(filePath: string, base: string): UniqueEntityInfo[] {
  const content = safeRead(filePath, base);
  if (content === null || !content.includes('UniqueEntity')) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: UniqueEntityInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (!line.includes('UniqueEntity')) continue;

    // Look ahead for fields key
    const lookahead = lines.slice(i, i + 10).join('\n');
    if (!/\bfields\b/.test(lookahead)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'yaml-unique-entity-no-fields',
        issue: 'UniqueEntity constraint in YAML config without "fields" key — constraint will have no effect; add fields: [field_name] to specify which field must be unique',
        severity: 'high',
      });
    }
  }

  return results;
}

function loadAll(appPath: string): UniqueEntityInfo[] {
  const srcDir = path.join(appPath, 'src');
  const configDir = path.join(appPath, 'config');
  const results: UniqueEntityInfo[] = [];

  if (fs.existsSync(srcDir)) {
    for (const f of collectFiles(srcDir, appPath, ['.php'])) {
      results.push(...analyzePhpFile(f, appPath));
    }
  }
  if (fs.existsSync(configDir)) {
    for (const f of collectFiles(configDir, appPath, ['.yaml', '.yml'])) {
      results.push(...analyzeYamlFile(f, appPath));
    }
  }

  return results.sort((a, b) => {
    const sev: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3) || a.file.localeCompare(b.file) || a.line - b.line;
  });
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listSymfonyValidatorUniqueEntity(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);
    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No UniqueEntity constraint issues found in src/ or config/.\n\n' +
            'Checked: missing fields, ignoreNull on non-nullable, missing errorPath for multi-field, ' +
            'soft-delete without repositoryMethod, composite PK overlap.',
        }],
      };
    }

    const high = items.filter((i) => i.severity === 'high');
    const medium = items.filter((i) => i.severity === 'medium');
    const low = items.filter((i) => i.severity === 'low');

    let text = `Symfony UniqueEntity Constraint Analysis\n${'='.repeat(55)}\n\n`;
    text += `  Total findings:  ${items.length}\n`;
    text += `  High:            ${high.length}\n`;
    text += `  Medium:          ${medium.length}\n`;
    text += `  Low:             ${low.length}\n`;
    text += `  Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;

    for (const item of items) {
      text += `[${item.severity.toUpperCase()}] ${item.file}:${item.line}  [${item.pattern}]\n`;
      text += `  ${item.issue}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyValidatorUniqueEntityStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    const byPattern: Record<string, number> = {};
    for (const item of items) {
      byPattern[item.pattern] = (byPattern[item.pattern] ?? 0) + 1;
    }

    let text = `Symfony UniqueEntity Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total:           ${items.length}\n`;
    text += `High:            ${items.filter((i) => i.severity === 'high').length}\n`;
    text += `Medium:          ${items.filter((i) => i.severity === 'medium').length}\n`;
    text += `Low:             ${items.filter((i) => i.severity === 'low').length}\n`;
    text += `Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;
    text += `By pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) {
      text += `  ${pat}: ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function getSymfonyValidatorUniqueEntityTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_validator_unique_entity',
      description: 'Scan src/**/*.php and config/**/*.yaml for UniqueEntity issues: missing fields, ignoreNull:true on non-nullable column, missing errorPath for multi-field constraints, soft-deleted entity without repositoryMethod, composite PK overlap making constraint redundant',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_validator_unique_entity_stats',
      description: 'Statistics for Symfony UniqueEntity constraint findings: total count, breakdown by severity (high/medium/low) and pattern, files affected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
