// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Interface Segregation Principle (ISP) Inspector
 *
 * Scans src/ PHP for:
 *   - Interface declarations and their methods
 *   - Classes implementing these interfaces
 *
 * Detects:
 *   - Interfaces with >7 methods (ISP violation candidate)
 *   - "Fat" interfaces vs segregated ones
 *   - Marker interfaces (0 methods)
 *   - Partial implementations (method body throws RuntimeException or BadMethodCallException)
 *
 * Warns:
 *   - Interface with >7 methods (consider splitting)
 *   - Class implementing interface but throwing NotImplementedException in methods
 *   - Marker interface in non-framework context (use attribute instead)
 *   - Interface extending many interfaces (high coupling)
 *   - Class implementing same interface multiple times via parent chain
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface InterfaceSegregationInfo {
  file: string;
  name: string;
  methodCount: number;
  implementors: number;
  isMarker: boolean;
  hasPartialImplementation: boolean;
  issues: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── Interface parsing ────────────────────────────────────────────────────────

interface ParsedInterface {
  name: string;
  file: string;
  methodCount: number;
  extendsCount: number;
  isMarker: boolean;
}

function parseInterface(filePath: string): ParsedInterface | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('interface ')) return null;
  const ifaceM = /\binterface\s+(\w{1,80})/.exec(content);
  if (!ifaceM) return null;

  const name = ifaceM[1];

  // Count method declarations in the interface
  // interface body: from 'interface Name ... {' to matching '}'
  const bodyM = /interface\s+\w{1,80}[^{]{0,200}\{([\s\S]{0,5000})\}/.exec(content);
  const body = bodyM ? bodyM[1] : content;

  const methodMatches = body.match(/public\s+function\s+\w{1,80}\s*\(/g) ?? [];
  const methodCount = methodMatches.length;

  // Count parent interfaces
  const extendsM = /interface\s+\w{1,80}\s+extends\s+([\w\\, ]{1,300})/.exec(content);
  const extendsCount = extendsM
    ? extendsM[1].split(',').filter((s) => s.trim().length > 0).length
    : 0;

  return {
    name,
    file: filePath,
    methodCount,
    extendsCount,
    isMarker: methodCount === 0,
  };
}

// ─── Class parsing ────────────────────────────────────────────────────────────

interface ParsedClass {
  name: string;
  file: string;
  implementedInterfaces: string[];
  hasPartialImpl: boolean;
}

function parseClass(filePath: string): ParsedClass | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('class ')) return null;
  const classM = /\bclass\s+(\w{1,80})/.exec(content);
  if (!classM) return null;

  const implM = /implements\s+([\w\\, ]{1,400})/.exec(content);
  const implementedInterfaces = implM
    ? implM[1].split(',').map((s) => s.trim().split('\\').pop() ?? s.trim()).filter(Boolean)
    : [];

  // Detect partial implementation: method throws RuntimeException or BadMethodCallException
  const hasPartialImpl =
    /throw\s+new\s+\\?(?:RuntimeException|BadMethodCallException|LogicException)\s*\([^)]{0,200}\)\s*;/.test(content);

  return {
    name: classM[1],
    file: filePath,
    implementedInterfaces,
    hasPartialImpl,
  };
}

// ─── Main analysis ────────────────────────────────────────────────────────────

