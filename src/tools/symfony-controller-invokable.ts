/**
 * Symfony Invokable Controller Inspector
 *
 * Distinct from controllers.ts (general controller listing) and controller-security.ts
 * (access control audit). Focuses on invokable controller patterns and style consistency:
 *
 * - Scans src/ PHP for: classes with __invoke() and #[Route] on class or __invoke()
 * - Detects AbstractController subclasses with single action
 * - Detects #[AsController] attribute usage
 * - Classifies invokable vs multi-action controllers
 * - Detects controller-as-service (no AbstractController extension)
 *
 * Warnings:
 *   - Invokable controller extending AbstractController using only 2+ helper methods
 *     (AbstractController brings many deps; prefer plain service)
 *   - __invoke() with too many parameters (>5; consider command/query pattern)
 *   - Invokable controller in same directory as multi-action controllers (inconsistent style)
 *   - #[AsController] without __invoke() (tag without action)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface InvokableControllerInfo {
  file: string;
  class: string;
  isInvokable: boolean;
  extendsAbstractController: boolean;
  hasAsControllerAttribute: boolean;
  parameterCount: number;
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

const ABSTRACT_CONTROLLER_HELPERS = [
  'render(',
  'redirect(',
  'redirectToRoute(',
  'json(',
  'file(',
  'forward(',
  'getParameter(',
  'isGranted(',
  'denyAccessUnlessGranted(',
  'addFlash(',
  'generateUrl(',
  'createForm(',
  'createNotFoundException(',
  'createAccessDeniedException(',
  'getUser(',
  'isCsrfTokenValid(',
  'dispatchMessage(',
  'getSubscribedServices(',
];

function countHelperMethodUsage(content: string): number {
  let count = 0;
  for (const helper of ABSTRACT_CONTROLLER_HELPERS) {
    if (content.includes(helper)) count++;
  }
  return count;
}

function countInvokeParameters(content: string): number {
  const invokeM = /public\s+function\s+__invoke\s*\(([^)]{0,500})\)/.exec(content);
  if (!invokeM || !invokeM[1].trim()) return 0;
  const params = invokeM[1].split(',');
  return params.filter((p) => p.trim().length > 0).length;
}

function parseControllerFile(filePath: string): InvokableControllerInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isController = content.includes('Controller') ||
    content.includes('#[Route') ||
    content.includes('@Route') ||
    content.includes('#[AsController') ||
    content.includes('AbstractController');

  if (!isController) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasInvoke = content.includes('function __invoke(') || content.includes('function __invoke (');
  const extendsAbstractController = content.includes('extends AbstractController') ||
    content.includes('AbstractController');

  const hasAsControllerAttribute = content.includes('#[AsController') ||
    content.includes('@AsController');

  const hasRouteOnClass = /#\[Route[^\]]{0,200}\][\s\S]{0,100}class\s/.test(content) ||
    /class\s+\w{1,100}[^{]{0,200}#\[Route/.test(content);

  const hasRouteOnInvoke = /#\[Route[^\]]{0,200}\][^;]{0,100}function\s+__invoke/.test(content);

  const isInvokable = hasInvoke && (hasRouteOnClass || hasRouteOnInvoke || hasAsControllerAttribute);

  if (!isInvokable && !extendsAbstractController && !hasAsControllerAttribute) return null;
  if (!isInvokable && !content.includes('Controller')) return null;

  const parameterCount = hasInvoke ? countInvokeParameters(content) : 0;
  const helperCount = extendsAbstractController ? countHelperMethodUsage(content) : 0;

  const issues: string[] = [];

  if (isInvokable && extendsAbstractController && helperCount <= 2) {
    issues.push(`Invokable controller extends AbstractController but uses only ${helperCount} helper method(s) — consider plain service to avoid heavy container injection`);
  }

  if (isInvokable && parameterCount > 5) {
    issues.push(`__invoke() has ${parameterCount} parameters — consider command/query pattern to reduce parameter count`);
  }

  if (hasAsControllerAttribute && !hasInvoke) {
    issues.push('#[AsController] attribute present without __invoke() method — tag applied but no single action defined');
  }

  return {
    file: path.relative(process.cwd(), filePath),
    class: classM[1],
    isInvokable,
    extendsAbstractController,
    hasAsControllerAttribute,
    parameterCount,
    issues,
  };
}

function detectMixedStyles(results: InvokableControllerInfo[]): string[] {
  const warnings: string[] = [];
  const byDir = new Map<string, { invokable: number; multiAction: number }>();

  for (const r of results) {
    const dir = path.dirname(r.file);
    const entry = byDir.get(dir) ?? { invokable: 0, multiAction: 0 };
    if (r.isInvokable) entry.invokable++;
    else entry.multiAction++;
    byDir.set(dir, entry);
  }

  for (const [dir, counts] of byDir) {
    if (counts.invokable > 0 && counts.multiAction > 0) {
      warnings.push(`Directory "${dir}" mixes ${counts.invokable} invokable and ${counts.multiAction} multi-action controllers — inconsistent style`);
    }
  }
  return warnings;
}

export function listInvokableControllers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: InvokableControllerInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseControllerFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No controllers found in src/.' }] };
    }

    const styleWarnings = detectMixedStyles(results);
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0) + styleWarnings.length;

    let text = `Invokable Controller Analysis\n${'='.repeat(55)}\n`;
    text += `\nControllers: ${results.length}  Issues: ${totalIssues}\n`;

    const invokable = results.filter((r) => r.isInvokable);
    const multiAction = results.filter((r) => !r.isInvokable);

    if (invokable.length > 0) {
      text += `\nInvokable controllers (${invokable.length}):\n`;
      for (const r of invokable) {
        const ac = r.extendsAbstractController ? ' [AbstractController]' : ' [service]';
        const asCtrl = r.hasAsControllerAttribute ? ' [#AsController]' : '';
        const params = r.parameterCount > 0 ? ` params:${r.parameterCount}` : '';
        text += `  ${r.class.padEnd(45)} (${path.basename(r.file)})${ac}${asCtrl}${params}\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (multiAction.length > 0) {
      text += `\nMulti-action controllers (${multiAction.length}):\n`;
      for (const r of multiAction) {
        const ac = r.extendsAbstractController ? ' [AbstractController]' : ' [service]';
        text += `  ${r.class.padEnd(45)} (${path.basename(r.file)})${ac}\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (styleWarnings.length > 0) {
      text += `\nStyle consistency warnings:\n`;
      for (const w of styleWarnings) text += `  ⚠ ${w}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getInvokableControllerStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: InvokableControllerInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseControllerFile(file);
      if (info) results.push(info);
    }

    const styleWarnings = detectMixedStyles(results);

    let text = `Invokable Controller Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total controllers:             ${results.length}\n`;
    text += `  Invokable (__invoke):        ${results.filter((r) => r.isInvokable).length}\n`;
    text += `  Multi-action:                ${results.filter((r) => !r.isInvokable).length}\n`;
    text += `  Extends AbstractController:  ${results.filter((r) => r.extendsAbstractController).length}\n`;
    text += `  Plain service (no AC):       ${results.filter((r) => !r.extendsAbstractController).length}\n`;
    text += `  With #[AsController]:        ${results.filter((r) => r.hasAsControllerAttribute).length}\n`;
    text += `  High param count (>5):       ${results.filter((r) => r.parameterCount > 5).length}\n`;
    text += `Mixed-style directories:       ${styleWarnings.length}\n`;
    text += `Issues:                        ${results.reduce((s, r) => s + r.issues.length, 0) + styleWarnings.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getInvokableControllerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_invokable_controllers',
      description: 'Show Symfony invokable controller analysis: __invoke() controllers with #[Route]/#[AsController], AbstractController vs plain service pattern, parameter count, mixed invokable/multi-action directories; warns on unnecessary AbstractController extension, too many __invoke params (>5), #[AsController] without __invoke, inconsistent controller style per directory',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_invokable_controller_stats',
      description: 'Show invokable controller statistics: total controllers, invokable vs multi-action count, AbstractController vs plain service count, #[AsController] count, high-parameter count, mixed-style directory count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
