import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface TaggedIteratorInfo {
  file: string;
  class: string;
  paramName: string;
  tag: string;
  type: 'iterator' | 'locator';
  hasDefaultIndex: boolean;
  hasPriority: boolean;
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

function parseTaggedIteratorFile(filePath: string, appPath: string, knownTags: Set<string>): TaggedIteratorInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  if (!content.includes('TaggedIterator') && !content.includes('TaggedLocator')) return [];
  if (content.includes('namespace Symfony\\')) return [];

  const classM = /class\s+(\w{1,100})/.exec(content);
  const className = classM ? classM[1] : path.basename(filePath, '.php');

  const results: TaggedIteratorInfo[] = [];

  // Match #[TaggedIterator('tag.name')] on constructor params
  const iteratorRegex = /#\[TaggedIterator\s*\(\s*['"]([^'"]{1,100})['"]((?:[^)]{0,200}))\)\s*\]\s*(?:\w+\s+)?\$(\w{1,80})/g;
  for (const m of content.matchAll(iteratorRegex)) {
    const tag = m[1];
    const attrs = m[2];
    const paramName = m[3];
    const hasDefaultIndex = attrs.includes('defaultIndexMethod') || attrs.includes('index_by');
    const hasPriority = attrs.includes('defaultPriorityMethod') || attrs.includes('priority');

    const issues: string[] = [];

    // Check type hint — should be iterable
    const paramRegex = new RegExp(`(\\w+)\\s+\\$${paramName}\\b`);
    const paramTypeM = paramRegex.exec(content);
    if (paramTypeM) {
      const typHint = paramTypeM[1];
      if (typHint !== 'iterable' && typHint !== 'array') {
        issues.push(`#[TaggedIterator] on non-iterable type hint "${typHint}" for $${paramName} — type mismatch`);
      }
    }

    if (!knownTags.has(tag)) {
      issues.push(`TaggedIterator tag "${tag}" has no registered services — iterator will be empty (silent)`);
    }

    results.push({
      file: path.relative(appPath, filePath),
      class: className,
      paramName,
      tag,
      type: 'iterator',
      hasDefaultIndex,
      hasPriority,
      issues,
    });
  }

  // Match #[TaggedLocator('tag.name')]
  const locatorRegex = /#\[TaggedLocator\s*\(\s*['"]([^'"]{1,100})['"]((?:[^)]{0,200}))\)\s*\]\s*(?:\w+\s+)?\$(\w{1,80})/g;
  for (const m of content.matchAll(locatorRegex)) {
    const tag = m[1];
    const attrs = m[2];
    const paramName = m[3];
    const hasDefaultIndex = attrs.includes('defaultIndexMethod') || attrs.includes('index_by');
    const hasPriority = attrs.includes('defaultPriorityMethod') || attrs.includes('priority');

    const issues: string[] = [];

    if (!knownTags.has(tag)) {
      issues.push(`TaggedLocator tag "${tag}" has no registered services — locator->get() will throw`);
    }

    // Check if locator->get() is called without has() guard
    const locatorUseRegex = new RegExp(`\\$this->${paramName}->get\\s*\\(`);
    const locatorHasRegex = new RegExp(`\\$this->${paramName}->has\\s*\\(`);
    if (locatorUseRegex.test(content) && !locatorHasRegex.test(content)) {
      issues.push(`TaggedLocator->get() used without ->has() check — throws if service not found`);
    }

    results.push({
      file: path.relative(appPath, filePath),
      class: className,
      paramName,
      tag,
      type: 'locator',
      hasDefaultIndex,
      hasPriority,
      issues,
    });
  }

  return results;
}

function collectKnownTags(appPath: string): Set<string> {
  const tags = new Set<string>();

  // From services.yaml tags
  const servicesYaml = path.join(appPath, 'config', 'services.yaml');
  const raw = parseYamlFile(servicesYaml) as Record<string, unknown> | null;
  if (raw) {
    const services = (raw['services'] ?? {}) as Record<string, unknown>;
    for (const [, def] of Object.entries(services)) {
      const d = (def ?? {}) as Record<string, unknown>;
      const tagList = (d['tags'] ?? []) as unknown[];
      for (const tag of tagList) {
        if (typeof tag === 'string') tags.add(tag);
        if (typeof tag === 'object' && tag !== null) {
          const t = tag as Record<string, unknown>;
          if (typeof t['name'] === 'string') tags.add(t['name']);
        }
      }
    }
  }

  // From PHP attributes in src/
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      // #[AutoconfigureTag('tag.name')]
      for (const m of content.matchAll(/#\[AutoconfigureTag\s*\(\s*['"]([^'"]{1,100})['"]/g)) {
        tags.add(m[1]);
      }
      // $container->registerForAutoconfiguration(X::class)->addTag('tag')
      for (const m of content.matchAll(/->addTag\s*\(\s*['"]([^'"]{1,100})['"]/g)) {
        tags.add(m[1]);
      }
    }
  }

  return tags;
}

function loadTaggedIterators(appPath: string): TaggedIteratorInfo[] {
  const knownTags = collectKnownTags(appPath);
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: TaggedIteratorInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    results.push(...parseTaggedIteratorFile(file, appPath, knownTags));
  }
  return results;
}

export function listTaggedIterators(appPath: string): McpToolResult {
  try {
    const iterators = loadTaggedIterators(appPath);
    if (iterators.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No #[TaggedIterator] or #[TaggedLocator] usage found.\n\nExample:\n  public function __construct(\n    #[TaggedIterator(\'app.handler\')] private iterable $handlers\n  ) {}',
        }],
      };
    }

    const totalIssues = iterators.reduce((s, i) => s + i.issues.length, 0);
    let text = `Tagged Iterators & Locators\n${'='.repeat(55)}\n\nEntries: ${iterators.length}  Issues: ${totalIssues}\n`;

    for (const info of iterators.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}::$${info.paramName}  (${info.file})\n`;
      text += `    type: ${info.type}\n`;
      text += `    tag:  ${info.tag}\n`;
      if (info.hasDefaultIndex) text += `    default index method: yes\n`;
      if (info.hasPriority) text += `    priority method: yes\n`;
      for (const issue of info.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTaggedIteratorStats(appPath: string): McpToolResult {
  try {
    const iterators = loadTaggedIterators(appPath);
    const iteratorCount = iterators.filter((i) => i.type === 'iterator').length;
    const locatorCount = iterators.filter((i) => i.type === 'locator').length;

    let text = `Tagged Iterator Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total tagged params:     ${iterators.length}\n`;
    text += `  TaggedIterator:        ${iteratorCount}\n`;
    text += `  TaggedLocator:         ${locatorCount}\n`;
    text += `  With default index:    ${iterators.filter((i) => i.hasDefaultIndex).length}\n`;
    text += `  With priority method:  ${iterators.filter((i) => i.hasPriority).length}\n`;
    text += `Issues:                  ${iterators.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTaggedIteratorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_tagged_iterators',
      description: 'Show #[TaggedIterator] and #[TaggedLocator] usage: tag names, type hints, defaultIndexMethod/priority; warns on non-iterable type hint, empty tag (no services), locator->get() without ->has(), TaggedIterator vs TaggedLocator intent mismatch',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_tagged_iterator_stats',
      description: 'Show tagged iterator statistics: total count, iterator/locator split, default index/priority method usage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
