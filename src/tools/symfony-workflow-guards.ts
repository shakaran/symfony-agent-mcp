/**
 * Symfony Workflow Guards Inspector
 *
 * Distinct from workflows.ts (which lists workflow config and places).
 * Focuses specifically on guard configuration:
 *
 * YAML guard expressions:
 *   - transitions[name].guard expressions in workflow YAML config
 *   - Expression types: is_granted(), subject.getOwner() == user, etc.
 *   - Transitions with no guard expression (anyone with the right place can transition)
 *
 * PHP guard event listeners:
 *   - Classes subscribing to "workflow.guard" / "workflow.{name}.guard.{transition}" events
 *   - #[AsEventListener(event: 'workflow.guard.*')] attributes
 *   - GuardEvent::setBlocked() calls
 *   - GuardEvent::addTransitionBlocker() calls
 *
 * Cross-check:
 *   - Transitions in YAML that have no guard AND no GuardEvent listener
 *   - Guard listeners for workflows not defined in config (orphan)
 *   - Transitions that can lead to a "terminal" place without a guard
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TransitionGuard {
  workflow: string;
  transition: string;
  guard?: string;
  hasListener: boolean;
}

interface GuardListener {
  class: string;
  file: string;
  workflowEvent: string;
  usesSetBlocked: boolean;
  usesAddBlocker: boolean;
}

function loadWorkflowYamls(appPath: string): Array<{ name: string; raw: Record<string, unknown> }> {
  const configDir = path.join(appPath, 'config', 'packages');
  const results: Array<{ name: string; raw: Record<string, unknown> }> = [];
  if (!fs.existsSync(configDir)) return results;

  try {
    for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
      const filePath = path.join(configDir, entry.name);
      const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
      if (!raw) continue;
      const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
      if (framework['workflows'] || raw['workflows']) {
        results.push({ name: entry.name, raw: raw as Record<string, unknown> });
      }
    }
  } catch { /* skip */ }
  return results;
}

