// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine Column Charset Inspector
 *
 * Scans entity PHP files for #[Column] with options charset/collation.
 * Detects utf8 vs utf8mb4 mixing in the same entity.
 * Warns about utf8 charset (emoji truncation), latin1, missing collation.
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ColumnCharset {
  name: string;
  charset: string | null;
  collation: string | null;
  type: string;
  issues: string[];
}

interface ColumnCharsetInfo {
  file: string;
  class: string;
  columns: ColumnCharset[];
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

function extractClassFromContent(content: string): string | null {
  const m = /class\s+(\w{1,120})\b/.exec(content);
  return m ? m[1] : null;
}

// Extract the name from a property or field definition near a Column attribute
function extractPropertyName(content: string, attrStart: number): string {
  // Look forward for property/variable name after the attribute block
  const snippet = content.slice(attrStart, Math.min(content.length, attrStart + 400));
  const propMatch = /\$(\w{1,80})/.exec(snippet);
  return propMatch ? propMatch[1] : '(unknown)';
}

function extractColumnAttributes(content: string): ColumnCharset[] {
  const columns: ColumnCharset[] = [];

  // Match #[Column(...)] or #[ORM\Column(...)]
  const attrPattern = /#\[(?:\w+\\){0,5}Column\s*\(([^)]{0,600})\)/g;
  let m: RegExpExecArray | null;

  while ((m = attrPattern.exec(content)) !== null) {
    const block = m[1];
    const attrStart = m.index;

    const typeMatch = /\btype\s*[=:]\s*['"]?(\w{1,60})['"]?/.exec(block);
    const colType = typeMatch ? typeMatch[1] : 'string';

    // Only process string/text columns (charset only applies to these)
    if (!['string', 'text', 'ascii_string', 'json', 'simple_array', 'guid'].includes(colType)) {
      continue;
    }

    // Look for charset in options: ['charset' => 'utf8mb4']
    const charsetMatch = /['"]charset['"]\s*=>\s*['"]([a-zA-Z0-9_]{1,40})['"]/.exec(block);
    const charset = charsetMatch ? charsetMatch[1] : null;

    const collationMatch = /['"]collation['"]\s*=>\s*['"]([a-zA-Z0-9_]{1,80})['"]/.exec(block);
    const collation = collationMatch ? collationMatch[1] : null;

    const propName = extractPropertyName(content, attrStart);
    const issues: string[] = [];

    if (charset === 'utf8') {
      issues.push(`Column "${propName}": charset "utf8" may truncate 4-byte Unicode (emoji) — use utf8mb4`);
    }
    if (charset === 'latin1' || charset === 'latin1_swedish_ci') {
      issues.push(`Column "${propName}": charset "latin1" is limited — consider utf8mb4 for full Unicode support`);
    }
    if (charset !== null && collation === null) {
      issues.push(`Column "${propName}": charset is specified but collation is not — explicitly set collation to avoid implicit defaults`);
    }

    columns.push({ name: propName, charset, collation, type: colType, issues });
  }

  // Also match annotation style: @ORM\Column(type="string", options={"charset":"utf8mb4"})
  const annotPattern = /@(?:\w+\\){0,5}Column\s*\(([^)]{0,600})\)/g;
  while ((m = annotPattern.exec(content)) !== null) {
    const block = m[1];
    const attrStart = m.index;

    const typeMatch = /\btype\s*=\s*["'](\w{1,60})["']/.exec(block);
    const colType = typeMatch ? typeMatch[1] : 'string';
    if (!['string', 'text', 'ascii_string', 'json', 'simple_array', 'guid'].includes(colType)) continue;

    const optionsBlock = /options\s*=\s*\{([^}]{0,300})\}/.exec(block);
    if (!optionsBlock) continue;

    const charsetMatch = /["']charset["']\s*:\s*["']([a-zA-Z0-9_]{1,40})["']/.exec(optionsBlock[1]);
    const charset = charsetMatch ? charsetMatch[1] : null;

    const collationMatch = /["']collation["']\s*:\s*["']([a-zA-Z0-9_]{1,80})["']/.exec(optionsBlock[1]);
    const collation = collationMatch ? collationMatch[1] : null;

    const propName = extractPropertyName(content, attrStart);
    const issues: string[] = [];

    if (charset === 'utf8') {
      issues.push(`Column "${propName}": charset "utf8" may truncate 4-byte Unicode (emoji) — use utf8mb4`);
    }
    if (charset === 'latin1') {
      issues.push(`Column "${propName}": charset "latin1" is limited — consider utf8mb4`);
    }
    if (charset !== null && collation === null) {
      issues.push(`Column "${propName}": charset specified but collation not set`);
    }

    if (charset !== null) {
      columns.push({ name: propName, charset, collation, type: colType, issues });
    }
  }

  return columns;
}

function scanColumnCharsets(appPath: string): ColumnCharsetInfo[] {
  const results: ColumnCharsetInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = getAllPhpFiles(srcDir);

  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('Column')) continue;
    if (!content.includes('ORM') && !content.includes('#[Column')) continue;

    const columns = extractColumnAttributes(content);
    if (columns.length === 0) continue;

    const className = extractClassFromContent(content) ?? path.basename(file, '.php');
    const fileIssues: string[] = [];

    // Detect utf8 vs utf8mb4 mixing
    const charsets = new Set(columns.map(c => c.charset).filter(c => c !== null));
    if (charsets.has('utf8') && charsets.has('utf8mb4')) {
      fileIssues.push(`Entity "${className}" mixes utf8 and utf8mb4 charsets in the same table — may cause inconsistent storage and collation issues`);
    }

    // Columns with charset annotation present — flag any string/text columns in same entity without charset (inconsistency)
    const columnsWithCharset = columns.filter(c => c.charset !== null);
    const columnsWithoutCharset = columns.filter(c => c.charset === null);
    if (columnsWithCharset.length > 0 && columnsWithoutCharset.length > 0) {
      fileIssues.push(`Entity "${className}" has ${columnsWithCharset.length} column(s) with charset and ${columnsWithoutCharset.length} without — inconsistent charset specification`);
    }

    const allIssues = [...fileIssues, ...columns.flatMap(c => c.issues)];

    if (allIssues.length === 0 && columns.filter(c => c.charset !== null).length === 0) continue;

    results.push({
      file: path.relative(appPath, file),
      class: className,
      columns,
      issues: fileIssues,
    });
  }

  return results;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listDoctrineColumnCharsets(appPath: string): McpToolResult {
  try {
    const infos = scanColumnCharsets(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine columns with explicit charset/collation options found in src/.\n\nExample:\n  #[ORM\\Column(type: \'string\', options: [\'charset\' => \'utf8mb4\', \'collation\' => \'utf8mb4_unicode_ci\'])]',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length + i.columns.reduce((cs, c) => cs + c.issues.length, 0), 0);
    let text = `Doctrine Column Charset Analysis\n${'='.repeat(50)}\n`;
    text += `Files: ${infos.length}  |  Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n${info.file}  (${info.class})\n`;
      for (const col of info.columns) {
        if (col.charset === null && col.issues.length === 0) continue;
        text += `  $${col.name}  [${col.type}]\n`;
        if (col.charset) text += `    charset:   ${col.charset}\n`;
        if (col.collation) text += `    collation: ${col.collation}\n`;
        for (const issue of col.issues) {
          text += `    ⚠ ${issue}\n`;
        }
      }
      for (const issue of info.issues) {
        text += `  ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error scanning Doctrine column charsets: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDoctrineColumnCharsetStats(appPath: string): McpToolResult {
  try {
    const infos = scanColumnCharsets(appPath);

    const allColumns = infos.flatMap(i => i.columns);
    const withCharset = allColumns.filter(c => c.charset !== null).length;
    const utf8Columns = allColumns.filter(c => c.charset === 'utf8').length;
    const utf8mb4Columns = allColumns.filter(c => c.charset === 'utf8mb4').length;
    const latin1Columns = allColumns.filter(c => c.charset === 'latin1').length;
    const withCollation = allColumns.filter(c => c.collation !== null).length;
    const totalIssues = infos.reduce((s, i) => s + i.issues.length + i.columns.reduce((cs, c) => cs + c.issues.length, 0), 0);

    const text = [
      'Doctrine Column Charset Statistics',
      '='.repeat(45),
      `Files with charset columns:  ${infos.length}`,
      `Total charset-annotated cols: ${withCharset}`,
      `  utf8mb4:                    ${utf8mb4Columns}`,
      `  utf8 (risk):                ${utf8Columns}`,
      `  latin1 (risk):              ${latin1Columns}`,
      `With collation set:           ${withCollation}`,
      `Total issues:                 ${totalIssues}`,
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error computing Doctrine column charset stats: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDoctrineColumnCharsetTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'list_doctrine_column_charsets',
      description: 'List Doctrine entity columns with explicit charset/collation options and warn about utf8 truncation risk, latin1, and mixed charsets in the same entity.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_doctrine_column_charset_stats',
      description: 'Get statistics about Doctrine column charset and collation usage.',
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
