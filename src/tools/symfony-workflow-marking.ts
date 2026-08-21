import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface WorkflowMarkingInfo {
  workflow: string;
  type: 'workflow' | 'state_machine';
  markingStore: string;
  property: string;
  isSingleState: boolean;
  entityClass?: string;
  issues: string[];
}

function loadWorkflowMarkings(appPath: string): WorkflowMarkingInfo[] {
  const markings: WorkflowMarkingInfo[] = [];
  const candidates = [
    path.join(appPath, 'config', 'packages', 'workflow.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const processSection = (section: Record<string, unknown>, sectionType: 'workflow' | 'state_machine'): void => {
      for (const [name, def] of Object.entries(section)) {
        const d = (def ?? {}) as Record<string, unknown>;
        const markingStoreConfig = (d['marking_store'] ?? {}) as Record<string, unknown>;
        const markingStore = String(markingStoreConfig['type'] ?? 'method');
        const property = String(markingStoreConfig['property'] ?? 'marking');
        const isSingleState = sectionType === 'state_machine' || markingStore === 'single_state';
        const supports = Array.isArray(d['supports']) ? (d['supports'] as string[]) : (d['supports'] ? [String(d['supports'])] : []);
        const issues: string[] = [];
        if (sectionType === 'workflow' && isSingleState) issues.push('workflow type with single_state marking — use state_machine for single-state workflows');
        if (property === 'marking' && supports.length > 0) issues.push(`Default marking property "marking" — ensure entity has $marking property (type: string for single_state, array for workflow)`);
        markings.push({ workflow: name, type: sectionType, markingStore, property, isSingleState, entityClass: supports[0], issues });
      }
    };
    const workflows = (framework['workflows'] ?? {}) as Record<string, unknown>;
    const stateMachines = (framework['state_machines'] ?? {}) as Record<string, unknown>;
    processSection(workflows, 'workflow');
    processSection(stateMachines, 'state_machine');
  }
  return markings;
}

export function listWorkflowMarkings(appPath: string): McpToolResult {
  try {
    const markings = loadWorkflowMarkings(appPath);
    if (markings.length === 0) return { content: [{ type: 'text', text: 'No workflow marking_store configuration found.\n\nExample:\n  framework:\n    workflows:\n      article_publication:\n        marking_store:\n          type: method\n          property: currentPlace\n        supports: App\\Entity\\Article' }] };
    const totalIssues = markings.reduce((s, m) => s + m.issues.length, 0);
    let text = `Workflow Marking Store\n${'='.repeat(55)}\n\nWorkflows: ${markings.length}  Issues: ${totalIssues}\n`;
    for (const m of markings.sort((a, b) => b.issues.length - a.issues.length)) {
      const entity = m.entityClass ? `  supports: ${m.entityClass}` : '';
      text += `\n  ${m.workflow}  type: ${m.type}  store: ${m.markingStore}  property: $${m.property}${entity}\n`;
      for (const i of m.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getWorkflowMarkingStats(appPath: string): McpToolResult {
  try {
    const markings = loadWorkflowMarkings(appPath);
    let text = `Workflow Marking Statistics\n${'='.repeat(40)}\n\n`;
    text += `Workflows: ${markings.filter((m) => m.type === 'workflow').length}\nState machines: ${markings.filter((m) => m.type === 'state_machine').length}\nSingle-state: ${markings.filter((m) => m.isSingleState).length}\nIssues: ${markings.reduce((s, m) => s + m.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getWorkflowMarkingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_workflow_markings', description: 'Show workflow marking_store: method/single_state store type, marking property name, supported entity class, workflow vs state_machine type mismatch warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_workflow_marking_stats', description: 'Show workflow marking statistics: workflow/state_machine/single_state counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