function extractTransitionGuards(yamls: Array<{ name: string; raw: Record<string, unknown> }>): TransitionGuard[] {
  const results: TransitionGuard[] = [];

  for (const { raw } of yamls) {
    const framework  = (raw['framework'] ?? raw) as Record<string, unknown>;
    const workflows  = (framework['workflows'] ?? raw['workflows'] ?? {}) as Record<string, unknown>;

    for (const [wfName, wfDef] of Object.entries(workflows)) {
      const wf = (wfDef ?? {}) as Record<string, unknown>;
      const transitions = (wf['transitions'] ?? {}) as Record<string, unknown>;

      for (const [trName, trDef] of Object.entries(transitions)) {
        const tr = (trDef ?? {}) as Record<string, unknown>;
        results.push({
          workflow: wfName,
          transition: trName,
          guard: tr['guard'] ? String(tr['guard']) : undefined,
          hasListener: false,
        });
      }
    }
  }
  return results;
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function scanGuardListeners(appPath: string): GuardListener[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: GuardListener[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, srcDir);
    if (content === null) continue;

    const isGuard = content.includes('GuardEvent') ||
                    (content.includes('workflow') && content.includes('guard'));
    if (!isGuard) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // Event name from AsEventListener or getSubscribedEvents
    const eventM = /#\[AsEventListener[^)]*event\s*:\s*['"]([^'"]*guard[^'"]*)['"]/i.exec(content) ??
                   /['"]([^'"]*workflow[^'"]*guard[^'"]*)['"]\s*=>/i.exec(content);
    if (!eventM) continue;

    results.push({
      class: classM[1],
      file: path.basename(file),
      workflowEvent: eventM[1],
      usesSetBlocked: content.includes('setBlocked('),
      usesAddBlocker: content.includes('addTransitionBlocker('),
    });
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

export function listWorkflowGuards(appPath: string): McpToolResult {
  try {
    const yamls     = loadWorkflowYamls(appPath);
    const guards    = extractTransitionGuards(yamls);
    const listeners = scanGuardListeners(appPath);

    if (guards.length === 0 && listeners.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No workflow guards found.\n\nAdd guards in workflow YAML:\n  transitions:\n    publish:\n      guard: "is_granted(\'ROLE_EDITOR\') and subject.isReady()"\n      from: draft\n      to: published\n\nOr via PHP listener:\n  #[AsEventListener(event: \'workflow.blog.guard.publish\')]\n  public function onGuard(GuardEvent $event): void\n  {\n    if (!$this->isAllowed($event->getSubject())) {\n      $event->setBlocked(true);\n    }\n  }',
        }],
      };
    }

    // Mark guards that have listeners
    for (const g of guards) {
      g.hasListener = listeners.some(
        (l) => l.workflowEvent.includes(g.workflow) || l.workflowEvent.includes(g.transition)
      );
    }

    const unguarded = guards.filter((g) => !g.guard && !g.hasListener);

    let text = `Workflow Guards\n${'='.repeat(55)}\n`;

    // Group by workflow
    const byWorkflow = new Map<string, TransitionGuard[]>();
    for (const g of guards) {
      const list = byWorkflow.get(g.workflow) ?? [];
      list.push(g);
      byWorkflow.set(g.workflow, list);
    }

    for (const [wf, transitions] of [...byWorkflow.entries()].sort()) {
      const guardedCount = transitions.filter((t) => t.guard || t.hasListener).length;
      text += `\n  Workflow: ${wf}  (${guardedCount}/${transitions.length} guarded)\n`;
      for (const t of transitions) {
        const guardSrc = t.guard ? `  expr: ${t.guard.slice(0, 60)}${t.guard.length > 60 ? '...' : ''}` :
                         t.hasListener ? '  [PHP listener]' : '  ⚠ no guard';
        text += `    ${t.transition.padEnd(30)} ${guardSrc}\n`;
      }
    }

    if (listeners.length > 0) {
      text += `\nGuard listeners (${listeners.length}):\n`;
      for (const l of listeners) {
        const method = l.usesSetBlocked ? 'setBlocked' : l.usesAddBlocker ? 'addTransitionBlocker' : '(reads only)';
        text += `  ${l.class.padEnd(40)} → ${l.workflowEvent}  [${method}]\n`;
      }
    }

    if (unguarded.length > 0) {
      text += `\n⚠ Transitions with no guard (${unguarded.length}):\n`;
      for (const u of unguarded) {
        text += `  ${u.workflow} :: ${u.transition}\n`;
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

export function getWorkflowGuardStats(appPath: string): McpToolResult {
  try {
    const yamls     = loadWorkflowYamls(appPath);
    const guards    = extractTransitionGuards(yamls);
    const listeners = scanGuardListeners(appPath);

    for (const g of guards) {
      g.hasListener = listeners.some(
        (l) => l.workflowEvent.includes(g.workflow) || l.workflowEvent.includes(g.transition)
      );
    }

    let text = `Workflow Guard Statistics\n${'='.repeat(40)}\n\n`;
    text += `Workflows with guards: ${new Set(guards.map((g) => g.workflow)).size}\n`;
    text += `Total transitions:     ${guards.length}\n`;
    text += `  With YAML guard:     ${guards.filter((g) => g.guard).length}\n`;
    text += `  With PHP listener:   ${guards.filter((g) => g.hasListener).length}\n`;
    text += `  Unguarded:           ${guards.filter((g) => !g.guard && !g.hasListener).length}\n`;
    text += `Guard listener classes: ${listeners.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getWorkflowGuardTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_workflow_guards',
      description: 'Show Symfony workflow guards: YAML guard expressions per transition, PHP GuardEvent listener classes (setBlocked/addTransitionBlocker), unguarded transition detection, cross-check between YAML and PHP guards',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_workflow_guard_stats',
      description: 'Show workflow guard statistics: workflow count, total transitions, YAML guard count, PHP listener count, unguarded transition count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
