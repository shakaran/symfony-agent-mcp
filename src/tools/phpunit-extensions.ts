// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHPUnit Extension Inspector
 *
 * Reads phpunit.xml / phpunit.xml.dist for <extensions> section:
 *   - Extracts registered extension class names and parameters
 *
 * Scans src/ and tests/ for:
 *   - Classes implementing PHPUnit Extension interface
 *   - BeforeTestHook, AfterTestHook, BeforeFirstTestHook, AfterLastTestHook
 *   - AfterTestErrorHook, TestRunnerStartedSubscriber (PHPUnit 10+)
 *   - Legacy TestListener interface (PHPUnit 9 deprecation)
 *
 * Warns about:
 *   - Extension in phpunit.xml but class file not found
 *   - Using deprecated TestListener interface (PHPUnit 9→10 migration)
 *   - Extension with no hook methods (empty/no-op extension)
 *   - Bootstrap file specified in phpunit.xml not found
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpUnitExtensionInfo {
  className: string;
  isRegisteredInXml: boolean;
  hooks: string[];
  isLegacyListener: boolean;
  parametersCount: number;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

const HOOK_INTERFACES = [
  'BeforeTestHook',
  'AfterTestHook',
  'BeforeFirstTestHook',
  'AfterLastTestHook',
  'AfterTestErrorHook',
  'BeforeTestMethodHook',
  'AfterTestMethodHook',
];

const SUBSCRIBER_INTERFACES = [
  'TestRunnerStartedSubscriber',
  'TestRunnerFinishedSubscriber',
  'TestPreparedSubscriber',
  'TestPassedSubscriber',
  'TestFailedSubscriber',
];

interface XmlExtension {
  className: string;
  parametersCount: number;
}

interface XmlConfig {
  extensions: XmlExtension[];
  bootstrapFile?: string;
}

function parsePhpUnitXml(appPath: string): XmlConfig {
  const candidates = ['phpunit.xml', 'phpunit.xml.dist'];
  for (const fname of candidates) {
    const filePath = path.join(appPath, fname);
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    const extensions: XmlExtension[] = [];

    // Match <extension class="..." /> or <extension class="...">...</extension>
    const extPattern = /<extension\s[^>]{0,500}class\s*=\s*["']([^"']{1,200})["'][^>]{0,200}>/g;
    let m: RegExpExecArray | null;
    while ((m = extPattern.exec(content)) !== null) {
      const className = m[1];
      // Count parameters nested in this extension block
      const blockStart = m.index;
      const blockEnd = Math.min(content.length, blockStart + 1000);
      const block = content.substring(blockStart, blockEnd);
      const paramCount = (block.match(/<parameter\s/g) ?? []).length;
      extensions.push({ className, parametersCount: paramCount });
    }

    // Extract bootstrap attribute
    const bootstrapMatch = /bootstrap\s*=\s*["']([^"']{1,200})["']/.exec(content);
    const bootstrapFile = bootstrapMatch ? bootstrapMatch[1] : undefined;

    return { extensions, bootstrapFile };
  }
  return { extensions: [] };
}

function parseExtensionClass(filePath: string): {
  className: string;
  hooks: string[];
  isLegacyListener: boolean;
} | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasHookInterface = HOOK_INTERFACES.some((iface) => content.includes(iface));
  const hasSubscriberInterface = SUBSCRIBER_INTERFACES.some((iface) => content.includes(iface));
  const isLegacyListener = content.includes('TestListener') && !content.includes('TestListenerDefaultImplementation');

  if (!hasHookInterface && !hasSubscriberInterface && !isLegacyListener) return null;
  if (!/\bclass\s+/.test(content)) return null;

  const classMatch = /class\s+(\w{1,100})/.exec(content);
  if (!classMatch) return null;

  const hooks: string[] = [];
  for (const iface of HOOK_INTERFACES) {
    if (content.includes(iface)) hooks.push(iface);
  }
  for (const iface of SUBSCRIBER_INTERFACES) {
    if (content.includes(iface)) hooks.push(iface);
  }

  return {
    className: classMatch[1],
    hooks,
    isLegacyListener,
  };
}

function scanExtensionClasses(appPath: string): Array<{
  className: string;
  hooks: string[];
  isLegacyListener: boolean;
}> {
  const dirs = [
    path.join(appPath, 'src'),
    path.join(appPath, 'tests'),
  ].filter((d) => fs.existsSync(d));

  const results: Array<{ className: string; hooks: string[]; isLegacyListener: boolean }> = [];
  for (const dir of dirs) {
    for (const file of getAllPhpFiles(dir)) {
      const ext = parseExtensionClass(file);
      if (ext) results.push(ext);
    }
  }
  return results;
}

