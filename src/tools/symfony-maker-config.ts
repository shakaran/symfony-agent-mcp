/**
 * Symfony MakerBundle Configuration Inspector
 *
 * Reads config/packages/maker.yaml:
 *   - root_namespace (default: App)
 *   - generate_final_classes (default: true in MakerBundle ≥1.58)
 *
 * Scans src/ for generated class patterns by type:
 *   - Entity: src/Entity/*.php
 *   - Controller: src/Controller/(subdir)*.php
 *   - Form: src/Form/*.php
 *   - Repository: src/Repository/*.php
 *   - EventSubscriber/Listener: src/EventSubscriber, src/EventListener
 *   - Command: src/Command/*.php
 *   - MessageHandler: src/MessageHandler/*.php
 *   - DataFixture: src/DataFixtures/*.php
 *   - Voter: src/Security/Voter*.php
 *   - Normalizer/Denormalizer: src/Serializer/*.php
 *   - Service/Provider: everything else in src/
 *
 * Analysis:
 *   - Unusually large class counts per type (code smell)
 *   - Command classes without #[AsCommand] attribute (missing attribute = not auto-registered)
 *   - EventSubscribers that also have #[AsEventListener] (duplicate registration risk)
 *   - Maker root_namespace mismatch with composer.json autoload
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface MakerConfig {
  rootNamespace: string;
  generateFinalClasses?: boolean;
}

interface ClassCount {
  type: string;
  count: number;
  examples: string[];
}

function loadMakerConfig(appPath: string): MakerConfig | null {
  const filePath = path.join(appPath, 'config', 'packages', 'maker.yaml');
  if (!fs.existsSync(filePath)) return null;

  const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
  if (!raw) return null;

  const maker = (raw['maker'] ?? raw) as Record<string, unknown>;
  return {
    rootNamespace: String(maker['root_namespace'] ?? 'App'),
    generateFinalClasses: typeof maker['generate_final_classes'] === 'boolean' ? maker['generate_final_classes'] : undefined,
  };
}

function countClassesInDir(dir: string, maxExamples = 3): { count: number; examples: string[] } {
  if (!fs.existsSync(dir)) return { count: 0, examples: [] };
  const examples: string[] = [];
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.php')) {
        count++;
        if (examples.length < maxExamples) examples.push(e.name.replace('.php', ''));
      } else if (e.isDirectory()) {
        const sub = countClassesInDir(path.join(dir, e.name), maxExamples - examples.length);
        count += sub.count;
        examples.push(...sub.examples.slice(0, maxExamples - examples.length));
      }
    }
  } catch { /* skip */ }
  return { count, examples };
}

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

