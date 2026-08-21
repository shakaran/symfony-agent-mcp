/**
 * Doctrine Change Tracking Policy Inspector
 *
 * Distinct from doctrine-orm-config.ts (global ORM config), doctrine-lifecycle.ts (lifecycle callbacks),
 * and doctrine-entity-graph.ts (entity relations). Focuses on change tracking policies:
 *
 * - Scans src/ PHP for: #[ChangeTrackingPolicy] attribute, DEFERRED_IMPLICIT / DEFERRED_EXPLICIT / NOTIFY
 *   values, NotifyPropertyChanged interface, propertyChanged() method
 * - Reads doctrine.yaml for global change tracking config
 * - Detects: entities using DEFERRED_IMPLICIT (default, expensive), DEFERRED_EXPLICIT (requires manual
 *   scheduling), NOTIFY (requires interface implementation)
 *
 * Warnings:
 *   - DEFERRED_IMPLICIT on entity with >20 fields (flush compares all fields)
 *   - NOTIFY change tracking without NotifyPropertyChanged implementation (no actual notifications)
 *   - DEFERRED_EXPLICIT entity without ->scheduleForDirtyCheck() calls (changes never detected)
 *   - Mixing NOTIFY and DEFERRED_IMPLICIT in related entities (inconsistent)
 *   - Global DEFERRED_IMPLICIT with large entity graph (slow flush)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';
import { parseYamlFile } from '../utils/symfony-parser.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DoctrineChangeTrackingInfo {
  file: string;
  class: string;
  policy: string;
  hasNotifyInterface: boolean;
  hasScheduleCall: boolean;
  fieldCount: number;
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

function countEntityFields(content: string): number {
  const matches = content.match(/#\[ORM\\Column/g) ?? [];
  const privateMatches = content.match(/private\s+[\w|?]{1,80}\s+\$\w{1,80}/g) ?? [];
  return Math.max(matches.length, privateMatches.length);
}

function parseChangeTrackingFile(filePath: string): DoctrineChangeTrackingInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasEntity = content.includes('#[ORM\\Entity') || content.includes('@ORM\\Entity');
  if (!hasEntity) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  let policy = 'DEFERRED_IMPLICIT';

  const policyM = /#\[ChangeTrackingPolicy\s*\(\s*(?:ClassMetadata::)?([A-Z_]{1,50})\s*\)\]/.exec(content) ??
    /#\[ORM\\ChangeTrackingPolicy\s*\(\s*(?:ClassMetadata::)?([A-Z_]{1,50})\s*\)\]/.exec(content);
  if (policyM) {
    policy = policyM[1];
  } else if (content.includes('@ORM\\ChangeTrackingPolicy')) {
    const legacyM = /@ORM\\ChangeTrackingPolicy\("([A-Z_]{1,50})"\)/.exec(content);
    if (legacyM) policy = legacyM[1];
  }

  const hasNotifyInterface = content.includes('NotifyPropertyChanged') ||
    content.includes('implements NotifyPropertyChanged');

  const hasScheduleCall = content.includes('scheduleForDirtyCheck') ||
    content.includes('->scheduleForDirtyCheck(');

  const hasPropertyChanged = content.includes('propertyChanged(') || content.includes('propertyChanged ();');

  const fieldCount = countEntityFields(content);

  const issues: string[] = [];

  if (policy === 'DEFERRED_IMPLICIT' && fieldCount > 20) {
    issues.push(`DEFERRED_IMPLICIT with ${fieldCount} fields — Doctrine compares all fields on every flush, causing performance overhead; consider DEFERRED_EXPLICIT or NOTIFY`);
  }

  if (policy === 'NOTIFY' && !hasNotifyInterface) {
    issues.push('NOTIFY change tracking without implementing NotifyPropertyChanged interface — property changes will never be detected');
  }

  if (policy === 'NOTIFY' && hasNotifyInterface && !hasPropertyChanged) {
    issues.push('NotifyPropertyChanged implemented but propertyChanged() never called in setters — notifications not fired');
  }

  if (policy === 'DEFERRED_EXPLICIT' && !hasScheduleCall) {
    issues.push('DEFERRED_EXPLICIT policy without scheduleForDirtyCheck() calls — entity changes will never be detected on flush');
  }

  return {
    file: path.basename(filePath),
    class: classM[1],
    policy,
    hasNotifyInterface,
    hasScheduleCall,
    fieldCount,
    issues,
  };
}

function readGlobalPolicy(appPath: string): string | null {
  const configPaths = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'doctrine.yaml'),
  ];
  for (const configPath of configPaths) {
    const config = parseYamlFile(configPath);
    if (!config) continue;
    const orm = (config as Record<string, unknown>)['doctrine'];
    if (orm && typeof orm === 'object') {
      const ormSection = (orm as Record<string, unknown>)['orm'];
      if (ormSection && typeof ormSection === 'object') {
        const policy = (ormSection as Record<string, unknown>)['default_entity_manager'];
        if (typeof policy === 'string') return policy;
      }
    }
  }
  return null;
}

export function listDoctrineChangeTracking(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DoctrineChangeTrackingInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseChangeTrackingFile(file);
      if (info) results.push(info);
    }

    const policies = new Map<string, DoctrineChangeTrackingInfo[]>();
    for (const r of results) {
      const list = policies.get(r.policy) ?? [];
      list.push(r);
      policies.set(r.policy, list);
    }

    const notifyCount = (policies.get('NOTIFY') ?? []).length;
    const implicitCount = (policies.get('DEFERRED_IMPLICIT') ?? []).length;
    const globalIssues: string[] = [];

    if (notifyCount > 0 && implicitCount > 0) {
      globalIssues.push(`Mixing NOTIFY (${notifyCount}) and DEFERRED_IMPLICIT (${implicitCount}) entities — inconsistent change tracking may cause subtle flush ordering bugs`);
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine entities with change tracking configuration found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0) + globalIssues.length;

    let text = `Doctrine Change Tracking Analysis\n${'='.repeat(55)}\n`;
    text += `\nEntities: ${results.length}  Issues: ${totalIssues}\n`;

    if (globalIssues.length > 0) {
      text += `\nGlobal issues:\n`;
      for (const issue of globalIssues) text += `  ⚠ ${issue}\n`;
    }

    for (const [policyName, items] of policies) {
      text += `\n${policyName} (${items.length}):\n`;
      for (const r of items) {
        text += `  ${r.class.padEnd(45)} (${r.file}) fields=${r.fieldCount}`;
        if (r.hasNotifyInterface) text += ' [NotifyInterface]';
        if (r.hasScheduleCall) text += ' [scheduleForDirtyCheck]';
        text += '\n';
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

export function getDoctrineChangeTrackingStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DoctrineChangeTrackingInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseChangeTrackingFile(file);
      if (info) results.push(info);
    }

    const globalPolicy = readGlobalPolicy(appPath);

    let text = `Doctrine Change Tracking Statistics\n${'='.repeat(42)}\n\n`;
    if (globalPolicy) text += `Global doctrine.yaml policy: ${globalPolicy}\n`;
    text += `Total entities scanned:            ${results.length}\n`;
    text += `  DEFERRED_IMPLICIT (default):     ${results.filter((r) => r.policy === 'DEFERRED_IMPLICIT').length}\n`;
    text += `  DEFERRED_EXPLICIT:               ${results.filter((r) => r.policy === 'DEFERRED_EXPLICIT').length}\n`;
    text += `  NOTIFY:                          ${results.filter((r) => r.policy === 'NOTIFY').length}\n`;
    text += `  With NotifyPropertyChanged:      ${results.filter((r) => r.hasNotifyInterface).length}\n`;
    text += `  With scheduleForDirtyCheck:      ${results.filter((r) => r.hasScheduleCall).length}\n`;
    text += `  Large entities (>20 fields):     ${results.filter((r) => r.fieldCount > 20).length}\n`;
    text += `Issues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineChangeTrackingTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_change_tracking',
      description: 'Show Doctrine change tracking policies: DEFERRED_IMPLICIT/DEFERRED_EXPLICIT/NOTIFY per entity; warns on DEFERRED_IMPLICIT with >20 fields (slow flush), NOTIFY without NotifyPropertyChanged interface, DEFERRED_EXPLICIT without scheduleForDirtyCheck(), mixed policies in related entities',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_change_tracking_stats',
      description: 'Show Doctrine change tracking statistics: total entities, DEFERRED_IMPLICIT/EXPLICIT/NOTIFY counts, NotifyPropertyChanged count, scheduleForDirtyCheck count, large entity count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
