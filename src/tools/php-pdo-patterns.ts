/**
 * PHP PDO Patterns Inspector
 *
 * Scans src/**\/*.php for PDO usage patterns:
 * - new PDO( without ERRMODE_EXCEPTION
 * - ->query( direct use (possible SQL injection)
 * - ->prepare( without subsequent bindParam/bindValue/execute
 * - PDO::ATTR_PERSISTENT (persistent connections)
 * - PDO::ERRMODE_SILENT usage
 * - Missing try/catch around PDO operations
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PdoPatternInfo {
  file: string;
  type: 'connection' | 'query' | 'prepared' | 'transaction';
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

function analysePdoFile(content: string, relFile: string): PdoPatternInfo[] {
  const infos: PdoPatternInfo[] = [];
  const lines = content.split('\n');

  // Connection issues
  const connectionIssues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/new\s+PDO\s*\(/.test(line)) {
      // Look ahead up to 5 lines for ERRMODE_EXCEPTION
      const block = lines.slice(i, Math.min(i + 6, lines.length)).join('\n');
      if (!/ERRMODE_EXCEPTION/.test(block)) {
        connectionIssues.push(`Line ${i + 1}: new PDO() without PDO::ERRMODE_EXCEPTION — errors may be silently ignored`);
      }
    }
    if (/ERRMODE_SILENT/.test(line)) {
      connectionIssues.push(`Line ${i + 1}: PDO::ERRMODE_SILENT found — errors are suppressed`);
    }
    if (/ATTR_PERSISTENT\s*,\s*true/.test(line)) {
      connectionIssues.push(`Line ${i + 1}: PDO::ATTR_PERSISTENT => true — persistent connections can cause state leakage`);
    }
  }
  if (connectionIssues.length > 0) {
    infos.push({ file: relFile, type: 'connection', issues: connectionIssues });
  }

  // Direct query usage
  const queryIssues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/->query\s*\(/.test(line)) {
      if (/\$_(GET|POST|REQUEST|COOKIE|SERVER)/.test(line) || /\.\s*\$/.test(line)) {
        queryIssues.push(`Line ${i + 1}: ->query() with user input — SQL injection risk; use ->prepare()`);
      } else {
        queryIssues.push(`Line ${i + 1}: ->query() without prepare — consider ->prepare() for safety`);
      }
    }
    if (/->exec\s*\(/.test(line)) {
      if (/\$_(GET|POST|REQUEST|COOKIE|SERVER)/.test(line) || /\.\s*\$/.test(line)) {
        queryIssues.push(`Line ${i + 1}: ->exec() with user input — SQL injection risk`);
      }
    }
  }
  if (queryIssues.length > 0) {
    infos.push({ file: relFile, type: 'query', issues: queryIssues });
  }

  // Prepared statement analysis
  const preparedIssues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/->prepare\s*\(/.test(line)) {
      // Look ahead for bind/execute within 10 lines
      const block = lines.slice(i, Math.min(i + 11, lines.length)).join('\n');
      if (!/bindParam|bindValue|->execute\s*\(/.test(block)) {
        preparedIssues.push(`Line ${i + 1}: ->prepare() without visible bindParam/bindValue/execute — verify bindings`);
      }
    }
  }
  if (preparedIssues.length > 0) {
    infos.push({ file: relFile, type: 'prepared', issues: preparedIssues });
  }

  // Transaction analysis
  const transactionIssues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/beginTransaction\s*\(/.test(line)) {
      // Look ahead for try/catch surrounding it
      const before = lines.slice(Math.max(0, i - 3), i).join('\n');
      if (!/try\s*\{/.test(before)) {
        transactionIssues.push(`Line ${i + 1}: beginTransaction() without enclosing try/catch — transaction may not be rolled back on error`);
      }
    }
    if (/->commit\s*\(\)/.test(line)) {
      const surroundBlock = lines.slice(Math.max(0, i - 10), Math.min(i + 5, lines.length)).join('\n');
      if (!/rollBack\s*\(\)/.test(surroundBlock) && !/rollback\s*\(\)/.test(surroundBlock)) {
        transactionIssues.push(`Line ${i + 1}: commit() without rollBack() in nearby catch block`);
      }
    }
  }
  if (transactionIssues.length > 0) {
    infos.push({ file: relFile, type: 'transaction', issues: transactionIssues });
  }

  return infos;
}

function buildPdoPatternInfos(appPath: string): PdoPatternInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: PdoPatternInfo[] = [];
  const files = collectPhpFiles(srcDir, appPath);
  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!/PDO|->query\s*\(|->prepare\s*\(|->exec\s*\(/.test(content)) continue;
    const infos = analysePdoFile(content, path.relative(appPath, file));
    results.push(...infos);
  }
  return results;
}

export function listPhpPdoPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildPdoPatternInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PDO pattern issues found in src/.' }] };
    }

    let text = `PHP PDO Pattern Analysis\n${'='.repeat(50)}\n\n`;
    text += `Total pattern groups found: ${infos.length}\n\n`;

    const byType: Record<string, PdoPatternInfo[]> = {};
    for (const info of infos) {
      if (!byType[info.type]) byType[info.type] = [];
      byType[info.type].push(info);
    }

    for (const [type, items] of Object.entries(byType)) {
      text += `[${type.toUpperCase()}] (${items.length})\n`;
      for (const item of items) {
        text += `  ${item.file}\n`;
        for (const issue of item.issues) {
          text += `    - ${issue}\n`;
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpPdoPatternsStats(appPath: string): McpToolResult {
  try {
    const infos = buildPdoPatternInfos(appPath);

    const counts: Record<string, number> = { connection: 0, query: 0, prepared: 0, transaction: 0 };
    for (const info of infos) counts[info.type] = (counts[info.type] ?? 0) + 1;

    const totalIssues = infos.reduce((sum, i) => sum + i.issues.length, 0);
    const filesAffected = new Set(infos.map((i) => i.file)).size;

    let text = `PHP PDO Pattern Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with PDO issues: ${filesAffected}\n`;
    text += `Total issue groups:    ${infos.length}\n`;
    text += `Total issues:          ${totalIssues}\n\n`;
    text += `By type:\n`;
    text += `  Connection issues:   ${counts['connection'] ?? 0}\n`;
    text += `  Direct query usage:  ${counts['query'] ?? 0}\n`;
    text += `  Prepared stmt issues:${counts['prepared'] ?? 0}\n`;
    text += `  Transaction issues:  ${counts['transaction'] ?? 0}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpPdoPatternsTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_pdo_patterns',
      description: 'List PHP PDO usage patterns: missing ERRMODE_EXCEPTION, direct query() calls, unprepared statements, transaction safety issues, persistent connections',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_pdo_patterns_stats',
      description: 'Get PHP PDO pattern statistics: counts by type (connection/query/prepared/transaction), affected files, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