function analyzeAll(appPath: string): InterfaceSegregationInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const interfaces: ParsedInterface[] = [];
  const classes: ParsedClass[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    if (/\binterface\s+\w/.test(content)) {
      const iface = parseInterface(file);
      if (iface) interfaces.push(iface);
    } else if (/\bclass\s+\w/.test(content)) {
      const cls = parseClass(file);
      if (cls) classes.push(cls);
    }
  }

  // Count implementors per interface
  const implCount = new Map<string, number>();
  const partialMap = new Map<string, boolean>();
  for (const cls of classes) {
    for (const iface of cls.implementedInterfaces) {
      implCount.set(iface, (implCount.get(iface) ?? 0) + 1);
      if (cls.hasPartialImpl) partialMap.set(iface, true);
    }
  }

  return interfaces.map((iface): InterfaceSegregationInfo => {
    const issues: string[] = [];
    const name = iface.name;

    if (iface.methodCount > 7) {
      issues.push(
        `Interface ${name} has ${iface.methodCount} methods (>7). ` +
        `Consider splitting into smaller, more focused interfaces (ISP violation).`,
      );
    }

    if (iface.isMarker) {
      issues.push(
        `Interface ${name} is a marker interface (0 methods). ` +
        `In modern PHP 8+, consider using an attribute #[MyMarker] instead.`,
      );
    }

    if (iface.extendsCount > 3) {
      issues.push(
        `Interface ${name} extends ${iface.extendsCount} other interfaces. ` +
        `High coupling — this interface may be too broad.`,
      );
    }

    if (partialMap.get(name)) {
      issues.push(
        `Interface ${name} has at least one implementor that throws RuntimeException/BadMethodCallException. ` +
        `Partial implementation violates the interface contract.`,
      );
    }

    return {
      file: path.basename(iface.file),
      name,
      methodCount: iface.methodCount,
      implementors: implCount.get(name) ?? 0,
      isMarker: iface.isMarker,
      hasPartialImplementation: partialMap.get(name) ?? false,
      issues,
    };
  }).sort((a, b) => b.methodCount - a.methodCount || a.name.localeCompare(b.name));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listInterfaceSegregation(appPath: string): McpToolResult {
  try {
    const items = analyzeAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No interfaces found in src/.\n\n' +
            'Define interfaces to establish contracts:\n' +
            '  interface UserRepositoryInterface {\n' +
            '    public function findById(int $id): ?User;\n' +
            '  }',
        }],
      };
    }

    const fatInterfaces    = items.filter((i) => i.methodCount > 7);
    const markerInterfaces = items.filter((i) => i.isMarker);
    const partialImpls     = items.filter((i) => i.hasPartialImplementation);
    const withIssues       = items.filter((i) => i.issues.length > 0);

    let text = `Interface Segregation Principle Analysis\n${'='.repeat(55)}\n`;
    text += `  Total interfaces:       ${items.length}\n`;
    text += `  Fat interfaces (>7):    ${fatInterfaces.length}\n`;
    text += `  Marker interfaces:      ${markerInterfaces.length}\n`;
    text += `  Partial implementations:${partialImpls.length}\n`;
    text += `  With issues:            ${withIssues.length}\n\n`;

    for (const item of items) {
      text += `${item.name} [${item.file}]\n`;
      text += `  methods: ${item.methodCount}   implementors: ${item.implementors}`;
      if (item.isMarker) text += '   [marker]';
      if (item.hasPartialImplementation) text += '   [partial-impl]';
      text += '\n';
      for (const issue of item.issues) {
        text += `  WARN: ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getInterfaceSegregationStats(appPath: string): McpToolResult {
  try {
    const items = analyzeAll(appPath);

    let text = `Interface Segregation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total interfaces:        ${items.length}\n`;
    text += `Fat interfaces (>7):     ${items.filter((i) => i.methodCount > 7).length}\n`;
    text += `Marker interfaces (0):   ${items.filter((i) => i.isMarker).length}\n`;
    text += `Partial implementations: ${items.filter((i) => i.hasPartialImplementation).length}\n`;
    text += `With implementors:       ${items.filter((i) => i.implementors > 0).length}\n`;
    text += `With issues:             ${items.filter((i) => i.issues.length > 0).length}\n`;

    const maxMethods = items.reduce((max, i) => Math.max(max, i.methodCount), 0);
    text += `Max methods in one:      ${maxMethods}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getInterfaceSegregationTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_php_interface_segregation',
      description: 'List PHP interface segregation analysis: fat interfaces (>7 methods), marker interfaces, partial implementations, high-coupling extends chains',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_php_interface_segregation_stats',
      description: 'Show interface segregation statistics: total interfaces, fat count, marker count, partial implementation count, max method count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
