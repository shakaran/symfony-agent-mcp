/**
 * Symfony Sonata Admin Inspector
 *
 * Scans src/**\/*.php for classes extending AbstractAdmin or implementing AdminInterface.
 * Extracts:
 *   - getEntityFqcn() — managed entity
 *   - configureListFields(), configureFormFields(), configureShowFields() — configured actions
 *
 * Flags: missing configureListFields, admin without security voter, no search enabled.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SonataAdminInfo {
  class: string;
  file: string;
  entity: string;
  actions: string[];
  issues: string[];
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

function extractEntityFqcn(content: string): string {
  // Look for getEntityFqcn() return statement
  const m = /function\s+getEntityFqcn\s*\([^)]{0,50}\)[^{]{0,50}\{[^}]{0,300}return\s+([^;]{1,150})/s.exec(content);
  if (!m) return 'unknown';
  const ret = m[1].trim();
  // Extract class reference from ::class or string
  const classM = /(\w+)::class/.exec(ret);
  if (classM) return classM[1];
  // Extract from quoted string
  const strM = /['"]([\\A-Za-z\d_]+)['"]\s*;/.exec(ret);
  if (strM) {
    const parts = strM[1].split('\\');
    return parts[parts.length - 1];
  }
  return ret.replace(/[^A-Za-z\d\\]/g, '').slice(0, 80);
}

function extractActions(content: string): string[] {
  const actions: string[] = [];
  if (content.includes('configureListFields')) actions.push('list');
  if (content.includes('configureFormFields')) actions.push('form');
  if (content.includes('configureShowFields')) actions.push('show');
  if (content.includes('configureDatagridFilters')) actions.push('filters');
  if (content.includes('configureRoutes') || content.includes('configureDefaultSortValues')) actions.push('routes');
  if (content.includes('configureExportFields')) actions.push('export');
  return actions;
}

function analyzeSonataAdminFile(filePath: string, appPath: string): SonataAdminInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  // Must extend AbstractAdmin or implement AdminInterface
  const isAdmin = content.includes('extends AbstractAdmin') ||
    content.includes('implements AdminInterface') ||
    content.includes('extends Admin');

  if (!isAdmin) return null;
  // Skip Sonata framework internals
  if (content.includes('namespace Sonata\\AdminBundle') || content.includes('namespace Sonata\\DoctrineORMAdminBundle')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const entity = extractEntityFqcn(content);
  const actions = extractActions(content);
  const issues: string[] = [];

  // Flag: missing configureListFields
  if (!actions.includes('list')) {
    issues.push('Admin class without configureListFields() — list view will be empty or use defaults');
  }

  // Flag: admin without security voter
  const hasVoter = content.includes('isGranted') || content.includes('checkAccess') ||
    content.includes('Security') || content.includes('voter') ||
    content.includes('hasAccess');
  if (!hasVoter) {
    issues.push('Admin class without security voter/isGranted check — all authenticated users can access this admin');
  }

  // Flag: no search enabled (no configureDatagridFilters or search fields)
  if (!actions.includes('filters') && !content.includes('searchable')) {
    issues.push('Admin class without configureDatagridFilters() — no search/filter available in list view');
  }

  // Flag: no show view (common oversight)
  if (!actions.includes('show') && actions.includes('list')) {
    issues.push('Admin class without configureShowFields() — detail view not configured');
  }

  // Flag: potential batch actions without confirmation
  if (content.includes('configureBatchActions') && !content.includes('askConfirmation')) {
    issues.push('Batch actions configured without confirmation prompt — add askConfirmation for destructive batch operations');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    entity,
    actions,
    issues,
  };
}

function buildSonataAdminInfos(appPath: string): SonataAdminInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: SonataAdminInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  for (const file of collectPhpFiles(srcDir, srcDir)) {
    const info = analyzeSonataAdminFile(file, appPath);
    if (info) results.push(info);
  }

  return results;
}

export function listSymfonySonataAdmin(appPath: string): McpToolResult {
  try {
    const infos = buildSonataAdminInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Sonata Admin classes (AbstractAdmin / AdminInterface) found in src/ PHP files.' }] };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);
    let text = `Symfony Sonata Admin Classes\n${'='.repeat(55)}\n\n`;
    text += `Admin classes found: ${infos.length}  (with issues: ${withIssues.length})\n\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `  ${info.class}  (${info.file})\n`;
      text += `    Entity:  ${info.entity}\n`;
      text += `    Actions: ${info.actions.length > 0 ? info.actions.join(', ') : 'none configured'}\n`;
      for (const issue of info.issues) {
        text += `    [WARN] ${issue}\n`;
      }
      if (info.issues.length === 0) text += `    OK\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySonataAdminStats(appPath: string): McpToolResult {
  try {
    const infos = buildSonataAdminInfos(appPath);

    const withList = infos.filter((i) => i.actions.includes('list')).length;
    const withForm = infos.filter((i) => i.actions.includes('form')).length;
    const withShow = infos.filter((i) => i.actions.includes('show')).length;
    const withFilters = infos.filter((i) => i.actions.includes('filters')).length;
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);

    let text = `Symfony Sonata Admin Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total admin classes: ${infos.length}\n\n`;
    text += `Action coverage:\n`;
    text += `  configureListFields:       ${withList}\n`;
    text += `  configureFormFields:       ${withForm}\n`;
    text += `  configureShowFields:       ${withShow}\n`;
    text += `  configureDatagridFilters:  ${withFilters}\n`;
    text += `\nTotal issues:      ${totalIssues}\n`;
    text += `Classes with issues: ${infos.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySonataAdminTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_sonata_admin',
      description: 'List Symfony Sonata Admin classes: entity managed, configured actions (list/form/show/filters/export), flags missing configureListFields, admin without security voter, no search, missing show view',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_sonata_admin_stats',
      description: 'Show Symfony Sonata Admin statistics: total admin classes, action coverage counts (list/form/show/filters), total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
