/**
 * Doctrine Entity State Inspector
 *
 * Distinct from doctrine-lifecycle.ts (lifecycle callbacks), doctrine-bulk-operations.ts (batching),
 * and repository-analyzer.ts (N+1 detection). Focuses on entity identity map state transitions:
 *
 * - Scans src/ PHP for: $em->detach(, $em->merge( (deprecated Doctrine 3), $em->refresh(,
 *   $em->contains(, UnitOfWork::STATE_ constants usage, getEntityState() calls
 * - Detects: merge() usage (removed in Doctrine ORM 3), detach + re-persist patterns,
 *   contains() checks before persist
 *
 * Warnings:
 *   - $em->merge() usage (removed in Doctrine ORM 3, use persist() on detached entity instead)
 *   - $em->detach() without subsequent handling (entity becomes stale)
 *   - $em->refresh() on newly created entity (makes no sense — not in DB yet)
 *   - Entity state check without contains() (may lead to double-persist)
 *   - Operating on detached entity without re-attaching (changes lost on flush)
 *   - merge() in event listener (causes recursive flush)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DoctrineEntityStateInfo {
  file: string;
  class: string;
  hasMerge: boolean;
  hasDetach: boolean;
  hasRefresh: boolean;
  hasContains: boolean;
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

function parseEntityStateFile(filePath: string): DoctrineEntityStateInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasStateCode = content.includes('->detach(') ||
    content.includes('->merge(') ||
    content.includes('->refresh(') ||
    content.includes('->contains(') ||
    content.includes('UnitOfWork::STATE_') ||
    content.includes('getEntityState(');

  if (!hasStateCode) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasMerge = content.includes('->merge(');
  const hasDetach = content.includes('->detach(');
  const hasRefresh = content.includes('->refresh(');
  const hasContains = content.includes('->contains(');
  const hasGetEntityState = content.includes('getEntityState(');
  const hasUoWState = content.includes('UnitOfWork::STATE_');

  const isEventListener = content.includes('EventSubscriber') ||
    content.includes('EventListener') ||
    content.includes('onFlush') ||
    content.includes('preFlush') ||
    content.includes('postFlush') ||
    content.includes('prePersist') ||
    content.includes('postPersist');

  const normalizedPath = filePath.replace(/\\/g, '/');
  const isTest = normalizedPath.includes('/Test') ||
    normalizedPath.includes('/tests/') ||
    content.includes('TestCase');

  const issues: string[] = [];

  if (hasMerge) {
    issues.push('$em->merge() is removed in Doctrine ORM 3 — replace with $em->persist() on the detached entity; check for unintentional data overwrite');
    if (isEventListener) {
      issues.push('$em->merge() inside event listener — can cause recursive flush loop and UnitOfWork corruption');
    }
  }

  if (hasDetach) {
    const hasSubsequentPersist = content.includes('->persist(') || content.includes('->merge(');
    if (!hasSubsequentPersist && !isTest) {
      issues.push('$em->detach() without subsequent persist/re-attach — any changes made to the detached entity will be lost on flush');
    }
  }

  if (hasRefresh) {
    const hasNewEntity = content.includes('new ') && content.indexOf('new ') < content.indexOf('->refresh(');
    if (hasNewEntity) {
      issues.push('$em->refresh() called near entity instantiation — refresh on a new (not yet persisted) entity throws InvalidArgumentException');
    }
  }

  if (hasGetEntityState && !hasContains) {
    issues.push('getEntityState() used without ->contains() check — entity state transitions can be unexpected; use $em->contains($entity) to check if managed');
  }

  if (hasUoWState && !isTest) {
    issues.push('Direct UnitOfWork::STATE_ constant usage in business code — UnitOfWork internals are implementation details; avoid coupling to internal state machine');
  }

  if (hasDetach && hasRefresh) {
    issues.push('$em->detach() and $em->refresh() used together — refresh after detach throws exception; refresh only managed entities');
  }

  return {
    file: path.basename(filePath),
    class: classM[1],
    hasMerge,
    hasDetach,
    hasRefresh,
    hasContains,
    issues,
  };
}

export function listDoctrineEntityState(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DoctrineEntityStateInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseEntityStateFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine entity state management (detach/merge/refresh/contains) found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `Doctrine Entity State Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Issues: ${totalIssues}\n`;

    const mergeUsers = results.filter((r) => r.hasMerge);
    if (mergeUsers.length > 0) {
      text += `\n⚠ merge() usage — removed in Doctrine ORM 3 (${mergeUsers.length}):\n`;
      for (const r of mergeUsers) {
        text += `  ${r.class.padEnd(45)} (${r.file})\n`;
        for (const issue of r.issues.filter((i) => i.includes('merge'))) text += `    ⚠ ${issue}\n`;
      }
    }

    const withIssues = results.filter((r) => r.issues.length > 0 && !r.hasMerge);
    if (withIssues.length > 0) {
      text += `\nOther state issues (${withIssues.length}):\n`;
      for (const r of withIssues) {
        const flags: string[] = [];
        if (r.hasDetach) flags.push('detach');
        if (r.hasRefresh) flags.push('refresh');
        if (r.hasContains) flags.push('contains');
        text += `  ${r.class.padEnd(45)} (${r.file})`;
        if (flags.length > 0) text += ` [${flags.join(', ')}]`;
        text += '\n';
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    const clean = results.filter((r) => r.issues.length === 0);
    if (clean.length > 0) {
      text += `\nClean entity state usage (${clean.length}):\n`;
      for (const r of clean) {
        const flags: string[] = [];
        if (r.hasDetach) flags.push('detach');
        if (r.hasRefresh) flags.push('refresh');
        if (r.hasContains) flags.push('contains');
        text += `  ${r.class.padEnd(45)} (${r.file}) [${flags.join(', ')}]\n`;
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

export function getDoctrineEntityStateStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DoctrineEntityStateInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseEntityStateFile(file);
      if (info) results.push(info);
    }

    let text = `Doctrine Entity State Statistics\n${'='.repeat(42)}\n\n`;
    text += `Total files with entity state ops: ${results.length}\n`;
    text += `  With merge() [deprecated]:       ${results.filter((r) => r.hasMerge).length}\n`;
    text += `  With detach():                   ${results.filter((r) => r.hasDetach).length}\n`;
    text += `  With refresh():                  ${results.filter((r) => r.hasRefresh).length}\n`;
    text += `  With contains():                 ${results.filter((r) => r.hasContains).length}\n`;
    text += `Issues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineEntityStateTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_entity_state',
      description: 'Show Doctrine entity state management: detach/merge/refresh/contains/UnitOfWork usage; warns on merge() removed in Doctrine ORM 3, detach without re-attach (lost changes), refresh on new entity (exception), getEntityState without contains(), UnitOfWork internals in business code, merge in event listener (recursive flush risk)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_entity_state_stats',
      description: 'Show Doctrine entity state statistics: total files, merge/detach/refresh/contains usage counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
