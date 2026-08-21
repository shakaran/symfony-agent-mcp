import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SqlLoggerInfo {
  environment: string;
  logger: 'doctrine' | 'monolog' | 'custom' | 'none';
  config: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const files: string[] = [];
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return files;
  try {
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      const full = path.join(resolved, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...collectPhpFiles(full, base));
      else if (entry.isFile() && entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseDoctrineYaml(content: string, relFile: string, env: string): SqlLoggerInfo {
  const issues: string[] = [];

  const loggingMatch = /\blogging\s*:\s*(true|false)/i.exec(content);
  const profilingMatch = /\bprofiling\s*:\s*(true|false)/i.exec(content);
  const backtraceMatch = /\bprofiling_collect_backtrace\s*:\s*(true|false)/i.exec(content);

  const loggingEnabled = loggingMatch ? loggingMatch[1] === 'true' : false;
  const profilingEnabled = profilingMatch ? profilingMatch[1] === 'true' : false;
  const backtraceEnabled = backtraceMatch ? backtraceMatch[1] === 'true' : false;

  if (env === 'prod') {
    if (loggingEnabled) {
      issues.push('dbal.logging: true in prod — disables slow queries log performance impact; use only in dev/test');
    }
    if (backtraceEnabled) {
      issues.push('profiling_collect_backtrace: true in prod — high overhead; enable only in dev');
    }
  }

  if (env === 'dev' && !loggingEnabled && !profilingEnabled) {
    issues.push('No dbal.logging or profiling enabled in dev — consider enabling for query debugging');
  }

  const hasMiddleware = content.includes('middleware') || content.includes('logging_middleware');

  let logger: SqlLoggerInfo['logger'] = 'none';
  if (loggingEnabled) logger = 'doctrine';
  else if (hasMiddleware) logger = 'custom';
  else if (content.includes('monolog')) logger = 'monolog';

  return { environment: env, logger, config: relFile, issues };
}

function buildSqlLoggerInfos(appPath: string): SqlLoggerInfo[] {
  const results: SqlLoggerInfo[] = [];
  const configPackagesDir = path.join(appPath, 'config', 'packages');

  const envDirs: Array<{ dir: string; env: string }> = [
    { dir: configPackagesDir, env: 'base' },
    { dir: path.join(configPackagesDir, 'dev'), env: 'dev' },
    { dir: path.join(configPackagesDir, 'test'), env: 'test' },
    { dir: path.join(configPackagesDir, 'prod'), env: 'prod' },
  ];

  for (const { dir, env } of envDirs) {
    const doctrineFile = path.join(dir, 'doctrine.yaml');
    const content = safeRead(doctrineFile, appPath);
    if (!content) continue;
    const relFile = path.relative(appPath, doctrineFile);
    results.push(parseDoctrineYaml(content, relFile, env));
  }

  // Check services.yaml/services.php for EchoSQLLogger
  const servicesFiles = ['config/services.yaml', 'config/services.php'];
  for (const sf of servicesFiles) {
    const content = safeRead(path.join(appPath, sf), appPath);
    if (!content) continue;
    if (content.includes('EchoSQLLogger')) {
      results.push({
        environment: 'base',
        logger: 'doctrine',
        config: sf,
        issues: ['Doctrine\\DBAL\\Logging\\EchoSQLLogger registered — echoes all SQL to stdout; remove for non-dev environments'],
      });
    }
  }

  // Scan src/ PHP files for middleware logging usage
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const filePath of collectPhpFiles(srcDir, appPath)) {
      const content = safeRead(filePath, appPath);
      if (!content) continue;
      if (!content.includes('SQLLogger') && !content.includes('logging_middleware') && !content.includes('MiddlewareInterface')) continue;
      const relFile = path.relative(appPath, filePath);
      const issues: string[] = [];
      if (content.includes('EchoSQLLogger')) {
        issues.push(`EchoSQLLogger used in ${relFile} — remove in production`);
      }
      results.push({ environment: 'custom', logger: 'custom', config: relFile, issues });
    }
  }

  return results;
}

export function listSymfonyDoctrineSqlLogger(appPath: string): McpToolResult {
  try {
    const infos = buildSqlLoggerInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine SQL logger configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine SQL Logger Analysis\n${'='.repeat(55)}\n\nConfigurations: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.environment.toUpperCase()}]  logger:${info.logger}  (${info.config})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyDoctrineSqlLoggerStats(appPath: string): McpToolResult {
  try {
    const infos = buildSqlLoggerInfos(appPath);
    let text = `Doctrine SQL Logger Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total configurations: ${infos.length}\n`;
    text += `  doctrine logger:    ${infos.filter((i) => i.logger === 'doctrine').length}\n`;
    text += `  monolog logger:     ${infos.filter((i) => i.logger === 'monolog').length}\n`;
    text += `  custom logger:      ${infos.filter((i) => i.logger === 'custom').length}\n`;
    text += `  no logger:          ${infos.filter((i) => i.logger === 'none').length}\n`;
    text += `Issues:               ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    const prodIssues = infos.filter((i) => i.environment === 'prod' && i.issues.length > 0);
    if (prodIssues.length > 0) {
      text += `\nProd environment issues (${prodIssues.length}):\n`;
      for (const pi of prodIssues) {
        for (const issue of pi.issues) text += `  - ${issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyDoctrineSqlLoggerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_doctrine_sql_logger',
      description: 'Analyze Doctrine SQL logger configuration across all environments (base/dev/test/prod): dbal.logging, profiling, profiling_collect_backtrace, EchoSQLLogger in services, middleware logging, flags for logging in prod or missing logging in dev',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_doctrine_sql_logger_stats',
      description: 'Statistics for Doctrine SQL logger: configuration counts by logger type, total issues, prod environment issues summary',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
