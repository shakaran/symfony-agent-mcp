// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Workflow / State Machine Inspector
 *
 * Parses config/packages/workflow.yaml to extract:
 *   - Workflow definitions (type: workflow | state_machine)
 *   - States (places)
 *   - Transitions (from → to, guard expression)
 *   - Entity class bindings (supports)
 *   - Initial places
 *   - Marking store type
 *
 * Pure static analysis — no PHP execution required.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface WorkflowPlace {
  name: string;
  metadata?: Record<string, unknown>;
}

interface WorkflowTransition {
  name: string;
  from: string[];
  to: string[];
  guard?: string;
  metadata?: Record<string, unknown>;
}

interface WorkflowDefinition {
  name: string;
  type: 'workflow' | 'state_machine';
  supports: string[];
  initialPlaces: string[];
  places: WorkflowPlace[];
  transitions: WorkflowTransition[];
  markingStore?: string;
  auditTrail?: boolean;
}

// ─── YAML parsing ──────────────────────────────────────────────────────────

function parseStringOrArray(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map(String);
  return [];
}

function parsePlaces(raw: unknown): WorkflowPlace[] {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw.map((p) => ({ name: String(p) }));
  }

  if (typeof raw === 'object' && raw !== null) {
    return Object.entries(raw as Record<string, unknown>).map(([name, meta]) => ({
      name,
      metadata: meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : undefined,
    }));
  }

  return [];
}

function parseTransitions(raw: unknown): WorkflowTransition[] {
  if (!raw || typeof raw !== 'object') return [];

  const transitions: WorkflowTransition[] = [];

  for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue;
    const t = def as Record<string, unknown>;

    transitions.push({
      name,
      from: parseStringOrArray(t['from']),
      to: parseStringOrArray(t['to']),
      guard: t['guard'] ? String(t['guard']) : undefined,
      metadata: t['metadata'] ? (t['metadata'] as Record<string, unknown>) : undefined,
    });
  }

  return transitions;
}

function loadWorkflows(appPath: string): WorkflowDefinition[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'workflow.yaml'),
    path.join(appPath, 'config', 'workflow.yaml'),
    path.join(appPath, 'config', 'packages', 'workflow.yml'),
  ];

  let raw: Record<string, unknown> | null = null;
  for (const file of candidates) {
    raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (raw) break;
  }

  if (!raw) return [];

  const frameworkKey = raw['framework'] as Record<string, unknown> | undefined;
  const workflowSection = (frameworkKey?.['workflows'] ?? raw['workflows']) as
    | Record<string, unknown>
    | undefined;

  if (!workflowSection) return [];

  const definitions: WorkflowDefinition[] = [];

  for (const [name, def] of Object.entries(workflowSection)) {
    if (!def || typeof def !== 'object') continue;
    const w = def as Record<string, unknown>;

    const type = (w['type'] as string) === 'state_machine' ? 'state_machine' : 'workflow';
    const supports = parseStringOrArray(w['supports']);

    const initialPlaces = parseStringOrArray(
      w['initial_places'] ?? w['initial_place'] ?? w['initial_marking']
    );

    const markingStore = w['marking_store']
      ? String((w['marking_store'] as Record<string, unknown>)['type'] ?? 'method')
      : undefined;

    definitions.push({
      name,
      type,
      supports,
      initialPlaces,
      places: parsePlaces(w['places']),
      transitions: parseTransitions(w['transitions']),
      markingStore,
      auditTrail: Boolean(w['audit_trail']),
    });
  }

  return definitions;
}

// ─── Text rendering ────────────────────────────────────────────────────────

