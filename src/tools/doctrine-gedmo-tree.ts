import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface GedmoTreeInfo {
  file: string;
  entity: string;
  treeType: string;
  fields: string[];
  issues: string[];
}

const NESTED_REQUIRED = ['TreeLeft', 'TreeRight', 'TreeRoot', 'TreeLevel', 'TreeParent'];

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

function extractEntityName(content: string, filePath: string): string {
  const classMatch = /class\s+([A-Za-z_][A-Za-z0-9_]{0,100})/.exec(content);
  return classMatch ? classMatch[1] : path.basename(filePath, '.php');
}

function extractTreeType(content: string): string | null {
  const attrRe = /#\[Gedmo\\Tree\s*\(\s*type\s*:\s*["']([^"']{1,50})["']/.exec(content);
  if (attrRe) return attrRe[1];
  const annotRe = /@Tree\s*\(\s*type\s*=\s*["']([^"']{1,50})["']/.exec(content);
  if (annotRe) return annotRe[1];
  if (content.includes('#[Gedmo\\Tree') || content.includes('@Tree')) return 'nested';
  return null;
}

function extractGedmoFields(content: string): string[] {
  const fields: string[] = [];
  const fieldRe = /#\[Gedmo\\(Tree[A-Za-z]{1,40})\]|@(Tree[A-Za-z]{1,40})\b/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(content)) !== null) {
    const fieldName = m[1] ?? m[2];
    if (fieldName && !fields.includes(fieldName)) fields.push(fieldName);
  }
  return fields;
}

function buildGedmoTreeInfos(appPath: string): GedmoTreeInfo[] {
  const results: GedmoTreeInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasTree = content.includes('Gedmo\\Tree') || content.includes('@Tree') ||
      content.includes('use Gedmo\\Tree\\') || content.includes('use Stof\\DoctrineExtensionsBundle\\');
    if (!hasTree) continue;

    const treeType = extractTreeType(content);
    if (!treeType) continue;

    const relFile = path.relative(appPath, file);
    const entity = extractEntityName(content, file);
    const fields = extractGedmoFields(content);
    const issues: string[] = [];

    if (treeType === 'nested') {
      const missingFields = NESTED_REQUIRED.filter((f) => !fields.includes(f));
      if (missingFields.length > 0) {
        issues.push(`Nested set tree "${entity}" missing required Gedmo fields: ${missingFields.join(', ')} — all five fields (left, right, root, level, parent) are required for nested set trees`);
      }
      if (fields.includes('TreeRoot')) {
        const rootPropRe = /#\[Gedmo\\TreeRoot\][^;]{0,300}(nullable\s*=\s*false|NOT\s+NULL)/;
        if (rootPropRe.test(content)) {
          issues.push(`TreeRoot field in "${entity}" appears non-nullable — root field must be nullable (null for root nodes) otherwise root node insertion fails`);
        }
      }
    }

    if (treeType === 'closure') {
      const closureRe = /#\[Gedmo\\TreeClosure\s*\([^)]{0,200}\)/.exec(content);
      if (!closureRe) {
        issues.push(`Closure tree "${entity}" missing #[Gedmo\\TreeClosure(class: ClosureEntity::class)] attribute — closure entity must be mapped`);
      }
    }

    if (treeType === 'materializedPath') {
      if (!fields.includes('TreePath')) {
        issues.push(`Materialized path tree "${entity}" missing #[Gedmo\\TreePath] field — required for materialized path strategy`);
      }
      if (!fields.includes('TreePathSource')) {
        issues.push(`Materialized path tree "${entity}" missing #[Gedmo\\TreePathSource] field — path source field required`);
      }
    }

    if (content.includes('use Stof\\DoctrineExtensionsBundle\\') && !content.includes('stof_doctrine_extensions')) {
      issues.push(`"${entity}" uses StofDoctrineExtensionsBundle trait but stof_doctrine_extensions config may not enable tree listener`);
    }

    results.push({ file: relFile, entity, treeType, fields, issues });
  }

  return results;
}

export function listDoctrineGedmoTree(appPath: string): McpToolResult {
  try {
    const infos = buildGedmoTreeInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Gedmo Tree entities found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Gedmo Tree Analysis\n${'='.repeat(55)}\n\nEntities: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  ${info.entity}  [${info.treeType}]  (${info.file})\n`;
      if (info.fields.length) text += `    fields: ${info.fields.join(', ')}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineGedmoTreeStats(appPath: string): McpToolResult {
  try {
    const infos = buildGedmoTreeInfos(appPath);
    let text = `Gedmo Tree Statistics\n${'='.repeat(40)}\n\n`;
    const types = ['nested', 'closure', 'materializedPath'];
    for (const t of types) {
      text += `${t}: ${infos.filter((i) => i.treeType === t).length}\n`;
    }
    text += `Issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineGedmoTreeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_gedmo_tree',
      description: 'Scan PHP entities for Gedmo Tree extension (nested set, closure table, materializedPath); detects #[Gedmo\\Tree] type, required fields for each strategy, missing closure entity mapping, non-nullable root field, missing materializedPath fields',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_gedmo_tree_stats',
      description: 'Statistics for Gedmo Tree: count per strategy type (nested/closure/materializedPath), issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
