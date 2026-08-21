/**
 * Doctrine ORM Profiling Inspector
 *
 * Reads doctrine.yaml for profiling, profiling_collect_backtrace, logging settings.
 * Scans src/ PHP for DebugStack, getSQLLogger(), LoggingConnection.
 *
 * Warns about:
 *   - profiling_collect_backtrace:true in non-dev (huge performance impact)
 *   - SQLLogger in production code (logs every query)
 *   - DebugStack not cleared between requests (memory leak)
 *   - Profiling enabled without Symfony profiler (useless overhead)
 *
 * Pure static analysis — no execution.
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

interface OrmProfilingInfo {
  environment: string;
  profilingEnabled: boolean;
  collectBacktrace: boolean;
  hasCustomLogger: boolean;
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

function readDoctrineConfig(cfgPath: string): Record<string, unknown> | null {
  const raw = parseYamlFile(cfgPath) as Record<string, unknown> | null;
  if (!raw) return null;
  const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
  const orm = (doctrine['orm'] ?? {}) as Record<string, unknown>;
  return orm;
}

function buildProfilingInfos(appPath: string): OrmProfilingInfo[] {
  const results: OrmProfilingInfo[] = [];

  const cfgPairs: Array<[string, string]> = [
    [path.join(appPath, 'config', 'packages', 'doctrine.yaml'), 'prod'],
    [path.join(appPath, 'config', 'packages', 'dev', 'doctrine.yaml'), 'dev'],
    [path.join(appPath, 'config', 'packages', 'test', 'doctrine.yaml'), 'test'],
  ];

  for (const [cfgPath, env] of cfgPairs) {
    const orm = readDoctrineConfig(cfgPath);
    if (!orm) continue;

    const profilingEnabled = orm['profiling'] === true || orm['profiling'] === 'true';
    const collectBacktrace = orm['profiling_collect_backtrace'] === true || orm['profiling_collect_backtrace'] === 'true';
    const loggingEnabled = orm['logging'] === true || orm['logging'] === 'true';
    const issues: string[] = [];

    if (collectBacktrace && env !== 'dev') {
      issues.push(`profiling_collect_backtrace:true in '${env}' environment — this records stack traces for every query (severe performance regression)`);
    }
    if (loggingEnabled && env === 'prod') {
      issues.push(`doctrine.orm.logging:true in production — logs every SQL query (high volume, performance impact, potential data exposure in logs)`);
    }
    if (profilingEnabled && env === 'prod') {
      issues.push(`doctrine.orm.profiling:true in production — profiling overhead without benefit in production; enable only in dev`);
    }

    results.push({ environment: env, profilingEnabled, collectBacktrace, hasCustomLogger: false, issues });
  }

  // Scan PHP for custom loggers
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    let hasCustomLogger = false;
    let hasDebugStack = false;
    let hasDebugStackClear = false;

    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      if (content.includes('DebugStack') || content.includes('getSQLLogger()') || content.includes('LoggingConnection')) {
        hasCustomLogger = true;
        if (content.includes('DebugStack')) hasDebugStack = true;
        if (content.includes('->queries = []') || content.includes('reset(') || content.includes('$debugStack->queries')) {
          hasDebugStackClear = true;
        }
      }
    }

    if (hasCustomLogger) {
      const issues: string[] = [];
      const isTestFile = (p: string): boolean => p.includes('/test') || p.includes('/Test');
      const phpFiles = getAllPhpFiles(srcDir);
      const nonTestLogger = phpFiles.some((f) => {
        if (!isTestFile(f)) {
          try {
            const c = fs.readFileSync(f, 'utf-8');
            return c.includes('getSQLLogger()') || c.includes('LoggingConnection');
          } catch { return false; }
        }
        return false;
      });

      if (nonTestLogger) {
        issues.push('getSQLLogger() / LoggingConnection used outside test files — logging all SQL in production causes memory and performance issues');
      }
      if (hasDebugStack && !hasDebugStackClear) {
        issues.push('DebugStack used without clearing $debugStack->queries between requests — memory leak in long-running processes (workers, CLI)');
      }

      results.push({ environment: 'src', profilingEnabled: false, collectBacktrace: false, hasCustomLogger: true, issues });
    }
  }

  return results;
}

export function listDoctrineOrmProfiling(appPath: string): McpToolResult {
  try {
    const infos = buildProfilingInfos(appPath);

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine ORM profiling configuration found (doctrine.yaml).' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine ORM Profiling Analysis\n${'='.repeat(50)}\n\nConfigs: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  Environment: ${info.environment}\n`;
      text += `    profiling:          ${info.profilingEnabled ? 'yes' : 'no'}\n`;
      text += `    collect_backtrace:  ${info.collectBacktrace ? 'yes' : 'no'}\n`;
      text += `    custom_logger:      ${info.hasCustomLogger ? 'yes' : 'no'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineOrmProfilingStats(appPath: string): McpToolResult {
  try {
    const infos = buildProfilingInfos(appPath);

    let text = `Doctrine ORM Profiling Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config environments:          ${infos.filter((i) => i.environment !== 'src').length}\n`;
    text += `With profiling enabled:       ${infos.filter((i) => i.profilingEnabled).length}\n`;
    text += `With backtrace collection:    ${infos.filter((i) => i.collectBacktrace).length}\n`;
    text += `With custom SQL logger:       ${infos.filter((i) => i.hasCustomLogger).length}\n`;
    text += `Total issues:                 ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineOrmProfilingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_orm_profiling',
      description: 'Inspect Doctrine ORM profiling configuration across environments; warns on profiling_collect_backtrace in non-dev, SQLLogger in production, DebugStack memory leak, profiling overhead without Symfony profiler',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_orm_profiling_stats',
      description: 'Statistics for Doctrine ORM profiling: environments configured, profiling enabled count, backtrace collection count, custom logger count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
