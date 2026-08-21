/**
 * Doctrine DBAL Prepared Statement Inspector
 *
 * Scans src/ PHP for executeQuery/executeStatement/fetchAllAssociative/fetchOne/fetchFirstColumn calls.
 * Detects positional ? params, named :param, array binding for IN clauses.
 * Warns about SQL injection via string concatenation, mixed param styles, incorrect array binding.
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

type ParamStyle = 'positional' | 'named' | 'none' | 'mixed';

interface PreparedStatementInfo {
  file: string;
  method: string;
  paramStyle: ParamStyle;
  hasArrayBinding: boolean;
  hasConcatenation: boolean;
  issues: string[];
}

const DBAL_METHODS = [
  'executeQuery',
  'executeStatement',
  'fetchAllAssociative',
  'fetchOne',
  'fetchFirstColumn',
  'fetchAllKeyValue',
  'fetchAllNumeric',
  'fetchAssociative',
  'fetchNumeric',
  'prepare',
];

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

// Extract a SQL string argument from a method call (first string argument)
function extractSqlArg(callBlock: string): string {
  // Match single-quoted or double-quoted string, or heredoc (simplified)
  const sqMatch = /'((?:[^'\\]{0,500}|\\.){0,500})'/.exec(callBlock);
  if (sqMatch) return sqMatch[1];
  const dqMatch = /"((?:[^"\\]{0,500}|\\.){0,500})"/.exec(callBlock);
  if (dqMatch) return dqMatch[1];
  return '';
}

// Get text around a method call (limited to avoid excessive scanning)
function extractCallContext(content: string, methodName: string): string[] {
  const contexts: string[] = [];
  const pattern = new RegExp(`->\\s*${methodName}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(content)) !== null) {
    const start = m.index;
    const end = Math.min(content.length, start + 800);
    contexts.push(content.slice(start, end));
  }

  return contexts;
}

function detectParamStyle(sqlSnippet: string, contextBlock: string): ParamStyle {
  const hasPositional = sqlSnippet.includes('?');
  // named param: :word (not followed by : to avoid ::cast)
  const hasNamed = /:(?!:)[a-zA-Z_][a-zA-Z0-9_]{0,60}/.test(sqlSnippet);

  if (hasPositional && hasNamed) return 'mixed';
  if (hasPositional) return 'positional';
  if (hasNamed) return 'named';

  // Check param array in context
  const hasParamArray = /\[\s*['"]?\w/.test(contextBlock) || contextBlock.includes('ArrayParameterType') || contextBlock.includes('PARAM_INT_ARRAY') || contextBlock.includes('PARAM_STR_ARRAY');
  if (hasParamArray) return 'positional';

  return 'none';
}

function detectArrayBinding(contextBlock: string): boolean {
  return (
    contextBlock.includes('ArrayParameterType') ||
    contextBlock.includes('PARAM_INT_ARRAY') ||
    contextBlock.includes('PARAM_STR_ARRAY') ||
    contextBlock.includes('Connection::PARAM_INT_ARRAY') ||
    contextBlock.includes('Connection::PARAM_STR_ARRAY')
  );
}

function detectStringConcatenation(contextBlock: string): boolean {
  // Detect string concatenation in what looks like SQL: . $var, . " WHERE, . ' AND, etc.
  return (
    /\.\s*\$\w{1,80}/.test(contextBlock) ||
    /\.\s*"[^"]{0,60}(?:WHERE|AND|OR|FROM|INSERT|UPDATE|DELETE)/i.test(contextBlock) ||
    /sprintf\s*\(/.test(contextBlock) && /(?:WHERE|FROM|SELECT|INSERT)/i.test(contextBlock)
  );
}

function detectInWithoutArrayBinding(sqlSnippet: string, hasArrayBinding: boolean): boolean {
  const hasInClause = /\bIN\s*\(\s*\?/.test(sqlSnippet);
  return hasInClause && !hasArrayBinding;
}

function analyzeFile(filePath: string, content: string, appPath: string): PreparedStatementInfo[] {
  const infos: PreparedStatementInfo[] = [];
  const relFile = path.relative(appPath, filePath);

  for (const method of DBAL_METHODS) {
    const contexts = extractCallContext(content, method);
    for (const ctx of contexts) {
      const sqlArg = extractSqlArg(ctx);
      const paramStyle = detectParamStyle(sqlArg, ctx);
      const hasArrayBinding = detectArrayBinding(ctx);
      const hasConcatenation = detectStringConcatenation(ctx);

      const issues: string[] = [];

      if (hasConcatenation) {
        issues.push(`${method}(): SQL string concatenation detected — potential SQL injection risk; use parameterized queries`);
      }
      if (paramStyle === 'mixed') {
        issues.push(`${method}(): mixed positional (?) and named (:param) parameters in same query — DBAL does not support mixing`);
      }
      if (detectInWithoutArrayBinding(sqlArg, hasArrayBinding)) {
        issues.push(`${method}(): IN (?) clause without DBAL array binding type (ArrayParameterType or PARAM_INT_ARRAY) — array params require explicit type`);
      }

      if (paramStyle !== 'none' || hasConcatenation || hasArrayBinding) {
        infos.push({
          file: relFile,
          method,
          paramStyle,
          hasArrayBinding,
          hasConcatenation,
          issues,
        });
      }
    }
  }

  return infos;
}

function scanDbalPreparedStatements(appPath: string): PreparedStatementInfo[] {
  const results: PreparedStatementInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = getAllPhpFiles(srcDir);

  for (const file of files) {
    const content = safeRead(file, appPath) ?? '';
    if (!content) continue;

    const hasDbalCall = DBAL_METHODS.some(m => content.includes(m));
    if (!hasDbalCall) continue;

    const infos = analyzeFile(file, content, appPath);
    results.push(...infos);
  }

  return results;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listDbalPreparedStatements(appPath: string): McpToolResult {
  try {
    const infos = scanDbalPreparedStatements(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No DBAL prepared statement usages with parameters found in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `DBAL Prepared Statement Analysis\n${'='.repeat(50)}\n`;
    text += `Total calls: ${infos.length}  |  Issues: ${totalIssues}\n`;

    for (const info of infos) {
      const flags: string[] = [`params:${info.paramStyle}`];
      if (info.hasArrayBinding) flags.push('array-binding');
      if (info.hasConcatenation) flags.push('CONCATENATION!');

      text += `\n${info.file}\n`;
      text += `  ${info.method}()  [${flags.join(', ')}]\n`;
      for (const issue of info.issues) {
        text += `  ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error scanning DBAL prepared statements: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDbalPreparedStatementStats(appPath: string): McpToolResult {
  try {
    const infos = scanDbalPreparedStatements(appPath);

    const positional = infos.filter(i => i.paramStyle === 'positional').length;
    const named = infos.filter(i => i.paramStyle === 'named').length;
    const mixed = infos.filter(i => i.paramStyle === 'mixed').length;
    const none = infos.filter(i => i.paramStyle === 'none').length;
    const withArrayBinding = infos.filter(i => i.hasArrayBinding).length;
    const withConcatenation = infos.filter(i => i.hasConcatenation).length;
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);

    const methodCounts: Record<string, number> = {};
    for (const info of infos) {
      methodCounts[info.method] = (methodCounts[info.method] ?? 0) + 1;
    }

    let text = `DBAL Prepared Statement Statistics\n${'='.repeat(45)}\n`;
    text += `Total calls analyzed:     ${infos.length}\n`;
    text += `Param style:\n`;
    text += `  positional (?):         ${positional}\n`;
    text += `  named (:param):         ${named}\n`;
    text += `  mixed (risk):           ${mixed}\n`;
    text += `  none:                   ${none}\n`;
    text += `With array binding:       ${withArrayBinding}\n`;
    text += `With concatenation (risk):${withConcatenation}\n`;
    text += `Total issues:             ${totalIssues}\n`;

    if (Object.keys(methodCounts).length > 0) {
      text += `\nBy method:\n`;
      for (const [method, count] of Object.entries(methodCounts).sort((a, b) => b[1] - a[1])) {
        text += `  ${method}: ${count}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error computing DBAL prepared statement stats: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDbalPreparedStatementTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'list_dbal_prepared_statements',
      description: 'Analyze DBAL prepared statements for SQL injection risks (string concatenation), mixed param styles, and missing array binding types for IN clauses.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_dbal_prepared_statement_stats',
      description: 'Get statistics about DBAL prepared statement usage and parameter styles.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
  ];
}
