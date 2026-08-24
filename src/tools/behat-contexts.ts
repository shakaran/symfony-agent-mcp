// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface BehatContextInfo {
  class: string;
  file: string;
  stepCount: number;
  givenCount: number;
  whenCount: number;
  thenCount: number;
  hasBeforeScenario: boolean;
  hasAfterScenario: boolean;
  implementsContext: boolean;
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

function parseBehatContext(filePath: string, appPath: string): BehatContextInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('Behat\\') && !content.includes('@Given') && !content.includes('@When') && !content.includes('@Then') && !content.includes('#[Given') && !content.includes('#[When') && !content.includes('#[Then')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const givenCount = [...content.matchAll(/#\[Given|@Given/g)].length;
  const whenCount = [...content.matchAll(/#\[When|@When/g)].length;
  const thenCount = [...content.matchAll(/#\[Then|@Then/g)].length;
  const stepCount = givenCount + whenCount + thenCount;
  if (stepCount === 0) return null;
  const hasBeforeScenario = content.includes('@BeforeScenario') || content.includes('#[BeforeScenario');
  const hasAfterScenario = content.includes('@AfterScenario') || content.includes('#[AfterScenario');
  const implementsContext = content.includes('implements Context') || content.includes('Behat\\Behat\\Context\\Context');
  const issues: string[] = [];
  if (!implementsContext) issues.push('Context class does not implement Behat\\Context\\Context — Behat may not register it');
  if (thenCount === 0 && givenCount > 0) issues.push('Context has Given/When steps but no Then assertions — incomplete BDD scenario coverage');
  return { class: classM[1], file: path.relative(appPath, filePath), stepCount, givenCount, whenCount, thenCount, hasBeforeScenario, hasAfterScenario, implementsContext, issues };
}

function loadFeatureFiles(appPath: string): { file: string; scenarioCount: number }[] {
  const featureDir = path.join(appPath, 'features');
  const result: { file: string; scenarioCount: number }[] = [];
  if (!fs.existsSync(featureDir)) return result;
  const scan = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) scan(full);
        else if (e.name.endsWith('.feature')) {
          let content = '';
          try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
          const count = [...content.matchAll(/^\s*Scenario/gm)].length;
          result.push({ file: path.relative(appPath, full), scenarioCount: count });
        }
      }
    } catch { /* skip */ }
  };
  scan(featureDir);
  return result;
}

export function listBehatContexts(appPath: string): McpToolResult {
  try {
    const featureFiles = loadFeatureFiles(appPath);
    const contexts: BehatContextInfo[] = [];
    const dirs = [path.join(appPath, 'features'), path.join(appPath, 'tests', 'Behat'), path.join(appPath, 'tests', 'Features')];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const file of getAllPhpFiles(dir)) {
        const c = parseBehatContext(file, appPath);
        if (c) contexts.push(c);
      }
    }
    const totalScenarios = featureFiles.reduce((s, f) => s + f.scenarioCount, 0);
    const totalIssues = contexts.reduce((s, c) => s + c.issues.length, 0);
    if (contexts.length === 0 && featureFiles.length === 0) return { content: [{ type: 'text', text: 'No Behat contexts or feature files found.' }] };
    let text = `Behat Contexts\n${'='.repeat(55)}\n\nContexts: ${contexts.length}  Feature files: ${featureFiles.length}  Scenarios: ${totalScenarios}  Issues: ${totalIssues}\n`;
    for (const c of contexts.sort((a, b) => b.issues.length - a.issues.length)) {
      const hooks = [c.hasBeforeScenario ? '@BeforeScenario' : '', c.hasAfterScenario ? '@AfterScenario' : ''].filter(Boolean).join('  ');
      text += `\n  ${c.class}  steps: ${c.stepCount} (Given:${c.givenCount} When:${c.whenCount} Then:${c.thenCount})  ${hooks}  (${c.file})\n`;
      for (const i of c.issues) text += `    ⚠ ${i}\n`;
    }
    if (featureFiles.length > 0) {
      text += `\nFeature files:\n`;
      for (const f of featureFiles) text += `  ${f.file}  scenarios: ${f.scenarioCount}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getBehatContextStats(appPath: string): McpToolResult {
  try {
    const featureFiles = loadFeatureFiles(appPath);
    const contexts: BehatContextInfo[] = [];
    const dirs = [path.join(appPath, 'features'), path.join(appPath, 'tests', 'Behat'), path.join(appPath, 'tests', 'Features')];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const file of getAllPhpFiles(dir)) {
        const c = parseBehatContext(file, appPath);
        if (c) contexts.push(c);
      }
    }
    let text = `Behat Statistics\n${'='.repeat(40)}\n\n`;
    text += `Contexts: ${contexts.length}\n  Steps: ${contexts.reduce((s, c) => s + c.stepCount, 0)}\n  Given: ${contexts.reduce((s, c) => s + c.givenCount, 0)}  When: ${contexts.reduce((s, c) => s + c.whenCount, 0)}  Then: ${contexts.reduce((s, c) => s + c.thenCount, 0)}\nFeature files: ${featureFiles.length}\n  Scenarios: ${featureFiles.reduce((s, f) => s + f.scenarioCount, 0)}\nIssues: ${contexts.reduce((s, c) => s + c.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getBehatContextTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_behat_contexts', description: 'Show Behat context step definitions: Given/When/Then counts, BeforeScenario/AfterScenario hooks, feature file count, scenario count, missing Context interface warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_behat_context_stats', description: 'Show Behat statistics: context count, step counts by type, feature file count, scenario count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
