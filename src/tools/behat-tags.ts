/**
 * Behat Tag Inspector
 *
 * Scans features/ .feature files for @tag annotations on Feature, Scenario, Scenario Outline.
 * Reads behat.yaml for: filter_tags, profiles with tag filters, javascript profile.
 *
 * Warnings:
 *   - @javascript scenarios without browser driver configured in behat.yaml
 *   - @wip scenarios that seem complete (all steps defined)
 *   - @skip without TODO comment
 *   - Large percentage of @javascript scenarios (slow suite)
 *   - Duplicate tags on feature and scenario (redundant)
 *   - @slow without timeout configuration
 *   - Custom tags used but not in any profile filter
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

interface BehatTagInfo {
  featureFile: string;
  scenarioTitle: string;
  tags: string[];
  needsBrowser: boolean;
  hasBrowserConfig: boolean;
  isWip: boolean;
  issues: string[];
}

interface BehatConfig {
  hasBrowserDriver: boolean;
  profileTags: string[];
  hasJsProfile: boolean;
  hasTimeoutConfig: boolean;
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

function readBehatConfig(appPath: string): BehatConfig {
  const result: BehatConfig = {
    hasBrowserDriver: false,
    profileTags: [],
    hasJsProfile: false,
    hasTimeoutConfig: false,
  };

  const behatYamlPaths = [
    path.join(appPath, 'behat.yaml'),
    path.join(appPath, 'behat.yml'),
    path.join(appPath, 'config', 'behat.yaml'),
  ];

  for (const yamlPath of behatYamlPaths) {
    const config = parseYamlFile(yamlPath);
    if (!config) continue;

    const configStr = JSON.stringify(config);

    // Check for browser driver
    if (configStr.includes('selenium') || configStr.includes('playwright') ||
        configStr.includes('panther') || configStr.includes('chrome') ||
        configStr.includes('firefox') || configStr.includes('webkit')) {
      result.hasBrowserDriver = true;
    }

    // Check for javascript profile
    if (configStr.includes('javascript') || configStr.includes('@javascript')) {
      result.hasJsProfile = true;
    }

    // Extract profile tag filters
    const profiles = (config as Record<string, unknown>)['default'] ??
      (config as Record<string, unknown>)['profiles'];
    if (profiles && typeof profiles === 'object') {
      const profileStr = JSON.stringify(profiles);
      const tagMatches = profileStr.matchAll(/@\w{1,80}/g);
      for (const m of tagMatches) {
        result.profileTags.push(m[0]);
      }
    }

    // Check for timeout config
    if (configStr.includes('timeout') || configStr.includes('wait')) {
      result.hasTimeoutConfig = true;
    }
    break;
  }

  return result;
}

interface ParsedScenario {
  featureFile: string;
  featureTags: string[];
  scenarioTitle: string;
  scenarioTags: string[];
  lineIndex: number;
  lines: string[];
}

function parseFeatureFile(filePath: string): ParsedScenario[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const lines = content.split('\n');
  const scenarios: ParsedScenario[] = [];
  let featureTags: string[] = [];
  let pendingTags: string[] = [];

  for (let i = 0; i < lines.length && i < 2000; i++) {
    const line = lines[i].trim();

    // Extract tags from @ lines
    if (line.startsWith('@')) {
      const tags = line.match(/@\w{1,80}/g) ?? [];
      pendingTags.push(...tags);
      continue;
    }

    if (/^Feature:/i.test(line)) {
      featureTags = [...pendingTags];
      pendingTags = [];
      continue;
    }

    if (/^(Scenario|Scenario Outline|Scenario Template):/i.test(line)) {
      const titleM = /^(?:Scenario Outline|Scenario Template|Scenario):\s*(.{0,200})$/i.exec(line);
      const title = titleM ? titleM[1].trim() : line;
      scenarios.push({
        featureFile: path.basename(filePath),
        featureTags: [...featureTags],
        scenarioTitle: title,
        scenarioTags: [...pendingTags],
        lineIndex: i,
        lines,
      });
      pendingTags = [];
      continue;
    }

    // Reset pending tags if not consumed by Scenario
    if (line.length > 0 && !line.startsWith('#') && !line.startsWith('@')) {
      if (pendingTags.length > 0) pendingTags = [];
    }
  }

  return scenarios;
}

export function listBehatTags(appPath: string): McpToolResult {
  try {
    const featuresDir = path.join(appPath, 'features');
    if (!fs.existsSync(featuresDir)) {
      return { content: [{ type: 'text', text: 'No features/ directory found. Behat not configured.' }] };
    }

    const featureFiles = getFeatureFiles(featuresDir);
    if (featureFiles.length === 0) {
      return { content: [{ type: 'text', text: 'No .feature files found in features/.' }] };
    }

    const behatConfig = readBehatConfig(appPath);
    const results: BehatTagInfo[] = [];
    const allTags = new Set<string>();
    let jsScenarioCount = 0;
    let totalScenarioCount = 0;

    for (const f of featureFiles) {
      const scenarios = parseFeatureFile(f);
      for (const scenario of scenarios) {
        totalScenarioCount++;
        const allScenarioTags = [...new Set([...scenario.featureTags, ...scenario.scenarioTags])];
        for (const t of allScenarioTags) allTags.add(t);

        const needsBrowser = allScenarioTags.includes('@javascript') ||
          allScenarioTags.includes('@browser');
        if (needsBrowser) jsScenarioCount++;

        const isWip = allScenarioTags.includes('@wip') ||
          allScenarioTags.includes('@pending');
        const isSkip = allScenarioTags.includes('@skip') ||
          allScenarioTags.includes('@ignore');
        const isSlow = allScenarioTags.includes('@slow');

        const issues: string[] = [];

        // @javascript without browser driver
        if (needsBrowser && !behatConfig.hasBrowserDriver) {
          issues.push('@javascript tag without browser driver configured in behat.yaml (Selenium/Playwright/Panther)');
        }

        // @wip scenario that looks complete (no "TODO" or "pending" in steps)
        const scenarioLines = scenario.lines.slice(scenario.lineIndex, scenario.lineIndex + 20).join('\n');
        const hasTodo = /TODO|pending|not implemented|WIP/i.test(scenarioLines);
        if (isWip && !hasTodo) {
          issues.push('@wip scenario appears complete — remove @wip tag or add TODO comment');
        }

        // @skip without TODO comment
        if (isSkip) {
          const hasSkipComment = /TODO|FIXME|pending|skip reason/i.test(scenarioLines);
          if (!hasSkipComment) {
            issues.push('@skip/@ignore without TODO comment — explain why this scenario is skipped');
          }
        }

        // @slow without timeout configuration
        if (isSlow && !behatConfig.hasTimeoutConfig) {
          issues.push('@slow scenario without timeout configuration in behat.yaml');
        }

        // Duplicate tags on feature and scenario
        const duplicates = scenario.featureTags.filter((t) => scenario.scenarioTags.includes(t));
        if (duplicates.length > 0) {
          issues.push(`Redundant tags (already on Feature): ${duplicates.join(', ')}`);
        }

        results.push({
          featureFile: scenario.featureFile,
          scenarioTitle: scenario.scenarioTitle,
          tags: allScenarioTags,
          needsBrowser,
          hasBrowserConfig: behatConfig.hasBrowserDriver,
          isWip,
          issues,
        });
      }
    }

    // Custom tags not in any profile filter
    const unusedCustomTags: string[] = [];
    for (const tag of allTags) {
      const isStandard = ['@javascript', '@wip', '@skip', '@ignore', '@slow', '@browser'].includes(tag);
      if (!isStandard && !behatConfig.profileTags.includes(tag)) {
        unusedCustomTags.push(tag);
      }
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    const jsPercent = totalScenarioCount > 0
      ? Math.round((jsScenarioCount / totalScenarioCount) * 100)
      : 0;

    let text = `Behat Tag Analysis\n${'='.repeat(55)}\n`;
    text += `\nFeature files: ${featureFiles.length}  Scenarios: ${totalScenarioCount}  Tags: ${allTags.size}  Issues: ${totalIssues}\n`;
    text += `@javascript scenarios: ${jsScenarioCount} (${jsPercent}%)  Browser driver: ${behatConfig.hasBrowserDriver ? 'configured' : 'NOT configured'}\n`;

    if (jsPercent > 50) {
      text += `  ! Large percentage of @javascript scenarios (${jsPercent}%) — suite will be slow\n`;
    }

    if (unusedCustomTags.length > 0) {
      text += `\nCustom tags not in any behat.yaml profile filter:\n`;
      for (const t of unusedCustomTags.slice(0, 20)) text += `  ${t}\n`;
    }

    const withIssues = results.filter((r) => r.issues.length > 0);
    if (withIssues.length > 0) {
      text += `\nScenarios with issues:\n`;
      for (const r of withIssues) {
        text += `\n  [${r.featureFile}] "${r.scenarioTitle}"\n`;
        text += `    tags: ${r.tags.join(', ')}\n`;
        for (const issue of r.issues) text += `    ! ${issue}\n`;
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

export function getBehatTagStats(appPath: string): McpToolResult {
  try {
    const featuresDir = path.join(appPath, 'features');
    if (!fs.existsSync(featuresDir)) {
      return { content: [{ type: 'text', text: 'No features/ directory found.' }] };
    }

    const featureFiles = getFeatureFiles(featuresDir);
    const behatConfig = readBehatConfig(appPath);
    const tagCounts = new Map<string, number>();
    let totalScenarios = 0;

    for (const f of featureFiles) {
      const scenarios = parseFeatureFile(f);
      for (const scenario of scenarios) {
        totalScenarios++;
        const allTags = [...new Set([...scenario.featureTags, ...scenario.scenarioTags])];
        for (const t of allTags) {
          tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
        }
      }
    }

    const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);

    let text = `Behat Tag Statistics\n${'='.repeat(40)}\n\n`;
    text += `Feature files:                  ${featureFiles.length}\n`;
    text += `Total scenarios:                ${totalScenarios}\n`;
    text += `Unique tags:                    ${tagCounts.size}\n`;
    text += `Browser driver configured:      ${behatConfig.hasBrowserDriver ? 'yes' : 'NO'}\n`;
    text += `\nTop tags:\n`;
    for (const [tag, count] of sorted.slice(0, 15)) {
      text += `  ${tag.padEnd(30)} ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getBehatTagTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_behat_tags',
      description: 'Analyse Behat scenario tags: @javascript without browser driver, @wip without TODO, @skip without reason, large @javascript percentage (slow suite), redundant feature+scenario tags, @slow without timeout config, custom tags not in any profile filter',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_behat_tag_stats',
      description: 'Get Behat tag statistics: feature file count, scenario count, unique tags, tag frequency table, browser driver status',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
