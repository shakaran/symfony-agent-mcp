import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TemporalTableInfo {
  file: string;
  entity: string;
  type: 'valid-time' | 'transaction-time' | 'bitemporal';
  columns: string[];
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

const VALID_TIME_COLUMNS = ['valid_from', 'valid_to', 'effective_date', 'expires_at', 'start_date', 'end_date', 'valid_at', 'expired_at'];
const TRANSACTION_TIME_COLUMNS = ['created_at', 'updated_at', 'deleted_at', 'transaction_time', 'recorded_at'];
const HISTORY_PATTERNS = ['History', 'Audit', 'Log', 'Archive', 'Revision', 'Version'];

function buildTemporalInfos(appPath: string): TemporalTableInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: TemporalTableInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isEntity = content.includes('#[ORM\\Entity') || content.includes('@ORM\\Entity') || content.includes('@Entity');
    if (!isEntity) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const entity = classMatch ? classMatch[1] : path.basename(file, '.php');
    const relFile = path.relative(appPath, file);

    const foundValidTime = VALID_TIME_COLUMNS.filter((c) => content.includes(c));
    const foundTransactionTime = TRANSACTION_TIME_COLUMNS.filter((c) => content.includes(c));
    const isHistoryTable = HISTORY_PATTERNS.some((p) => entity.endsWith(p));

    const hasLoggable = content.includes('@Loggable') || content.includes('#[Loggable]') || content.includes('LogEntry');

    const type: 'valid-time' | 'transaction-time' | 'bitemporal' =
      foundValidTime.length > 0 && foundTransactionTime.length > 1 ? 'bitemporal' :
      foundValidTime.length > 0 ? 'valid-time' : 'transaction-time';

    const columns = [...foundValidTime, ...foundTransactionTime];
    if (columns.length === 0 && !isHistoryTable && !hasLoggable) continue;

    const issues: string[] = [];

    if (foundValidTime.includes('valid_from') && foundValidTime.includes('valid_to')) {
      const hasCheck = content.includes('Check') || content.includes('@Assert') || content.includes('#[Assert]');
      if (!hasCheck) {
        issues.push(`Entity "${entity}" has valid_from/valid_to but no CHECK constraint or Assert validation — invalid ranges (valid_from > valid_to) can be stored`);
      }
      const hasIndex = content.includes('@Index') || content.includes('#[Index]') || content.includes('index');
      if (!hasIndex) {
        issues.push(`Entity "${entity}" has temporal columns but no index defined — range queries on valid_from will be slow`);
      }
    }

    if (type === 'bitemporal') {
      const hasTransactionTime = content.includes('transaction_time') || content.includes('recorded_at');
      if (!hasTransactionTime) {
        issues.push(`Entity "${entity}" appears bitemporal but lacks explicit transaction_time column — cannot determine who changed what and when`);
      }
    }

    if (hasLoggable) {
      const hasVersionedFields = content.includes('@Versioned') || content.includes('#[Versioned]');
      if (!hasVersionedFields) {
        issues.push(`@Loggable entity "${entity}" has no @Versioned fields — Gedmo will log all field changes (potentially large log volume)`);
      }
    }

    results.push({ file: relFile, entity, type, columns, issues });
  }

  return results;
}

export function listDoctrineTemporalTables(appPath: string): McpToolResult {
  try {
    const infos = buildTemporalInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No temporal table patterns found (no valid_from/valid_to, history tables, or @Loggable entities).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Temporal Table Analysis\n${'='.repeat(55)}\n\nEntities: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.entity}  (${info.file})\n`;
      text += `    columns: ${info.columns.join(', ')}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineTemporalStats(appPath: string): McpToolResult {
  try {
    const infos = buildTemporalInfos(appPath);
    let text = `Temporal Table Statistics\n${'='.repeat(40)}\n\n`;
    text += `Valid-time:      ${infos.filter((i) => i.type === 'valid-time').length}\n`;
    text += `Transaction-time: ${infos.filter((i) => i.type === 'transaction-time').length}\n`;
    text += `Bitemporal:      ${infos.filter((i) => i.type === 'bitemporal').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineTemporalTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_temporal_tables', description: 'Detect temporal/bitemporal table patterns; warns on valid_from/valid_to without CHECK constraint or index, missing transaction_time in bitemporal, @Loggable without @Versioned fields', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_temporal_stats', description: 'Statistics for temporal tables: valid-time/transaction-time/bitemporal count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
