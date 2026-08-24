// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface XmlSecurityInfo {
  file: string;
  type: 'xxe' | 'entity' | 'injection';
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

function buildPhpXmlSecurityInfos(appPath: string): XmlSecurityInfo[] {
  const srcDir = path.join(appPath, 'src');
  const phpFiles = getAllPhpFiles(srcDir);
  const results: XmlSecurityInfo[] = [];

  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (content === null) continue;

    if (
      !content.includes('DOMDocument') &&
      !content.includes('simplexml') &&
      !content.includes('XMLReader') &&
      !content.includes('libxml')
    ) continue;

    const relFile = path.relative(appPath, filePath);

    if (/libxml_disable_entity_loader\s*\(\s*false\s*\)/.test(content)) {
      results.push({
        file: relFile,
        type: 'xxe',
        pattern: 'libxml_disable_entity_loader(false)',
        issues: ['libxml_disable_entity_loader(false) re-enables entity processing — XXE attacks become possible; remove this call (PHP 8.0+ disables entities by default)'],
      });
    }

    if (/LIBXML_NOENT/.test(content)) {
      results.push({
        file: relFile,
        type: 'entity',
        pattern: 'LIBXML_NOENT flag',
        issues: ['LIBXML_NOENT flag enables entity substitution in XML parsing — this is the main XXE attack vector; remove LIBXML_NOENT flag unless you understand the implications'],
      });
    }

    if (/simplexml_load_string|simplexml_load_file/.test(content) && !content.includes('LIBXML_NOENT')) {
      results.push({
        file: relFile,
        type: 'xxe',
        pattern: 'simplexml_load_string/simplexml_load_file without LIBXML_NOENT check',
        issues: ['SimpleXML parsing without LIBXML_NOENT check — PHP 8.0+ is safe by default but older versions are vulnerable; add libxml_disable_entity_loader(true) for PHP < 8.0'],
      });
    }

    if (/new\s+XMLReader/.test(content) && !content.includes('libxml_disable_entity_loader')) {
      results.push({
        file: relFile,
        type: 'xxe',
        pattern: 'XMLReader without libxml_disable_entity_loader',
        issues: ['XMLReader usage detected — ensure external entities are disabled; call libxml_disable_entity_loader(true) before XMLReader::open() for PHP < 8.0'],
      });
    }

    if (/DOMDocument.*loadXML|loadHTML\b.*\$_/.test(content)) {
      results.push({
        file: relFile,
        type: 'injection',
        pattern: 'DOMDocument loading user-controlled HTML/XML',
        issues: ['DOMDocument loading user-controlled HTML/XML — validate input and ensure entity processing is disabled to prevent XXE'],
      });
    }
  }

  return results;
}

export function listPhpXmlSecurity(appPath: string): McpToolResult {
  try {
    const infos = buildPhpXmlSecurityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No XML security issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP XML Security Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpXmlSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpXmlSecurityInfos(appPath);
    let text = `PHP XML Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `XXE:       ${infos.filter((i) => i.type === 'xxe').length}\n`;
    text += `Entity:    ${infos.filter((i) => i.type === 'entity').length}\n`;
    text += `Injection: ${infos.filter((i) => i.type === 'injection').length}\n`;
    text += `Issues:    ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpXmlSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_xml_security', description: 'Analyze PHP XML parsing for XXE, entity, and injection security issues', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_xml_security_stats', description: 'Statistics for PHP XML security: counts by type and issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
