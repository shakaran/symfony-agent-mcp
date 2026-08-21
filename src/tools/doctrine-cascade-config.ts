import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface CascadeInfo {
  class: string;
  file: string;
  property: string;
  cascadeTypes: string[];
  hasAll: boolean;
  hasOrphanRemoval: boolean;
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

function parseCascadeConfig(filePath: string, appPath: string): CascadeInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  if (!content.includes('cascade') && !content.includes('orphanRemoval')) return [];
  if (!content.includes('ORM\\') && !content.includes('@ORM')) return [];
  if (content.includes('namespace Doctrine\\')) return [];
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return [];
  const found: CascadeInfo[] = [];
  const assocPattern = /#\[ORM\\(?:OneToMany|ManyToMany|OneToOne|ManyToOne)[^\]]{0,600}\]/g;
  let m: RegExpExecArray | null;
  while ((m = assocPattern.exec(content)) !== null) {
    const attrBlock = m[0];
    if (!attrBlock.includes('cascade')) continue;
    const propM = /targetEntity[^)]+\)[\s\S]{0,200}(?:public|protected|private)\s+(?:\w+\s+)?\$(\w+)/.exec(content.slice(m.index, m.index + 500));
    const property = propM?.[1] ?? 'unknown';
    const cascadeM = /cascade\s*:\s*\[([^\]]{0,200})\]/.exec(attrBlock);
    const cascadeTypes = cascadeM ? cascadeM[1].replace(/['"]/g, '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
    const hasAll = cascadeTypes.includes('all');
    const orphanBlockRe = new RegExp(`\\$${property}[^;]{0,300}orphanRemoval\\s*:\\s*true`);
    const hasOrphanRemoval = orphanBlockRe.test(content);
    const issues: string[] = [];
    if (hasAll) issues.push(`$${property}: cascade=ALL includes REMOVE — deleting parent deletes all children; verify intent`);
    if (cascadeTypes.includes('remove') && !hasOrphanRemoval) issues.push(`$${property}: cascade=REMOVE without orphanRemoval — unlinked children remain in DB`);
    if (hasAll && cascadeTypes.length > 1) issues.push(`$${property}: cascade=ALL with extra types — "all" already covers them`);
    found.push({ class: classM[1], file: path.relative(appPath, filePath), property, cascadeTypes, hasAll, hasOrphanRemoval, issues });
  }
  return found;
}

export function listDoctrineCascadeConfig(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const all: CascadeInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      all.push(...parseCascadeConfig(file, appPath));
    }
    if (all.length === 0) return { content: [{ type: 'text', text: 'No Doctrine cascade configuration found.' }] };
    const totalIssues = all.reduce((s, c) => s + c.issues.length, 0);
    let text = `Doctrine Cascade Configuration\n${'='.repeat(55)}\n\nCascaded associations: ${all.length}  Issues: ${totalIssues}\n`;
    text += `  cascade=ALL: ${all.filter((c) => c.hasAll).length}  With orphanRemoval: ${all.filter((c) => c.hasOrphanRemoval).length}\n`;
    for (const c of all.sort((a, b) => b.issues.length - a.issues.length)) {
      const types = c.cascadeTypes.join(', ');
      const orphan = c.hasOrphanRemoval ? '  orphanRemoval' : '';
      text += `\n  ${c.class}::$${c.property}  cascade: ${types}${orphan}  (${c.file})\n`;
      for (const i of c.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineCascadeStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const all: CascadeInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        all.push(...parseCascadeConfig(file, appPath));
      }
    }
    let text = `Doctrine Cascade Statistics\n${'='.repeat(40)}\n\n`;
    text += `Cascaded associations: ${all.length}\n  cascade=ALL: ${all.filter((c) => c.hasAll).length}\n  With REMOVE: ${all.filter((c) => c.cascadeTypes.includes('remove')).length}\n  With PERSIST: ${all.filter((c) => c.cascadeTypes.includes('persist')).length}\n  With orphanRemoval: ${all.filter((c) => c.hasOrphanRemoval).length}\nIssues: ${all.reduce((s, c) => s + c.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineCascadeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_cascade_config', description: 'Show Doctrine cascade configuration: cascade=ALL/PERSIST/REMOVE per association, orphanRemoval, cascade=ALL with REMOVE warning, REMOVE without orphanRemoval warning, redundant types warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_cascade_stats', description: 'Show Doctrine cascade statistics: association counts by type, orphanRemoval count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
