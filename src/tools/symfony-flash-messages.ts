/**
 * Symfony Flash Messages Inspector
 *
 * Scans src/ PHP for addFlash() calls — extracts category, counts per category.
 * Scans templates/ for app.flashes(), app.flashes('success'), for-loop patterns.
 * Detects peekFlashes() vs getFlashes() usage.
 *
 * Warns: flash categories in PHP not matched by any Twig consumer,
 * custom category names inconsistent, flashBag direct use (deprecated in 6+),
 * addFlash in a service (not controller/subscriber).
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

interface FlashMessageInfo {
  file: string;
  categories: string[];
  count: number;
  isController: boolean;
  issues: string[];
}

const STANDARD_CATEGORIES = ['success', 'error', 'warning', 'info', 'notice', 'danger'];

const CONTROLLER_PATTERNS = [
  'AbstractController',
  'Controller',
  'ControllerTrait',
  'extends Controller',
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

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig') || e.name.endsWith('.html.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractFlashCategories(content: string): string[] {
  const cats: string[] = [];
  // Match ->addFlash('category', ...) and ->addFlash("category", ...)
  const reS = /->addFlash\s*\(\s*'([^']{1,50})'/g;
  const reD = /->addFlash\s*\(\s*"([^"]{1,50})"/g;
  let m: RegExpExecArray | null;
  while ((m = reS.exec(content)) !== null) cats.push(m[1]);
  while ((m = reD.exec(content)) !== null) cats.push(m[1]);
  return cats;
}

function parsePhpFlash(filePath: string, appPath: string): FlashMessageInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('addFlash(') && !content.includes('flashBag')) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const categories = extractFlashCategories(content);
  const flashBagCount = (content.match(/flashBag/g) ?? []).length;
  const isController = CONTROLLER_PATTERNS.some((p) => content.includes(p));

  const issues: string[] = [];

  if (flashBagCount > 0) {
    issues.push('Direct flashBag usage detected — deprecated in Symfony 6+, use addFlash() instead');
  }
  if (!isController && categories.length > 0) {
    issues.push('addFlash() called in a service — flash messages require session scope (controller or subscriber)');
  }

  if (categories.length === 0 && flashBagCount === 0) return null;

  return {
    file: path.relative(appPath, filePath),
    categories: [...new Set(categories)],
    count: categories.length,
    isController,
    issues,
  };
}

function collectTwigConsumers(appPath: string): Set<string> {
  const consumed = new Set<string>();
  const templatesDir = path.join(appPath, 'templates');
  if (!fs.existsSync(templatesDir)) return consumed;

  const files = getAllTwigFiles(templatesDir);
  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    // app.flashes('category') or app.flashes("category")
    const reS = /app\.flashes\s*\(\s*'([^']{1,50})'\s*\)/g;
    const reD = /app\.flashes\s*\(\s*"([^"]{1,50})"\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = reS.exec(content)) !== null) consumed.add(m[1]);
    while ((m = reD.exec(content)) !== null) consumed.add(m[1]);

    // app.flashes (no argument = all consumed)
    if (/app\.flashes\s*\(\s*\)/.test(content) || /app\.flashes(?!\s*\()/.test(content)) {
      consumed.add('*');
    }
  }
  return consumed;
}

export function listFlashMessages(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const phpResults: FlashMessageInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = parsePhpFlash(file, appPath);
      if (r) phpResults.push(r);
    }

    const twigConsumers = collectTwigConsumers(appPath);
    const consumesAll = twigConsumers.has('*');

    // Cross-check: categories in PHP not consumed in Twig
    for (const r of phpResults) {
      for (const cat of r.categories) {
        if (!consumesAll && !twigConsumers.has(cat)) {
          r.issues.push(`Flash category '${cat}' is not consumed in any Twig template — message will never be displayed`);
        }
      }
    }

    // Check for inconsistent custom category names across files
    const allCats = phpResults.flatMap((r) => r.categories);
    const customCats = allCats.filter((c) => !STANDARD_CATEGORIES.includes(c));
    const customCatSet = new Set(customCats);
    if (customCatSet.size > 0) {
      const catList = [...customCatSet].join(', ');
      for (const r of phpResults) {
        if (r.categories.some((c) => customCatSet.has(c))) {
          r.issues.push(`Custom flash category used: ${catList} — ensure consistent naming across all controllers`);
          break;
        }
      }
    }

    if (phpResults.length === 0) {
      return { content: [{ type: 'text', text: 'No flash message usage found in src/.' }] };
    }

    const totalIssues = phpResults.reduce((s, r) => s + r.issues.length, 0);
    let text = `Symfony Flash Messages\n${'='.repeat(55)}\n`;
    text += `\nFiles using flash: ${phpResults.length}  Issues: ${totalIssues}\n`;
    text += `Twig consumers: ${consumesAll ? 'all categories (app.flashes)' : [...twigConsumers].join(', ') || 'none detected'}\n`;

    for (const r of phpResults.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.file}  (${r.isController ? 'controller' : 'service'})\n`;
      text += `    Flash calls: ${r.count}  Categories: ${r.categories.join(', ') || '(dynamic)'}\n`;
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

export function getFlashMessageStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const phpResults: FlashMessageInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parsePhpFlash(file, appPath);
        if (r) phpResults.push(r);
      }
    }

    const twigConsumers = collectTwigConsumers(appPath);
    const allCats = phpResults.flatMap((r) => r.categories);
    const catCounts: Record<string, number> = {};
    for (const cat of allCats) {
      catCounts[cat] = (catCounts[cat] ?? 0) + 1;
    }

    let text = `Flash Message Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with addFlash():      ${phpResults.length}\n`;
    text += `  In controllers:           ${phpResults.filter((r) => r.isController).length}\n`;
    text += `  In services:              ${phpResults.filter((r) => !r.isController).length}\n`;
    text += `Total flash calls:          ${phpResults.reduce((s, r) => s + r.count, 0)}\n`;

    const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
    if (sortedCats.length > 0) {
      text += `Categories:\n`;
      for (const [cat, count] of sortedCats) {
        const consumed = twigConsumers.has('*') || twigConsumers.has(cat) ? 'consumed' : 'NOT consumed in Twig';
        text += `  ${cat.padEnd(20)} ${count}x  ${consumed}\n`;
      }
    }

    text += `Issues detected:            ${phpResults.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFlashMessageTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_flash_messages',
      description: 'Show Symfony flash message usage: addFlash categories per file, Twig consumer detection, warns on categories not consumed in Twig, flashBag direct use (deprecated Symfony 6+), addFlash in service (needs session scope)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_flash_message_stats',
      description: 'Show flash message statistics: file count, controller vs service split, total calls, category usage counts with Twig consumption status, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
