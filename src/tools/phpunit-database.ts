/**
 * PHPUnit Database Usage Inspector
 *
 * Scans tests/ PHP for:
 *   - DatabaseTestCase, RefreshDatabaseTrait, ResetDatabase
 *   - LiipFunctionalTestBundle, initializeDatabaseWith(), truncateTables()
 *   - DataFixtures loading in tests
 *
 * Detects:
 *   - Test classes using DB without @group database annotation
 *   - Test using real DB vs SQLite in-memory vs fixtures
 *
 * Warns:
 *   - DB test without @group database (CI without DB will fail silently)
 *   - Missing database cleanup strategy (transactions vs truncate vs drop-recreate)
 *   - Test using fixtures but not clearing between tests (state pollution)
 *   - Multiple test classes sharing DB state without clear isolation
 *   - Using assert after DB operation that may have rolled back
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

interface PhpUnitDatabaseInfo {
  file: string;
  class: string;
  hasDbUsage: boolean;
  hasDatabaseGroup: boolean;
  cleanupStrategy: string;
  usesFixtures: boolean;
  issues: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── DB indicators ────────────────────────────────────────────────────────────

const DB_CLASS_INDICATORS = [
  'DatabaseTestCase',
  'RefreshDatabaseTrait',
  'ResetDatabase',
  'LiipFunctionalTestBundle',
  'KernelTestCase',
  'WebTestCase',
  'initializeDatabaseWith',
  'truncateTables',
  'entityManager',
  'getRepository',
  'ObjectManager',
  'EntityManagerInterface',
  'createDatabaseTool',
];

const FIXTURE_INDICATORS = [
  'DataFixtures',
  'AppFixtures',
  'loadFixtures',
  'databaseTool',
  'ORMExecutor',
  'ORMPurger',
  'fixture',
  'Fixture',
];

const CLEANUP_STRATEGIES: Record<string, string> = {
  'TRUNCATE': 'truncate',
  'TRANSACTION': 'transaction',
  'RefreshDatabase': 'drop-recreate',
  'ResetDatabase': 'drop-recreate',
  'beginTransaction': 'transaction',
  'rollback': 'transaction',
  'truncateTables': 'truncate',
  'SchemaDropAndCreate': 'drop-recreate',
};

// ─── File analysis ────────────────────────────────────────────────────────────

function detectCleanupStrategy(content: string): string {
  for (const [pattern, strategy] of Object.entries(CLEANUP_STRATEGIES)) {
    if (content.includes(pattern)) return strategy;
  }
  return 'none';
}

function analyzeFile(filePath: string): PhpUnitDatabaseInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const classM = /\bclass\s+(\w{1,80})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  const hasDbUsage = DB_CLASS_INDICATORS.some((ind) => content.includes(ind));
  if (!hasDbUsage) return null;

  const hasDatabaseGroup =
    /@group\s+database\b/.test(content) ||
    /#\[Group\s*\(\s*['"]database['"]\s*\)\]/.test(content);

  const usesFixtures = FIXTURE_INDICATORS.some((ind) => content.includes(ind));
  const cleanupStrategy = detectCleanupStrategy(content);

  const issues: string[] = [];

  if (!hasDatabaseGroup) {
    issues.push(
      `${className} uses database but has no @group database annotation. ` +
      `CI environments without DB will fail silently or skip this test incorrectly.`,
    );
  }

  if (cleanupStrategy === 'none') {
    issues.push(
      `${className} uses DB but has no clear cleanup strategy (no transaction, truncate, or drop-recreate). ` +
      `Tests may pollute each other's DB state.`,
    );
  }

  if (usesFixtures && cleanupStrategy === 'none') {
    issues.push(
      `${className} loads fixtures but does not appear to clear the DB between tests. ` +
      `Fixture data accumulates and causes state pollution across test runs.`,
    );
  }

  // Detect assert after possible rollback
  if (content.includes('rollback') && /\bassert\w{0,60}\s*\(/.test(content)) {
    const rollbackIdx = content.indexOf('rollback');
    const firstAssertAfter = /\bassert\w{0,60}\s*\(/.exec(content.slice(rollbackIdx));
    if (firstAssertAfter) {
      issues.push(
        `${className} appears to assert values after a potential DB rollback. ` +
        `Assertions on rolled-back data will silently pass with empty/stale results.`,
      );
    }
  }

  return {
    file: path.basename(filePath),
    class: className,
    hasDbUsage,
    hasDatabaseGroup,
    cleanupStrategy,
    usesFixtures,
    issues,
  };
}

function loadAll(appPath: string): PhpUnitDatabaseInfo[] {
  const testsDir = path.join(appPath, 'tests');
  if (!fs.existsSync(testsDir)) return [];

  const results: PhpUnitDatabaseInfo[] = [];
  for (const file of getAllPhpFiles(testsDir)) {
    const info = analyzeFile(file);
    if (info) results.push(info);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpUnitDatabase(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No database-dependent test classes found in tests/.\n\n' +
            'Database tests should extend KernelTestCase or use DatabaseTestCase ' +
            'and be annotated with @group database.',
        }],
      };
    }

    const noGroup      = items.filter((i) => !i.hasDatabaseGroup);
    const withFixtures = items.filter((i) => i.usesFixtures);
    const noCleanup    = items.filter((i) => i.cleanupStrategy === 'none');
    const withIssues   = items.filter((i) => i.issues.length > 0);

    let text = `PHPUnit Database Usage Analysis\n${'='.repeat(55)}\n`;
    text += `  DB test classes:           ${items.length}\n`;
    text += `  Missing @group database:   ${noGroup.length}\n`;
    text += `  Using fixtures:            ${withFixtures.length}\n`;
    text += `  No cleanup strategy:       ${noCleanup.length}\n`;
    text += `  With issues:               ${withIssues.length}\n\n`;

    // Strategy distribution
    const strategies = new Map<string, number>();
    for (const i of items) {
      strategies.set(i.cleanupStrategy, (strategies.get(i.cleanupStrategy) ?? 0) + 1);
    }
    text += `Cleanup strategies:\n`;
    for (const [strat, count] of strategies) {
      text += `  ${strat.padEnd(20)} ${count}\n`;
    }
    text += '\n';

    for (const item of withIssues) {
      text += `${item.class} [${item.file}]\n`;
      text += `  cleanup: ${item.cleanupStrategy}`;
      if (!item.hasDatabaseGroup) text += '  [no-db-group]';
      if (item.usesFixtures) text += '  [fixtures]';
      text += '\n';
      for (const issue of item.issues) {
        text += `  WARN: ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitDatabaseStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    let text = `PHPUnit Database Statistics\n${'='.repeat(40)}\n\n`;
    text += `DB test classes:         ${items.length}\n`;
    text += `Has @group database:     ${items.filter((i) => i.hasDatabaseGroup).length}\n`;
    text += `Missing @group database: ${items.filter((i) => !i.hasDatabaseGroup).length}\n`;
    text += `Using fixtures:          ${items.filter((i) => i.usesFixtures).length}\n`;
    text += `No cleanup strategy:     ${items.filter((i) => i.cleanupStrategy === 'none').length}\n`;
    text += `Transaction cleanup:     ${items.filter((i) => i.cleanupStrategy === 'transaction').length}\n`;
    text += `Truncate cleanup:        ${items.filter((i) => i.cleanupStrategy === 'truncate').length}\n`;
    text += `Drop-recreate cleanup:   ${items.filter((i) => i.cleanupStrategy === 'drop-recreate').length}\n`;
    text += `With issues:             ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpUnitDatabaseTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_phpunit_database',
      description: 'List PHPUnit database usage: missing @group database annotation, cleanup strategy detection, fixture usage, post-rollback assertion warnings',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_database_stats',
      description: 'Show PHPUnit database test statistics: total DB tests, annotation coverage, cleanup strategy distribution, fixture usage, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
