// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Web Profiler Custom Panel Inspector
 *
 * Scans src/ PHP for:
 *   - Classes extending AbstractDataCollector or implementing DataCollectorInterface
 *   - getName() returning panel name
 *   - getTitle()/getIcon() for WebProfilerBundle panels
 *   - collect() method
 *
 * Detects template registration:
 *   - Matching template in templates/bundles/WebProfilerBundle/Collector/
 *   - Referenced template string in getName/getTitle
 *
 * Checks services.yaml for data_collector tag with template and id attributes.
 *
 * Warns about:
 *   - DataCollector without template in profiler (data collected but not shown)
 *   - collect() not calling parent::collect() when extending AbstractDataCollector
 *   - DataCollector storing non-serializable objects (profiler data must be serializable)
 *   - getName() returning existing built-in panel name (collision)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ProfilerPanelInfo {
  file: string;
  class: string;
  panelName: string;
  hasTemplate: boolean;
  hasTag: boolean;
  templatePath?: string;
  hasParentCollect: boolean;
  issues: string[];
}

// Built-in Symfony profiler panel names that should not be reused
const BUILTIN_PANELS = new Set([
  'request', 'time', 'memory', 'ajax', 'form', 'exception', 'events',
  'logger', 'routing', 'security', 'twig', 'doctrine', 'mailer',
  'messenger', 'cache', 'translation', 'validator', 'http_client',
  'notifier', 'mercure', 'config', 'dump',
]);

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

