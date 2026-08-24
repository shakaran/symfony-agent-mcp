// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine DBAL Schema Manager Inspector
 *
 * Distinct from database.ts (table/schema inspection), migrations-analysis.ts (migration quality),
 * and doctrine-orm-config.ts (ORM config). Focuses on SchemaManager API usage in PHP code:
 *
 * - Scans src/ PHP for: $connection->createSchemaManager(), SchemaManager methods:
 *   createTable(), dropTable(), introspectTable(), listTableNames(), tablesExist(), getDatabasePlatform()
 * - Detects whether usage is in migration, test, or production code
 *
 * Warnings:
 *   - SchemaManager in production service (schema changes should be in migrations)
 *   - createTable() outside migration (out-of-sync with migration history)
 *   - dropTable() in non-migration code (data loss risk)
 *   - SchemaManager used without wrapping in transaction
 *   - introspectTable() in hot path (expensive schema query)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DbalSchemaManagerInfo {
  file: string;
  class: string;
  methods: string[];
  isInMigration: boolean;
  isInTest: boolean;
  hasTransaction: boolean;
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

const SCHEMA_MANAGER_METHODS = [
  'createSchemaManager',
  'createTable',
  'dropTable',
  'introspectTable',
  'listTableNames',
  'tablesExist',
  'getDatabasePlatform',
  'renameTable',
  'dropAndCreateTable',
  'alterTable',
];

function parseSchemaManagerFile(filePath: string): DbalSchemaManagerInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasSchemaManager = content.includes('SchemaManager') ||
    content.includes('createSchemaManager') ||
    SCHEMA_MANAGER_METHODS.some((m) => content.includes(m + '('));

  if (!hasSchemaManager) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const methods: string[] = [];
  for (const method of SCHEMA_MANAGER_METHODS) {
    if (content.includes(method + '(') || content.includes(method + ' (')) {
      methods.push(method);
    }
  }

  if (methods.length === 0) return null;

  const normalizedPath = filePath.replace(/\\/g, '/');
  const isInMigration = normalizedPath.includes('/Migration') ||
    normalizedPath.includes('/migrations/') ||
    content.includes('AbstractMigration') ||
    content.includes('extends AbstractMigration');

  const isInTest = normalizedPath.includes('/Test') ||
    normalizedPath.includes('/tests/') ||
    normalizedPath.includes('Test.php') ||
    content.includes('TestCase') ||
    content.includes('KernelTestCase');

  const hasTransaction = content.includes('beginTransaction') ||
    content.includes('wrapInTransaction') ||
    content.includes('transactional(');

  const issues: string[] = [];

  if (!isInMigration && !isInTest) {
    if (methods.includes('createSchemaManager') || methods.includes('createTable') ||
      methods.includes('dropTable') || methods.includes('alterTable')) {
      issues.push('SchemaManager used in production code — schema modifications should be in Doctrine migrations');
    }
  }

  if (!isInMigration && methods.includes('createTable')) {
    issues.push('createTable() outside migration — table creation out-of-sync with migration history');
  }

  if (!isInMigration && methods.includes('dropTable')) {
    issues.push('dropTable() in non-migration code — risk of accidental data loss');
  }

  if ((methods.includes('createTable') || methods.includes('dropTable') || methods.includes('alterTable')) &&
    !hasTransaction && !isInTest) {
    issues.push('Schema modification without transaction wrapper — partial failure leaves inconsistent schema');
  }

  if (methods.includes('introspectTable') && !isInMigration && !isInTest) {
    issues.push('introspectTable() in production code — expensive schema introspection query, avoid in hot paths');
  }

  if (methods.includes('getDatabasePlatform') && !isInMigration) {
    issues.push('getDatabasePlatform() outside migration — platform-specific code reduces portability');
  }

  return {
    file: path.basename(filePath),
    class: classM[1],
    methods,
    isInMigration,
    isInTest,
    hasTransaction,
    issues,
  };
}

export function listDbalSchemaManager(appPath: string): McpToolResult {
  try {
    const results: DbalSchemaManagerInfo[] = [];

    for (const dir of ['src', 'migrations', 'tests']) {
      const dirPath = path.join(appPath, dir);
      for (const file of getAllPhpFiles(dirPath)) {
        const info = parseSchemaManagerFile(file);
        if (info) results.push(info);
      }
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No DBAL SchemaManager usage found in src/, migrations/, or tests/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `DBAL Schema Manager Usage\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Issues: ${totalIssues}\n`;

    const production = results.filter((r) => !r.isInMigration && !r.isInTest);
    const migrations = results.filter((r) => r.isInMigration);
    const tests = results.filter((r) => r.isInTest);

    if (production.length > 0) {
      text += `\nProduction code (${production.length}) — REVIEW NEEDED:\n`;
      for (const r of production) {
        const tx = r.hasTransaction ? ' [tx]' : ' [no-tx]';
        text += `  ${r.class.padEnd(45)} (${r.file})${tx}\n`;
        text += `    methods: ${r.methods.join(', ')}\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (migrations.length > 0) {
      text += `\nMigrations (${migrations.length}):\n`;
      for (const r of migrations) {
        text += `  ${r.class.padEnd(45)} (${r.file})\n`;
        text += `    methods: ${r.methods.join(', ')}\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (tests.length > 0) {
      text += `\nTest code (${tests.length}):\n`;
      for (const r of tests) {
        text += `  ${r.class.padEnd(45)} (${r.file})\n`;
        text += `    methods: ${r.methods.join(', ')}\n`;
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

export function getDbalSchemaManagerStats(appPath: string): McpToolResult {
  try {
    const results: DbalSchemaManagerInfo[] = [];

    for (const dir of ['src', 'migrations', 'tests']) {
      const dirPath = path.join(appPath, dir);
      for (const file of getAllPhpFiles(dirPath)) {
        const info = parseSchemaManagerFile(file);
        if (info) results.push(info);
      }
    }

    let text = `DBAL Schema Manager Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total files with SchemaManager: ${results.length}\n`;
    text += `  In migrations:                ${results.filter((r) => r.isInMigration).length}\n`;
    text += `  In tests:                     ${results.filter((r) => r.isInTest).length}\n`;
    text += `  In production code:           ${results.filter((r) => !r.isInMigration && !r.isInTest).length}\n`;
    text += `  With transaction:             ${results.filter((r) => r.hasTransaction).length}\n`;

    const methodCounts: Record<string, number> = {};
    for (const r of results) {
      for (const m of r.methods) {
        methodCounts[m] = (methodCounts[m] ?? 0) + 1;
      }
    }
    if (Object.keys(methodCounts).length > 0) {
      text += `\nMethod usage:\n`;
      for (const [m, cnt] of Object.entries(methodCounts).sort(([, a], [, b]) => b - a)) {
        text += `  ${m.padEnd(30)} ${cnt}\n`;
      }
    }

    text += `\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDbalSchemaManagerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_dbal_schema_manager',
      description: 'Show DBAL SchemaManager usage: createSchemaManager/createTable/dropTable/introspectTable/listTableNames/tablesExist/getDatabasePlatform calls; classifies into migration/test/production code; warns on schema modifications in production, createTable/dropTable outside migrations, missing transaction, introspectTable in hot paths',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_dbal_schema_manager_stats',
      description: 'Show DBAL SchemaManager statistics: total usage count, breakdown by migration/test/production, transaction coverage, method usage counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