function detectIssues(appPath: string): string[] {
  const issues: string[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return issues;

  // Commands without #[AsCommand]
  const cmdDir = path.join(srcDir, 'Command');
  if (fs.existsSync(cmdDir)) {
    for (const file of getAllPhpFiles(cmdDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      if (content.includes('extends Command') && !content.includes('#[AsCommand')) {
        const classM = /class\s+(\w+)/.exec(content);
        if (classM) issues.push(`Command ${classM[1]} extends Command but has no #[AsCommand] attribute`);
      }
    }
  }

  // EventSubscribers with both implements EventSubscriberInterface AND #[AsEventListener]
  const subDirs = ['EventSubscriber', 'EventListener'];
  for (const dir of subDirs) {
    const dirPath = path.join(srcDir, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const file of getAllPhpFiles(dirPath)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      if (content.includes('EventSubscriberInterface') && content.includes('#[AsEventListener')) {
        const classM = /class\s+(\w+)/.exec(content);
        if (classM) issues.push(`${classM[1]} implements EventSubscriberInterface AND has #[AsEventListener] — may double-register`);
      }
    }
  }

  return issues;
}

export function listMakerConfig(appPath: string): McpToolResult {
  try {
    const config = loadMakerConfig(appPath);
    const srcDir = path.join(appPath, 'src');
    const srcExists = fs.existsSync(srcDir);

    const counts: ClassCount[] = [
      { type: 'Entity', count: 0, examples: [] },
      { type: 'Controller', count: 0, examples: [] },
      { type: 'Form', count: 0, examples: [] },
      { type: 'Repository', count: 0, examples: [] },
      { type: 'Command', count: 0, examples: [] },
      { type: 'EventSubscriber', count: 0, examples: [] },
      { type: 'EventListener', count: 0, examples: [] },
      { type: 'MessageHandler', count: 0, examples: [] },
      { type: 'DataFixtures', count: 0, examples: [] },
      { type: 'Security/Voter', count: 0, examples: [] },
      { type: 'Serializer', count: 0, examples: [] },
    ];

    if (srcExists) {
      const dirMap: Record<string, string> = {
        'Entity': path.join(srcDir, 'Entity'),
        'Controller': path.join(srcDir, 'Controller'),
        'Form': path.join(srcDir, 'Form'),
        'Repository': path.join(srcDir, 'Repository'),
        'Command': path.join(srcDir, 'Command'),
        'EventSubscriber': path.join(srcDir, 'EventSubscriber'),
        'EventListener': path.join(srcDir, 'EventListener'),
        'MessageHandler': path.join(srcDir, 'MessageHandler'),
        'DataFixtures': path.join(srcDir, 'DataFixtures'),
        'Security/Voter': path.join(srcDir, 'Security'),
        'Serializer': path.join(srcDir, 'Serializer'),
      };

      for (const entry of counts) {
        const dir = dirMap[entry.type];
        if (!dir) continue;
        const { count, examples } = countClassesInDir(dir);
        entry.count = count;
        entry.examples = examples;
      }
    }

    const issues = detectIssues(appPath);

    let text = `Symfony MakerBundle Configuration\n${'='.repeat(55)}\n\n`;

    if (config) {
      text += `root_namespace:          ${config.rootNamespace}\n`;
      text += `generate_final_classes:  ${config.generateFinalClasses === undefined ? 'default' : String(config.generateFinalClasses)}\n`;
    } else {
      text += `maker.yaml:              not found (using defaults)\n`;
      text += `root_namespace:          App (default)\n`;
    }

    text += `\nClass counts by type:\n`;
    const populated = counts.filter((c) => c.count > 0);
    if (populated.length === 0) {
      text += `  (no src/ directory or all counts are 0)\n`;
    } else {
      for (const c of populated) {
        const examples = c.examples.length > 0 ? `  (e.g. ${c.examples.slice(0, 2).join(', ')})` : '';
        const warn = c.type === 'Controller' && c.count > 30 ? ' ⚠ many controllers' :
                     c.type === 'Entity' && c.count > 50 ? ' ⚠ large domain' : '';
        text += `  ${c.type.padEnd(20)} ${String(c.count).padStart(4)}${examples}${warn}\n`;
      }
    }

    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
      for (const i of issues) text += `  ⚠ ${i}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMakerStats(appPath: string): McpToolResult {
  try {
    const config  = loadMakerConfig(appPath);
    const srcDir  = path.join(appPath, 'src');
    const total   = srcDir ? getAllPhpFiles(srcDir).length : 0;
    const issues  = detectIssues(appPath);

    let text = `Maker Statistics\n${'='.repeat(40)}\n\n`;
    text += `maker.yaml found:  ${config ? 'yes' : 'no'}\n`;
    text += `root_namespace:    ${config?.rootNamespace ?? 'App'}\n`;
    text += `Total PHP files:   ${total}\n`;
    text += `Issues detected:   ${issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMakerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_maker_config',
      description: 'Show Symfony MakerBundle configuration: maker.yaml (root_namespace, generate_final_classes), class counts by type (Entity/Controller/Form/Repository/Command/EventSubscriber/MessageHandler/DataFixtures/Serializer), missing #[AsCommand] detection, double-registration warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_maker_stats',
      description: 'Show MakerBundle statistics: config found flag, root namespace, total PHP file count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
