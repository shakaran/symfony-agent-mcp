import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface Html5ParserInfo {
  file: string;
  type: 'legacy' | 'modern' | 'charset' | 'error-suppression';
  pattern: string;
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

function buildPhpHtml5ParserInfos(appPath: string): Html5ParserInfo[] {
  const srcDir = path.join(appPath, 'src');
  const phpFiles = getAllPhpFiles(srcDir);
  const results: Html5ParserInfo[] = [];

  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (content === null) continue;

    if (!content.includes('DOMDocument') && !content.includes('Dom\\')) continue;

    const relFile = path.relative(appPath, filePath);

    if (/new\s+DOMDocument\b/.test(content) && !content.includes('Dom\\HTMLDocument')) {
      results.push({
        file: relFile,
        type: 'legacy',
        pattern: 'new DOMDocument (legacy)',
        issues: ['Legacy DOMDocument detected — PHP 8.4 introduced Dom\\HTMLDocument::createFromString() with proper HTML5 parsing; consider migrating for better standards compliance'],
      });
    }

    if (/->loadHTML\b/.test(content) && !content.includes('charset') && !content.includes('mb_convert_encoding')) {
      results.push({
        file: relFile,
        type: 'charset',
        pattern: 'DOMDocument::loadHTML without charset',
        issues: ['DOMDocument::loadHTML() without explicit charset — wrap with \'<?xml encoding="UTF-8">\' or use mb_convert_encoding() to prevent character encoding attacks'],
      });
    }

    if (/libxml_use_internal_errors\s*\(\s*true\s*\)/.test(content) && content.includes('loadHTML') && !content.includes('libxml_clear_errors')) {
      results.push({
        file: relFile,
        type: 'error-suppression',
        pattern: 'libxml_use_internal_errors without libxml_clear_errors',
        issues: ['libxml_use_internal_errors(true) without libxml_clear_errors() — suppressed errors accumulate in memory; call libxml_clear_errors() after parsing'],
      });
    }

    if (/Dom\\HTMLDocument::createFromString/.test(content)) {
      results.push({
        file: relFile,
        type: 'modern',
        pattern: 'Dom\\HTMLDocument::createFromString (modern)',
        issues: [],
      });
    }

    if (/Dom\\XMLDocument::createFromString/.test(content)) {
      results.push({
        file: relFile,
        type: 'modern',
        pattern: 'Dom\\XMLDocument::createFromString (modern)',
        issues: [],
      });
    }
  }

  return results;
}

export function listPhpHtml5Parser(appPath: string): McpToolResult {
  try {
    const infos = buildPhpHtml5ParserInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No HTML5 parser patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP HTML5 Parser Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpHtml5ParserStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpHtml5ParserInfos(appPath);
    let text = `PHP HTML5 Parser Statistics\n${'='.repeat(40)}\n\n`;
    text += `Legacy:            ${infos.filter((i) => i.type === 'legacy').length}\n`;
    text += `Modern:            ${infos.filter((i) => i.type === 'modern').length}\n`;
    text += `Charset:           ${infos.filter((i) => i.type === 'charset').length}\n`;
    text += `Error-suppression: ${infos.filter((i) => i.type === 'error-suppression').length}\n`;
    text += `Issues:            ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpHtml5ParserTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_html5_parser', description: 'Analyze PHP HTML5 parsing usage for legacy DOMDocument, charset, and error-suppression issues', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_html5_parser_stats', description: 'Statistics for PHP HTML5 parser: counts by type and issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
