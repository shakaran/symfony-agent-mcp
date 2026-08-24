// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Workflow Parallel Transitions Inspector
 *
 * Scans config/**\/*.yaml and src/**\/*.php for parallel place patterns:
 *   - Workflow with type: workflow using to: [place1, place2] (parallel split)
 *   - Missing synchronization place that joins parallel branches
 *   - marking_store.type: multiple_state absent for parallel workflows
 *   - guard expressions not accounting for all required places
 *   - Transitions firing from only one active place in multi-place marking
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ParallelTransition {
  workflow: string;
  transition: string;
  fromPlaces: string[];
  toPlaces: string[];
  isParallelSplit: boolean;
  isSyncPoint: boolean;
  guard?: string;
}

interface WorkflowParallelInfo {
  name: string;
  type: string;
  hasMultipleStateStore: boolean;
  markingStoreType: string;
  parallelTransitions: ParallelTransition[];
  issues: string[];
}

function getAllYamlFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...getAllYamlFiles(full));
      } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...getAllPhpFiles(full));
      } else if (entry.name.endsWith('.php')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

function extractWorkflowsFromYaml(filePath: string, base: string): WorkflowParallelInfo[] {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return [];
  let content = '';
  try { content = fs.readFileSync(resolved, 'utf-8'); } catch { return []; }

  if (!content.includes('workflow') && !content.includes('type: workflow')) return [];
  if (!content.includes('workflows:')) return [];

  const results: WorkflowParallelInfo[] = [];

  // For each potential workflow section, look for parallel patterns
  const sections = content.split(/\n(?=\s{4}\w[\w_-]*:\s*\n)/);
  for (const section of sections) {
    const nameMatch = /^ {4}(\w[\w_-]*):/m.exec(section);
    if (!nameMatch) continue;
    const wfName = nameMatch[1];

    const typeMatch = /type:\s*(workflow|state_machine)/m.exec(section);
    const wfType = typeMatch ? typeMatch[1] : 'state_machine';

    if (wfType !== 'workflow') continue;

    const markingStoreMatch = /marking_store:\s*\n\s+type:\s*(\S+)/m.exec(section) ??
                              /marking_store:\s*\n\s+method:\s*(\S+)/m.exec(section);
    const markingStoreType = markingStoreMatch ? markingStoreMatch[1] : 'single_state';
    const hasMultipleStateStore = markingStoreType === 'multiple_state';

    const parallelTransitions: ParallelTransition[] = [];
    const issues: string[] = [];

    // Find transitions section — stop at next top-level section or end of string
    const transSection = /transitions:\s*\n([\s\S]+?)(?=\n\s{4}\w|\n\w|(?![\s\S]))/m.exec(section);
    if (!transSection) continue;

    const transContent = transSection[1];

    // Find each transition
    const singleTransRegex = /^ {6,8}(\w[\w_-]*):\s*\n((?:[ \t]+[^\n]*\n)*)/gm;
    let transMatch: RegExpExecArray | null;
    while ((transMatch = singleTransRegex.exec(transContent)) !== null) {
      const transName = transMatch[1];
      const transBody = transMatch[2];

      // Extract from places
      const fromMatch = /from:\s*\[([^\]]+)]/m.exec(transBody) ??
                        /from:\s*(\S+)/m.exec(transBody);
      const fromPlaces: string[] = [];
      if (fromMatch) {
        if (fromMatch[1].includes(',')) {
          fromPlaces.push(...fromMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')));
        } else {
          fromPlaces.push(fromMatch[1].trim().replace(/['"]/g, ''));
        }
      }

      // Extract to places
      const toMatch = /to:\s*\[([^\]]+)]/m.exec(transBody) ??
                      /to:\s*(\S+)/m.exec(transBody);
      const toPlaces: string[] = [];
      if (toMatch) {
        if (toMatch[1].includes(',')) {
          toPlaces.push(...toMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')));
        } else {
          toPlaces.push(toMatch[1].trim().replace(/['"]/g, ''));
        }
      }

      const guardMatch = /guard:\s*['"]?([^'"}\n]+)['"]?/m.exec(transBody);
      const guard = guardMatch ? guardMatch[1].trim() : undefined;

      const isParallelSplit = toPlaces.length > 1;
      const isSyncPoint = fromPlaces.length > 1;

      parallelTransitions.push({
        workflow: wfName,
        transition: transName,
        fromPlaces,
        toPlaces,
        isParallelSplit,
        isSyncPoint,
        guard,
      });
    }

    // Detect issues
    const hasSplits = parallelTransitions.some((t) => t.isParallelSplit);
    if (hasSplits && !hasMultipleStateStore) {
      issues.push('Parallel workflow (type: workflow) with multiple to: places but marking_store is not multiple_state — marking will be lost');
    }

    const splitTransitions = parallelTransitions.filter((t) => t.isParallelSplit);
    const syncTransitions = parallelTransitions.filter((t) => t.isSyncPoint);

    for (const split of splitTransitions) {
      const branchPlaces = split.toPlaces;
      const hasSync = syncTransitions.some((s) => branchPlaces.every((p) => s.fromPlaces.includes(p)));
      if (!hasSync) {
        issues.push(`Transition "${split.transition}" splits to [${split.toPlaces.join(', ')}] but no synchronization transition joins all branches — parallel branches may never complete`);
      }
    }

    for (const sync of syncTransitions) {
      if (sync.guard && !sync.fromPlaces.every((p) => sync.guard?.includes(p))) {
        issues.push(`Sync transition "${sync.transition}" guard expression may not check all required places: ${sync.fromPlaces.join(', ')}`);
      }
    }

    // Check transitions that fire from only one place in a multi-place workflow
    if (hasSplits) {
      for (const t of parallelTransitions) {
        if (!t.isParallelSplit && !t.isSyncPoint && t.fromPlaces.length === 1) {
          issues.push(`Transition "${t.transition}" fires from single place "${t.fromPlaces[0]}" — in parallel marking, ensure this is intentional (possible race condition)`);
        }
      }
    }

    if (parallelTransitions.length > 0 || issues.length > 0) {
      results.push({
        name: wfName,
        type: wfType,
        hasMultipleStateStore,
        markingStoreType,
        parallelTransitions,
        issues,
      });
    }
  }

  return results;
}

function scanPhpParallelWorkflowUsage(appPath: string): Array<{ file: string; issues: string[] }> {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: Array<{ file: string; issues: string[] }> = [];

  const resolvedBase = path.resolve(appPath);
  const safePhpFiles = getAllPhpFiles(srcDir).filter(f => path.resolve(f).startsWith(resolvedBase + path.sep));
  for (const file of safePhpFiles) {
    const resolvedFile = path.resolve(file);
    if (!resolvedFile.startsWith(resolvedBase + path.sep)) continue;
    const content = (() => { try { return fs.readFileSync(resolvedFile, 'utf-8'); } catch { return null; } })();
    if (content === null) continue;

    if (!content.includes('Marking') && !content.includes('workflow') && !content.includes('getMarking')) continue;

    const issues: string[] = [];

    // getMarking() without checking multiple places
    if (content.includes('getMarking(') && !content.includes('getPlaces(') && !content.includes('has(')) {
      issues.push('getMarking() used without checking multiple places via getPlaces() or has() — may miss parallel state');
    }

    // workflow.can() in parallel workflows should check all required places
    if (content.includes('->can(') && content.includes('Workflow') && !content.includes('getMarking')) {
      issues.push('workflow->can() without first inspecting marking — parallel workflow guards may be incorrect');
    }

    if (issues.length > 0) {
      results.push({ file: path.relative(appPath, file), issues });
    }
  }
  return results;
}

function analyzeAll(appPath: string): { workflows: WorkflowParallelInfo[]; phpIssues: Array<{ file: string; issues: string[] }> } {
  const resolvedBase = path.resolve(appPath);
  const configDir = path.join(resolvedBase, 'config');
  const srcDir = path.join(resolvedBase, 'src');

  const yamlFiles: string[] = [];
  if (fs.existsSync(configDir)) {
    yamlFiles.push(...getAllYamlFiles(configDir));
  }

  // Validate paths
  const safeYamls = yamlFiles.filter((f) => path.resolve(f).startsWith(resolvedBase + path.sep));

  const workflows: WorkflowParallelInfo[] = [];
  for (const f of safeYamls) {
    workflows.push(...extractWorkflowsFromYaml(f, resolvedBase));
  }

  const phpIssues = fs.existsSync(srcDir) ? scanPhpParallelWorkflowUsage(appPath) : [];

  return { workflows, phpIssues };
}

export function listSymfonyWorkflowParallelTransitions(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { workflows, phpIssues } = analyzeAll(appPath);

    if (workflows.length === 0 && phpIssues.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony workflow parallel transition patterns found.\n\nParallel splits use:\n  transitions:\n    fork:\n      from: initial\n      to: [branch_a, branch_b]\n\nRequires marking_store type: multiple_state for type: workflow.',
        }],
      };
    }

    let text = `Symfony Workflow Parallel Transitions\n${'='.repeat(55)}\n\n`;

    for (const wf of workflows) {
      text += `Workflow: ${wf.name}  (type: ${wf.type})\n`;
      text += `  Marking store: ${wf.markingStoreType}${wf.hasMultipleStateStore ? ' [OK]' : ' [WARNING: not multiple_state]'}\n`;

      const splits = wf.parallelTransitions.filter((t) => t.isParallelSplit);
      const syncs = wf.parallelTransitions.filter((t) => t.isSyncPoint);

      if (splits.length > 0) {
        text += `  Parallel splits (${splits.length}):\n`;
        for (const t of splits) {
          text += `    ${t.transition}: ${t.fromPlaces.join(', ')} -> [${t.toPlaces.join(', ')}]`;
          text += t.guard ? `  [guard: ${t.guard.slice(0, 50)}]` : '  [no guard]';
          text += '\n';
        }
      }

      if (syncs.length > 0) {
        text += `  Synchronization points (${syncs.length}):\n`;
        for (const t of syncs) {
          text += `    ${t.transition}: [${t.fromPlaces.join(', ')}] -> ${t.toPlaces.join(', ')}\n`;
        }
      }

      if (wf.issues.length > 0) {
        text += `  Issues (${wf.issues.length}):\n`;
        for (const issue of wf.issues) {
          text += `    - ${issue}\n`;
        }
      }
      text += '\n';
    }

    if (phpIssues.length > 0) {
      text += `PHP usage issues (${phpIssues.length} file(s)):\n`;
      for (const p of phpIssues) {
        text += `  ${p.file}:\n`;
        for (const issue of p.issues) {
          text += `    - ${issue}\n`;
        }
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

export function getSymfonyWorkflowParallelTransitionsStats(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { workflows, phpIssues } = analyzeAll(appPath);

    const totalSplits = workflows.reduce((s, w) => s + w.parallelTransitions.filter((t) => t.isParallelSplit).length, 0);
    const totalSyncs = workflows.reduce((s, w) => s + w.parallelTransitions.filter((t) => t.isSyncPoint).length, 0);
    const totalIssues = workflows.reduce((s, w) => s + w.issues.length, 0) + phpIssues.reduce((s, p) => s + p.issues.length, 0);
    const missingMultipleState = workflows.filter((w) => w.parallelTransitions.some((t) => t.isParallelSplit) && !w.hasMultipleStateStore).length;

    let text = `Symfony Workflow Parallel Transitions Stats\n${'='.repeat(45)}\n\n`;
    text += `Parallel workflows found:     ${workflows.length}\n`;
    text += `Parallel split transitions:   ${totalSplits}\n`;
    text += `Synchronization transitions:  ${totalSyncs}\n`;
    text += `Missing multiple_state store: ${missingMultipleState}\n`;
    text += `PHP usage issues:             ${phpIssues.length} file(s)\n`;
    text += `Total issues detected:        ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyWorkflowParallelTransitionsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_workflow_parallel_transitions',
      description: 'Scan Symfony workflow config for parallel place patterns: parallel splits (to: [place1, place2]), missing synchronization points, absent multiple_state marking store, guard expressions not covering all active places, race-prone single-place transitions in parallel workflows',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_workflow_parallel_transitions_stats',
      description: 'Statistics for Symfony workflow parallel transitions: workflow count, split count, sync count, missing multiple_state store count, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
