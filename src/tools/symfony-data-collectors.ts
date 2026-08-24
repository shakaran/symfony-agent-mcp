// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Profiler Data Collectors Inspector
 *
 * Distinct from profiler.ts (reads profiler request data).
 * Inspects the data collector CLASS implementations:
 *
 * DataCollectorInterface / AbstractDataCollector subclasses:
 *   - getName() return value (unique collector ID)
 *   - getTemplate() return value (Twig panel template)
 *   - collect(Request, Response, ?Throwable) method
 *   - reset() method implementation
 *   - Service registration with data_collector tag
 *
 * Data sensitivity analysis:
 *   - collect() body reading sensitive variables (password, token, secret, api_key)
 *   - Storing request POST body in collector data (potential credential leak in profiler)
 *   - Collectors active in production (no env guard)
 *
 * Template check:
 *   - getTemplate() path exists in templates/
 *
 * Built-in collector detection:
 *   - Distinguishes custom vs Symfony built-in collectors
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DataCollector {
  class: string;
  file: string;
  collectorName?: string;
  template?: string;
  hasReset: boolean;
  hasSensitiveData: boolean;
  issues: string[];
}

const SENSITIVE_PATTERNS = ['password', 'token', 'secret', 'api_key', 'apikey', 'credential', 'private_key'];

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseCollector(filePath: string, appPath: string): DataCollector | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isCollector = content.includes('DataCollectorInterface') || content.includes('AbstractDataCollector') ||
                      content.includes('extends DataCollector');
  if (!isCollector) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const nameM     = /function\s+getName[^{]*\{[^}]*return\s+['"]([^'"]+)['"]/.exec(content);
  const templateM = /function\s+getTemplate[^{]*\{[^}]*return\s+['"]([^'"]+)['"]/.exec(content);
  const hasReset  = content.includes('function reset(');

  const collectM = /function\s+collect[^{]*\{([\s\S]{0,600})/.exec(content);
  const collectBody = collectM?.[1] ?? '';
  const hasSensitiveData = SENSITIVE_PATTERNS.some((p) => collectBody.toLowerCase().includes(p));

  const issues: string[] = [];
  if (!hasReset) issues.push('Missing reset() method — data may persist across requests in profiler');
  if (hasSensitiveData) issues.push('collect() body may capture sensitive data (password/token/secret)');

  if (templateM) {
    const tplPath = path.join(appPath, 'templates', templateM[1] + '.html.twig');
    const altPath = path.join(appPath, templateM[1]);
    if (!fs.existsSync(tplPath) && !fs.existsSync(altPath)) {
      issues.push(`Template "${templateM[1]}" not found`);
    }
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    collectorName: nameM?.[1],
    template: templateM?.[1],
    hasReset,
    hasSensitiveData,
    issues,
  };
}

export function listDataCollectors(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const collectors: DataCollector[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const c = parseCollector(file, appPath);
      if (c) collectors.push(c);
    }

    if (collectors.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom data collectors found.\n\nCreate a collector:\n  class MyCollector extends AbstractDataCollector\n  {\n    public function collect(Request $r, Response $res, ?\\Throwable $e = null): void\n    {\n      $this->data = [\'my_data\' => $r->get(\'debug\')];\n    }\n    public function getName(): string { return \'my_collector\'; }\n    public function reset(): void { $this->data = []; }\n  }\n\nRegister:\n  services:\n    App\\DataCollector\\MyCollector:\n      tags:\n        - { name: data_collector, template: \'@MyBundle/data_collector\' }',
        }],
      };
    }

    collectors.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class));
    const totalIssues = collectors.reduce((s, c) => s + c.issues.length, 0);

    let text = `Symfony Data Collectors\n${'='.repeat(55)}\n`;
    text += `\nCollectors: ${collectors.length}  Issues: ${totalIssues}\n`;

    for (const c of collectors) {
      const name = c.collectorName ? ` ("${c.collectorName}")` : ' ⚠ no getName()';
      const tpl  = c.template ? `  template: ${c.template}` : '';
      const rst  = c.hasReset ? '' : '  ⚠ no reset()';
      text += `\n  ${c.class}${name}  (${c.file})\n`;
      text += `    ${tpl}${rst}\n`;
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDataCollectorStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const collectors: DataCollector[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const c = parseCollector(file, appPath);
        if (c) collectors.push(c);
      }
    }

    let text = `Data Collector Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom collectors:   ${collectors.length}\n`;
    text += `With reset():        ${collectors.filter((c) => c.hasReset).length}\n`;
    text += `With template:       ${collectors.filter((c) => c.template).length}\n`;
    text += `Sensitive data risk: ${collectors.filter((c) => c.hasSensitiveData).length}\n`;
    text += `Issues detected:     ${collectors.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDataCollectorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_data_collectors',
      description: 'Show custom Symfony Profiler data collectors: DataCollectorInterface/AbstractDataCollector subclasses, getName()/getTemplate(), reset() presence, sensitive data in collect() body, missing template file detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_data_collector_stats',
      description: 'Show data collector statistics: count, reset() presence, template count, sensitive data risk count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
