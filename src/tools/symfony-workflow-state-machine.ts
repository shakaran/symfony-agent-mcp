// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Workflow / State Machine Inspector
 *
 * Scans config/packages/workflow.yaml and config/workflows/*.yaml.
 * Detects workflow vs state_machine types, validates state machine invariants
 * (each transition must have exactly one from state), checks audit_trail and
 * marking_store configuration.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface StateMachineInfo {
  name: string;
  type: 'state_machine' | 'workflow';
  states: string[];
  transitions: number;
  auditTrail: boolean;
  issues: string[];
}

function collectConfigFiles(dir: string, base: string, exts: string[]): string[] {
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
    if (stat.isDirectory()) results.push(...collectConfigFiles(full, base, exts));
    else if (exts.some(e => entry.endsWith(e))) results.push(full);
  }
  return results;
}

function parseWorkflowsFromContent(content: string, _sourceFile: string): StateMachineInfo[] {
  const infos: StateMachineInfo[] = [];

  // Find type: state_machine or type: workflow blocks
  // We do line-by-line parsing since we avoid external YAML libs
  const lines = content.split('\n');

  let currentName = '';
  let currentType: 'state_machine' | 'workflow' | null = null;
  let inWorkflowBlock = false;
  let inTransitions = false;
  let inPlaces = false;
  let currentStates: string[] = [];
  let currentTransitions = 0;
  let currentAuditTrail = false;
  let currentIssues: string[] = [];
  let hasMarkingStore = false;
  // Track state machine from-counts to check invariant
  let currentFromCount = 0;
  let inTransitionDef = false;
  const seenTransitionNames = new Map<string, number[]>();
  let currentTransitionName = '';

  const flush = (): void => {
    if (!currentName || currentType === null) return;

    const issues = [...currentIssues];

    if (!currentAuditTrail) {
      issues.push(`No audit_trail configured — enable audit_trail.enabled: true to log state transitions`);
    }
    if (!hasMarkingStore) {
      issues.push(`No marking_store defined — specify marking_store.type and property for the entity`);
    }
    if (currentType === 'state_machine') {
      // Check invariant: each transition must have exactly one from state
      for (const [tName, counts] of seenTransitionNames) {
        for (const cnt of counts) {
          if (cnt > 1) {
            issues.push(`State machine transition "${tName}" has ${cnt} from-states — state machines must have exactly one from state per transition`);
          }
        }
      }
    }

    infos.push({
      name: currentName,
      type: currentType,
      states: [...currentStates],
      transitions: currentTransitions,
      auditTrail: currentAuditTrail,
      issues,
    });
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect workflow or state_machine name (top-level keys under framework.workflows or state_machines)
    const wfNameMatch = /^(\s{4,8})(\w{1,80})\s*:/.exec(line);
    if (wfNameMatch && !trimmed.startsWith('#')) {
      const indent = wfNameMatch[1].length;
      if (indent <= 8 && (inWorkflowBlock || currentType !== null)) {
        // Could be a new workflow entry
        const candidate = wfNameMatch[2];
        if (!['type', 'marking_store', 'places', 'transitions', 'supports', 'audit_trail', 'from', 'to', 'guard', 'metadata', 'initial_marking'].includes(candidate)) {
          flush();
          currentName = candidate;
          currentType = null;
          currentStates = [];
          currentTransitions = 0;
          currentAuditTrail = false;
          currentIssues = [];
          hasMarkingStore = false;
          inTransitions = false;
          inPlaces = false;
          inTransitionDef = false;
          seenTransitionNames.clear();
          currentFromCount = 0;
        }
      }
    }

    // Detect section markers
    if (/\bworkflows\s*:/.test(trimmed)) { inWorkflowBlock = true; }
    if (/\bstate_machines\s*:/.test(trimmed)) { inWorkflowBlock = true; }

    // Detect type
    if (/^\s+type\s*:\s*state_machine/.test(line)) { currentType = 'state_machine'; }
    if (/^\s+type\s*:\s*workflow/.test(line)) { currentType = 'workflow'; }

    // Audit trail
    if (/audit_trail/.test(trimmed) && /enabled\s*:\s*true/.test(trimmed)) { currentAuditTrail = true; }
    if (/audit_trail/.test(trimmed)) { /* present, check enabled on next line */ }
    if (/\bEnabled\s*:\s*true/i.test(trimmed) && inWorkflowBlock) { currentAuditTrail = true; }

    // Marking store
    if (/marking_store\s*:/.test(trimmed)) { hasMarkingStore = true; }

    // Places / states
    if (/^\s+places\s*:/.test(line)) { inPlaces = true; inTransitions = false; }
    if (/^\s+transitions\s*:/.test(line)) { inTransitions = true; inPlaces = false; }

    if (inPlaces && /^\s+-\s+(\w{1,80})/.test(line)) {
      const placeMatch = /^\s+-\s+(\w{1,80})/.exec(line);
      if (placeMatch) currentStates.push(placeMatch[1]);
    }
    if (inPlaces && /^\s+(\w{1,80})\s*:/.test(line)) {
      const placeMatch = /^\s+(\w{1,80})\s*:/.exec(line);
      if (placeMatch && !['places', 'transitions', 'supports', 'marking_store', 'type', 'audit_trail'].includes(placeMatch[1])) {
        currentStates.push(placeMatch[1]);
      }
    }

    // Transitions
    if (inTransitions) {
      const tNameMatch = /^\s{6,12}(\w{1,80})\s*:/.exec(line);
      if (tNameMatch && !['from', 'to', 'guard', 'name', 'metadata'].includes(tNameMatch[1])) {
        // flush previous transition
        if (currentTransitionName) {
          const existing = seenTransitionNames.get(currentTransitionName) ?? [];
          existing.push(currentFromCount);
          seenTransitionNames.set(currentTransitionName, existing);
        }
        currentTransitionName = tNameMatch[1];
        currentTransitions++;
        currentFromCount = 0;
        inTransitionDef = true;
      }
      if (inTransitionDef && /^\s+from\s*:/.test(line)) {
        // from: single or from: [a, b] or from:\n  - a
        const inlineList = /\[([^\]]{1,200})\]/.exec(line);
        if (inlineList) {
          currentFromCount = inlineList[1].split(',').filter(Boolean).length;
        } else {
          currentFromCount = 1; // will be incremented by list items
        }
      }
      if (inTransitionDef && /^\s+-\s+\w/.test(line) && !/^\s+-\s+\w/.test(lines[lines.indexOf(line) - 1] ?? '')) {
        // array item under from
        currentFromCount++;
      }
    }
  }

  // Flush last
  if (currentTransitionName) {
    const existing = seenTransitionNames.get(currentTransitionName) ?? [];
    existing.push(currentFromCount);
    seenTransitionNames.set(currentTransitionName, existing);
  }
  flush();

  return infos;
}

