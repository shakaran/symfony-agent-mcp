import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DataProviderInfo {
  file: string;
  class?: string;
  providers: Array<{ name: string; isStatic: boolean; returnsGenerator: boolean }>;
  consumerCount: number;
  issues: string[];
}

function getAllPhpTestFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpTestFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseDataProviders(filePath: string, appPath: string): DataProviderInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('dataProvider') && !content.includes('DataProvider') && !content.includes('DataSet')) return null;
  if (!content.includes('TestCase') && !content.includes('PHPUnit')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const providers: DataProviderInfo['providers'] = [];
  const attrPattern = /#\[DataProvider\s*\(\s*['"]([^'"]+)['"]\s*\)\]/g;
  const annotPattern = /@dataProvider\s+(\w+)/g;
  const providerNames = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = attrPattern.exec(content)) !== null) providerNames.add(m[1]);
  while ((m = annotPattern.exec(content)) !== null) providerNames.add(m[1]);
  for (const name of providerNames) {
    const fnRe = new RegExp(`(static\\s+)?function\\s+${name}\\s*\\(`);
    const match = fnRe.exec(content);
    const isStatic = !!match && match[0].includes('static');
    const returnsGenerator = content.includes(`function ${name}`) && content.slice(content.indexOf(`function ${name}`), content.indexOf(`function ${name}`) + 400).includes('yield');
    providers.push({ name, isStatic, returnsGenerator });
  }
  const consumerCount = [...content.matchAll(/#\[DataProvider|@dataProvider/g)].length;
  const issues: string[] = [];
  for (const p of providers) {
    if (!p.isStatic) issues.push(`${p.name}(): data provider not static — PHPUnit 10+ requires static data providers`);
  }
  if (providers.length === 0 && consumerCount === 0) return null;
  return { file: path.relative(appPath, filePath), class: classM?.[1], providers, consumerCount, issues };
}

export function listPhpUnitDataProviders(appPath: string): McpToolResult {
  try {
    const testDir = path.join(appPath, 'tests');
    if (!fs.existsSync(testDir)) return { content: [{ type: 'text', text: 'No tests/ directory found.' }] };
    const all: DataProviderInfo[] = [];
    for (const file of getAllPhpTestFiles(testDir)) {
      const d = parseDataProviders(file, appPath);
      if (d) all.push(d);
    }
    if (all.length === 0) return { content: [{ type: 'text', text: 'No PHPUnit data providers found.' }] };
    const totalIssues = all.reduce((s, d) => s + d.issues.length, 0);
    let text = `PHPUnit Data Providers\n${'='.repeat(55)}\n\nFiles: ${all.length}  Providers: ${all.reduce((s, d) => s + d.providers.length, 0)}  Issues: ${totalIssues}\n`;
    for (const d of all.filter((x) => x.issues.length > 0 || x.providers.length > 0)) {
      text += `\n  ${d.class ?? '(file)'}  providers: ${d.providers.length}  consumers: ${d.consumerCount}  (${d.file})\n`;
      for (const p of d.providers) {
        const flags = [p.isStatic ? '✓ static' : '⚠ not static', p.returnsGenerator ? 'generator' : 'array'].join('  ');
        text += `    ${p.name}()  ${flags}\n`;
      }
      for (const i of d.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpUnitDataProviderStats(appPath: string): McpToolResult {
  try {
    const testDir = path.join(appPath, 'tests');
    const all: DataProviderInfo[] = [];
    if (fs.existsSync(testDir)) {
      for (const file of getAllPhpTestFiles(testDir)) {
        const d = parseDataProviders(file, appPath);
        if (d) all.push(d);
      }
    }
    const allProviders = all.flatMap((d) => d.providers);
    let text = `PHPUnit Data Provider Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files: ${all.length}\n  Providers: ${allProviders.length}\n  Static: ${allProviders.filter((p) => p.isStatic).length}\n  Using generators: ${allProviders.filter((p) => p.returnsGenerator).length}\nIssues: ${all.reduce((s, d) => s + d.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpUnitDataProviderTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_phpunit_data_providers', description: 'Show PHPUnit #[DataProvider]/@dataProvider usage: provider function static check (PHPUnit 10 requires static), generator vs array return, consumer count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_phpunit_data_provider_stats', description: 'Show PHPUnit data provider statistics: file count, provider count, static count, generator count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
