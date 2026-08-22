/**
 * Symfony Compound, Sequentially and When Constraint Inspector
 *
 * Distinct from symfony-custom-constraints.ts (custom Constraint classes) and validation.ts.
 * Focuses on composite/conditional constraint combinators (Symfony 6.1+):
 *
 * #[Compound] (Symfony 6.4+):
 *   #[Attribute(Attribute::TARGET_CLASS | Attribute::TARGET_PROPERTY)]
 *   class StrongPassword extends Compound
 *   {
 *     protected function getConstraints(array $options): array
 *     {
 *       return [
 *         new NotBlank(),
 *         new Length(min: 8),
 *         new Regex('/[A-Z]/'),
 *       ];
 *     }
 *   }
 *
 * Sequentially (Symfony 5.1+):
 *   #[Assert\Sequentially([
 *     new Assert\NotBlank(),
 *     new Assert\Url(),
 *     new Assert\Length(max: 255),
 *   ])]
 *   — stops validation on first violation
 *
 * When (Symfony 6.2+):
 *   #[Assert\When(
 *     expression: 'this.isActive() === true',
 *     constraints: [new Assert\NotBlank()],
 *   )]
 *   — conditional validation
 *
 * Atlas (Symfony 7.1+):
 *   #[Assert\AtLeastOneOf([...])]
 *   — passes if at least one constraint passes
 *
 * Analysis:
 *   - Sequentially with only one constraint (equivalent to plain constraint)
 *   - #[Compound] that extends something other than Compound
 *   - When with empty expression string
 *   - When without constraints array
 *   - Nested Sequentially inside Sequentially (over-engineering)
 *   - AtLeastOneOf with single constraint
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CompoundConstraintUsage {
  file: string;
  class?: string;
  type: 'Compound' | 'Sequentially' | 'When' | 'AtLeastOneOf';
  constraintCount: number;
  expression?: string;
  issues: string[];
}

interface CompoundClassDef {
  class: string;
  file: string;
  extendsCompound: boolean;
  constraintCount: number;
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

function countNewConstraints(block: string): number {
  return [...block.matchAll(/new\s+(?:Assert\\)?[A-Z]\w+\s*\(/g)].length;
}

function scanFile(filePath: string, appPath: string): {
  usages: CompoundConstraintUsage[];
  classdef: CompoundClassDef | null;
} {
  const usages: CompoundConstraintUsage[] = [];
  let classdef: CompoundClassDef | null = null;

  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return { usages, classdef }; }

  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\')) return { usages, classdef };

  const relPath  = path.relative(appPath, filePath);
  const classM   = /class\s+(\w+)/.exec(content);

  // Detect class extending Compound
  if (classM && content.includes('extends Compound')) {
    const extendsCompound = /extends\s+Compound\b/.test(content);
    const getM = /getConstraints[^{]*\{([\s\S]{0,800})/.exec(content);
    const constraintCount = getM ? countNewConstraints(getM[1]) : 0;
    const issues: string[] = [];
    if (constraintCount === 0) issues.push('Compound class returns no constraints from getConstraints()');
    if (constraintCount === 1) issues.push('Compound with only 1 constraint — use that constraint directly');
    classdef = { class: classM[1], file: relPath, extendsCompound, constraintCount, issues };
  }

  // Sequentially
  for (const m of content.matchAll(/(?:Assert\\)?Sequentially\s*\(\s*\[?([\s\S]{0,500}?)\]?\s*\)/g)) {
    const block = m[1];
    const count = countNewConstraints(block);
    const issues: string[] = [];
    if (count <= 1) issues.push(`Sequentially with ${count} constraint(s) — use constraint directly without Sequentially`);
    if (block.includes('Sequentially')) issues.push('Nested Sequentially inside Sequentially — simplify');
    usages.push({ file: relPath, class: classM?.[1], type: 'Sequentially', constraintCount: count, issues });
  }

  // When
  for (const m of content.matchAll(/(?:Assert\\)?When\s*\([^)]{0,600}\)/g)) {
    const block = m[0];
    const exprM = /expression\s*:\s*['"]([^'"]{0,200})['"]/.exec(block);
    const expression = exprM?.[1];
    const count = countNewConstraints(block);
    const issues: string[] = [];
    if (!expression || expression.trim() === '') issues.push('When constraint with empty expression — always evaluates true');
    if (count === 0) issues.push('When constraint without any constraints array');
    usages.push({ file: relPath, class: classM?.[1], type: 'When', constraintCount: count, expression, issues });
  }

  // AtLeastOneOf
  for (const m of content.matchAll(/(?:Assert\\)?AtLeastOneOf\s*\(\s*\[?([\s\S]{0,400}?)\]?\s*\)/g)) {
    const block = m[1];
    const count = countNewConstraints(block);
    const issues: string[] = [];
    if (count <= 1) issues.push('AtLeastOneOf with 1 constraint — use that constraint directly');
    usages.push({ file: relPath, class: classM?.[1], type: 'AtLeastOneOf', constraintCount: count, issues });
  }

  return { usages, classdef };
}

export function listCompoundConstraints(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const allUsages: CompoundConstraintUsage[] = [];
    const classDefs: CompoundClassDef[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const result = scanFile(file, appPath);
      allUsages.push(...result.usages);
      if (result.classdef) classDefs.push(result.classdef);
    }

    if (allUsages.length === 0 && classDefs.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Sequentially/When/AtLeastOneOf/Compound usage found.\n\nExample:\n  #[Assert\\Sequentially([\n    new Assert\\NotBlank(),\n    new Assert\\Url(),\n  ])]\n  private string $website;\n\n  #[Assert\\When(\n    expression: \'this.isActive()\',\n    constraints: [new Assert\\NotBlank()],\n  )]\n  private ?string $activeField;',
        }],
      };
    }

    const totalIssues = allUsages.reduce((s, u) => s + u.issues.length, 0) +
                        classDefs.reduce((s, c) => s + c.issues.length, 0);
    const byType = new Map<string, number>();
    for (const u of allUsages) byType.set(u.type, (byType.get(u.type) ?? 0) + 1);

    let text = `Compound/Sequentially/When/AtLeastOneOf\n${'='.repeat(55)}\n`;
    text += `\nUsages: ${allUsages.length}  Compound classes: ${classDefs.length}  Issues: ${totalIssues}\n`;

    for (const [type, count] of byType.entries()) text += `  ${type.padEnd(16)} ${count}\n`;

    const withIssues = [...allUsages.filter((u) => u.issues.length > 0),
                        ...classDefs.filter((c) => c.issues.length > 0)];
    if (withIssues.length > 0) {
      text += `\nItems with issues:\n`;
      for (const item of withIssues.slice(0, 15)) {
        if ('type' in item) {
          const u = item as CompoundConstraintUsage;
          text += `  ${u.type}  ${u.constraintCount} constraints  (${u.file})\n`;
          for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
        } else {
          const c = item as CompoundClassDef;
          text += `  ${c.class}  ${c.constraintCount} constraints  (${c.file})\n`;
          for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
        }
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

export function getCompoundConstraintStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const allUsages: CompoundConstraintUsage[] = [];
    const classDefs: CompoundClassDef[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const result = scanFile(file, appPath);
        allUsages.push(...result.usages);
        if (result.classdef) classDefs.push(result.classdef);
      }
    }

    let text = `Compound Constraint Statistics\n${'='.repeat(40)}\n\n`;
    text += `Sequentially usages:  ${allUsages.filter((u) => u.type === 'Sequentially').length}\n`;
    text += `When usages:          ${allUsages.filter((u) => u.type === 'When').length}\n`;
    text += `AtLeastOneOf usages:  ${allUsages.filter((u) => u.type === 'AtLeastOneOf').length}\n`;
    text += `Compound classes:     ${classDefs.length}\n`;
    text += `Issues:               ${allUsages.reduce((s, u) => s + u.issues.length, 0) + classDefs.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCompoundConstraintTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_compound_constraints',
      description: 'Show Symfony Sequentially/When/AtLeastOneOf/#[Compound] usage: constraint counts per usage, When expression detection, single-constraint Sequentially/AtLeastOneOf warning, empty When expression, nested Sequentially, Compound class with 0/1 constraints',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_compound_constraint_stats',
      description: 'Show compound constraint statistics: Sequentially/When/AtLeastOneOf/Compound counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
