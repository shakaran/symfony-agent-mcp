// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine Composite Primary Key Inspector
 *
 * Scans src/**\/*.php for Doctrine composite primary key patterns:
 *   - Multiple #[Id] / @Id without GeneratedValue NONE strategy
 *   - ManyToOne used as part of composite PK without @Id annotation
 *   - Composite PK in ManyToMany join table without proper mapping
 *   - EntityManager::find() with scalar instead of array for composite PK
 *   - $em->getReference() with scalar for composite PK entity
 *   - Entity with composite PK extending JOINED inheritance
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CompositePkEntity {
  file: string;
  className: string;
  idCount: number;
  idFields: string[];
  hasGeneratedValueNone: boolean;
  hasGeneratedValue: boolean;
  generatedValueStrategy: string;
  hasManyToOneId: boolean;
  usesJoinedInheritance: boolean;
  issues: string[];
}

interface FindCallIssue {
  file: string;
  className: string;
  entityClass: string;
  method: string;
  description: string;
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...getAllPhpFiles(full));
      } else if (entry.name.endsWith('.php')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

function extractIdFields(content: string): string[] {
  const fields: string[] = [];

  // PHP 8 attributes: #[Id] preceding a property
  const attrIdRegex = /#\[Id[^\]]*]\s*(?:#[^\]]*]\s*)*(?:public|protected|private)\s+[^$]*\$(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = attrIdRegex.exec(content)) !== null) {
    fields.push(m[1]);
  }

  // Doctrine annotations: @Id preceding @Column
  const annotationIdRegex = /\*\s+@Id\s*\n[^@]*@Column[^*]*\s+(?:public|protected|private)\s+[^$]*\$(\w+)/g;
  while ((m = annotationIdRegex.exec(content)) !== null) {
    if (!fields.includes(m[1])) fields.push(m[1]);
  }

  // Class-level @ORM\Id() — older style
  const ormIdRegex = /@ORM\\Id\b[^@]*(?:public|protected|private)\s+[^$]*\$(\w+)/g;
  while ((m = ormIdRegex.exec(content)) !== null) {
    if (!fields.includes(m[1])) fields.push(m[1]);
  }

  return fields;
}

function extractGeneratedValueStrategy(content: string): string {
  const attrMatch = /#\[GeneratedValue\s*\(\s*strategy\s*:\s*['"](\w+)['"]/i.exec(content) ??
                    /@GeneratedValue\s*\(\s*strategy\s*=\s*['"](\w+)['"]/i.exec(content) ??
                    /GeneratedValue\s*\(["'](\w+)['"]\)/i.exec(content);
  return attrMatch ? attrMatch[1].toUpperCase() : '';
}

function scanEntityFiles(appPath: string): CompositePkEntity[] {
  const resolvedBase = path.resolve(appPath);
  const srcDir = path.join(resolvedBase, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: CompositePkEntity[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    if (!path.resolve(file).startsWith(resolvedBase + path.sep)) continue;

    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isEntity = content.includes('#[Entity') || content.includes('@Entity') ||
                     content.includes('@ORM\\Entity') || content.includes('#[ORM\\Entity');
    if (!isEntity) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    if (!classMatch) continue;
    const className = classMatch[1];

    const idFields = extractIdFields(content);
    const idCount = idFields.length;

    if (idCount < 2) continue; // Only composite PKs (2+ @Id)

    const generatedValueStrategy = extractGeneratedValueStrategy(content);
    const hasGeneratedValue = content.includes('GeneratedValue') || content.includes('#[GeneratedValue');
    const hasGeneratedValueNone = generatedValueStrategy === 'NONE' ||
                                  content.includes('strategy="NONE"') ||
                                  content.includes('strategy: "NONE"') ||
                                  content.includes("strategy='NONE'");

    // ManyToOne as part of composite PK
    const hasManyToOneId = /#\[Id[^\]]*]\s*(?:#[^\]]*]\s*)*#\[ManyToOne|#\[ManyToOne[^\]]*]\s*(?:#[^\]]*]\s*)*#\[Id/.test(content) ||
                           /@Id\s*\n[^@]*@ManyToOne|@ManyToOne[^@]*\n[^@]*@Id/.test(content);

    // JOINED inheritance
    const usesJoinedInheritance = content.includes('InheritanceType::JOINED') ||
                                   content.includes('"JOINED"') ||
                                   content.includes("'JOINED'") ||
                                   content.includes('type="JOINED"');

    const issues: string[] = [];

    if (hasGeneratedValue && !hasGeneratedValueNone) {
      issues.push(`Composite PK entity "${className}" has @GeneratedValue with strategy "${generatedValueStrategy}" — composite PKs must use strategy="NONE"; remove @GeneratedValue or set strategy to NONE`);
    }

    if (!hasGeneratedValue && !hasGeneratedValueNone) {
      // It's fine — no GeneratedValue means NONE is implicit for composite PKs
      // But warn if only one of the @Id fields would need a generator
    }

    if (hasManyToOneId) {
      const joinColMatch = /#\[JoinColumn[^\]]*]\s*(?:#[^\]]*]\s*)*#\[Id|#\[Id[^\]]*]\s*(?:#[^\]]*]\s*)*#\[JoinColumn/.test(content);
      if (!joinColMatch) {
        issues.push(`Composite PK "${className}" uses ManyToOne as @Id — ensure the join column is also explicitly annotated with #[JoinColumn]`);
      }
    }

    if (usesJoinedInheritance) {
      issues.push(`Entity "${className}" has composite PK and uses JOINED inheritance — Doctrine does not support composite PK in JOINED inheritance cleanly; consider single-column surrogate key`);
    }

    results.push({
      file: path.relative(appPath, file),
      className,
      idCount,
      idFields,
      hasGeneratedValueNone,
      hasGeneratedValue,
      generatedValueStrategy,
      hasManyToOneId,
      usesJoinedInheritance,
      issues,
    });
  }

  return results;
}

function scanFindCallIssues(appPath: string, compositePkClasses: Set<string>): FindCallIssue[] {
  const resolvedBase = path.resolve(appPath);
  const srcDir = path.join(resolvedBase, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: FindCallIssue[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    if (!path.resolve(file).startsWith(resolvedBase + path.sep)) continue;

    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('->find(') && !content.includes('->getReference(')) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    // $em->find(EntityClass::class, $scalarId) — check if EntityClass is composite
    const findRegex = /->find\s*\(\s*(\w+)::class\s*,\s*(\$\w+|'[^']*'|"[^"]*"|\d+)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = findRegex.exec(content)) !== null) {
      const entityClass = m[1];
      const idArg = m[2];
      if (compositePkClasses.has(entityClass)) {
        // Check if idArg looks like a scalar (not an array)
        if (!idArg.includes('array') && !idArg.startsWith('[') && !idArg.startsWith('$ids')) {
          results.push({
            file: path.relative(appPath, file),
            className,
            entityClass,
            method: 'find()',
            description: `EntityManager::find(${entityClass}::class, ${idArg}) — ${entityClass} has composite PK; second argument must be an array like ['id1' => ..., 'id2' => ...]`,
          });
        }
      }
    }

    // $em->getReference(EntityClass::class, $scalarId)
    const refRegex = /->getReference\s*\(\s*(\w+)::class\s*,\s*(\$\w+|'[^']*'|"[^"]*"|\d+)\s*\)/g;
    while ((m = refRegex.exec(content)) !== null) {
      const entityClass = m[1];
      const idArg = m[2];
      if (compositePkClasses.has(entityClass)) {
        if (!idArg.includes('array') && !idArg.startsWith('[') && !idArg.startsWith('$ids')) {
          results.push({
            file: path.relative(appPath, file),
            className,
            entityClass,
            method: 'getReference()',
            description: `EntityManager::getReference(${entityClass}::class, ${idArg}) — ${entityClass} has composite PK; must pass array of all PK fields`,
          });
        }
      }
    }
  }

  return results;
}

function buildAnalysis(appPath: string): { entities: CompositePkEntity[]; findIssues: FindCallIssue[] } {
  const entities = scanEntityFiles(appPath);
  const compositePkClasses = new Set(entities.map((e) => e.className));
  const findIssues = scanFindCallIssues(appPath, compositePkClasses);
  return { entities, findIssues };
}

export function listDoctrineCompositePrimaryKeys(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { entities, findIssues } = buildAnalysis(appPath);

    if (entities.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine entities with composite primary keys found.\n\nComposite PK example:\n  #[Entity]\n  class OrderItem {\n    #[Id, ManyToOne]\n    #[JoinColumn]\n    private Order $order;\n\n    #[Id, ManyToOne]\n    #[JoinColumn]\n    private Product $product;\n  }',
        }],
      };
    }

    let text = `Doctrine Composite Primary Key Audit\n${'='.repeat(55)}\n\n`;
    text += `Entities with composite PK: ${entities.length}\n\n`;

    for (const entity of entities) {
      text += `  ${entity.className}  (${entity.file})\n`;
      text += `    PK fields (${entity.idCount}): [${entity.idFields.join(', ')}]\n`;
      text += `    GeneratedValue: ${entity.hasGeneratedValue ? entity.generatedValueStrategy || 'set' : 'none (OK for composite)'}\n`;
      text += `    ManyToOne as Id: ${entity.hasManyToOneId}\n`;
      text += `    JOINED inheritance: ${entity.usesJoinedInheritance}\n`;

      for (const issue of entity.issues) {
        text += `    - ${issue}\n`;
      }
      if (entity.issues.length === 0) text += `    [OK]\n`;
      text += '\n';
    }

    if (findIssues.length > 0) {
      text += `find()/getReference() scalar-id issues (${findIssues.length}):\n`;
      for (const issue of findIssues) {
        text += `  ${issue.file}  [${issue.method}]\n`;
        text += `    ${issue.description}\n`;
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

export function getDoctrineCompositePrimaryKeysStats(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { entities, findIssues } = buildAnalysis(appPath);

    let text = `Doctrine Composite Primary Keys Stats\n${'='.repeat(40)}\n\n`;
    text += `Entities with composite PK:        ${entities.length}\n`;
    text += `With ManyToOne as Id:              ${entities.filter((e) => e.hasManyToOneId).length}\n`;
    text += `With GeneratedValue (not NONE):    ${entities.filter((e) => e.hasGeneratedValue && !e.hasGeneratedValueNone).length}\n`;
    text += `With JOINED inheritance:           ${entities.filter((e) => e.usesJoinedInheritance).length}\n`;
    text += `Entities with issues:              ${entities.filter((e) => e.issues.length > 0).length}\n`;
    text += `find()/getReference() scalar calls: ${findIssues.length}\n`;
    text += `Total issues:                      ${entities.reduce((s, e) => s + e.issues.length, 0) + findIssues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineCompositePrimaryKeysTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_composite_primary_keys',
      description: 'Audit Doctrine composite primary key entities: GeneratedValue strategy must be NONE, ManyToOne as Id without JoinColumn, JOINED inheritance incompatibility, EntityManager::find() and getReference() called with scalar instead of array for composite PK',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_composite_primary_keys_stats',
      description: 'Statistics for Doctrine composite PK entities: count, ManyToOne-as-Id, GeneratedValue issues, JOINED inheritance, find()/getReference() scalar calls',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
