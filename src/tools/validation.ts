/**
 * Symfony Validation Inspector
 *
 * Scans entities and DTOs for validation constraints:
 *   - Built-in Assert constraints (#[Assert\NotBlank], #[Assert\Email], etc.)
 *   - Custom ConstraintValidator subclasses in src/
 *   - Validation groups (#[Assert\GroupSequence], groups on individual constraints)
 *   - Cascade validation (#[Assert\Valid])
 *   - Class-level constraints (#[Assert\Callback], #[UniqueEntity])
 *
 * Pure static analysis — no validation executed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ConstraintInfo {
  constraint: string;
  property?: string;
  options?: string;
  groups?: string[];
}

interface ValidatedClass {
  class: string;
  file: string;
  namespace?: string;
  constraints: ConstraintInfo[];
  hasGroups: boolean;
  hasCascade: boolean;
}

interface CustomValidator {
  class: string;
  file: string;
  validatesConstraint?: string;
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

// ─── Constraint parsing ────────────────────────────────────────────────────

const KNOWN_CONSTRAINTS = [
  'NotBlank', 'Blank', 'NotNull', 'IsNull', 'IsTrue', 'IsFalse',
  'Type', 'Email', 'Length', 'Url', 'Regex', 'Hostname', 'Ip',
  'Uuid', 'Ulid', 'EqualTo', 'NotEqualTo', 'LessThan', 'LessThanOrEqual',
  'GreaterThan', 'GreaterThanOrEqual', 'Date', 'DateTime', 'Time',
  'Timezone', 'Choice', 'Collection', 'Count', 'UniqueEntity',
  'Range', 'Positive', 'PositiveOrZero', 'Negative', 'NegativeOrZero',
  'File', 'Image', 'CardScheme', 'Currency', 'Luhn', 'Iban', 'Bic',
  'Isbn', 'Issn', 'All', 'Valid', 'Callback', 'Sequentially',
  'AtLeastOneOf', 'Compound', 'When', 'GroupSequence',
];

function extractConstraints(content: string): ConstraintInfo[] {
  const constraints: ConstraintInfo[] = [];

  // Match #[Assert\ConstraintName(...)] optionally preceded by a property declaration
  const assertRe = /#\[Assert\\(\w+)\s*(?:\(([^)]*)\))?\]/g;
  let m: RegExpExecArray | null;

  while ((m = assertRe.exec(content)) !== null) {
    const constraint = m[1];
    const rawOptions = m[2] ?? '';

    // Find the property that follows this attribute (within ~200 chars)
    const after = content.slice(m.index, m.index + 300);
    const propM = /(?:private|protected|public)\s+(?:readonly\s+)?(?:\??\w+(?:\|\w+)*\s+)?\$(\w+)/.exec(after);

    // Extract groups option
    const groupsM = /groups\s*:\s*\[([^\]]+)\]/.exec(rawOptions);
    const groups = groupsM
      ? groupsM[1].split(',').map((g) => g.trim().replace(/['"]/g, '')).filter(Boolean)
      : undefined;

    constraints.push({
      constraint,
      property: propM?.[1],
      options: rawOptions.trim() || undefined,
      groups,
    });
  }

  // Also detect #[UniqueEntity(...)] (not under Assert\ namespace)
  for (const m2 of content.matchAll(/#\[UniqueEntity\s*\(([^)]*)\)\]/g)) {
    constraints.push({
      constraint: 'UniqueEntity',
      options: m2[1].trim() || undefined,
    });
  }

  return constraints;
}

function parseValidatedClass(filePath: string): ValidatedClass | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasAssert = content.includes('#[Assert\\') || content.includes('UniqueEntity');
  if (!hasAssert) return null;

  const classM = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const nsM = /^namespace\s+([\w\\]+);/m.exec(content);
  const constraints = extractConstraints(content);

  if (constraints.length === 0) return null;

  return {
    class: classM[1],
    file: path.basename(filePath),
    namespace: nsM?.[1],
    constraints,
    hasGroups: constraints.some((c) => c.groups && c.groups.length > 0),
    hasCascade: constraints.some((c) => c.constraint === 'Valid'),
  };
}

function findCustomValidators(appPath: string): CustomValidator[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const validators: CustomValidator[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('ConstraintValidator') &&
        !content.includes('extends ConstraintValidator')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // Try to find what constraint it validates
    const validateM = /class\s+\w+\s+extends\s+ConstraintValidator/.test(content)
      ? /class\s+(\w+)Validator/.exec(content)
      : null;

    validators.push({
      class: classM[1],
      file: path.basename(file),
      validatesConstraint: validateM?.[1],
    });
  }

  return validators;
}

function loadValidatedClasses(appPath: string): ValidatedClass[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const classes: ValidatedClass[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const c = parseValidatedClass(file);
    if (c) classes.push(c);
  }
  return classes.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listValidationConstraints(appPath: string): McpToolResult {
  try {
    const classes = loadValidatedClasses(appPath);
    const customValidators = findCustomValidators(appPath);

    if (classes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No validation constraints found.\n\nAdd constraints:\n  use Symfony\\Component\\Validator\\Constraints as Assert;\n\n  #[Assert\\NotBlank]\n  #[Assert\\Email]\n  private string $email;',
        }],
      };
    }

    const constraintCount: Record<string, number> = {};
    for (const cls of classes) {
      for (const c of cls.constraints) {
        constraintCount[c.constraint] = (constraintCount[c.constraint] ?? 0) + 1;
      }
    }

    let text = `Validation Constraints  (${classes.length} classes)\n${'='.repeat(60)}\n`;

    text += `\nMost-used constraints:\n`;
    const sorted = Object.entries(constraintCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [name, count] of sorted) {
      text += `  ${name.padEnd(20)} ${count}x\n`;
    }

    if (customValidators.length > 0) {
      text += `\nCustom validators (${customValidators.length}):\n`;
      for (const v of customValidators) {
        const validates = v.validatesConstraint ? `  validates ${v.validatesConstraint}` : '';
        text += `  ${v.class}  (${v.file})${validates}\n`;
      }
    }

    text += `\nPer class:\n`;
    for (const cls of classes) {
      const flags: string[] = [];
      if (cls.hasGroups) flags.push('groups');
      if (cls.hasCascade) flags.push('cascade');
      const flagStr = flags.length > 0 ? `  [${flags.join(', ')}]` : '';
      text += `\n  ${cls.class}  (${cls.file})${flagStr}\n`;

      for (const c of cls.constraints) {
        const prop = c.property ? `  $${c.property}` : '';
        const groups = c.groups ? `  groups: [${c.groups.join(', ')}]` : '';
        text += `    #[${c.constraint}]${prop}${groups}\n`;
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

export function getValidationStats(appPath: string): McpToolResult {
  try {
    const classes = loadValidatedClasses(appPath);
    const customValidators = findCustomValidators(appPath);

    const totalConstraints = classes.reduce((s, c) => s + c.constraints.length, 0);
    const withGroups = classes.filter((c) => c.hasGroups).length;
    const withCascade = classes.filter((c) => c.hasCascade).length;

    const constraintCount: Record<string, number> = {};
    for (const cls of classes) {
      for (const c of cls.constraints) {
        constraintCount[c.constraint] = (constraintCount[c.constraint] ?? 0) + 1;
      }
    }

    let text = `Validation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Validated classes:   ${classes.length}\n`;
    text += `Total constraints:   ${totalConstraints}\n`;
    text += `With groups:         ${withGroups}\n`;
    text += `With cascade valid:  ${withCascade}\n`;
    text += `Custom validators:   ${customValidators.length}\n`;

    const knownUsed = Object.keys(constraintCount).filter((k) => KNOWN_CONSTRAINTS.includes(k));
    const customUsed = Object.keys(constraintCount).filter((k) => !KNOWN_CONSTRAINTS.includes(k) && k !== 'UniqueEntity');
    if (customUsed.length > 0) {
      text += `\nCustom constraint types: ${customUsed.join(', ')}\n`;
    }

    text += `\nTop constraints:\n`;
    const top = Object.entries(constraintCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [name, count] of top) {
      const isKnown = knownUsed.includes(name) || name === 'UniqueEntity';
      text += `  ${name.padEnd(22)} ${count}x${isKnown ? '' : '  [custom]'}\n`;
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

export function getValidationTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_validation_constraints',
      description: 'List Symfony validation constraints (#[Assert\\*]) on entities and DTOs, grouped by class. Shows custom validators and validation groups.',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_validation_stats',
      description: 'Show validation statistics: total constrained classes, constraint type frequency, custom validators, cascade usage',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
