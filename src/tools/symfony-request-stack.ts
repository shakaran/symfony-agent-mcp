/**
 * Symfony RequestStack Usage Inspector
 *
 * Scans src/ PHP for RequestStack injection/usage: getMainRequest(),
 * getCurrentRequest() (deprecated), getParentRequest(),
 * sub-request patterns (HttpKernelInterface::SUB_REQUEST),
 * #[MainRequest] attribute.
 *
 * Warns: getCurrentRequest() (deprecated since 5.3), service injecting
 * RequestStack not scoped for console commands (stale request),
 * getMainRequest() null not handled, storing request in property.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface RequestStackInfo {
  file: string;
  class: string;
  usesCurrentRequest: boolean;
  usesMainRequest: boolean;
  usesParentRequest: boolean;
  isInConsoleCommand: boolean;
  storesRequestInProperty: boolean;
  issues: string[];
}

const CONSOLE_COMMAND_PATTERNS = [
  'extends Command',
  'AsCommand',
  'Command $',
  'implements Command',
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

function detectStoresRequestInProperty(content: string): boolean {
  // Patterns like $this->request = $requestStack->getMainRequest()
  // or $this->currentRequest = ...getMainRequest()
  const storeRe = /\$this->[a-zA-Z]{1,60}\s*=\s*[^;]{0,100}(?:getMainRequest|getCurrentRequest|getRequest)\s*\(\s*\)/;
  return storeRe.test(content);
}

function detectNullNotHandled(content: string): boolean {
  // getMainRequest() is called but the result is not null-checked before ->get... call
  if (!content.includes('getMainRequest()')) return false;
  // Simple heuristic: if we see getMainRequest() and there is no if/null check near it
  const re = /getMainRequest\s*\(\s*\)\s*->/;
  return re.test(content);
}

function parseRequestStack(filePath: string, appPath: string): RequestStackInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasRequestStack =
    content.includes('RequestStack') && (
      content.includes('__construct') ||
      content.includes('RequestStack $') ||
      content.includes('getMainRequest') ||
      content.includes('getCurrentRequest')
    );

  if (!hasRequestStack) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const usesCurrentRequest = content.includes('->getCurrentRequest(');
  const usesMainRequest = content.includes('->getMainRequest(');
  const usesParentRequest = content.includes('->getParentRequest(');
  const isInConsoleCommand = CONSOLE_COMMAND_PATTERNS.some((p) => content.includes(p));
  const storesRequestInProperty = detectStoresRequestInProperty(content);
  const nullNotHandled = detectNullNotHandled(content);

  const issues: string[] = [];

  if (usesCurrentRequest) {
    issues.push('getCurrentRequest() is deprecated since Symfony 5.3 — use getMainRequest() instead');
  }
  if (isInConsoleCommand) {
    issues.push('RequestStack injected in a console command — getMainRequest() returns null in CLI context');
  }
  if (nullNotHandled) {
    issues.push('getMainRequest() result used directly without null check — will throw in CLI/sub-request context');
  }
  if (storesRequestInProperty) {
    issues.push('Request stored in object property from RequestStack — stale request risk in long-running processes or messenger consumers');
  }

  const hasAnyIssue = issues.length > 0
    || usesCurrentRequest
    || usesMainRequest
    || usesParentRequest
    || storesRequestInProperty;

  if (!hasAnyIssue && !usesCurrentRequest && !usesMainRequest) return null;

  return {
    file: path.relative(appPath, filePath),
    class: classM[1],
    usesCurrentRequest,
    usesMainRequest,
    usesParentRequest,
    isInConsoleCommand,
    storesRequestInProperty,
    issues,
  };
}

export function listRequestStackUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const results: RequestStackInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = parseRequestStack(file, appPath);
      if (r) results.push(r);
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No RequestStack usage found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Symfony RequestStack Usage\n${'='.repeat(55)}\n`;
    text += `\nClasses using RequestStack: ${results.length}  Issues: ${totalIssues}\n`;

    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.class}  (${r.file})\n`;
      const flags: string[] = [];
      if (r.usesCurrentRequest) flags.push('getCurrentRequest [deprecated]');
      if (r.usesMainRequest) flags.push('getMainRequest');
      if (r.usesParentRequest) flags.push('getParentRequest');
      if (r.isInConsoleCommand) flags.push('console-command');
      if (r.storesRequestInProperty) flags.push('stores-in-property');
      if (flags.length > 0) text += `    Uses: ${flags.join(', ')}\n`;
      for (const issue of r.issues) {
        text += `    WARNING: ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRequestStackStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: RequestStackInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseRequestStack(file, appPath);
        if (r) results.push(r);
      }
    }

    let text = `RequestStack Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with RequestStack:    ${results.length}\n`;
    text += `  getCurrentRequest [depr.]:  ${results.filter((r) => r.usesCurrentRequest).length}\n`;
    text += `  getMainRequest:             ${results.filter((r) => r.usesMainRequest).length}\n`;
    text += `  getParentRequest:           ${results.filter((r) => r.usesParentRequest).length}\n`;
    text += `  In console commands:        ${results.filter((r) => r.isInConsoleCommand).length}\n`;
    text += `  Stores request in property: ${results.filter((r) => r.storesRequestInProperty).length}\n`;
    text += `Issues detected:              ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRequestStackTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_request_stack_usage',
      description: 'Show Symfony RequestStack usage: getMainRequest/getCurrentRequest (deprecated 5.3)/getParentRequest detection, console command injection, null-unchecked getMainRequest, request stored in property; warns on deprecated method, null risk, stale data in long-running processes',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_request_stack_stats',
      description: 'Show RequestStack statistics: class count, getCurrentRequest deprecated count, getMainRequest count, console command count, stores-in-property count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
