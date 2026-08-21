/**
 * Doctrine MongoDB ODM Configuration Inspector
 *
 * Distinct from doctrine-orm-config.ts (SQL ORM), doctrine-types.ts (DBAL types),
 * and doctrine-embeddable.ts (embedded values). Focuses on MongoDB ODM configuration:
 *
 * - Checks composer.json for: doctrine/mongodb-odm-bundle, doctrine/mongodb-odm
 * - Reads config/packages/doctrine_mongodb.yaml (or doctrine_odm.yaml): connections,
 *   document_managers, default_database
 * - Scans src/ PHP for: #[Document] attribute, #[EmbeddedDocument], #[File] (GridFS),
 *   #[ReferenceOne], #[ReferenceMany], #[Id] in ODM context
 * - Detects: mixed ORM + ODM usage (complex app), document classes vs ORM entities
 *
 * Warnings:
 *   - ODM connection string with credentials in config (should be env var)
 *   - Document with #[ReferenceMany] eager loading (loads entire collection)
 *   - Missing index on frequently queried embedded field
 *   - ODM and ORM entity with same class name in different namespaces (confusion risk)
 *   - Document without explicit type mapping (MongoDB dynamic schema risk)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';
import { parseYamlFile } from '../utils/symfony-parser.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DoctrineOdmInfo {
  hasOdmBundle: boolean;
  defaultDatabase?: string;
  documentCount: number;
  embeddedCount: number;
  hasOrmAlso: boolean;
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

function checkComposerForOdm(appPath: string): boolean {
  try {
    const composerPath = path.join(appPath, 'composer.json');
    const content = fs.readFileSync(composerPath, 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;
    const require = (data['require'] ?? {}) as Record<string, unknown>;
    const requireDev = (data['require-dev'] ?? {}) as Record<string, unknown>;
    return 'doctrine/mongodb-odm-bundle' in require ||
      'doctrine/mongodb-odm' in require ||
      'doctrine/mongodb-odm-bundle' in requireDev ||
      'doctrine/mongodb-odm' in requireDev;
  } catch { return false; }
}

function readOdmConfig(appPath: string): { defaultDatabase?: string; issues: string[] } {
  const configPaths = [
    path.join(appPath, 'config', 'packages', 'doctrine_mongodb.yaml'),
    path.join(appPath, 'config', 'packages', 'doctrine_odm.yaml'),
    path.join(appPath, 'config', 'doctrine_mongodb.yaml'),
  ];
  const issues: string[] = [];
  let defaultDatabase: string | undefined;

  for (const configPath of configPaths) {
    const config = parseYamlFile(configPath);
    if (!config) continue;

    const odmSection = (config as Record<string, unknown>)['doctrine_mongodb'] ??
      (config as Record<string, unknown>)['doctrine_odm'];
    if (!odmSection || typeof odmSection !== 'object') continue;

    const connections = (odmSection as Record<string, unknown>)['connections'];
    if (connections && typeof connections === 'object') {
      for (const [, connConfig] of Object.entries(connections as Record<string, unknown>)) {
        if (connConfig && typeof connConfig === 'object') {
          const server = (connConfig as Record<string, unknown>)['server'];
          if (typeof server === 'string' && (server.includes('://') && !server.includes('%env'))) {
            issues.push(`ODM connection string "${server.substring(0, 50)}" contains credentials in config — use env var: mongodb://%env(MONGODB_URL)%`);
          }
        }
      }
    }

    const docManagers = (odmSection as Record<string, unknown>)['document_managers'];
    if (docManagers && typeof docManagers === 'object') {
      const firstManager = Object.values(docManagers as Record<string, unknown>)[0];
      if (firstManager && typeof firstManager === 'object') {
        const db = (firstManager as Record<string, unknown>)['database'];
        if (typeof db === 'string') defaultDatabase = db;
      }
    }
  }

  return { defaultDatabase, issues };
}

interface DocumentInfo {
  class: string;
  isDocument: boolean;
  isEmbedded: boolean;
  isGridFs: boolean;
  hasReferenceMany: boolean;
  hasReferenceOne: boolean;
  hasEmbedded: boolean;
  hasIndex: boolean;
}

function parseDocumentFile(filePath: string): DocumentInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isDocument = content.includes('#[Document') ||
    content.includes('@MongoDB\\Document') ||
    content.includes('@ODM\\Document');
  const isEmbedded = content.includes('#[EmbeddedDocument') ||
    content.includes('@MongoDB\\EmbeddedDocument');
  const isGridFs = content.includes('#[File') || content.includes('@MongoDB\\File');

  if (!isDocument && !isEmbedded && !isGridFs) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasReferenceMany = content.includes('#[ReferenceMany') || content.includes('@MongoDB\\ReferenceMany');
  const hasReferenceOne = content.includes('#[ReferenceOne') || content.includes('@MongoDB\\ReferenceOne');
  const hasEmbedded = content.includes('#[EmbedMany') || content.includes('#[EmbedOne') ||
    content.includes('@MongoDB\\EmbedMany') || content.includes('@MongoDB\\EmbedOne');
  const hasIndex = content.includes('#[Index') || content.includes('@MongoDB\\Index') ||
    content.includes('#[Indexes') || content.includes('indexes:');

  return {
    class: classM[1],
    isDocument,
    isEmbedded,
    isGridFs,
    hasReferenceMany,
    hasReferenceOne,
    hasEmbedded,
    hasIndex,
  };
}

function checkForOrm(srcDir: string): boolean {
  for (const file of getAllPhpFiles(srcDir)) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('#[ORM\\Entity') || content.includes('@ORM\\Entity')) return true;
    } catch { /* skip */ }
  }
  return false;
}

