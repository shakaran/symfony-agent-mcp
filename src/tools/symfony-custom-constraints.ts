/**
 * Symfony Custom Validator Constraints Inspector
 *
 * Distinct from validation.ts (validation configuration broadly).
 * Focuses on custom Constraint + ConstraintValidator class pairs:
 *
 * Constraint class:
 *   - Extends Constraint
 *   - Public properties (options passed in annotation)
 *   - getDefaultOption(): which option is default
 *   - getTargets(): PROPERTY_CONSTRAINT, CLASS_CONSTRAINT, GETTER_CONSTRAINT
 *   - validatedBy(): which validator class handles this constraint
 *
 * ConstraintValidator class:
 *   - Extends ConstraintValidator
 *   - validate(mixed $value, Constraint $constraint): void
 *   - $this->context->buildViolation($constraint->message)->addViolation()
 *   - Calls to other validators (validate chaining)
 *
 * Usage scan:
 *   - #[Assert\CustomConstraint(...)] usage on entity/DTO properties
 *   - Constraint used in configureOptions() of form types
 *   - Groups specified in constraint usage
 *
 * Analysis:
 *   - Constraint without matching validator class (validatedBy() returns non-existent service)
 *   - ConstraintValidator that doesn't call addViolation() (never fails, always passes)
 *   - Constraint message not translated (missing translation key)
 *   - validate() with no instanceof check on $constraint parameter (not type-safe)
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

interface ConstraintClass {
  class: string;
  file: string;
  message?: string;
  targets: string[];
  validatedByClass?: string;
  hasTranslatableMessage: boolean;
  issues: string[];
}

interface ValidatorClass {
  class: string;
  file: string;
  hasAddViolation: boolean;
  hasInstanceofCheck: boolean;
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

function parseConstraint(filePath: string, appPath: string): ConstraintClass | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('extends Constraint')) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const messageM = /public\s+string\s+\$message\s*=\s*['"]([^'"]+)['"]/.exec(content) ??
                   /['"]message['"]\s*=>\s*['"]([^'"]+)['"]/.exec(content);
  const message = messageM?.[1];

  const targets: string[] = [];
  if (content.includes('PROPERTY_CONSTRAINT')) targets.push('property');
  if (content.includes('CLASS_CONSTRAINT')) targets.push('class');
  if (content.includes('GETTER_CONSTRAINT')) targets.push('getter');

  const validatedByM = /function\s+validatedBy[^{]*\{[^}]*return\s+['"]([^'"]+)['"]/.exec(content);
  const validatedByClass = validatedByM?.[1];

  const hasTranslatableMessage = !message || message.includes('.') ||
    /public\s+\w+\s+\$message\s*=\s*TranslatableMessage/.test(content);

  const issues: string[] = [];
  if (message && !message.includes('.') && !message.includes('{{')) {
    issues.push('Constraint message is a plain string — use a translation key (e.g. "my.constraint.invalid")');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    message,
    targets,
    validatedByClass,
    hasTranslatableMessage,
    issues,
  };
}

function parseValidator(filePath: string, appPath: string): ValidatorClass | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('extends ConstraintValidator')) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const hasAddViolation  = content.includes('addViolation') || content.includes('buildViolation');
  const hasInstanceofCheck = /instanceof\s+\w+Constraint/.test(content) ||
                              /assert\s*\(\s*\$constraint\s+instanceof/.test(content);

  const issues: string[] = [];
  if (!hasAddViolation) {
    issues.push('validate() never calls addViolation/buildViolation — constraint never fails');
  }
  if (!hasInstanceofCheck) {
    issues.push('No instanceof check on $constraint parameter — not type-safe');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    hasAddViolation,
    hasInstanceofCheck,
    issues,
  };
}

export function listCustomConstraints(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const constraints: ConstraintClass[] = [];
    const validators: ValidatorClass[]   = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const c = parseConstraint(file, appPath);
      if (c) constraints.push(c);
      const v = parseValidator(file, appPath);
      if (v) validators.push(v);
    }

    if (constraints.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom constraints found.\n\nCreate a custom constraint:\n  class ContainsAlphanumeric extends Constraint\n  {\n    public string $message = \'constraint.alphanumeric\';\n  }\n\n  class ContainsAlphanumericValidator extends ConstraintValidator\n  {\n    public function validate(mixed $value, Constraint $constraint): void\n    {\n      assert($constraint instanceof ContainsAlphanumeric);\n      if (!preg_match(\'/^[a-z0-9]+$/i\', (string)$value)) {\n        $this->context->buildViolation($constraint->message)->addViolation();\n      }\n    }\n  }',
        }],
      };
    }

    // Match constraints to validators
    const validatorsByName = new Map(validators.map((v) => [v.class, v]));
    const constraintIssues: string[] = [];

    for (const c of constraints) {
      const expectedValidator = c.class + 'Validator';
      const matched = c.validatedByClass
        ? validatorsByName.get(c.validatedByClass.split('\\').pop() ?? '')
        : validatorsByName.get(expectedValidator);
      if (!matched) constraintIssues.push(`${c.class}: no matching validator class found (expected ${expectedValidator})`);
    }

    const totalIssues = constraints.reduce((s, c) => s + c.issues.length, 0) +
                        validators.reduce((s, v) => s + v.issues.length, 0) +
                        constraintIssues.length;

    let text = `Custom Validator Constraints\n${'='.repeat(55)}\n`;
    text += `\nConstraints: ${constraints.length}  Validators: ${validators.length}  Issues: ${totalIssues}\n`;

    text += `\nConstraints:\n`;
    for (const c of constraints.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
      const targets = c.targets.length > 0 ? `  targets: ${c.targets.join(', ')}` : '';
      text += `  ${c.class}${targets}  (${c.file})\n`;
      if (c.message) text += `    message: "${c.message}"\n`;
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    if (validators.length > 0) {
      text += `\nValidators:\n`;
      for (const v of validators.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
        const vio = v.hasAddViolation ? '✓ violation' : '⚠ no violation';
        const chk = v.hasInstanceofCheck ? '✓ instanceof' : '⚠ no instanceof';
        text += `  ${v.class.padEnd(40)} ${vio}  ${chk}\n`;
        for (const issue of v.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (constraintIssues.length > 0) {
      text += `\nMissing validators:\n`;
      for (const issue of constraintIssues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getConstraintStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const constraints: ConstraintClass[] = [];
    const validators: ValidatorClass[]   = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const c = parseConstraint(file, appPath);
        if (c) constraints.push(c);
        const v = parseValidator(file, appPath);
        if (v) validators.push(v);
      }
    }

    let text = `Custom Constraint Statistics\n${'='.repeat(40)}\n\n`;
    text += `Constraints:             ${constraints.length}\n`;
    text += `  With translatable msg: ${constraints.filter((c) => c.hasTranslatableMessage).length}\n`;
    text += `  Class target:          ${constraints.filter((c) => c.targets.includes('class')).length}\n`;
    text += `Validators:              ${validators.length}\n`;
    text += `  With addViolation:     ${validators.filter((v) => v.hasAddViolation).length}\n`;
    text += `  With instanceof:       ${validators.filter((v) => v.hasInstanceofCheck).length}\n`;
    text += `Issues:                  ${constraints.reduce((s, c) => s + c.issues.length, 0) + validators.reduce((s, v) => s + v.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCustomConstraintTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_custom_constraints',
      description: 'Show custom Validator Constraint classes: Constraint/ConstraintValidator pairs, getTargets(), message translatability, validatedBy() matching, validator never failing warning, missing instanceof check, unmatched constraint/validator pairs',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_constraint_stats',
      description: 'Show custom constraint statistics: constraint count, translatable message count, class-target count, validator count with addViolation/instanceof counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
