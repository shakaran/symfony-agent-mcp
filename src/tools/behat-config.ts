/**
 * Behat Functional Test Configuration Inspector
 *
 * Reads behat.yml / behat.yml.dist:
 *   - Test suites: name, contexts, feature paths
 *   - Extensions: Symfony, Mink (Goutte/Selenium/Panther), Behatch
 *   - base_url per suite or default
 *   - default_session (goutte/selenium2/panther)
 *
 * Scans features/ directory:
 *   - .feature file count per suite
 *   - Scenario / Scenario Outline count
 *   - Tags used (@javascript, @wip, @slow)
 *
 * Scans src/ for step definitions (Context classes):
 *   - Classes ending in Context or implementing ContextInterface
 *   - Number of @Given/@When/@Then step definitions
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

interface BehatSuite {
  name: string;
  contexts: string[];
  featurePaths: string[];
  featureCount: number;
  scenarioCount: number;
  tags: string[];
}

interface BehatExtension {
  name: string;
  driver?: string;
}

interface BehatConfig {
  baseUrl?: string;
  defaultSession?: string;
  suites: BehatSuite[];
  extensions: BehatExtension[];
}

interface BehatContext {
  class: string;
  file: string;
  stepCount: number;
}

// ─── Feature file scanning ───────────────────────────────────────────────────

function countScenariosInFeature(filePath: string): { scenarios: number; tags: string[] } {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return { scenarios: 0, tags: [] }; }

  const scenarios = (content.match(/^\s*(?:Scenario|Scenario Outline):/gm) ?? []).length;
  const tagMatches = content.match(/@\w+/g) ?? [];
  const tags = [...new Set(tagMatches)];
  return { scenarios, tags };
}

function countFeaturesInDir(dir: string): { count: number; scenarios: number; tags: string[] } {
  let count = 0;
  let scenarios = 0;
  const allTags: string[] = [];

  if (!fs.existsSync(dir)) return { count, scenarios, tags: [] };

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const sub = countFeaturesInDir(full);
        count    += sub.count;
        scenarios += sub.scenarios;
        allTags.push(...sub.tags);
      } else if (entry.name.endsWith('.feature')) {
        count++;
        const r = countScenariosInFeature(full);
        scenarios += r.scenarios;
        allTags.push(...r.tags);
      }
    }
  } catch { /* skip */ }

  return { count, scenarios, tags: [...new Set(allTags)] };
}

// ─── Config loading ──────────────────────────────────────────────────────────

function loadBehatConfig(appPath: string): BehatConfig | null {
  const candidates = ['behat.yml', 'behat.yml.dist', 'behat.yaml', 'behat.yaml.dist'];

  for (const fname of candidates) {
    const raw = parseYamlFile(path.join(appPath, fname)) as Record<string, unknown> | null;
    if (!raw) continue;

    const defaultRaw = raw['default'] as Record<string, unknown> | undefined ?? raw;

    // Extensions
    const extsRaw = (defaultRaw['extensions'] ?? {}) as Record<string, unknown>;
    const extensions: BehatExtension[] = [];
    for (const [extName] of Object.entries(extsRaw)) {
      const shortName = extName.split('\\').pop() ?? extName;
      const extDef = extsRaw[extName] as Record<string, unknown> | undefined;
      const driver = (extDef?.['default_session'] ?? extDef?.['driver']) as string | undefined;
      extensions.push({ name: shortName, driver: driver ? String(driver) : undefined });
    }

    // Base URL
    const minkExt = Object.entries(extsRaw).find(([k]) => k.toLowerCase().includes('mink'));
    const minkDef = minkExt ? minkExt[1] as Record<string, unknown> : {};
    const baseUrl = minkDef?.['base_url'] ? String(minkDef['base_url']) : undefined;
    const defaultSession = minkDef?.['default_session'] ? String(minkDef['default_session']) : undefined;

    // Suites
    const suitesRaw = (defaultRaw['suites'] ?? {}) as Record<string, unknown>;
    const suites: BehatSuite[] = [];

    for (const [sname, sdef] of Object.entries(suitesRaw)) {
      if (!sdef || typeof sdef !== 'object') continue;
      const sd = sdef as Record<string, unknown>;

      const contextsRaw = sd['contexts'];
      const contexts: string[] = [];
      if (Array.isArray(contextsRaw)) {
        for (const c of contextsRaw) {
          contexts.push(typeof c === 'string' ? c.split('\\').pop() ?? c : Object.keys(c as object)[0].split('\\').pop() ?? '');
        }
      }

      const pathsRaw = sd['paths'] ?? sd['features'];
      const featurePaths = pathsRaw
        ? (Array.isArray(pathsRaw) ? pathsRaw.map(String) : [String(pathsRaw)])
        : ['features'];

      // Count features across all paths
      let totalFeatures = 0;
      let totalScenarios = 0;
      const allTags: string[] = [];
      for (const p of featurePaths) {
        const absPath = path.isAbsolute(p) ? p : path.join(appPath, p);
        // Containment check: YAML-derived paths must not escape appPath
        const resolvedAbs = path.resolve(absPath);
        const resolvedApp = path.resolve(appPath);
        if (!resolvedAbs.startsWith(resolvedApp + path.sep) && resolvedAbs !== resolvedApp) continue;
        const r = countFeaturesInDir(absPath);
        totalFeatures  += r.count;
        totalScenarios += r.scenarios;
        allTags.push(...r.tags);
      }

      suites.push({
        name: sname,
        contexts,
        featurePaths,
        featureCount: totalFeatures,
        scenarioCount: totalScenarios,
        tags: [...new Set(allTags)],
      });
    }

    // If no suites defined, scan default features/ dir
    if (suites.length === 0) {
      const r = countFeaturesInDir(path.join(appPath, 'features'));
      suites.push({
        name: 'default',
        contexts: [],
        featurePaths: ['features'],
        featureCount: r.count,
        scenarioCount: r.scenarios,
        tags: r.tags,
      });
    }

    return { baseUrl, defaultSession, suites, extensions };
  }
  return null;
}

