/**
 * API Platform 3 State Providers and Processors Inspector
 *
 * Distinct from api-platform-config.ts (general config) and api-platform-filters.ts (filter setup).
 * Focuses on the API Platform 3 state layer (replaces DataProviders/DataPersisters):
 *
 * State Providers (ProviderInterface):
 *   - provide(Operation, array $uriVariables, array $context): object|array|null|iterable
 *   - #[ApiResource(provider: MyProvider::class)]
 *   - Decorated built-in providers (#[AsDecorator(decorates: CollectionProvider::class)])
 *   - Pagination provider usage
 *   - Security inside provide() (manual checks)
 *
 * State Processors (ProcessorInterface):
 *   - process(mixed $data, Operation, array $uriVariables, array $context): void|mixed
 *   - #[ApiResource(processor: MyProcessor::class)]
 *   - Decorated built-in processors
 *   - Doctrine flush inside process() (manual vs. automatic via DoctrineItemPersister)
 *   - Mailer/Notifier calls inside process()
 *
 * Operation → Provider/Processor mapping:
 *   - Operations without custom provider/processor (using defaults)
 *   - Operations with custom provider but no processor (or vice versa)
 *   - Deprecated DataProvider / DataPersister style (AP v2)
 *
 * Analysis:
 *   - process() without try/catch — exceptions not converted to API errors
 *   - provide() without pagination for collection operations
 *   - Multiple processors on same resource (via decorated chain)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ApiStateClass {
  class: string;
  file: string;
  type: 'provider' | 'processor';
  isDecorator: boolean;
  decorates?: string;
  boundResources: string[];
  hasPagination: boolean;
  hasFlush: boolean;
  hasMailer: boolean;
  issues: string[];
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

function parseStateClass(filePath: string, appPath: string): ApiStateClass | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isProvider  = content.includes('ProviderInterface') || content.includes('implements ProviderInterface');
  const isProcessor = content.includes('ProcessorInterface') || content.includes('implements ProcessorInterface');

  if (!isProvider && !isProcessor) return null;
  if (content.includes('namespace ApiPlatform\\') || content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const type: 'provider' | 'processor' = isProvider ? 'provider' : 'processor';

  const isDecorator = content.includes('#[AsDecorator') || content.includes('AsDecorator');
  const decoratesM  = /#\[AsDecorator[^)]*decorates\s*:\s*['"]?([A-Za-z\\:]+)['"]?/.exec(content);

  // Find resources that reference this class as provider/processor
  const boundResources: string[] = [];
  const className = classM[1];
  const resourcePattern = new RegExp(`provider:\\s*${className}::class|processor:\\s*${className}::class`);
  const globalSrcDir = path.join(appPath, 'src');
  if (fs.existsSync(globalSrcDir)) {
    for (const f of getAllPhpFiles(globalSrcDir)) {
      if (f === filePath) continue;
      let otherContent = '';
      try { otherContent = fs.readFileSync(f, 'utf-8'); } catch { continue; }
      if (resourcePattern.test(otherContent)) {
        const rm = /class\s+(\w+)/.exec(otherContent);
        if (rm) boundResources.push(rm[1]);
      }
    }
  }

  const hasPagination = content.includes('Pagination') || content.includes('paginator');
  const hasFlush      = content.includes('->flush()');
  const hasMailer     = content.includes('mailer') || content.includes('Mailer') ||
                        content.includes('sendMessage') || content.includes('notifier');

  const issues: string[] = [];
  if (type === 'processor' && !content.includes('try') && content.includes('flush')) {
    issues.push('process() flushes without try/catch — exceptions not converted to API errors');
  }
  if (type === 'provider' && !hasPagination && !isDecorator) {
    issues.push('provide() may return full collection without pagination support');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    type,
    isDecorator,
    decorates: decoratesM?.[1]?.split('\\').pop(),
    boundResources: boundResources.slice(0, 5),
    hasPagination,
    hasFlush,
    hasMailer,
    issues,
  };
}

function scanDeprecatedDataProviders(appPath: string): string[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const deprecated: string[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (content.includes('DataProviderInterface') || content.includes('DataPersisterInterface') ||
        content.includes('RestrictedDataProviderInterface')) {
      const classM = /class\s+(\w+)/.exec(content);
      if (classM) deprecated.push(classM[1]);
    }
  }
  return deprecated;
}

export function listApiStateProviders(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const classes: ApiStateClass[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const c = parseStateClass(file, appPath);
      if (c) classes.push(c);
    }

    const deprecated = scanDeprecatedDataProviders(appPath);

    if (classes.length === 0 && deprecated.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No API Platform state providers/processors found.\n\nCreate a provider:\n  #[AsProvider(priority: 0)]\n  class ArticleProvider implements ProviderInterface\n  {\n    public function provide(Operation $op, array $uriVars = [], array $ctx = []): iterable\n    {\n      return $this->repository->findAll();\n    }\n  }',
        }],
      };
    }

    const providers  = classes.filter((c) => c.type === 'provider');
    const processors = classes.filter((c) => c.type === 'processor');
    const totalIssues = classes.reduce((s, c) => s + c.issues.length, 0);

    let text = `API Platform State Layer\n${'='.repeat(55)}\n`;
    text += `\nProviders:   ${providers.length}  Processors: ${processors.length}  Issues: ${totalIssues}\n`;
    if (deprecated.length > 0) text += `⚠ Deprecated AP v2 style: ${deprecated.join(', ')}\n`;

    for (const group of [providers, processors]) {
      if (group.length === 0) continue;
      const label = group[0].type === 'provider' ? 'Providers' : 'Processors';
      text += `\n${label}:\n`;
      for (const c of group.sort((a, b) => a.class.localeCompare(b.class))) {
        const dec = c.isDecorator ? `  [decorates: ${c.decorates ?? '?'}]` : '';
        const res = c.boundResources.length > 0 ? `  → ${c.boundResources.join(', ')}` : '';
        const flags = [
          c.hasPagination ? 'paged' : '',
          c.hasFlush ? 'flush' : '',
          c.hasMailer ? 'mailer' : '',
        ].filter(Boolean).join(', ');
        text += `  ${c.class}${dec}${res}\n`;
        if (flags) text += `    [${flags}]\n`;
        for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
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

export function getApiStateStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const classes: ApiStateClass[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const c = parseStateClass(file, appPath);
        if (c) classes.push(c);
      }
    }
    const deprecated = scanDeprecatedDataProviders(appPath);

    let text = `API State Statistics\n${'='.repeat(40)}\n\n`;
    text += `Providers:       ${classes.filter((c) => c.type === 'provider').length}\n`;
    text += `Processors:      ${classes.filter((c) => c.type === 'processor').length}\n`;
    text += `Decorators:      ${classes.filter((c) => c.isDecorator).length}\n`;
    text += `AP v2 deprecated: ${deprecated.length}\n`;
    text += `Issues:          ${classes.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiStateTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_api_state_providers',
      description: 'Show API Platform 3 state providers and processors: ProviderInterface/ProcessorInterface implementations, #[AsDecorator] detection, resource binding, pagination/flush/mailer flags, deprecated AP v2 DataProvider/DataPersister style detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_api_state_stats',
      description: 'Show API state statistics: provider count, processor count, decorator count, deprecated AP v2 count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
