import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface PostgresFeatureInfo {
  file: string;
  feature: string;
  type: 'json' | 'array' | 'fulltext' | 'generated' | 'sequence';
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

function isPostgresDriver(appPath: string): boolean {
  const dbalYaml = path.join(appPath, 'config', 'packages', 'doctrine.yaml');
  if (!fs.existsSync(dbalYaml)) return false;
  const cfg = parseYamlFile(dbalYaml) as Record<string, unknown> | null;
  if (!cfg) return false;
  const doctrine = (cfg['doctrine'] ?? cfg) as Record<string, unknown>;
  const dbal = (doctrine['dbal'] ?? {}) as Record<string, unknown>;
  const driver = String(dbal['driver'] ?? dbal['url'] ?? '');
  return driver.includes('pgsql') || driver.includes('postgres') || driver.includes('postgresql');
}

function buildPostgresInfos(appPath: string): PostgresFeatureInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const isPostgres = isPostgresDriver(appPath);
  const results: PostgresFeatureInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);

    if (content.includes("'json'") || content.includes("type: 'json'") || content.includes('JsonType') || content.includes("columnDefinition: 'jsonb'")) {
      const issues: string[] = [];
      const usesJsonFilter = content.includes('JSON_GET_FIELD') || content.includes('JSON_CONTAINS') ||
        content.includes("WHERE") && content.includes("->") && content.includes('json');
      if (usesJsonFilter && !content.includes('jsonb')) {
        issues.push("JSON column used for filtering — use JSONB type in PostgreSQL for GIN index support and faster JSON querying");
      }
      if (!isPostgres && (content.includes('jsonb') || content.includes('JSONB'))) {
        issues.push('JSONB type used but driver is not pdo_pgsql — JSONB is PostgreSQL-specific');
      }
      results.push({ file: relFile, feature: 'JSON/JSONB column', type: 'json', issues });
    }

    if (content.includes('SimpleArrayType') || content.includes("type: 'simple_array'") || content.includes("columnDefinition: 'array'")) {
      const issues: string[] = [];
      const hasCommaCheck = content.includes('implode') || content.includes('join(');
      if (!hasCommaCheck) {
        issues.push('SimpleArrayType used — values containing commas will corrupt the array (comma is the delimiter); use JSON type instead');
      }
      results.push({ file: relFile, feature: 'Simple Array type', type: 'array', issues });
    }

    if (content.includes('to_tsvector') || content.includes('to_tsquery') || content.includes('TSVector') || content.includes('GIN index')) {
      const issues: string[] = [];
      if (content.includes('LIKE') && content.includes('tsvector')) {
        issues.push('LIKE used on a tsvector column — use @@ (match) operator instead of LIKE for full-text search');
      }
      results.push({ file: relFile, feature: 'Full-text search (tsvector)', type: 'fulltext', issues });
    }

    if (content.includes('GENERATED ALWAYS AS') || content.includes('GeneratedValue::SEQUENCE')) {
      results.push({ file: relFile, feature: 'Generated/Sequence column', type: 'generated', issues: [] });
    }

    if (content.includes('SequenceGenerator') || content.includes('allocationSize')) {
      const issues: string[] = [];
      const allocMatch = /allocationSize\s*[:=]\s*['"]?(\d+)['"]?/.exec(content);
      if (allocMatch && parseInt(allocMatch[1], 10) === 1) {
        issues.push('SequenceGenerator allocationSize=1 — generates a DB round-trip on every INSERT; set allocationSize to 50+ for better performance');
      }
      results.push({ file: relFile, feature: 'Doctrine SequenceGenerator', type: 'sequence', issues });
    }
  }

  return results;
}

export function listDoctrinePostgresFeatures(appPath: string): McpToolResult {
  try {
    const infos = buildPostgresInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PostgreSQL-specific Doctrine features found (no JSON/JSONB, SimpleArrayType, tsvector, sequences).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine PostgreSQL Features\n${'='.repeat(55)}\n\nFeatures: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.feature}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrinePostgresStats(appPath: string): McpToolResult {
  try {
    const infos = buildPostgresInfos(appPath);
    let text = `PostgreSQL Feature Statistics\n${'='.repeat(40)}\n\n`;
    text += `JSON/JSONB:   ${infos.filter((i) => i.type === 'json').length}\n`;
    text += `Arrays:       ${infos.filter((i) => i.type === 'array').length}\n`;
    text += `Full-text:    ${infos.filter((i) => i.type === 'fulltext').length}\n`;
    text += `Generated:    ${infos.filter((i) => i.type === 'generated').length}\n`;
    text += `Sequences:    ${infos.filter((i) => i.type === 'sequence').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrinePostgresTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_postgres_features', description: 'Detect PostgreSQL-specific Doctrine features; warns on JSON vs JSONB for filtering, SimpleArrayType with commas, LIKE on tsvector, allocationSize=1 in sequences', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_postgres_stats', description: 'Statistics for PostgreSQL features: JSON/array/fulltext/generated/sequence count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