function buildStateMachineInfos(appPath: string): StateMachineInfo[] {
  const infos: StateMachineInfo[] = [];
  const candidates: string[] = [];

  // Main workflow config
  const mainYaml = path.join(appPath, 'config', 'packages', 'workflow.yaml');
  const mainR = path.resolve(mainYaml);
  if (mainR.startsWith(path.resolve(appPath) + path.sep)) candidates.push(mainYaml);

  // Framework.yaml may also have workflows
  const frameworkYaml = path.join(appPath, 'config', 'packages', 'framework.yaml');
  const frameworkR = path.resolve(frameworkYaml);
  if (frameworkR.startsWith(path.resolve(appPath) + path.sep)) candidates.push(frameworkYaml);

  // Dedicated workflows directory
  const workflowsDir = path.join(appPath, 'config', 'workflows');
  const workflowsDirR = path.resolve(workflowsDir);
  if (workflowsDirR.startsWith(path.resolve(appPath) + path.sep)) {
    let stat;
    try { stat = fs.lstatSync(workflowsDir); } catch { stat = null; }
    if (stat && stat.isSymbolicLink()) stat = null;
    if (stat && stat.isDirectory()) {
      const wfFiles = collectConfigFiles(workflowsDir, appPath, ['.yaml', '.yml']);
      candidates.push(...wfFiles);
    }
  }

  for (const file of candidates) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('workflow') && !content.includes('state_machine')) continue;
    const parsed = parseWorkflowsFromContent(content, file);
    infos.push(...parsed);
  }

  return infos;
}

export function listSymfonyWorkflowStateMachine(appPath: string): McpToolResult {
  try {
    const infos = buildStateMachineInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No workflow or state_machine configuration found in config/packages/workflow.yaml or config/workflows/.' }] };
    }

    const withIssues = infos.filter(i => i.issues.length > 0);
    let text = `Symfony Workflow / State Machine Inspector\n${'='.repeat(55)}\n\n`;
    text += `Workflows found: ${infos.length}  (${withIssues.length} with issues)\n\n`;

    for (const info of infos) {
      text += `  [${info.type}] ${info.name}\n`;
      text += `    States: ${info.states.length > 0 ? info.states.join(', ') : 'none detected'}\n`;
      text += `    Transitions: ${info.transitions}  AuditTrail: ${info.auditTrail ? 'yes' : 'NO'}\n`;
      for (const issue of info.issues) {
        text += `    ! ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyWorkflowStateMachineStats(appPath: string): McpToolResult {
  try {
    const infos = buildStateMachineInfos(appPath);
    const stateMachines = infos.filter(i => i.type === 'state_machine').length;
    const workflows = infos.filter(i => i.type === 'workflow').length;
    const withAuditTrail = infos.filter(i => i.auditTrail).length;
    const withIssues = infos.filter(i => i.issues.length > 0).length;
    const totalTransitions = infos.reduce((s, i) => s + i.transitions, 0);

    let text = `Symfony Workflow Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total workflows:      ${infos.length}\n`;
    text += `  State machines:     ${stateMachines}\n`;
    text += `  Workflows:          ${workflows}\n`;
    text += `  With audit trail:   ${withAuditTrail}\n`;
    text += `  With issues:        ${withIssues}\n`;
    text += `Total transitions:    ${totalTransitions}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyWorkflowStateMachineTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_workflow_state_machine',
      description: 'List Symfony workflows and state machines: type, states, transition count, audit trail status, issues with missing marking_store or state machine invariant violations',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_workflow_state_machine_stats',
      description: 'Get Symfony workflow statistics: counts of state machines vs workflows, audit trail coverage, total transitions, workflows with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
