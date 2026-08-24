// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface WorkflowPersistenceInfo {
  source: string;
  type: 'marking-store' | 'doctrine' | 'session' | 'logging';
  pattern: string;
  issues: string[];
}

function buildSymfonyWorkflowPersistenceInfos(appPath: string): WorkflowPersistenceInfo[] {
  const results: WorkflowPersistenceInfo[] = [];

  const workflowConfig = path.join(appPath, 'config', 'packages', 'workflow.yaml');
  if (fs.existsSync(workflowConfig)) {
    let content = '';
    try { content = fs.readFileSync(workflowConfig, 'utf-8'); } catch { /* skip */ }

    const hasMarkingStore = content.includes('marking_store');
    const hasDoctrineStore = content.includes('doctrine_marking_store') || content.includes('doctrine');
    const hasSessionStore = content.includes('session');
    const hasMultiplePlaces = (content.match(/places:/g) || []).length > 0 &&
      (content.match(/- \w/g) || []).length > 3;

    if (!hasMarkingStore) {
      results.push({
        source: 'config/packages/workflow.yaml',
        type: 'marking-store',
        pattern: 'workflow without marking_store',
        issues: [
          'Workflow without marking_store configuration — Symfony defaults to MethodMarkingStore; configure explicitly with type: method and property: currentPlace',
        ],
      });
    } else if (hasSessionStore) {
      results.push({
        source: 'config/packages/workflow.yaml',
        type: 'session',
        pattern: 'session-based marking store',
        issues: [
          'Session-based workflow marking store — workflow state lost between sessions; use Doctrine marking store for persistence across sessions',
        ],
      });
    } else if (hasMarkingStore && content.includes('method')) {
      results.push({
        source: 'config/packages/workflow.yaml',
        type: 'marking-store',
        pattern: 'method_marking_store',
        issues: [],
      });
    }

    if (hasMultiplePlaces && !hasDoctrineStore) {
      results.push({
        source: 'config/packages/workflow.yaml',
        type: 'doctrine',
        pattern: 'multi-place workflow without Doctrine store',
        issues: [
          'Multi-place workflow without Doctrine marking store — consider using doctrine_marking_store for persistent state tracking across requests',
        ],
      });
    } else if (hasDoctrineStore) {
      const srcDir = path.join(appPath, 'src');
      let hasHistoryEntity = false;
      const checkForHistory = (dir: string): void => {
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isSymbolicLink()) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) checkForHistory(full);
            else if (e.name.endsWith('.php')) {
              const c = safeRead(full, srcDir);
              if (c !== null && (c.includes('WorkflowHistory') || c.includes('workflow_history') || c.includes('WorkflowAudit'))) {
                hasHistoryEntity = true;
              }
            }
          }
        } catch { /* skip */ }
      };
      if (fs.existsSync(srcDir)) checkForHistory(srcDir);

      const doctrineIssues: string[] = [];
      if (!hasHistoryEntity) {
        doctrineIssues.push(
          'Workflow with Doctrine marking store but no state history entity — consider adding a WorkflowHistory entity to audit state transitions',
        );
      }
      results.push({
        source: 'config/packages/workflow.yaml',
        type: 'doctrine',
        pattern: 'doctrine_marking_store',
        issues: doctrineIssues,
      });
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isSymbolicLink()) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            const content = safeRead(full, srcDir);
            if (content === null) continue;

            const hasWorkflowEvents = content.includes('workflow.') &&
              (content.includes('EventSubscriber') || content.includes('EventSubscriberInterface'));
            const hasWorkflowConstants = content.includes('WorkflowEvents');

            if (hasWorkflowEvents || hasWorkflowConstants) {
              const relFile = path.relative(appPath, full);
              results.push({
                source: relFile,
                type: 'logging',
                pattern: 'workflow event subscriber',
                issues: [],
              });
            }
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listSymfonyWorkflowPersistence(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyWorkflowPersistenceInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No workflow persistence patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Workflow Persistence Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyWorkflowPersistenceStats(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyWorkflowPersistenceInfos(appPath);
    let text = `Symfony Workflow Persistence Statistics\n${'='.repeat(40)}\n\n`;
    text += `Marking-store: ${infos.filter((i) => i.type === 'marking-store').length}\n`;
    text += `Doctrine:      ${infos.filter((i) => i.type === 'doctrine').length}\n`;
    text += `Session:       ${infos.filter((i) => i.type === 'session').length}\n`;
    text += `Logging:       ${infos.filter((i) => i.type === 'logging').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyWorkflowPersistenceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_workflow_persistence', description: 'Analyze Symfony workflow persistence configuration; warns on missing marking_store, session-based stores, multi-place workflows without Doctrine store, and missing history entities', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_workflow_persistence_stats', description: 'Statistics for Symfony workflow persistence: counts by type, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