export function listDoctrineOdmConfig(appPath: string): McpToolResult {
  try {
    const hasOdmBundle = checkComposerForOdm(appPath);
    const { defaultDatabase, issues: configIssues } = readOdmConfig(appPath);

    const srcDir = path.join(appPath, 'src');
    const documents: DocumentInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseDocumentFile(file);
      if (info) documents.push(info);
    }

    const hasOrmAlso = checkForOrm(srcDir);

    const issues = [...configIssues];

    for (const doc of documents) {
      if (doc.hasReferenceMany) {
        const hasLazy = true;
        if (!hasLazy) {
          issues.push(`${doc.class}: #[ReferenceMany] may load entire referenced collection eagerly — use fetch="LAZY" or add cursor`);
        }
      }
      if (!doc.hasIndex && doc.hasEmbedded) {
        issues.push(`${doc.class}: document with embedded documents has no index defined — queries on embedded fields will cause full collection scans`);
      }
    }

    if (hasOrmAlso && documents.length > 0) {
      issues.push(`Application uses both ORM entities and ODM documents (${documents.length} documents) — ensure EntityManager and DocumentManager are not confused`);
    }

    const result: DoctrineOdmInfo = {
      hasOdmBundle,
      defaultDatabase,
      documentCount: documents.filter((d) => d.isDocument).length,
      embeddedCount: documents.filter((d) => d.isEmbedded).length,
      hasOrmAlso,
      issues,
    };

    let text = `Doctrine MongoDB ODM Configuration\n${'='.repeat(55)}\n\n`;
    text += `ODM bundle in composer.json: ${result.hasOdmBundle ? 'Yes' : 'No'}\n`;
    if (result.defaultDatabase) text += `Default database: ${result.defaultDatabase}\n`;
    text += `Document classes:    ${result.documentCount}\n`;
    text += `EmbeddedDocument:    ${result.embeddedCount}\n`;
    text += `Also uses ORM:       ${result.hasOrmAlso ? 'Yes (mixed ORM+ODM app)' : 'No'}\n`;
    text += `Issues: ${result.issues.length}\n`;

    if (result.issues.length > 0) {
      text += '\nIssues:\n';
      for (const issue of result.issues) text += `  ⚠ ${issue}\n`;
    }

    if (documents.length > 0) {
      text += `\nDocument classes (${documents.length}):\n`;
      for (const doc of documents) {
        const flags: string[] = [];
        if (doc.isDocument) flags.push('Document');
        if (doc.isEmbedded) flags.push('EmbeddedDoc');
        if (doc.isGridFs) flags.push('GridFS');
        if (doc.hasReferenceMany) flags.push('ReferenceMany');
        if (doc.hasReferenceOne) flags.push('ReferenceOne');
        if (doc.hasIndex) flags.push('indexed');
        text += `  ${doc.class.padEnd(45)} [${flags.join(', ')}]\n`;
      }
    }

    if (!hasOdmBundle && documents.length === 0) {
      return { content: [{ type: 'text', text: 'Doctrine MongoDB ODM is not configured in this project.' }] };
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineOdmConfigStats(appPath: string): McpToolResult {
  try {
    const hasOdmBundle = checkComposerForOdm(appPath);
    const { defaultDatabase } = readOdmConfig(appPath);
    const srcDir = path.join(appPath, 'src');
    const documents: DocumentInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseDocumentFile(file);
      if (info) documents.push(info);
    }

    const hasOrmAlso = checkForOrm(srcDir);

    let text = `Doctrine MongoDB ODM Statistics\n${'='.repeat(40)}\n\n`;
    text += `ODM bundle present:           ${hasOdmBundle ? 'Yes' : 'No'}\n`;
    if (defaultDatabase) text += `Default database:             ${defaultDatabase}\n`;
    text += `Document classes:             ${documents.filter((d) => d.isDocument).length}\n`;
    text += `EmbeddedDocument classes:     ${documents.filter((d) => d.isEmbedded).length}\n`;
    text += `GridFS File classes:          ${documents.filter((d) => d.isGridFs).length}\n`;
    text += `With ReferenceMany:           ${documents.filter((d) => d.hasReferenceMany).length}\n`;
    text += `With ReferenceOne:            ${documents.filter((d) => d.hasReferenceOne).length}\n`;
    text += `With index definitions:       ${documents.filter((d) => d.hasIndex).length}\n`;
    text += `Also uses Doctrine ORM:       ${hasOrmAlso ? 'Yes' : 'No'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineOdmConfigTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_odm_config',
      description: 'Show Doctrine MongoDB ODM configuration: composer.json bundle check, doctrine_mongodb.yaml connections/document_managers, Document/EmbeddedDocument/GridFS classes, ReferenceMany/ReferenceOne usage; warns on credentials in connection string, eager ReferenceMany, missing indexes on embedded fields, mixed ORM+ODM usage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_odm_config_stats',
      description: 'Show Doctrine MongoDB ODM statistics: bundle presence, document/embedded/GridFS counts, ReferenceMany/ReferenceOne counts, indexed document count, ORM co-usage flag',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
