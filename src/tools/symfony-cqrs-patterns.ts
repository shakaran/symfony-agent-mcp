import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CqrsPatternInfo {
  file: string;
  type: 'command' | 'query' | 'handler' | 'bus';
  name: string;
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

function buildCqrsInfos(appPath: string): CqrsPatternInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: CqrsPatternInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const name = classMatch ? classMatch[1] : path.basename(file, '.php');
    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    const isCommand = content.includes('CommandInterface') ||
      content.includes('AbstractCommand') ||
      (file.includes('/Command/') && !content.includes('Command extends Command'));

    const isQuery = content.includes('QueryInterface') ||
      content.includes('AbstractQuery') ||
      file.includes('/Query/');

    const isHandler = (content.includes('HandleTrait') ||
      content.includes('CommandBusInterface') ||
      content.includes('QueryBusInterface') ||
      /#\[AsMessageHandler\]/.test(content)) &&
      content.includes('__invoke');

    const isBus = content.includes('CommandBusInterface') ||
      content.includes('QueryBusInterface') ||
      content.includes('MessageBusInterface');

    if (isHandler) {
      const returnsNonVoid = /function __invoke[^{]{0,200}\)\s*:\s*(?!void)[\w\\?]{1,60}/.test(content);
      const hasCommandInName = name.toLowerCase().includes('command') || file.toLowerCase().includes('/command/');
      if (returnsNonVoid && hasCommandInName) {
        issues.push(`Command handler "${name}" returns a non-void type — commands should be fire-and-forget (return void)`);
      }

      const hasWrite = /(?:->persist\(|->flush\(|->remove\(|->executeStatement\(|->save\()/.test(content);
      const isQueryHandler = name.toLowerCase().includes('query') || file.toLowerCase().includes('/query/');
      if (isQueryHandler && hasWrite) {
        issues.push(`Query handler "${name}" contains write operations — queries should be read-only (no side effects)`);
      }
    }

    if (isBus) {
      const hasCommandBus = content.includes('CommandBusInterface');
      const hasQueryBus = content.includes('QueryBusInterface');
      const hasGenericBus = content.includes('MessageBusInterface') && !hasCommandBus && !hasQueryBus;
      if (hasGenericBus) {
        issues.push(`"${name}" uses generic MessageBusInterface for both commands and queries — consider separate CommandBus and QueryBus interfaces`);
      }
    }

    if (isCommand) results.push({ file: relFile, type: 'command', name, issues });
    else if (isQuery) results.push({ file: relFile, type: 'query', name, issues });
    else if (isHandler) results.push({ file: relFile, type: 'handler', name, issues });
    else if (isBus && issues.length > 0) results.push({ file: relFile, type: 'bus', name, issues });
  }

  return results;
}

export function listSymfonyCqrsPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildCqrsInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No CQRS patterns found in src/ (no Command/Query/CommandBus/QueryBus).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `CQRS Pattern Analysis\n${'='.repeat(50)}\n\nClasses: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  [${info.type.toUpperCase()}] ${info.name}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyCqrsStats(appPath: string): McpToolResult {
  try {
    const infos = buildCqrsInfos(appPath);
    let text = `CQRS Statistics\n${'='.repeat(40)}\n\n`;
    text += `Commands:   ${infos.filter((i) => i.type === 'command').length}\n`;
    text += `Queries:    ${infos.filter((i) => i.type === 'query').length}\n`;
    text += `Handlers:   ${infos.filter((i) => i.type === 'handler').length}\n`;
    text += `Buses:      ${infos.filter((i) => i.type === 'bus').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyCqrsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_cqrs_patterns', description: 'Detect CQRS patterns in src/; warns on command handler returning non-void, query handler with side effects, mixed MessageBus for commands and queries', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_cqrs_stats', description: 'Statistics for CQRS: command/query/handler/bus count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
