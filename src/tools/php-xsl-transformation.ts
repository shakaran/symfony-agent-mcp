// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface XslTransformationInfo {
  file: string;
  line: number;
  fn: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full, base));
    } else if (entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

function collectXslFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectXslFiles(full, base));
    } else if (entry.name.endsWith('.xsl') || entry.name.endsWith('.xslt')) {
      results.push(full);
    }
  }
  return results;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function buildXslTransformationInfos(appPath: string): XslTransformationInfo[] {
  const results: XslTransformationInfo[] = [];

  const scanDirs = [
    path.join(appPath, 'src'),
    path.join(appPath, 'templates'),
  ];

  // Collect all PHP files
  const phpFiles: string[] = [];
  for (const dir of scanDirs) {
    phpFiles.push(...collectPhpFiles(dir, appPath));
  }

  // Collect all XSL files
  const xslFiles: string[] = [];
  for (const dir of scanDirs) {
    xslFiles.push(...collectXslFiles(dir, appPath));
  }

  // Analyze PHP files
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (!content.includes('XSLTProcessor')) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    // File-level: missing registerPHPFunctions(false) or whitelist
    const hasRegisterFalse = /registerPHPFunctions\s*\(\s*false\s*\)/.test(content);
    const hasRegisterList = /registerPHPFunctions\s*\(\s*\[/.test(content);
    if (!hasRegisterFalse && !hasRegisterList) {
      results.push({
        file: relFile,
        line: 0,
        fn: 'registerPHPFunctions',
        issue: 'missing-registerPHPFunctions-false: XSLTProcessor found but registerPHPFunctions(false) or whitelist not set — XSLT stylesheets can call arbitrary PHP functions; add registerPHPFunctions(false) or an explicit whitelist array',
        severity: 'medium',
      });
    }

    // File-level: registerPHPFunctions with no args (enables ALL PHP functions)
    if (/registerPHPFunctions\s*\(\s*\)/.test(content)) {
      results.push({
        file: relFile,
        line: 0,
        fn: 'registerPHPFunctions',
        issue: 'registerPHPFunctions-all: registerPHPFunctions() called with no arguments — this enables ALL PHP functions callable from XSLT; this is a critical RCE risk; restrict with an explicit whitelist array or pass false',
        severity: 'high',
      });
    }

    // Per-line analysis
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.includes('importStylesheet(')) {
        if (line.includes('$')) {
          results.push({
            file: relFile,
            line: lineNum,
            fn: 'importStylesheet',
            issue: 'importStylesheet-user-input: importStylesheet() called with a variable argument — if the stylesheet source is user-controlled, an attacker can inject malicious XSLT; validate the stylesheet origin',
            severity: 'high',
          });
        }
        continue;
      }

      if (line.includes('->setParameter(')) {
        if (line.includes('$_GET') || line.includes('$_POST') || line.includes('$_REQUEST')) {
          results.push({
            file: relFile,
            line: lineNum,
            fn: 'setParameter',
            issue: 'setParameter-user-input: setParameter() called with direct superglobal input — XPath parameter injection risk; sanitize or whitelist parameter values before passing to setParameter()',
            severity: 'high',
          });
        } else if (line.includes('$')) {
          results.push({
            file: relFile,
            line: lineNum,
            fn: 'setParameter',
            issue: 'setParameter-variable: setParameter() called with a variable — verify the value is not user-controlled to prevent XPath parameter injection',
            severity: 'medium',
          });
        }
        continue;
      }

      if (line.includes('->transformToXML(') || line.includes('->transformToDoc(') || line.includes('->transformToURI(')) {
        const fn = line.includes('->transformToXML(')
          ? 'transformToXML'
          : line.includes('->transformToDoc(')
            ? 'transformToDoc'
            : 'transformToURI';
        results.push({
          file: relFile,
          line: lineNum,
          fn,
          issue: `xslt-transform-call: ${fn}() invoked — ensure the input DOMDocument and stylesheet are validated and not user-controlled`,
          severity: 'low',
        });
        continue;
      }

      if (line.includes('registerPHPFunctions()')) {
        results.push({
          file: relFile,
          line: lineNum,
          fn: 'registerPHPFunctions',
          issue: 'registerPHPFunctions-unrestricted: registerPHPFunctions() called with empty parentheses — enables ALL PHP functions from XSLT; critical RCE risk; replace with registerPHPFunctions(false) or a whitelist array',
          severity: 'high',
        });
      }
    }
  }

  // Analyze XSL/XSLT files
  for (const filePath of xslFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.includes('xsl:include') || line.includes('xsl:import')) {
        const fn = line.includes('xsl:include') ? 'xsl:include' : 'xsl:import';
        // Check if href contains a variable reference {$...}
        if (/href\s*=\s*["'][^"']{0,200}\{\$/.test(line)) {
          results.push({
            file: relFile,
            line: lineNum,
            fn,
            issue: `xsl-include-variable-uri: ${fn} href attribute references a variable URI — if the URI is user-controlled, an attacker can load arbitrary stylesheets; fix the href to a static path`,
            severity: 'high',
          });
        }
      }
    }
  }

  return results;
}

export function listPhpXslTransformation(appPath: string): McpToolResult {
  try {
    const infos = buildXslTransformationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP XSL transformation patterns found.' }] };
    }
    const high = infos.filter(i => i.severity === 'high').length;
    const medium = infos.filter(i => i.severity === 'medium').length;
    const low = infos.filter(i => i.severity === 'low').length;
    let text = `PHP XSL Transformation Analysis\n${'='.repeat(55)}\n\nTotal: ${infos.length}  High: ${high}  Medium: ${medium}  Low: ${low}\n`;
    for (const info of infos) {
      text += `\n  [${info.severity.toUpperCase()}] ${info.file}:${info.line}  fn=${info.fn}\n    ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpXslTransformationStats(appPath: string): McpToolResult {
  try {
    const infos = buildXslTransformationInfos(appPath);
    const stats = {
      total: infos.length,
      bySeverity: {
        high: infos.filter(i => i.severity === 'high').length,
        medium: infos.filter(i => i.severity === 'medium').length,
        low: infos.filter(i => i.severity === 'low').length,
      },
    };
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpXslTransformationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Absolute path to the Symfony application root' } };
  return [
    {
      name: 'list_php_xsl_transformation',
      description: 'Scan PHP files for XSL transformation patterns: XSLTProcessor, importStylesheet(), setParameter(), registerPHPFunctions() — flags XSLT injection, XPath parameter injection, unrestricted PHP function exposure, and variable URIs in xsl:include/xsl:import.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_xsl_transformation_stats',
      description: 'Statistics for PHP XSL transformation findings: total count and breakdown by severity (high/medium/low).',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
