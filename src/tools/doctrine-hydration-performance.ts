import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface HydrationInfo {
  file: string;
  type: 'object' | 'array' | 'scalar' | 'single-scalar' | 'custom';
  usage: string;
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

function buildHydrationInfos(appPath: string): HydrationInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: HydrationInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);

    const hasGetResult = content.includes('->getResult()');
    const hasGetArrayResult = content.includes('->getArrayResult()');
    const hasGetScalarResult = content.includes('->getScalarResult()');
    const hasGetSingleScalar = content.includes('->getSingleScalarResult()');
    const hasHydrateObject = content.includes('Query::HYDRATE_OBJECT');
    const hasHydrateArray = content.includes('Query::HYDRATE_ARRAY');
    const hasHydrateScalar = content.includes('Query::HYDRATE_SCALAR') || content.includes('Query::HYDRATE_SINGLE_SCALAR');
    const hasCustomHydrator = content.includes('AbstractHydrator') || content.includes('addCustomHydrationMode(');
    const hasPartial = content.includes('HINT_FORCE_PARTIAL_LOAD') || /partial\s+\w{1,60}\s*,\s*\{/.test(content);

    if (hasGetResult || hasHydrateObject) {
      const issues: string[] = [];

      const hasReadOnlyContext = content.includes('readonly') || content.includes('list') || content.includes('index') ||
        (relFile.includes('Controller') && !relFile.includes('Form'));
      if (hasReadOnlyContext) {
        issues.push('HYDRATE_OBJECT (getResult()) used in what appears to be a read-only context — use getArrayResult() for 2-3x faster hydration when entity modification is not needed');
      }

      const noLimit = !content.includes('->setMaxResults(') && !content.includes('LIMIT');
      if (noLimit && (content.includes('findAll()') || content.includes('->getResult()'))) {
        issues.push('getResult() without setMaxResults() — may hydrate full table as objects (memory explosion on large tables)');
      }

      results.push({ file: relFile, type: 'object', usage: 'getResult()/HYDRATE_OBJECT', issues });
    }

    if (hasGetArrayResult || hasHydrateArray) {
      results.push({ file: relFile, type: 'array', usage: 'getArrayResult()/HYDRATE_ARRAY', issues: [] });
    }

    if (hasGetScalarResult || hasHydrateScalar) {
      results.push({ file: relFile, type: 'scalar', usage: 'getScalarResult()/HYDRATE_SCALAR', issues: [] });
    }

    if (hasGetSingleScalar) {
      results.push({ file: relFile, type: 'single-scalar', usage: 'getSingleScalarResult()', issues: [] });
    }

    if (hasCustomHydrator) {
      const issues: string[] = [];
      const hasHydrateResultSet = content.includes('hydrateResultSet(') || content.includes('hydrateAllData(');
      if (!hasHydrateResultSet && content.includes('AbstractHydrator')) {
        issues.push('Custom hydrator extending AbstractHydrator without overriding hydrateResultSet() — falls back to full object hydration');
      }
      results.push({ file: relFile, type: 'custom', usage: 'AbstractHydrator / custom hydration mode', issues });
    }

    if (hasPartial) {
      const issues: string[] = [];
      if (content.includes('HINT_FORCE_PARTIAL_LOAD') && content.includes('->')) {
        issues.push('HINT_FORCE_PARTIAL_LOAD with association traversal — accessing lazy-loaded associations on partial objects triggers N+1 queries');
      }
      results.push({ file: relFile, type: 'object', usage: 'partial object / HINT_FORCE_PARTIAL_LOAD', issues });
    }
  }

  return results;
}

export function listDoctrineHydrationPerformance(appPath: string): McpToolResult {
  try {
    const infos = buildHydrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine hydration patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Hydration Performance Analysis\n${'='.repeat(55)}\n\nUsages: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.usage}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineHydrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildHydrationInfos(appPath);
    let text = `Hydration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Object:       ${infos.filter((i) => i.type === 'object').length}\n`;
    text += `Array:        ${infos.filter((i) => i.type === 'array').length}\n`;
    text += `Scalar:       ${infos.filter((i) => i.type === 'scalar').length}\n`;
    text += `Single-scalar: ${infos.filter((i) => i.type === 'single-scalar').length}\n`;
    text += `Custom:       ${infos.filter((i) => i.type === 'custom').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineHydrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_hydration_performance', description: 'Analyze Doctrine hydration mode choices; warns on HYDRATE_OBJECT in read-only contexts, getResult() without LIMIT, custom hydrator without hydrateResultSet, HINT_FORCE_PARTIAL_LOAD with associations', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_hydration_stats', description: 'Statistics for hydration modes: object/array/scalar/single-scalar/custom count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
