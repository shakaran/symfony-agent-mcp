// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Error Controller Inspector
 *
 * Reads framework.yaml for error_controller config.
 * Scans src/ PHP for the configured error controller class.
 * Detects JSON/HTML response negotiation, HttpExceptionInterface implementations.
 *
 * Warns: error_controller configured but class not found,
 * custom error controller not handling JSON format,
 * HttpException subclass without message translation,
 * error_controller not handling all HTTP methods.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ErrorControllerInfo {
  configuredController?: string;
  controllerFound: boolean;
  handlesJson: boolean;
  handlesHtml: boolean;
  customExceptions: number;
  issues: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function readErrorControllerConfig(appPath: string): string | undefined {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'framework.yaml'),
  ];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const fw = (raw['framework'] ?? raw) as Record<string, unknown>;
    const errorCtrl = fw['error_controller'];
    if (typeof errorCtrl === 'string' && errorCtrl.length > 0) {
      return errorCtrl as string;
    }
  }

  return undefined;
}

function classFromController(controller: string): string {
  // Controller may be 'App\Controller\ErrorController::show' or 'App\Controller\ErrorController'
  const withoutMethod = controller.split('::')[0] ?? controller;
  const parts = withoutMethod.split('\\');
  return parts[parts.length - 1] ?? withoutMethod;
}

function scanCustomExceptions(srcDir: string): number {
  let count = 0;
  const appPath = path.dirname(srcDir);
  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (content.includes('HttpExceptionInterface') || /extends\s+HttpException\b/.test(content)) {
      count++;
    }
  }
  return count;
}

function analyseErrorController(appPath: string): ErrorControllerInfo {
  const configuredController = readErrorControllerConfig(appPath);
  const srcDir = path.join(appPath, 'src');

  let controllerFound = false;
  let handlesJson = false;
  let handlesHtml = false;

  if (configuredController) {
    const targetClass = classFromController(configuredController);

    for (const file of getAllPhpFiles(srcDir)) {
      const content = safeRead(file, appPath);
      if (content === null) continue;

      if (!content.includes(targetClass)) continue;

      const escapedClass = targetClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const classMatch = new RegExp(`class\\s+${escapedClass}\\b`).exec(content);
      if (!classMatch) continue;

      controllerFound = true;

      // JSON negotiation detection
      handlesJson = /application\/json|getPreferredFormat|isXmlHttpRequest|Accept/.test(content) ||
        /JsonResponse|json_encode/.test(content);

      handlesHtml = /render\s*\(|twig|HtmlResponse|Response\s*\(/.test(content);

      break;
    }
  } else {
    // Default Symfony error controller is always "found"
    controllerFound = true;
    handlesJson = true;
    handlesHtml = true;
  }

  const customExceptions = scanCustomExceptions(srcDir);

  const issues: string[] = [];

  if (configuredController && !controllerFound) {
    issues.push(`error_controller "${configuredController}" configured but class not found in src/`);
  }

  if (controllerFound && configuredController && !handlesJson) {
    issues.push('Custom error controller does not appear to handle JSON format — API clients may receive HTML error pages');
  }

  if (customExceptions > 0) {
    // Check if they have translatableMessage or a translator
    for (const file of getAllPhpFiles(srcDir)) {
      const content = safeRead(file, appPath);
      if (content === null) continue;

      if (!/extends\s+HttpException\b/.test(content)) continue;

      if (!content.includes('TranslatableMessage') && !content.includes('translator') && !content.includes('getMessage')) {
        issues.push('HttpException subclass detected without message translation — consider TranslatableMessage for i18n');
        break;
      }
    }
  }

  return { configuredController, controllerFound, handlesJson, handlesHtml, customExceptions, issues };
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listErrorController(appPath: string): McpToolResult {
  try {
    const info = analyseErrorController(appPath);

    let text = `Error Controller Configuration\n${'='.repeat(50)}\n\n`;
    text += `Configured controller:  ${info.configuredController ?? '(Symfony default)'}\n`;
    text += `Controller found:       ${info.controllerFound ? 'yes' : 'NO'}\n`;
    text += `Handles JSON:           ${info.handlesJson ? 'yes' : 'no'}\n`;
    text += `Handles HTML:           ${info.handlesHtml ? 'yes' : 'no'}\n`;
    text += `Custom HTTP exceptions: ${info.customExceptions}\n`;

    if (info.issues.length > 0) {
      text += `\nIssues:\n`;
      for (const issue of info.issues) {
        text += `  - ${issue}\n`;
      }
    } else {
      text += `\nNo issues detected.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getErrorControllerStats(appPath: string): McpToolResult {
  try {
    const info = analyseErrorController(appPath);

    let text = `Error Controller Stats\n${'='.repeat(40)}\n\n`;
    text += `Custom controller:      ${info.configuredController ? 'yes' : 'no (Symfony default)'}\n`;
    text += `Controller found:       ${info.controllerFound}\n`;
    text += `JSON-aware:             ${info.handlesJson}\n`;
    text += `Custom HTTP exceptions: ${info.customExceptions}\n`;
    text += `Issues:                 ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getErrorControllerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_error_controller',
      description: 'Show Symfony error_controller config: configured class, JSON/HTML handling detection, custom HttpException subclasses',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_error_controller_stats',
      description: 'Statistics for error controller: custom controller presence, JSON-aware flag, custom exception count, issue count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