function renderTransitionGraph(workflow: WorkflowDefinition): string {
  let text = '';
  for (const t of workflow.transitions) {
    const from = t.from.join(', ');
    const to = t.to.join(', ');
    const guard = t.guard ? `  [guard: ${t.guard}]` : '';
    text += `  ${from.padEnd(25)} ──[${t.name}]──▶ ${to}${guard}\n`;
  }
  return text;
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listWorkflows(appPath: string): McpToolResult {
  try {
    const workflows = loadWorkflows(appPath);

    if (workflows.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony workflows found.\n\nExpected: config/packages/workflow.yaml\n\nCreate with: php bin/console make:workflow',
        }],
      };
    }

    let text = `Symfony Workflows (${workflows.length})\n${'='.repeat(50)}\n`;

    for (const wf of workflows) {
      text += `\n  ${wf.name}  [${wf.type}]\n`;
      text += `    Places:       ${wf.places.length}  (${wf.places.map((p) => p.name).join(', ')})\n`;
      text += `    Transitions:  ${wf.transitions.length}\n`;
      text += `    Initial:      ${wf.initialPlaces.join(', ') || '(none)'}\n`;
      if (wf.markingStore) text += `    Marking store: ${wf.markingStore}\n`;
      if (wf.auditTrail) text += `    Audit trail:  enabled\n`;
      text += `    Supports:\n`;
      for (const cls of wf.supports) {
        text += `      - ${cls}\n`;
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

export function getWorkflowDetails(appPath: string, workflowName: string): McpToolResult {
  try {
    const workflows = loadWorkflows(appPath);
    const wf = workflows.find(
      (w) => w.name === workflowName || w.name.toLowerCase().includes(workflowName.toLowerCase())
    );

    if (!wf) {
      const names = workflows.map((w) => w.name).join(', ');
      return {
        content: [{ type: 'text', text: `Workflow "${workflowName}" not found.\n\nAvailable: ${names || 'none'}` }],
        isError: true,
      };
    }

    let text = `Workflow: ${wf.name}  [${wf.type}]\n${'='.repeat(50)}\n\n`;
    text += `Initial places: ${wf.initialPlaces.join(', ') || '(none)'}\n`;
    if (wf.markingStore) text += `Marking store:  ${wf.markingStore}\n`;
    if (wf.auditTrail) text += `Audit trail:    enabled\n`;

    text += `\nSupports:\n`;
    for (const cls of wf.supports) text += `  - ${cls}\n`;

    text += `\nPlaces (${wf.places.length}):\n`;
    for (const p of wf.places) {
      const isInitial = wf.initialPlaces.includes(p.name) ? '  ← initial' : '';
      const hasIncoming = wf.transitions.some((t) => t.to.includes(p.name));
      const hasOutgoing = wf.transitions.some((t) => t.from.includes(p.name));
      const role = !hasIncoming ? '  [entry]' : !hasOutgoing ? '  [terminal]' : '';
      text += `  ${p.name}${isInitial}${role}\n`;
    }

    text += `\nTransitions (${wf.transitions.length}):\n`;
    text += renderTransitionGraph(wf);

    if (wf.transitions.some((t) => t.guard)) {
      text += `\nGuards:\n`;
      for (const t of wf.transitions.filter((tr) => tr.guard)) {
        text += `  ${t.name}: ${t.guard}\n`;
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

export function getWorkflowStats(appPath: string): McpToolResult {
  try {
    const workflows = loadWorkflows(appPath);

    if (workflows.length === 0) {
      return { content: [{ type: 'text', text: 'No workflows found.' }] };
    }

    const totalPlaces = workflows.reduce((s, w) => s + w.places.length, 0);
    const totalTransitions = workflows.reduce((s, w) => s + w.transitions.length, 0);
    const totalEntities = workflows.reduce((s, w) => s + w.supports.length, 0);
    const withGuards = workflows.reduce((s, w) => s + w.transitions.filter((t) => t.guard).length, 0);

    let text = `Workflow Statistics\n${'='.repeat(40)}\n\n`;
    text += `Workflows:           ${workflows.length}\n`;
    text += `Total places:        ${totalPlaces}\n`;
    text += `Total transitions:   ${totalTransitions}\n`;
    text += `Guarded transitions: ${withGuards}\n`;
    text += `Supported entities:  ${totalEntities}\n`;

    text += `\nPer workflow:\n`;
    for (const wf of workflows) {
      const guards = wf.transitions.filter((t) => t.guard).length;
      text += `  ${wf.name.padEnd(30)} ${wf.type.padEnd(14)} ${wf.places.length} places  ${wf.transitions.length} transitions`;
      if (guards > 0) text += `  ${guards} guarded`;
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getWorkflowTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_workflows',
      description: 'List all Symfony workflows and state machines from config/packages/workflow.yaml with places, transitions, and supported entities',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_workflow_details',
      description: 'Get full details for a workflow: all places (including entry/terminal), transitions graph, guards, and marking store',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          workflow_name: { type: 'string', description: 'Workflow name or partial match' },
        },
        required: ['app_path', 'workflow_name'],
      },
    },
    {
      name: 'get_workflow_stats',
      description: 'Show aggregate workflow statistics: total places, transitions, guarded transitions, and supported entities',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
