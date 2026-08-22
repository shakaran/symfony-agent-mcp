/**
 * Doctrine Association Fetch Strategy Inspector
 *
 * Detects per-association fetch strategy (LAZY / EAGER / EXTRA_LAZY) in entity mappings.
 * Pure static analysis — reads PHP source and XML/YAML mapping files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface AssociationFetchInfo {
  file: string;
  entityClass: string;
  property: string;
  fetchMode: string;
  associationType: string;
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

function getAllMappingFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllMappingFiles(full));
      else if (e.name.endsWith('.xml') || e.name.endsWith('.yaml') || e.name.endsWith('.yml')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

const ASSOCIATION_TYPES = ['OneToMany', 'ManyToMany', 'OneToOne', 'ManyToOne'];
const FETCH_MODES = ['EAGER', 'LAZY', 'EXTRA_LAZY'];

function parseFetchFromPhp(content: string, filePath: string): AssociationFetchInfo[] {
  const results: AssociationFetchInfo[] = [];
  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return results;
  const entityClass = classM[1];

  // Match PHP 8 attributes: #[OneToMany(..., fetch: 'EAGER', ...)]
  const attrPattern = /#\[(OneToMany|ManyToMany|OneToOne|ManyToOne)\s*\([^)]{0,500}\)/g;
  let m: RegExpExecArray | null;
  while ((m = attrPattern.exec(content)) !== null) {
    const assocType = m[1];
    const attrBody = m[0];
    const fetchM = /fetch\s*:\s*['"]?(EAGER|LAZY|EXTRA_LAZY)['"]?/i.exec(attrBody);
    if (!fetchM) continue;
    const fetchMode = fetchM[1].toUpperCase();

    // Try to extract property name from the next line after the attribute
    const attrEnd = (m.index ?? 0) + attrBody.length;
    const afterAttr = content.slice(attrEnd, attrEnd + 200);
    const propM = /(?:public|protected|private)\s+(?:(?:readonly|static)\s+){0,2}(?:\?\w{1,80}\s+)?\$(\w{1,80})/.exec(afterAttr);
    const property = propM ? propM[1] : '(unknown)';

    const issues: string[] = [];
    if (fetchMode === 'EAGER' && (assocType === 'OneToMany' || assocType === 'ManyToMany')) {
      issues.push(`EAGER fetch on ${assocType} collection — full collection loaded even when unused; risk of Cartesian product`);
    }
    if (fetchMode === 'EXTRA_LAZY' && (assocType === 'OneToOne' || assocType === 'ManyToOne')) {
      issues.push(`EXTRA_LAZY on ${assocType} has no effect — EXTRA_LAZY only works on XToMany associations`);
    }

    results.push({ file: path.basename(filePath), entityClass, property, fetchMode, associationType: assocType, issues });
  }

  // Match annotation style: @ORM\OneToMany(..., fetch="EAGER")
  const annotPattern = /@(?:ORM\\)?(OneToMany|ManyToMany|OneToOne|ManyToOne)\s*\([^)]{0,500}\)/g;
  while ((m = annotPattern.exec(content)) !== null) {
    const assocType = m[1];
    const annotBody = m[0];
    const fetchM = /fetch\s*=\s*["'](EAGER|LAZY|EXTRA_LAZY)["']/i.exec(annotBody);
    if (!fetchM) continue;
    const fetchMode = fetchM[1].toUpperCase();

    const annotEnd = (m.index ?? 0) + annotBody.length;
    const afterAnnot = content.slice(annotEnd, annotEnd + 300);
    const propM = /(?:public|protected|private)\s+(?:\?\w{1,80}\s+)?\$(\w{1,80})/.exec(afterAnnot);
    const property = propM ? propM[1] : '(unknown)';

    const issues: string[] = [];
    if (fetchMode === 'EAGER' && (assocType === 'OneToMany' || assocType === 'ManyToMany')) {
      issues.push(`EAGER fetch on ${assocType} collection — full collection loaded even when unused; Cartesian product risk`);
    }
    if (fetchMode === 'EXTRA_LAZY' && (assocType === 'OneToOne' || assocType === 'ManyToOne')) {
      issues.push(`EXTRA_LAZY on ${assocType} has no effect — only works on XToMany associations`);
    }

    results.push({ file: path.basename(filePath), entityClass, property, fetchMode, associationType: assocType, issues });
  }

  return results;
}

function parseFetchFromXml(content: string, filePath: string): AssociationFetchInfo[] {
  const results: AssociationFetchInfo[] = [];
  const xmlAssocPattern = /<(one-to-many|many-to-many|one-to-one|many-to-one)[^>]{0,500}>/g;
  let m: RegExpExecArray | null;
  while ((m = xmlAssocPattern.exec(content)) !== null) {
    const rawType = m[1];
    const assocType = rawType.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
    const tag = m[0];
    const fetchM = /fetch\s*=\s*["'](EAGER|LAZY|EXTRA_LAZY)["']/i.exec(tag);
    if (!fetchM) continue;
    const fetchMode = fetchM[1].toUpperCase();
    const fieldM = /field\s*=\s*["'](\w{1,80})["']/.exec(tag);
    const property = fieldM ? fieldM[1] : '(unknown)';

    const issues: string[] = [];
    if (fetchMode === 'EAGER' && (assocType === 'OneToMany' || assocType === 'ManyToMany')) {
      issues.push(`EAGER fetch on ${assocType} in XML mapping — full collection loaded; Cartesian product risk`);
    }
    if (fetchMode === 'EXTRA_LAZY' && (assocType === 'OneToOne' || assocType === 'ManyToOne')) {
      issues.push(`EXTRA_LAZY on ${assocType} in XML mapping has no effect`);
    }

    results.push({ file: path.basename(filePath), entityClass: path.basename(filePath, '.xml'), property, fetchMode, associationType: assocType, issues });
  }
  return results;
}

export function listDoctrineAssociationFetches(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: AssociationFetchInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const hasFetch = FETCH_MODES.some((f) => content.includes(f));
      const hasAssoc = ASSOCIATION_TYPES.some((a) => content.includes(a));
      if (!hasFetch || !hasAssoc) continue;
      results.push(...parseFetchFromPhp(content, file));
    }

    for (const dir of ['config/doctrine', 'src/Resources/config/doctrine']) {
      const mappingDir = path.join(appPath, dir);
      for (const file of getAllMappingFiles(mappingDir)) {
        let content = '';
        try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
        if (file.endsWith('.xml')) results.push(...parseFetchFromXml(content, file));
      }
    }

    results.sort((a, b) => a.entityClass.localeCompare(b.entityClass));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No explicit fetch strategy annotations found in src/ or mapping files.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Doctrine Association Fetch Strategy\n${'='.repeat(55)}\n`;
    text += `\nAssociations with explicit fetch: ${results.length}  Issues: ${totalIssues}\n`;

    const byMode: Record<string, AssociationFetchInfo[]> = {};
    for (const r of results) {
      (byMode[r.fetchMode] ??= []).push(r);
    }
    for (const mode of ['EAGER', 'EXTRA_LAZY', 'LAZY']) {
      const group = byMode[mode] ?? [];
      if (group.length === 0) continue;
      text += `\n${mode} (${group.length}):\n`;
      for (const r of group) {
        text += `  ${r.entityClass.padEnd(35)} $${r.property.padEnd(25)} [${r.associationType}]\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineAssociationFetchStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: AssociationFetchInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const hasFetch = FETCH_MODES.some((f) => content.includes(f));
      const hasAssoc = ASSOCIATION_TYPES.some((a) => content.includes(a));
      if (!hasFetch || !hasAssoc) continue;
      results.push(...parseFetchFromPhp(content, file));
    }

    let text = `Doctrine Association Fetch Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total explicit fetch strategies: ${results.length}\n`;
    for (const mode of ['EAGER', 'LAZY', 'EXTRA_LAZY']) {
      text += `  ${mode.padEnd(12)} ${results.filter((r) => r.fetchMode === mode).length}\n`;
    }
    text += `Total issues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineAssociationFetchTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_association_fetches',
      description: 'Detect per-association fetch strategy (LAZY/EAGER/EXTRA_LAZY) in PHP entity attributes/annotations and XML/YAML mappings: #[OneToMany(fetch:)], #[ManyToMany(fetch:)], #[OneToOne(fetch:)], #[ManyToOne(fetch:)]; warns on EAGER on large collections, EXTRA_LAZY on XToOne, EAGER on ManyToMany (Cartesian product)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_association_fetch_stats',
      description: 'Statistics for Doctrine association fetch strategies: total count, EAGER/LAZY/EXTRA_LAZY breakdown, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
