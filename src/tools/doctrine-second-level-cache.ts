import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface SecondLevelCacheInfo {
  class: string;
  file: string;
  cacheUsage: string;
  cacheRegion?: string;
  associationCaches: Array<{ property: string; usage: string }>;
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

function parse2LCEntity(filePath: string, appPath: string): SecondLevelCacheInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('#[ORM\\Cache') && !content.includes('@Cache')) return null;
  if (content.includes('namespace Doctrine\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const classLevelM = /#\[ORM\\Cache\([^)]{0,300}\)/.exec(content);
  if (!classLevelM) return null;
  const usageM = /usage\s*:\s*['"]([^'"]+)['"]/i.exec(classLevelM[0]);
  const regionM = /region\s*:\s*['"]([^'"]+)['"]/i.exec(classLevelM[0]);
  const cacheUsage = usageM?.[1] ?? 'READ_WRITE';
  const cacheRegion = regionM?.[1];
  const assocPattern = /#\[ORM\\Cache[^\]]{0,200}\]\s*(?:#\[[^\]]+\]\s*)*(?:public|protected|private)\s+(?:\w+\s+)?\$(\w+)/g;
  const associationCaches: Array<{ property: string; usage: string }> = [];
  let am: RegExpExecArray | null;
  while ((am = assocPattern.exec(content)) !== null) {
    const blockStart = Math.max(0, am.index - 200);
    const block = content.slice(blockStart, am.index + 100);
    const aUsageM = /usage\s*:\s*['"]([^'"]+)['"]/i.exec(block);
    associationCaches.push({ property: am[1], usage: aUsageM?.[1] ?? 'READ_WRITE' });
  }
  const issues: string[] = [];
  if (cacheUsage === 'NONSTRICT_READ_WRITE' && !content.includes('timestamp')) issues.push('NONSTRICT_READ_WRITE — stale reads possible on concurrent write; consider READ_WRITE for consistency');
  if (!cacheRegion) issues.push('No cache region specified — all entities share the default region; use separate regions for different TTLs');
  return { class: classM[1], file: path.relative(appPath, filePath), cacheUsage, cacheRegion, associationCaches, issues };
}

function isSecondLevelCacheEnabled(appPath: string): boolean {
  const candidates = [path.join(appPath, 'config', 'packages', 'doctrine.yaml')];
  for (const f of candidates) {
    const raw = parseYamlFile(f) as Record<string, unknown> | null;
    if (!raw) continue;
    const doctrine = (raw['doctrine'] ?? {}) as Record<string, unknown>;
    const orm = (doctrine['orm'] ?? {}) as Record<string, unknown>;
    const slc = (orm['second_level_cache'] ?? {}) as Record<string, unknown>;
    if (slc['enabled']) return true;
  }
  return false;
}

export function listDoctrineSecondLevelCache(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const entities: SecondLevelCacheInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const e = parse2LCEntity(file, appPath);
      if (e) entities.push(e);
    }
    const slcEnabled = isSecondLevelCacheEnabled(appPath);
    if (entities.length === 0) return { content: [{ type: 'text', text: `No Doctrine Second Level Cache (#[ORM\\Cache]) found.\n\nSecond-level cache enabled in config: ${slcEnabled ? 'yes' : 'no'}\n\nExample:\n  #[ORM\\Cache(usage: 'READ_WRITE', region: 'users')]\n  class User { }` }] };
    const totalIssues = entities.reduce((s, e) => s + e.issues.length, 0);
    let text = `Doctrine Second Level Cache\n${'='.repeat(55)}\n\nEntities with @Cache: ${entities.length}  2LC enabled: ${slcEnabled ? 'yes' : '⚠ no'}  Issues: ${totalIssues}\n`;
    if (!slcEnabled) text += `  ⚠ 2LC not enabled in doctrine.yaml — @Cache annotations are ignored\n`;
    for (const e of entities.sort((a, b) => b.issues.length - a.issues.length)) {
      const region = e.cacheRegion ? `  region: ${e.cacheRegion}` : '  no region';
      const assocs = e.associationCaches.length > 0 ? `  assoc: ${e.associationCaches.map((a) => a.property).join(',')}` : '';
      text += `\n  ${e.class}  usage: ${e.cacheUsage}${region}${assocs}  (${e.file})\n`;
      for (const i of e.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineSecondLevelCacheStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const entities: SecondLevelCacheInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const e = parse2LCEntity(file, appPath);
        if (e) entities.push(e);
      }
    }
    let text = `Doctrine 2LC Statistics\n${'='.repeat(40)}\n\n`;
    text += `Entities with @Cache: ${entities.length}\n  READ_WRITE: ${entities.filter((e) => e.cacheUsage === 'READ_WRITE').length}\n  NONSTRICT_READ_WRITE: ${entities.filter((e) => e.cacheUsage === 'NONSTRICT_READ_WRITE').length}\n  With named region: ${entities.filter((e) => !!e.cacheRegion).length}\nIssues: ${entities.reduce((s, e) => s + e.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineSecondLevelCacheTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_second_level_cache', description: 'Show Doctrine Second Level Cache (#[ORM\\Cache]): usage mode (READ_WRITE/NONSTRICT_READ_WRITE), cache region, association cache, 2LC enabled check, missing region warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_second_level_cache_stats', description: 'Show Doctrine 2LC statistics: entity count by usage mode, named region count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
