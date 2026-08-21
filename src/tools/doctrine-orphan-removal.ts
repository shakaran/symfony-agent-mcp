import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface OrphanRemovalInfo {
  class: string;
  file: string;
  property: string;
  relationType: string;
  hasCascadePersist: boolean;
  hasCascadeRemove: boolean;
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

function parseOrphanRemoval(filePath: string, appPath: string): OrphanRemovalInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  if (!content.includes('orphanRemoval') && !content.includes('orphan_removal')) return [];
  if (!content.includes('ORM\\')) return [];
  if (content.includes('namespace Doctrine\\')) return [];
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return [];
  const found: OrphanRemovalInfo[] = [];
  const orPattern = /#\[ORM\\(OneToMany|OneToOne)[^\]]{0,600}orphanRemoval\s*:\s*true[^\]]{0,600}\]/g;
  let m: RegExpExecArray | null;
  while ((m = orPattern.exec(content)) !== null) {
    const block = m[0];
    const relationType = m[1];
    const propContextM = /\]\s*(?:#\[[^\]]+\]\s*)*(?:public|protected|private)\s+(?:\w+\s+)?\$(\w+)/.exec(content.slice(m.index, m.index + 400));
    const property = propContextM?.[1] ?? 'unknown';
    const hasCascadePersist = /cascade\s*:\s*\[[^\]]*persist[^\]]*\]/i.test(block) || /cascade\s*:\s*\[[^\]]*all[^\]]*\]/i.test(block);
    const hasCascadeRemove = /cascade\s*:\s*\[[^\]]*remove[^\]]*\]/i.test(block) || /cascade\s*:\s*\[[^\]]*all[^\]]*\]/i.test(block);
    const issues: string[] = [];
    if (!hasCascadePersist) issues.push(`$${property}: orphanRemoval without cascade=PERSIST — new children not persisted via parent; add cascade: ['persist']`);
    if (hasCascadeRemove) issues.push(`$${property}: orphanRemoval + cascade=REMOVE — removal happens twice; cascade=REMOVE is redundant with orphanRemoval`);
    found.push({ class: classM[1], file: path.relative(appPath, filePath), property, relationType, hasCascadePersist, hasCascadeRemove, issues });
  }
  return found;
}

export function listDoctrineOrphanRemoval(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const all: OrphanRemovalInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      all.push(...parseOrphanRemoval(file, appPath));
    }
    if (all.length === 0) return { content: [{ type: 'text', text: 'No orphanRemoval associations found.' }] };
    const totalIssues = all.reduce((s, o) => s + o.issues.length, 0);
    let text = `Doctrine orphanRemoval\n${'='.repeat(55)}\n\nAssociations: ${all.length}  Issues: ${totalIssues}\n`;
    for (const o of all.sort((a, b) => b.issues.length - a.issues.length)) {
      const cascade = [o.hasCascadePersist ? '✓ persist' : '⚠ no persist', o.hasCascadeRemove ? '⚠ remove (redundant)' : ''].filter(Boolean).join('  ');
      text += `\n  ${o.class}::$${o.property}  ${o.relationType}  cascade: ${cascade}  (${o.file})\n`;
      for (const i of o.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineOrphanRemovalStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const all: OrphanRemovalInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        all.push(...parseOrphanRemoval(file, appPath));
      }
    }
    let text = `Doctrine orphanRemoval Statistics\n${'='.repeat(40)}\n\n`;
    text += `Associations with orphanRemoval: ${all.length}\n  With cascade persist: ${all.filter((o) => o.hasCascadePersist).length}\n  With redundant cascade remove: ${all.filter((o) => o.hasCascadeRemove).length}\nIssues: ${all.reduce((s, o) => s + o.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineOrphanRemovalTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_orphan_removal', description: 'Show Doctrine orphanRemoval associations: OneToMany/OneToOne with orphanRemoval:true, cascade persist/remove presence, missing cascade persist warning, redundant cascade remove warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_orphan_removal_stats', description: 'Show orphanRemoval statistics: association count, cascade persist count, redundant cascade remove count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
