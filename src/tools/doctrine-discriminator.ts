import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DiscriminatorInfo {
  class: string;
  file: string;
  inheritanceType: string;
  discriminatorColumn?: string;
  discriminatorMap: Record<string, string>;
  childClasses: string[];
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

function parseDiscriminator(filePath: string, appPath: string): DiscriminatorInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('DiscriminatorMap') && !content.includes('InheritanceType')) return null;
  if (content.includes('namespace Doctrine\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const inheritM = /#\[ORM\\InheritanceType\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(content);
  if (!inheritM) return null;
  const inheritanceType = inheritM[1];
  const colM = /#\[ORM\\DiscriminatorColumn\s*\([^)]{0,200}\)/.exec(content);
  const colNameM = colM ? /name\s*:\s*['"]([^'"]+)['"]/i.exec(colM[0]) : null;
  const discriminatorColumn = colNameM?.[1];
  const mapM = /#\[ORM\\DiscriminatorMap\s*\(\s*\[([^\]]{0,800})\]/.exec(content);
  const discriminatorMap: Record<string, string> = {};
  if (mapM) {
    const pairPattern = /['"]([^'"]+)['"]\s*=>\s*(?:['"]([^'"]+)['"]|(\w+)::class)/g;
    let pm: RegExpExecArray | null;
    while ((pm = pairPattern.exec(mapM[1])) !== null) {
      discriminatorMap[pm[1]] = pm[2] ?? pm[3] ?? '';
    }
  }
  const childPattern = /extends\s+(\w+)\s*(?:implements|{)/g;
  const childClasses: string[] = [];
  let cm: RegExpExecArray | null;
  while ((cm = childPattern.exec(content)) !== null) {
    if (cm[1] !== classM[1]) childClasses.push(cm[1]);
  }
  const issues: string[] = [];
  if (Object.keys(discriminatorMap).length === 0) issues.push('InheritanceType without DiscriminatorMap — Doctrine may use class name as discriminator; explicit map is more stable');
  if (!discriminatorColumn) issues.push('No DiscriminatorColumn defined — defaults to dtype column; make explicit for clarity');
  if (inheritanceType === 'TABLE_PER_CLASS') issues.push('TABLE_PER_CLASS inheritance — polymorphic queries use UNION ALL; avoid for frequently queried hierarchies');
  return { class: classM[1], file: path.relative(appPath, filePath), inheritanceType, discriminatorColumn, discriminatorMap, childClasses, issues };
}

export function listDoctrineDiscriminators(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const entities: DiscriminatorInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const e = parseDiscriminator(file, appPath);
      if (e) entities.push(e);
    }
    if (entities.length === 0) return { content: [{ type: 'text', text: 'No Doctrine inheritance hierarchies (#[ORM\\InheritanceType]) found.' }] };
    const totalIssues = entities.reduce((s, e) => s + e.issues.length, 0);
    let text = `Doctrine Discriminator Map\n${'='.repeat(55)}\n\nHierarchies: ${entities.length}  Issues: ${totalIssues}\n`;
    for (const e of entities.sort((a, b) => b.issues.length - a.issues.length)) {
      const mapCount = Object.keys(e.discriminatorMap).length;
      const col = e.discriminatorColumn ? `  column: ${e.discriminatorColumn}` : '  no column';
      text += `\n  ${e.class}  type: ${e.inheritanceType}${col}  map entries: ${mapCount}  (${e.file})\n`;
      for (const [key, cls] of Object.entries(e.discriminatorMap)) text += `    ${key} => ${cls}\n`;
      for (const i of e.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineDiscriminatorStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const entities: DiscriminatorInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const e = parseDiscriminator(file, appPath);
        if (e) entities.push(e);
      }
    }
    let text = `Doctrine Discriminator Statistics\n${'='.repeat(40)}\n\n`;
    text += `Hierarchies: ${entities.length}\n  STI: ${entities.filter((e) => e.inheritanceType === 'SINGLE_TABLE').length}\n  CTI: ${entities.filter((e) => e.inheritanceType === 'JOINED').length}\n  TPC: ${entities.filter((e) => e.inheritanceType === 'TABLE_PER_CLASS').length}\n  With explicit map: ${entities.filter((e) => Object.keys(e.discriminatorMap).length > 0).length}\nIssues: ${entities.reduce((s, e) => s + e.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineDiscriminatorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_discriminators', description: 'Show Doctrine inheritance hierarchies: InheritanceType (STI/CTI/TPC), DiscriminatorColumn, DiscriminatorMap entries, missing map warning, TABLE_PER_CLASS performance warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_discriminator_stats', description: 'Show Doctrine discriminator statistics: hierarchy count by type, explicit map count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