function readFile(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

interface TagInfo {
  id: string;
  template?: string;
}

function parseServicesYaml(appPath: string): TagInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'services.yaml'),
    path.join(appPath, 'config', 'services.yml'),
    path.join(appPath, 'config', 'services.xml'),
  ];
  const tags: TagInfo[] = [];

  for (const filePath of candidates) {
    const content = readFile(filePath);
    if (!content) continue;

    // Find data_collector tag definitions in YAML
    // Pattern: kernel.data_collector with id and template attributes
    const tagPattern = /kernel\.data_collector[^\n]{0,200}/g;
    let m: RegExpExecArray | null;
    while ((m = tagPattern.exec(content)) !== null) {
      const tagLine = m[0];
      const idMatch = /\bid\s*:\s*['"]?([^\s'"]{1,100})/.exec(tagLine);
      const tplMatch = /\btemplate\s*:\s*['"]?([^\s'"]{1,200})/.exec(tagLine);

      // Look for adjacent lines to find id/template
      const contextStart = Math.max(0, m.index - 200);
      const context = content.substring(contextStart, m.index + 400);
      const ctxId = /\bid\s*:\s*['"]?([^\s'"\n]{1,100})/.exec(context);
      const ctxTpl = /\btemplate\s*:\s*['"]?([^\s'"\n]{1,200})/.exec(context);

      tags.push({
        id: idMatch?.[1] ?? ctxId?.[1] ?? '',
        template: tplMatch?.[1] ?? ctxTpl?.[1],
      });
    }
  }

  return tags;
}

function extractPanelName(content: string): string {
  // Match: return 'panel_name'; or return "panel_name"; inside getName()
  const nameMatch = /getName\s*\([^)]{0,30}\)[^{]{0,50}\{[^}]{0,300}return\s*['"]([^'"]{1,100})['"]/.exec(content);
  return nameMatch ? nameMatch[1] : '';
}

function detectNonSerializableStorage(content: string): boolean {
  // Heuristic: storing objects that are typically not serializable
  const nonSerializablePatterns = [
    /\$this->data\[['"][^'"]{1,80}['"]\]\s*=\s*\$(?:request|response|event|container|logger|connection)\b/,
    /\bPDO\b/,
    /\bResource\b/,
    /\bClosure\b/,
  ];
  return nonSerializablePatterns.some((p) => p.test(content));
}

function templateExists(appPath: string, panelName: string, templateRef?: string): {
  exists: boolean;
  templatePath?: string;
} {
  // Check WebProfilerBundle templates
  const candidates: string[] = [];

  if (panelName) {
    candidates.push(
      path.join(appPath, 'templates', 'bundles', 'WebProfilerBundle', 'Collector', `${panelName}.html.twig`),
      path.join(appPath, 'templates', 'data_collector', `${panelName}.html.twig`),
    );
  }
  if (templateRef) {
    // Strip bundle notation: @SomeBundle/...
    const stripped = templateRef.replace(/^@[\w]+\//, '');
    candidates.push(
      path.join(appPath, 'templates', stripped),
      path.join(appPath, stripped),
    );
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return { exists: true, templatePath: c };
  }
  return { exists: false };
}

function parseCollectorClass(
  filePath: string,
  appPath: string,
  tagInfos: TagInfo[]
): ProfilerPanelInfo | null {
  const content = readFile(filePath);
  if (!content) return null;

  const isCollector =
    content.includes('AbstractDataCollector') ||
    (content.includes('DataCollectorInterface') && content.includes('implements'));
  if (!isCollector) return null;
  if (!/\bclass\s+/.test(content)) return null;

  const classMatch = /class\s+(\w{1,100})/.exec(content);
  if (!classMatch) return null;

  const className = classMatch[1];
  const panelName = extractPanelName(content);

  const hasCollectMethod = /\bfunction\s+collect\s*\(/.test(content);
  const isAbstractDataCollector = content.includes('extends AbstractDataCollector') ||
                                   content.includes('extends \\AbstractDataCollector');
  const hasParentCollect = !isAbstractDataCollector ||
    /parent\s*::\s*collect\s*\(/.test(content) ||
    !hasCollectMethod;

  // Find matching tag in services.yaml
  const matchingTag = tagInfos.find((t) =>
    t.id === panelName ||
    t.id.includes(className.toLowerCase()) ||
    t.id === className
  );
  const hasTag = matchingTag !== undefined;

  // Detect template
  const { exists: hasTemplate, templatePath } = templateExists(appPath, panelName, matchingTag?.template);

  const issues: string[] = [];

  if (!hasTemplate && !hasTag) {
    issues.push(`${className}: DataCollector without profiler template — data collected but not visible in toolbar`);
  }
  if (isAbstractDataCollector && hasCollectMethod && !hasParentCollect) {
    issues.push(`${className}: collect() does not call parent::collect() — AbstractDataCollector::collect() must be called`);
  }
  if (detectNonSerializableStorage(content)) {
    issues.push(`${className}: may store non-serializable objects in ${'$'}this->data — profiler data must survive serialization`);
  }
  if (panelName && BUILTIN_PANELS.has(panelName)) {
    issues.push(`${className}: getName() returns '${panelName}' which conflicts with a built-in Symfony profiler panel`);
  }

  return {
    file: path.basename(filePath),
    class: className,
    panelName,
    hasTemplate,
    hasTag,
    templatePath,
    hasParentCollect,
    issues,
  };
}

function scanProfilerPanels(appPath: string): ProfilerPanelInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const tagInfos = parseServicesYaml(appPath);
  const results: ProfilerPanelInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const info = parseCollectorClass(file, appPath, tagInfos);
    if (info) results.push(info);
  }

  return results.sort((a, b) => a.class.localeCompare(b.class));
}

export function listProfilerPanels(appPath: string): McpToolResult {
  try {
    const panels = scanProfilerPanels(appPath);

    if (panels.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom profiler DataCollectors found in src/.\n\nCreate a custom profiler panel:\n  php bin/console make:data-collector\n\nOr manually:\n  class MyCollector extends AbstractDataCollector\n  Register with tag: kernel.data_collector + template + id',
        }],
      };
    }

    let text = `Symfony Profiler Custom Panels\n${'='.repeat(55)}\n`;
    let totalIssues = 0;

    for (const panel of panels) {
      const tplMark = panel.hasTemplate ? '[template:ok]' : '[NO TEMPLATE]';
      const tagMark = panel.hasTag ? '[tagged]' : '[untagged]';
      text += `\n${panel.class} (${panel.file})\n`;
      text += `  Panel name: ${panel.panelName || '(not detected)'}\n`;
      text += `  Status: ${tplMark} ${tagMark}\n`;
      if (panel.templatePath) text += `  Template: ${panel.templatePath}\n`;
      for (const issue of panel.issues) {
        text += `  WARNING: ${issue}\n`;
        totalIssues++;
      }
    }

    if (totalIssues === 0) {
      text += '\nNo issues detected.\n';
    } else {
      text += `\nTotal warnings: ${totalIssues}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getProfilerPanelStats(appPath: string): McpToolResult {
  try {
    const panels = scanProfilerPanels(appPath);

    let text = `Profiler Panel Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom DataCollectors:      ${panels.length}\n`;
    text += `  With template:            ${panels.filter((p) => p.hasTemplate).length}\n`;
    text += `  With services.yaml tag:   ${panels.filter((p) => p.hasTag).length}\n`;
    text += `  No template+tag:          ${panels.filter((p) => !p.hasTemplate && !p.hasTag).length}\n`;
    text += `  Built-in name collision:  ${panels.filter((p) => BUILTIN_PANELS.has(p.panelName)).length}\n`;
    text += `  Missing parent::collect:  ${panels.filter((p) => !p.hasParentCollect).length}\n`;
    text += `Total warnings:             ${panels.reduce((s, p) => s + p.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getProfilerPanelTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_profiler_panels',
      description: 'Analyze custom Symfony Web Profiler DataCollectors: detect AbstractDataCollector/DataCollectorInterface implementations, getName() panel names, template and services.yaml tag registration, missing parent::collect() call, non-serializable data storage, built-in panel name collisions',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_profiler_panel_stats',
      description: 'Statistics for custom profiler panels: total DataCollector count, with/without template, with/without service tag, built-in name collisions, missing parent::collect count, total warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
