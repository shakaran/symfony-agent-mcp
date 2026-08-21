import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface MigrationInfo {
  file: string;
  version: string;
  dependencies: string[];
  isTransactional: boolean;
  hasPostDown: boolean;
}

function extractVersion(filename: string): string {
  const m = /Version(\d+)/.exec(filename);
  return m?.[1] ?? filename.replace('.php', '');
}

function loadMigrations(appPath: string): MigrationInfo[] {
  const candidates = [
    path.join(appPath, 'migrations'),
    path.join(appPath, 'src', 'Migrations'),
    path.join(appPath, 'src', 'Migration'),
  ];
  const migrations: MigrationInfo[] = [];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.php')); } catch { continue; }
    for (const file of files.sort()) {
      const fullPath = path.join(dir, file);
      let content = '';
      try { content = fs.readFileSync(fullPath, 'utf-8'); } catch { continue; }
      const version = extractVersion(file);
      const isTransactional = !content.includes('isTransactional') || content.includes('return true') || !content.includes('return false');
      const hasPostDown = content.includes('function postDown');
      const depPattern = /DependencyVersion::(\d+)/g;
      const dependencies: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = depPattern.exec(content)) !== null) dependencies.push(m[1]);
      migrations.push({ file: path.relative(appPath, fullPath), version, dependencies, isTransactional, hasPostDown });
    }
  }
  return migrations;
}

function detectGaps(versions: string[]): string[] {
  const sorted = versions.slice().sort();
  const gaps: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (/^\d{14}$/.test(prev) && /^\d{14}$/.test(curr)) {
      const prevTs = parseInt(prev.slice(0, 8), 10);
      const currTs = parseInt(curr.slice(0, 8), 10);
      if (currTs - prevTs > 365) gaps.push(`${prev} → ${curr} (${currTs - prevTs} days gap)`);
    }
  }
  return gaps;
}

export function listDoctrineMigrationGraph(appPath: string): McpToolResult {
  try {
    const migrations = loadMigrations(appPath);
    if (migrations.length === 0) return { content: [{ type: 'text', text: 'No Doctrine migrations found in migrations/ or src/Migrations/.' }] };
    const versions = migrations.map((m) => m.version);
    const gaps = detectGaps(versions);
    const nonTransactional = migrations.filter((m) => !m.isTransactional);
    let text = `Doctrine Migration Graph\n${'='.repeat(55)}\n\nMigrations: ${migrations.length}  Non-transactional: ${nonTransactional.length}\n`;
    if (gaps.length > 0) {
      text += `\nVersion gaps (>1 year):\n`;
      for (const g of gaps) text += `  ⚠ ${g}\n`;
    }
    text += `\nFirst: ${versions[0] ?? 'none'}  Last: ${versions[versions.length - 1] ?? 'none'}\n`;
    if (nonTransactional.length > 0) {
      text += `\nNon-transactional migrations:\n`;
      for (const m of nonTransactional) text += `  ⚠ ${m.version}  (${m.file})\n`;
    }
    const withDeps = migrations.filter((m) => m.dependencies.length > 0);
    if (withDeps.length > 0) {
      text += `\nWith explicit dependencies:\n`;
      for (const m of withDeps) text += `  ${m.version} depends on: ${m.dependencies.join(', ')}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineMigrationGraphStats(appPath: string): McpToolResult {
  try {
    const migrations = loadMigrations(appPath);
    const versions = migrations.map((m) => m.version);
    const gaps = detectGaps(versions);
    let text = `Doctrine Migration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Migrations: ${migrations.length}\n  Transactional: ${migrations.filter((m) => m.isTransactional).length}\n  Non-transactional: ${migrations.filter((m) => !m.isTransactional).length}\n  Version gaps: ${gaps.length}\n  With dependencies: ${migrations.filter((m) => m.dependencies.length > 0).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineMigrationGraphTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_migration_graph', description: 'Show Doctrine migration ordering: version sequence, large time gaps (>1 year), non-transactional migrations, explicit DependencyVersion declarations', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_migration_graph_stats', description: 'Show Doctrine migration statistics: total count, transactional/non-transactional, version gaps, dependency count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