// ─── Context scanning ────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function scanContexts(appPath: string): BehatContext[] {
  const dirs = [
    path.join(appPath, 'tests', 'Behat'),
    path.join(appPath, 'tests', 'Context'),
    path.join(appPath, 'features', 'bootstrap'),
    path.join(appPath, 'features', 'context'),
    path.join(appPath, 'src'),
  ];

  const contexts: BehatContext[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);

      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const isContext =
        content.includes('ContextInterface') ||
        content.includes('RawMinkContext') ||
        content.includes('MinkContext') ||
        /class\s+\w+Context\b/.test(content);

      if (!isContext) continue;

      const classM = /class\s+(\w+)/.exec(content);
      if (!classM) continue;

      const stepCount = (content.match(/@(?:Given|When|Then|And|But)\s*\(/g) ?? []).length;
      contexts.push({ class: classM[1], file: path.basename(file), stepCount });
    }
  }

  return contexts.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listBehatConfig(appPath: string): McpToolResult {
  try {
    const config = loadBehatConfig(appPath);
    const contexts = scanContexts(appPath);

    if (!config && contexts.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'Behat not configured (behat.yml not found).\n\nInstall:\n  composer require --dev behat/behat friends-of-behat/symfony-extension\n\nCreate behat.yml:\n  default:\n    suites:\n      default:\n        contexts: [App\\Tests\\Behat\\DefaultContext]\n        paths: [features]',
        }],
      };
    }

    let text = `Behat Functional Test Configuration\n${'='.repeat(55)}\n`;

    if (config) {
      if (config.baseUrl) text += `\nBase URL:        ${config.baseUrl}\n`;
      if (config.defaultSession) text += `Default session: ${config.defaultSession}\n`;

      if (config.extensions.length > 0) {
        text += `\nExtensions:\n`;
        for (const ext of config.extensions) {
          const driver = ext.driver ? `  (${ext.driver})` : '';
          text += `  ${ext.name}${driver}\n`;
        }
      }

      const totalFeatures  = config.suites.reduce((s, suite) => s + suite.featureCount, 0);
      const totalScenarios = config.suites.reduce((s, suite) => s + suite.scenarioCount, 0);

      text += `\nSuites (${config.suites.length})  —  ${totalFeatures} features, ${totalScenarios} scenarios:\n`;
      for (const suite of config.suites) {
        text += `\n  ${suite.name}\n`;
        text += `    Paths:     ${suite.featurePaths.join(', ')}\n`;
        text += `    Features:  ${suite.featureCount}  (${suite.scenarioCount} scenarios)\n`;
        if (suite.contexts.length > 0) {
          text += `    Contexts:  ${suite.contexts.join(', ')}\n`;
        }
        const jsTag = suite.tags.filter((t) => t.includes('javascript') || t.includes('js'));
        const wipTag = suite.tags.filter((t) => t.includes('wip'));
        if (jsTag.length > 0) text += `    JS tagged: ${jsTag.join(', ')}\n`;
        if (wipTag.length > 0) text += `    WIP tags:  ${wipTag.join(', ')}\n`;
      }

      // WIP scenarios warning
      const wipSuites = config.suites.filter((s) => s.tags.some((t) => t.includes('wip')));
      if (wipSuites.length > 0) {
        text += `\n⚠ Suites with @wip scenarios — may be excluded from CI: ${wipSuites.map((s) => s.name).join(', ')}\n`;
      }
    }

    if (contexts.length > 0) {
      const totalSteps = contexts.reduce((s, c) => s + c.stepCount, 0);
      text += `\nStep definition contexts (${contexts.length})  —  ${totalSteps} steps:\n`;
      for (const ctx of contexts) {
        text += `  ${ctx.class.padEnd(40)} ${ctx.stepCount} steps  (${ctx.file})\n`;
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

export function getBehatStats(appPath: string): McpToolResult {
  try {
    const config = loadBehatConfig(appPath);
    const contexts = scanContexts(appPath);

    let text = `Behat Statistics\n${'='.repeat(40)}\n\n`;

    if (!config) {
      text += 'behat.yml: not found\n';
    } else {
      const totalFeatures  = config.suites.reduce((s, suite) => s + suite.featureCount, 0);
      const totalScenarios = config.suites.reduce((s, suite) => s + suite.scenarioCount, 0);
      text += `Suites:         ${config.suites.length}\n`;
      text += `Feature files:  ${totalFeatures}\n`;
      text += `Scenarios:      ${totalScenarios}\n`;
      text += `Extensions:     ${config.extensions.length}\n`;
    }

    const totalSteps = contexts.reduce((s, c) => s + c.stepCount, 0);
    text += `Context classes: ${contexts.length}\n`;
    text += `Step defs:       ${totalSteps}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getBehatConfigTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_behat_config',
      description: 'Show Behat configuration: suites, contexts, extensions (Mink/Panther), feature file count, scenario count per suite, WIP scenario warnings',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_behat_stats',
      description: 'Show Behat statistics: suite count, total feature files, total scenarios, context class count, step definition count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