function buildExtensionInfos(appPath: string): PhpUnitExtensionInfo[] {
  const xmlConfig = parsePhpUnitXml(appPath);
  const scanned = scanExtensionClasses(appPath);
  const registeredClassNames = new Set(xmlConfig.extensions.map((e) => {
    // Strip namespace prefix for matching short class names
    const parts = e.className.split('\\');
    return parts[parts.length - 1] ?? e.className;
  }));

  const infos: PhpUnitExtensionInfo[] = [];

  // Process XML-registered extensions
  for (const xmlExt of xmlConfig.extensions) {
    const shortName = ((): string => {
      const parts = xmlExt.className.split('\\');
      return parts[parts.length - 1] ?? xmlExt.className;
    })();
    const scannedMatch = scanned.find((s) => s.className === shortName || xmlExt.className.endsWith(s.className));
    const issues: string[] = [];

    if (!scannedMatch) {
      issues.push(`${xmlExt.className}: registered in phpunit.xml but class not found in src/ or tests/`);
    }
    if (scannedMatch?.isLegacyListener) {
      issues.push(`${xmlExt.className}: implements deprecated TestListener interface — migrate to PHPUnit 10 Extension/Subscriber`);
    }
    if (scannedMatch && scannedMatch.hooks.length === 0) {
      issues.push(`${xmlExt.className}: registered extension has no recognized hook methods — may be a no-op`);
    }

    infos.push({
      className: xmlExt.className,
      isRegisteredInXml: true,
      hooks: scannedMatch?.hooks ?? [],
      isLegacyListener: scannedMatch?.isLegacyListener ?? false,
      parametersCount: xmlExt.parametersCount,
      issues,
    });
  }

  // Process scanned-but-not-registered extensions
  for (const s of scanned) {
    if (registeredClassNames.has(s.className)) continue;
    const issues: string[] = [];
    if (s.isLegacyListener) {
      issues.push(`${s.className}: implements deprecated TestListener interface — migrate to PHPUnit 10 Extension/Subscriber`);
    }
    infos.push({
      className: s.className,
      isRegisteredInXml: false,
      hooks: s.hooks,
      isLegacyListener: s.isLegacyListener,
      parametersCount: 0,
      issues,
    });
  }

  // Bootstrap file check
  if (xmlConfig.bootstrapFile) {
    const bootstrapPath = path.isAbsolute(xmlConfig.bootstrapFile)
      ? xmlConfig.bootstrapFile
      : path.join(appPath, xmlConfig.bootstrapFile);
    if (!fs.existsSync(bootstrapPath)) {
      // Add as a synthetic entry
      infos.push({
        className: `[bootstrap: ${xmlConfig.bootstrapFile}]`,
        isRegisteredInXml: true,
        hooks: [],
        isLegacyListener: false,
        parametersCount: 0,
        issues: [`Bootstrap file '${xmlConfig.bootstrapFile}' specified in phpunit.xml not found`],
      });
    }
  }

  return infos.sort((a, b) => a.className.localeCompare(b.className));
}

export function listPhpUnitExtensions(appPath: string): McpToolResult {
  try {
    const infos = buildExtensionInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHPUnit extensions found in phpunit.xml or src/tests/.\n\nRegister an extension in phpunit.xml:\n  <extensions>\n    <extension class="App\\Tests\\Extension\\MyExtension" />\n  </extensions>',
        }],
      };
    }

    let text = `PHPUnit Extensions\n${'='.repeat(55)}\n`;
    let totalIssues = 0;

    for (const info of infos) {
      const xmlMark = info.isRegisteredInXml ? '[xml]' : '[unregistered]';
      const legacyMark = info.isLegacyListener ? '[LEGACY]' : '';
      text += `\n${info.className} ${xmlMark}${legacyMark}\n`;
      if (info.hooks.length > 0) text += `  Hooks: ${info.hooks.join(', ')}\n`;
      if (info.parametersCount > 0) text += `  Parameters: ${info.parametersCount}\n`;
      for (const issue of info.issues) {
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

export function getPhpUnitExtensionStats(appPath: string): McpToolResult {
  try {
    const infos = buildExtensionInfos(appPath);

    let text = `PHPUnit Extension Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total extensions:           ${infos.length}\n`;
    text += `  Registered in XML:        ${infos.filter((i) => i.isRegisteredInXml).length}\n`;
    text += `  Found in code only:       ${infos.filter((i) => !i.isRegisteredInXml).length}\n`;
    text += `  Legacy TestListener:      ${infos.filter((i) => i.isLegacyListener).length}\n`;
    text += `  No hook methods:          ${infos.filter((i) => i.hooks.length === 0 && !i.className.startsWith('[bootstrap')).length}\n`;
    text += `Total warnings:             ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitExtensionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpunit_extensions',
      description: 'Analyze PHPUnit extensions: parse phpunit.xml <extensions> section, scan src/tests for hook interface implementations (BeforeTestHook, AfterTestHook, PHPUnit 10 Subscribers), detect legacy TestListener, unregistered extensions, missing class files, missing bootstrap file',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_extension_stats',
      description: 'Statistics for PHPUnit extensions: total count, XML-registered vs code-only, legacy TestListener count, no-hook count, total warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
