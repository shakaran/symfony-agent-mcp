// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DomXpathInfo {
  file: string;
  line: number;
  fn: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
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

function analyseFile(content: string, relFile: string): DomXpathInfo[] {
  const infos: DomXpathInfo[] = [];
  const lines = content.split('\n');

  // File-level: loadXML present but no entity loader protection
  if (content.includes('loadXML(')) {
    const hasEntityDisable = content.includes('libxml_disable_entity_loader');
    const hasNoNet = content.includes('LIBXML_NONET');
    if (!hasEntityDisable && !hasNoNet) {
      // Find the line of first loadXML(
      const firstLoadXmlLine = lines.findIndex((l) => l.includes('loadXML('));
      infos.push({
        file: relFile,
        line: firstLoadXmlLine >= 0 ? firstLoadXmlLine + 1 : 0,
        fn: 'loadXML',
        issue: 'xxe-risk: file uses loadXML() without libxml_disable_entity_loader() or LIBXML_NONET — external entity injection (XXE) is possible if user-supplied XML is parsed; add libxml_disable_entity_loader(true) before loading (PHP < 8.0) or use LIBXML_NONET flag',
        severity: 'high',
      });
    }
  }

  const hasLibxmlNoimplied = content.includes('LIBXML_HTML_NOIMPLIED');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // loadHTML with variable arg and missing LIBXML_HTML_NOIMPLIED
    if (line.includes('loadHTML(')) {
      // Check if argument appears to be a variable (starts with $)
      const afterParen = /loadHTML\s*\(\s*(\S{0,200})/.exec(line);
      if (afterParen && afterParen[1].startsWith('$')) {
        if (!hasLibxmlNoimplied) {
          infos.push({
            file: relFile,
            line: i + 1,
            fn: 'loadHTML',
            issue: 'loadHTML-no-options: loadHTML() called with a variable argument but LIBXML_HTML_NOIMPLIED is not used in this file — missing option causes libxml to add <html>/<body> wrappers and may trigger encoding issues; pass LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD as second argument',
            severity: 'medium',
          });
        }
      }
    }

    // loadXML with variable arg → high severity (in addition to file-level)
    if (line.includes('loadXML(')) {
      const afterParen = /loadXML\s*\(\s*(\S{0,200})/.exec(line);
      if (afterParen && afterParen[1].startsWith('$')) {
        infos.push({
          file: relFile,
          line: i + 1,
          fn: 'loadXML',
          issue: 'loadXML-user-input: loadXML() called with a variable argument — if this contains user-supplied data, XXE injection is possible; validate/sanitize input and ensure entity loading is disabled',
          severity: 'high',
        });
      }
    }

    // XPath injection: ->query( or ->evaluate( with variable that doesn't look like a static path
    if (/->query\s*\(|->evaluate\s*\(/.test(line)) {
      const methodMatch = /->([a-z]{1,20})\s*\(/.exec(line);
      const fnName = methodMatch ? methodMatch[1] : 'query';
      // Contains a $ variable but not a string literal starting with '//' or '/'
      if (line.includes('$')) {
        // Check that it's not purely a string literal like '//foo' as argument
        const isStaticPath = /->(?:query|evaluate)\s*\(\s*['"][/][^\n]{0,200}/.test(line);
        if (!isStaticPath) {
          infos.push({
            file: relFile,
            line: i + 1,
            fn: fnName,
            issue: `xpath-injection: ->${fnName}() called with a variable expression — if the XPath expression includes user input, an attacker can alter the query logic (XPath injection); always build XPath expressions from static strings with parameterised values`,
            severity: 'high',
          });
        }
      }
    }

    // loadHTMLFile / ->load( with variable path
    if (line.includes('loadHTMLFile(') || /->load\s*\(/.test(line)) {
      const fnMatch = /(loadHTMLFile|load)\s*\(/.exec(line);
      const fnName = fnMatch ? fnMatch[1] : 'load';
      if (line.includes('$')) {
        infos.push({
          file: relFile,
          line: i + 1,
          fn: fnName,
          issue: `file-load-variable-path: ${fnName}() called with a variable argument — if the path derives from user input, path traversal is possible; validate and canonicalise the path before passing it to ${fnName}()`,
          severity: 'medium',
        });
      }
    }

    // SimpleXMLElement with user data and no LIBXML_NOENT nearby
    if (line.includes('SimpleXMLElement(')) {
      if (line.includes('$')) {
        const windowStart = Math.max(0, i - 5);
        const windowEnd = Math.min(lines.length, i + 6);
        const block = lines.slice(windowStart, windowEnd).join('\n');
        const hasNoEnt = block.includes('LIBXML_NOENT');
        if (!hasNoEnt) {
          infos.push({
            file: relFile,
            line: i + 1,
            fn: 'SimpleXMLElement',
            issue: 'SimpleXMLElement-no-noent: new SimpleXMLElement() called with a variable and LIBXML_NOENT not found in nearby context — if user-supplied XML is parsed without entity protection, XXE is possible; ensure libxml_disable_entity_loader(true) is called first (PHP < 8.0) and avoid LIBXML_NOENT flag',
            severity: 'medium',
          });
        }
      }
    }
  }

  return infos;
}

function buildDomXpathInfos(appPath: string): DomXpathInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: DomXpathInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;
  const files = collectPhpFiles(srcDir, appPath);
  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!content.includes('DOMDocument') && !content.includes('DOMXPath') && !content.includes('SimpleXML')) continue;
    const infos = analyseFile(content, path.relative(appPath, file));
    results.push(...infos);
  }
  return results;
}

export function listPhpDomXpath(appPath: string): McpToolResult {
  try {
    const infos = buildDomXpathInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No DOMDocument/DOMXPath/SimpleXML security issues found in src/.' }] };
    }

    let text = `PHP DOMDocument / DOMXPath Security Analysis\n${'='.repeat(55)}\n\n`;
    text += `Total findings: ${infos.length}\n`;
    text += `  High severity:   ${infos.filter((i) => i.severity === 'high').length}\n`;
    text += `  Medium severity: ${infos.filter((i) => i.severity === 'medium').length}\n`;
    text += `  Low severity:    ${infos.filter((i) => i.severity === 'low').length}\n\n`;

    const byFile = new Map<string, DomXpathInfo[]>();
    for (const info of infos) {
      const existing = byFile.get(info.file) ?? [];
      existing.push(info);
      byFile.set(info.file, existing);
    }

    for (const [file, entries] of byFile) {
      text += `${file}\n`;
      for (const entry of entries) {
        text += `  Line ${entry.line}  [${entry.severity.toUpperCase()}]  [${entry.fn}]  ${entry.issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDomXpathStats(appPath: string): McpToolResult {
  try {
    const infos = buildDomXpathInfos(appPath);

    const countBySeverity = { high: 0, medium: 0, low: 0 };
    for (const info of infos) countBySeverity[info.severity] = (countBySeverity[info.severity] ?? 0) + 1;

    const countByFn: Record<string, number> = {};
    for (const info of infos) {
      countByFn[info.fn] = (countByFn[info.fn] ?? 0) + 1;
    }

    const filesAffected = new Set(infos.map((i) => i.file)).size;

    let text = `PHP DOMDocument / DOMXPath Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings:    ${infos.length}\n`;
    text += `Files affected:    ${filesAffected}\n\n`;
    text += `By severity:\n`;
    text += `  High:    ${countBySeverity.high}\n`;
    text += `  Medium:  ${countBySeverity.medium}\n`;
    text += `  Low:     ${countBySeverity.low}\n\n`;
    text += `By function:\n`;
    for (const [fn, count] of Object.entries(countByFn)) {
      text += `  ${fn}:${' '.repeat(Math.max(1, 24 - fn.length))}${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDomXpathTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_dom_xpath',
      description: 'Scan PHP files for DOMDocument/DOMXPath/SimpleXML security issues: XXE risk in loadXML() without entity-loader protection, loadHTML() without LIBXML_HTML_NOIMPLIED, XPath injection in ->query()/->evaluate() with variable expressions, file path traversal in loadHTMLFile()/->load(), SimpleXMLElement with user data',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_dom_xpath_stats',
      description: 'Statistics for PHP DOMDocument/DOMXPath findings: total count, files affected, counts by severity (high/medium/low) and by function name (loadXML, loadHTML, query, evaluate, loadHTMLFile, load, SimpleXMLElement)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
