// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine Migrations Configuration Inspector
 *
 * Reads doctrine_migrations.yaml (or doctrine.yaml migrations section).
 * Warns about transactional: false, organize_migrations, missing schema_filter,
 * table_name collision with entity table names.
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface MigrationsConfigInfo {
  tableName: string;
  schemaFilter: string | null;
  transactional: boolean;
  allOrNothing: boolean;
  checkDatabasePlatform: boolean;
  organizeMigrations: string;
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

function extractEntityTableNames(appPath: string): Set<string> {
  const tables = new Set<string>();
  const srcDir = path.join(appPath, 'src');
  const files = getAllPhpFiles(srcDir);

  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('Entity') && !content.includes('@Table') && !content.includes('#[Table')) continue;

    // Match #[Table(name: 'foo')] or @ORM\Table(name="foo")
    const attrPattern = /#\[(?:\w+\\){0,5}Table\s*\([^)]{0,200}name\s*[=:]\s*['"](\w{1,120})['"]/.exec(content);
    if (attrPattern) tables.add(attrPattern[1]);

    const annotPattern = /@(?:\w+\\){0,5}Table\s*\([^)]{0,200}name\s*=\s*["'](\w{1,120})["']/.exec(content);
    if (annotPattern) tables.add(annotPattern[1]);
  }

  return tables;
}

function loadMigrationsConfig(appPath: string): MigrationsConfigInfo | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine_migrations.yaml'),
    path.join(appPath, 'config', 'packages', 'doctrine_migrations.yml'),
    path.join(appPath, 'config', 'doctrine_migrations.yaml'),
  ];

  let raw: Record<string, unknown> | null = null;

  for (const candidate of candidates) {
    raw = parseYamlFile(candidate) as Record<string, unknown> | null;
    if (raw) break;
  }

  // Also check doctrine.yaml migrations section as fallback
  if (!raw) {
    const doctrineYaml = path.join(appPath, 'config', 'packages', 'doctrine.yaml');
    const doctrineRaw = parseYamlFile(doctrineYaml) as Record<string, unknown> | null;
    if (doctrineRaw) {
      const section = doctrineRaw['doctrine_migrations'] as Record<string, unknown> | undefined;
      if (section) raw = { doctrine_migrations: section };
    }
  }

  if (!raw) return null;

  const section = raw['doctrine_migrations'] as Record<string, unknown> | undefined ?? raw;

  const tableName = section['table_name'] ? String(section['table_name']) : 'doctrine_migration_versions';
  const schemaFilter = section['schema_filter'] ? String(section['schema_filter']) : null;
  const transactional = section['transactional'] !== undefined ? Boolean(section['transactional']) : true;
  const allOrNothing = section['all_or_nothing'] !== undefined ? Boolean(section['all_or_nothing']) : false;
  const checkDatabasePlatform = section['check_database_platform'] !== undefined ? Boolean(section['check_database_platform']) : true;
  const organizeMigrations = section['organize_migrations'] ? String(section['organize_migrations']) : 'none';

  const entityTables = extractEntityTableNames(appPath);
  const issues: string[] = [];

  if (!transactional) {
    issues.push('transactional: false — migrations run without transactions; a failure leaves the database in a partially migrated state');
  }

  if (organizeMigrations === 'year' || organizeMigrations === 'year_and_month') {
    issues.push(`organize_migrations: "${organizeMigrations}" — migrations sorted into subdirectories; ensure migration runner discovers all subdirectories`);
  }

  if (!schemaFilter) {
    issues.push('schema_filter not set — if multiple applications share the same database, unrelated tables may be picked up by schema diff');
  }

  if (entityTables.has(tableName)) {
    issues.push(`table_name "${tableName}" collides with an entity table of the same name — rename to avoid schema conflicts`);
  }

  if (!allOrNothing) {
    issues.push('all_or_nothing: false (default) — individual migrations can partially succeed; consider enabling for safer deployments');
  }

  return {
    tableName,
    schemaFilter,
    transactional,
    allOrNothing,
    checkDatabasePlatform,
    organizeMigrations,
    issues,
  };
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listDoctrineMigrationsConfig(appPath: string): McpToolResult {
  try {
    const config = loadMigrationsConfig(appPath);

    if (!config) {
      return {
        content: [{
          type: 'text',
          text: 'doctrine_migrations.yaml not found.\n\nInstall Doctrine Migrations:\n  composer require doctrine/doctrine-migrations-bundle\n\nDefault config will be generated at config/packages/doctrine_migrations.yaml',
        }],
      };
    }

    let text = `Doctrine Migrations Configuration\n${'='.repeat(50)}\n`;
    text += `table_name:              ${config.tableName}\n`;
    text += `schema_filter:           ${config.schemaFilter ?? '(not set)'}\n`;
    text += `transactional:           ${config.transactional}\n`;
    text += `all_or_nothing:          ${config.allOrNothing}\n`;
    text += `check_database_platform: ${config.checkDatabasePlatform}\n`;
    text += `organize_migrations:     ${config.organizeMigrations}\n`;

    if (config.issues.length > 0) {
      text += `\nIssues (${config.issues.length}):\n`;
      for (const issue of config.issues) {
        text += `  ⚠ ${issue}\n`;
      }
    } else {
      text += '\nNo issues detected.\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error reading Doctrine migrations config: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDoctrineMigrationsConfigStats(appPath: string): McpToolResult {
  try {
    const config = loadMigrationsConfig(appPath);

    if (!config) {
      return {
        content: [{ type: 'text', text: 'doctrine_migrations.yaml not found.' }],
      };
    }

    // Count migration files
    const migrationsDir = path.join(appPath, 'migrations');
    let migrationCount = 0;
    try {
      const files = fs.readdirSync(migrationsDir);
      migrationCount = files.filter(f => f.endsWith('.php')).length;
    } catch { /* no migrations dir */ }

    const text = [
      'Doctrine Migrations Config Statistics',
      '='.repeat(45),
      `table_name:              ${config.tableName}`,
      `transactional:           ${config.transactional}`,
      `all_or_nothing:          ${config.allOrNothing}`,
      `check_database_platform: ${config.checkDatabasePlatform}`,
      `organize_migrations:     ${config.organizeMigrations}`,
      `schema_filter set:       ${config.schemaFilter !== null ? 'yes' : 'no'}`,
      `Migration files found:   ${migrationCount}`,
      `Total issues:            ${config.issues.length}`,
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error computing Doctrine migrations config stats: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDoctrineMigrationsConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'list_doctrine_migrations_config',
      description: 'Inspect doctrine_migrations.yaml configuration and warn about transactional:false, missing schema_filter, organize_migrations gotchas, and table_name collisions.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_doctrine_migrations_config_stats',
      description: 'Get statistics about Doctrine migrations configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
  ];
}
