import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface MappingFormatInfo {
  directory: string;
  type: string;
  phpFilesCount: number;
  xmlFilesCount: number;
  yamlFilesCount: number;
  issues: string[];
}


function countFilesWithExt(dir: string, ext: string): number {
  let count = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      if (e.isFile() && e.name.endsWith(ext)) count++;
      else if (e.isDirectory()) count += countFilesWithExt(path.join(dir, e.name), ext);
    }
  } catch { /* skip */ }
  return count;
}

function countPhpWithOrmAttribute(dir: string): number {
  let count = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) count += countPhpWithOrmAttribute(full);
      else if (e.name.endsWith('.php')) {
        let content = '';
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        if (content.includes('#[ORM\\') || content.includes('#[Doctrine\\ORM\\') || content.includes('@ORM\\') || content.includes('@Entity')) count++;
      }
    }
  } catch { /* skip */ }
  return count;
}

function loadMappingConfig(appPath: string): MappingFormatInfo[] {
  const infos: MappingFormatInfo[] = [];
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'doctrine.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
    const orm = (doctrine['orm'] ?? {}) as Record<string, unknown>;
    const mappings = (orm['mappings'] ?? {}) as Record<string, unknown>;
    for (const [name, def] of Object.entries(mappings)) {
      const d = (def ?? {}) as Record<string, unknown>;
      const type = String(d['type'] ?? 'attribute');
      const dir = String(d['dir'] ?? '');
      const absDir = dir.startsWith('%') ? path.join(appPath, 'src', 'Entity') : (path.isAbsolute(dir) ? dir : path.join(appPath, dir));
      const xmlFilesCount = countFilesWithExt(absDir, '.xml');
      const yamlFilesCount = countFilesWithExt(absDir, '.yaml') + countFilesWithExt(absDir, '.yml');
      const phpFilesCount = countPhpWithOrmAttribute(absDir);
      const issues: string[] = [];
      if (xmlFilesCount > 0 && phpFilesCount > 0) issues.push(`Mixed XML + attribute mapping in "${name}" — standardize to one format`);
      if (yamlFilesCount > 0 && phpFilesCount > 0) issues.push(`Mixed YAML + attribute mapping in "${name}" — standardize to one format`);
      if (xmlFilesCount > 0 && yamlFilesCount > 0) issues.push(`Mixed XML + YAML mapping in "${name}" — use a single format`);
      if (type === 'annotation') issues.push(`Mapping type "annotation" is deprecated (Doctrine 2) — migrate to "attribute" (PHP 8)`);
      infos.push({ directory: dir || absDir, type, phpFilesCount, xmlFilesCount, yamlFilesCount, issues });
    }
  }
  if (infos.length === 0) {
    const entityDir = path.join(appPath, 'src', 'Entity');
    if (fs.existsSync(entityDir)) {
      const xmlFilesCount = countFilesWithExt(entityDir, '.xml');
      const yamlFilesCount = countFilesWithExt(entityDir, '.yaml');
      const phpFilesCount = countPhpWithOrmAttribute(entityDir);
      const issues: string[] = [];
      if (xmlFilesCount > 0 && phpFilesCount > 0) issues.push('Mixed XML + attribute mapping — standardize to one format');
      infos.push({ directory: 'src/Entity', type: 'attribute (inferred)', phpFilesCount, xmlFilesCount, yamlFilesCount, issues });
    }
  }
  return infos;
}

export function listDoctrineMappingFormat(appPath: string): McpToolResult {
  try {
    const infos = loadMappingConfig(appPath);
    if (infos.length === 0) return { content: [{ type: 'text', text: 'No Doctrine entity mapping directories found.' }] };
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Mapping Format\n${'='.repeat(55)}\n\nMapping sets: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.directory}  type: ${info.type}\n    PHP attributes: ${info.phpFilesCount}  XML: ${info.xmlFilesCount}  YAML: ${info.yamlFilesCount}\n`;
      for (const i of info.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineMappingFormatStats(appPath: string): McpToolResult {
  try {
    const infos = loadMappingConfig(appPath);
    const totalPHP = infos.reduce((s, i) => s + i.phpFilesCount, 0);
    const totalXML = infos.reduce((s, i) => s + i.xmlFilesCount, 0);
    const totalYAML = infos.reduce((s, i) => s + i.yamlFilesCount, 0);
    let text = `Doctrine Mapping Format Statistics\n${'='.repeat(40)}\n\n`;
    text += `Mapping sets: ${infos.length}\nPHP attribute files: ${totalPHP}\nXML mapping files: ${totalXML}\nYAML mapping files: ${totalYAML}\nMixed-format sets: ${infos.filter(i => i.issues.length > 0).length}\nIssues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineMappingFormatTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_mapping_format', description: 'Check Doctrine entity mapping format consistency: XML vs PHP attributes vs YAML, mixed-format warning per mapping set, deprecated annotation type warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_mapping_format_stats', description: 'Doctrine mapping format statistics: PHP/XML/YAML file counts, mixed-format sets, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
