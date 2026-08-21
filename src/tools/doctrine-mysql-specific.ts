import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MysqlFeatureInfo {
  file: string;
  feature: string;
  type: 'spatial' | 'fulltext' | 'json' | 'virtual' | 'charset';
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

function isMysqlDriver(appPath: string): boolean {
  const dbalYaml = path.join(appPath, 'config', 'packages', 'doctrine.yaml');
  if (!fs.existsSync(dbalYaml)) return false;
  const cfg = parseYamlFile(dbalYaml) as Record<string, unknown> | null;
  if (!cfg) return false;
  const doctrine = (cfg['doctrine'] ?? cfg) as Record<string, unknown>;
  const dbal = (doctrine['dbal'] ?? {}) as Record<string, unknown>;
  const driver = String(dbal['driver'] ?? dbal['url'] ?? '');
  return driver.includes('mysql') || driver.includes('mysqli') || driver.includes('mariadb');
}

function buildMysqlInfos(appPath: string): MysqlFeatureInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: MysqlFeatureInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);

    if (content.includes("'fulltext'") || content.includes("'fulltext: true'") || content.includes('options: {fulltext') ||
        content.includes('FULLTEXT INDEX') || content.includes('MATCH(') || content.includes('AGAINST(')) {
      const issues: string[] = [];
      const notInnodb = content.includes('engine') && content.includes('MyISAM');
      if (notInnodb) {
        issues.push('FULLTEXT with MyISAM engine — InnoDB supports FULLTEXT from MySQL 5.6+; MyISAM lacks transactions and FK support');
      }
      results.push({ file: relFile, feature: 'FULLTEXT index', type: 'fulltext', issues });
    }

    if (content.includes("'json'") || content.includes('JSON_EXTRACT') || content.includes('JSON_CONTAINS')) {
      const issues: string[] = [];
      const useVarchar = content.includes("'string'") && content.includes('json');
      if (useVarchar) {
        issues.push('JSON data stored as VARCHAR/string — use type: json for MySQL JSON validation and JSON_* function support');
      }
      results.push({ file: relFile, feature: 'JSON column', type: 'json', issues });
    }

    if (content.includes('PointType') || content.includes('GeometryType') || content.includes("'spatial: true'") ||
        content.includes('ST_Distance') || content.includes('ST_Contains')) {
      results.push({ file: relFile, feature: 'Spatial type', type: 'spatial', issues: [] });
    }

    if (content.includes('GENERATED') && (content.includes('STORED') || content.includes('VIRTUAL'))) {
      results.push({ file: relFile, feature: 'Generated/virtual column', type: 'virtual', issues: [] });
    }

    if (content.includes("charset: 'utf8'") || content.includes("charset: utf8'") ||
        content.includes("charset => 'utf8'") || content.includes("'charset' => 'utf8'")) {
      const issues: string[] = [];
      if (!content.includes('utf8mb4')) {
        issues.push("charset: utf8 used instead of utf8mb4 — MySQL utf8 is actually a 3-byte subset that cannot store emoji or some CJK characters");
      }
      results.push({ file: relFile, feature: 'utf8 charset (not utf8mb4)', type: 'charset', issues });
    }

    if (content.includes("collation: 'utf8_") || content.includes("'collation' => 'utf8_")) {
      results.push({ file: relFile, feature: 'utf8 collation (not utf8mb4)', type: 'charset', issues: ["utf8_* collation should be utf8mb4_* — change to utf8mb4_unicode_ci or utf8mb4_0900_ai_ci"] });
    }
  }

  const dbalYaml = path.join(appPath, 'config', 'packages', 'doctrine.yaml');
  if (fs.existsSync(dbalYaml)) {
    let content = '';
    try { content = fs.readFileSync(dbalYaml, 'utf-8'); } catch { /* ignore */ }

    if (content.includes("charset: utf8") && !content.includes('utf8mb4')) {
      results.push({ file: 'config/packages/doctrine.yaml', feature: 'DBAL charset: utf8', type: 'charset', issues: ["doctrine.dbal.charset should be utf8mb4 — utf8 in MySQL is 3-byte only (emoji broken)"] });
    }
    if (isMysqlDriver(appPath) && content.includes("collate:") && !content.includes('utf8mb4')) {
      results.push({ file: 'config/packages/doctrine.yaml', feature: 'DBAL collate', type: 'charset', issues: ["doctrine.dbal.collate should use utf8mb4_* collation"] });
    }
  }

  return results;
}

export function listDoctrineMysqlFeatures(appPath: string): McpToolResult {
  try {
    const infos = buildMysqlInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No MySQL/MariaDB-specific Doctrine features found (no FULLTEXT, JSON, spatial, or charset issues).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine MySQL Features\n${'='.repeat(55)}\n\nFeatures: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.feature}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineMysqlStats(appPath: string): McpToolResult {
  try {
    const infos = buildMysqlInfos(appPath);
    let text = `MySQL Feature Statistics\n${'='.repeat(40)}\n\n`;
    text += `FULLTEXT:   ${infos.filter((i) => i.type === 'fulltext').length}\n`;
    text += `JSON:       ${infos.filter((i) => i.type === 'json').length}\n`;
    text += `Spatial:    ${infos.filter((i) => i.type === 'spatial').length}\n`;
    text += `Virtual:    ${infos.filter((i) => i.type === 'virtual').length}\n`;
    text += `Charset:    ${infos.filter((i) => i.type === 'charset').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineMysqlTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_mysql_features', description: 'Detect MySQL/MariaDB-specific Doctrine features; warns on FULLTEXT with MyISAM, JSON as VARCHAR, utf8 charset (use utf8mb4 for emoji)', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_mysql_stats', description: 'Statistics for MySQL features: FULLTEXT/JSON/spatial/virtual/charset count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
