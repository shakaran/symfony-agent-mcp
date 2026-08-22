/**
 * Behat Step Coverage Inspector
 *
 * Scans features/ directory for .feature files and extracts step text.
 * Scans features/bootstrap/ and src/**\/Behat/ for step definition PHP files.
 * Matches steps used in features against defined patterns.
 *
 * Warnings:
 *   - Step used in feature file with no matching definition (runtime error)
 *   - Step definition never used in any feature (dead code)
 *   - Step definition regex too broad
 *   - Step definition file in non-standard location
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface BehatStepCoverageInfo {
  featureFile: string;
  step: string;
  hasDefinition: boolean;
  matchingDefinition?: string;
  issues: string[];
}

interface StepDefinition {
  pattern: string;
  file: string;
  annotation: string;
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

function getFeatureFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getFeatureFiles(full));
      else if (e.name.endsWith('.feature')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractStepsFromFeature(filePath: string): Array<{ text: string; featureFile: string }> {
  const steps: Array<{ text: string; featureFile: string }> = [];
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return steps; }
  if (content.length > 500_000) return steps;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const stepM = /^(Given|When|Then|And|But)\s+(.{1,200})$/.exec(trimmed);
    if (stepM) {
      steps.push({ text: stepM[2].trim(), featureFile: path.basename(filePath) });
    }
  }
  return steps;
}

function extractStepDefinitions(phpFiles: string[]): StepDefinition[] {
  const definitions: StepDefinition[] = [];

  for (const filePath of phpFiles) {
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    if (content.length > 500_000) continue;

    // Annotations: @Given, @When, @Then, @Step
    const annotationMatches = content.matchAll(/@(Given|When|Then|Step)\s*\(["'/]([^"'\n]{0,300})["'/]\)/g);
    for (const m of annotationMatches) {
      definitions.push({ pattern: m[2], file: path.basename(filePath), annotation: m[1] });
    }

    // PHP 8 attributes: #[Given("...")], #[When("...")], #[Then("...")]
    const attributeMatches = content.matchAll(/#\[(Given|When|Then)\s*\(\s*["']([^"']{0,300})["']\s*\)\]/g);
    for (const m of attributeMatches) {
      definitions.push({ pattern: m[2], file: path.basename(filePath), annotation: m[1] });
    }
  }

  return definitions;
}

function stepMatchesDefinition(stepText: string, pattern: string): boolean {
  try {
    // Pattern might be a regex or a plain string with :arg placeholders
    let regexStr = pattern;

    // Replace Behat argument placeholders with regex groups
    regexStr = regexStr.replace(/:word/g, '\\w{1,80}');
    regexStr = regexStr.replace(/:int/g, '-?\\d{1,20}');
    regexStr = regexStr.replace(/:float/g, '-?\\d{1,20}(?:\\.\\d{1,10})?');
    regexStr = regexStr.replace(/:string/g, '[^"\']{0,200}');
    regexStr = regexStr.replace(/"([^"]{0,200})"/g, '"$1"');

    // Guard against ReDoS: malicious project file could inject catastrophic backtracking pattern
    if (regexStr.length > 300) {
      return stepText.toLowerCase().includes(pattern.toLowerCase().slice(0, 30));
    }

    // Try as regex
    const rx = new RegExp(`^${regexStr}$`, 'i');
    return rx.test(stepText);
  } catch {
    // Fallback: plain substring match
    return stepText.toLowerCase().includes(pattern.toLowerCase().slice(0, 30));
  }
}

function isRegexTooBroad(pattern: string): boolean {
  // Warn if pattern matches basically anything
  const broadPatterns = [/^\.\*$/, /^\.\+$/, /^[^)]{0,5}$/, /^\(\.\*\)$/];
  return broadPatterns.some((p) => p.test(pattern.trim()));
}

function getStepDefinitionFiles(appPath: string): string[] {
  const locations: string[] = [];

  const bootstrapDir = path.join(appPath, 'features', 'bootstrap');
  if (fs.existsSync(bootstrapDir)) {
    locations.push(...getAllPhpFiles(bootstrapDir));
  }

  const srcDir = path.join(appPath, 'src');
  for (const f of getAllPhpFiles(srcDir)) {
    const rel = f.replace(srcDir, '');
    if (rel.toLowerCase().includes('behat') || rel.toLowerCase().includes('context')) {
      locations.push(f);
    }
  }

  return locations;
}

export function listBehatStepCoverage(appPath: string): McpToolResult {
  try {
    const featuresDir = path.join(appPath, 'features');
    if (!fs.existsSync(featuresDir)) {
      return { content: [{ type: 'text', text: 'No features/ directory found. Behat not configured.' }] };
    }

    const featureFiles = getFeatureFiles(featuresDir);
    if (featureFiles.length === 0) {
      return { content: [{ type: 'text', text: 'No .feature files found in features/.' }] };
    }

    const definitionFiles = getStepDefinitionFiles(appPath);
    const definitions = extractStepDefinitions(definitionFiles);

    const allSteps: Array<{ text: string; featureFile: string }> = [];
    for (const f of featureFiles) {
      allSteps.push(...extractStepsFromFeature(f));
    }

    const results: BehatStepCoverageInfo[] = [];
    const usedDefinitions = new Set<string>();

    for (const step of allSteps) {
      const matchedDef = definitions.find((d) => stepMatchesDefinition(step.text, d.pattern));
      const issues: string[] = [];

      if (!matchedDef) {
        issues.push(`No step definition found for: "${step.text}" — will cause runtime error`);
      } else {
        usedDefinitions.add(matchedDef.pattern);
        if (isRegexTooBroad(matchedDef.pattern)) {
          issues.push(`Step definition "${matchedDef.pattern}" is too broad — may match unintended steps`);
        }
      }

      results.push({
        featureFile: step.featureFile,
        step: step.text,
        hasDefinition: !!matchedDef,
        matchingDefinition: matchedDef?.file,
        issues,
      });
    }

    // Unused definitions
    const unusedDefs = definitions.filter((d) => !usedDefinitions.has(d.pattern));

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    const missingDefs = results.filter((r) => !r.hasDefinition);

    let text = `Behat Step Coverage Analysis\n${'='.repeat(55)}\n`;
    text += `\nFeature files: ${featureFiles.length}  Steps: ${allSteps.length}  Definitions: ${definitions.length}\n`;
    text += `Steps without definitions: ${missingDefs.length}  Unused definitions: ${unusedDefs.length}  Issues: ${totalIssues}\n`;

    if (missingDefs.length > 0) {
      text += `\nUndefined Steps:\n`;
      for (const r of missingDefs) {
        text += `  [${r.featureFile}] "${r.step}"\n`;
        for (const issue of r.issues) text += `    ! ${issue}\n`;
      }
    }

    if (unusedDefs.length > 0) {
      text += `\nUnused Step Definitions:\n`;
      for (const d of unusedDefs) {
        text += `  [${d.file}] "${d.pattern}" (${d.annotation}) — never used in feature files\n`;
      }
    }

    // Non-standard locations
    const standardPaths = ['features/bootstrap', 'Behat'];
    const nonStandardFiles = definitionFiles.filter((f) =>
      !standardPaths.some((p) => f.includes(p))
    );
    if (nonStandardFiles.length > 0) {
      text += `\nNon-standard step definition locations:\n`;
      for (const f of nonStandardFiles) {
        text += `  ${path.basename(f)} — Behat may not auto-load from this location\n`;
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

export function getBehatStepCoverageStats(appPath: string): McpToolResult {
  try {
    const featuresDir = path.join(appPath, 'features');
    if (!fs.existsSync(featuresDir)) {
      return { content: [{ type: 'text', text: 'No features/ directory found.' }] };
    }

    const featureFiles = getFeatureFiles(featuresDir);
    const definitionFiles = getStepDefinitionFiles(appPath);
    const definitions = extractStepDefinitions(definitionFiles);

    const allSteps: Array<{ text: string; featureFile: string }> = [];
    for (const f of featureFiles) {
      allSteps.push(...extractStepsFromFeature(f));
    }

    let defined = 0;
    const usedDefinitions = new Set<string>();
    for (const step of allSteps) {
      const matchedDef = definitions.find((d) => stepMatchesDefinition(step.text, d.pattern));
      if (matchedDef) {
        defined++;
        usedDefinitions.add(matchedDef.pattern);
      }
    }

    const coveragePct = allSteps.length > 0
      ? Math.round((defined / allSteps.length) * 100)
      : 100;

    let text = `Behat Step Coverage Statistics\n${'='.repeat(40)}\n\n`;
    text += `Feature files:                  ${featureFiles.length}\n`;
    text += `Total steps in features:        ${allSteps.length}\n`;
    text += `Steps with definitions:         ${defined}\n`;
    text += `Steps WITHOUT definitions:      ${allSteps.length - defined}\n`;
    text += `Step definitions:               ${definitions.length}\n`;
    text += `Unused definitions:             ${definitions.length - usedDefinitions.size}\n`;
    text += `Coverage:                       ${coveragePct}%\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getBehatStepCoverageTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_behat_step_coverage',
      description: 'Analyse Behat step coverage: match .feature file steps against PHP step definitions (@Given/@When/@Then / PHP 8 attributes); reports undefined steps (runtime errors), unused definitions (dead code), overly broad regex patterns, non-standard file locations',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_behat_step_coverage_stats',
      description: 'Get Behat step coverage statistics: feature file count, step count, defined vs undefined steps, unused definitions, coverage percentage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
