/**
 * Custom Twig Extensions Inspector
 *
 * Scans src/ for classes extending AbstractExtension (or implementing
 * ExtensionInterface) and extracts what they register:
 *   - Filters ({{ value|myFilter }})
 *   - Functions ({{ myFunction() }})
 *   - Tests ({% if value is myTest %})
 *   - Globals ({{ myGlobal }})
 *   - Operators
 *   - Token parsers (custom tags)
 *
 * Also detects Twig Runtime classes (#[AsTaggedItem] / linked via getRuntimeExtensionClass).
 * Pure static analysis — reads PHP source without executing it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TwigItem {
  name: string;
  callable?: string;
  isSafe?: boolean;
  needsContext?: boolean;
}

interface TwigExtension {
  class: string;
  file: string;
  filters: TwigItem[];
  functions: TwigItem[];
  tests: TwigItem[];
  globals: TwigItem[];
  hasTokenParser: boolean;
  runtimeClass?: string;
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── Extraction helpers ────────────────────────────────────────────────────

function extractTwigItems(content: string, methodName: string): TwigItem[] {
  const items: TwigItem[] = [];

  // Match the method body
  const methodRe = new RegExp(
    `function\\s+${methodName}\\s*\\([^)]*\\)\\s*(?::\\s*array)?\\s*\\{([\\s\\S]*?)\\n\\s{4}\\}`,
    'g'
  );
  const methodMatch = methodRe.exec(content);
  if (!methodMatch) return [];

  const body = methodMatch[1];

  // new TwigFilter('name', ...) or new TwigFunction('name', ...)
  const itemRe = /new\s+Twig(?:Filter|Function|Test)\s*\(\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(body)) !== null) {
    const name = m[1];
    const isSafe = body.slice(m.index, m.index + 200).includes('is_safe');
    const needsContext = body.slice(m.index, m.index + 200).includes('needs_context');
    items.push({ name, isSafe, needsContext });
  }

  // Fallback: string literals that look like filter/function names
  if (items.length === 0) {
    for (const nm of body.matchAll(/['"]([a-z][a-z_0-9]{2,})['"]/g)) {
      items.push({ name: nm[1] });
    }
  }

  return items;
}

function extractGlobals(content: string): TwigItem[] {
  const items: TwigItem[] = [];
  const methodRe = /function\s+getGlobals\s*\([^)]*\)\s*(?::\s*array)?\s*\{([\s\S]*?)\n\s{4}\}/g;
  const methodMatch = methodRe.exec(content);
  if (!methodMatch) return [];

  const body = methodMatch[1];
  for (const m of body.matchAll(/['"]([a-z][a-z_0-9]{2,})['"]\s*=>/g)) {
    items.push({ name: m[1] });
  }
  return items;
}

function parseTwigExtension(filePath: string): TwigExtension | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isExtension =
    content.includes('extends AbstractExtension') ||
    content.includes('implements ExtensionInterface') ||
    content.includes('extends Extension') ||
    (content.includes('getFilters()') && content.includes('TwigFilter'));

  if (!isExtension) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const runtimeM = /getRuntimeExtensionClass\s*\(\s*\)\s*[^{]*\{[^}]*return\s+(\w+)::class/.exec(content);

  return {
    class: classM[1],
    file: path.basename(filePath),
    filters: extractTwigItems(content, 'getFilters'),
    functions: extractTwigItems(content, 'getFunctions'),
    tests: extractTwigItems(content, 'getTests'),
    globals: extractGlobals(content),
    hasTokenParser: content.includes('getTokenParsers') && content.includes('TokenParser'),
    runtimeClass: runtimeM?.[1],
  };
}

function loadTwigExtensions(appPath: string): TwigExtension[] {
  const scanDirs = [
    path.join(appPath, 'src', 'Twig'),
    path.join(appPath, 'src', 'Extension'),
    path.join(appPath, 'src'),
  ];

  const seen = new Set<string>();
  const extensions: TwigExtension[] = [];

  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);

      const content = safeRead(file, dir);
      if (content === null) continue;
      if (!content.includes('AbstractExtension') &&
          !content.includes('TwigFilter') &&
          !content.includes('TwigFunction')) continue;

      const ext = parseTwigExtension(file);
      if (ext) extensions.push(ext);
    }
  }

  return extensions.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listTwigExtensions(appPath: string): McpToolResult {
  try {
    const extensions = loadTwigExtensions(appPath);

    if (extensions.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom Twig extensions found.\n\nCreate:\n  php bin/console make:twig-extension\n\nOr manually:\n  class AppExtension extends AbstractExtension {\n    public function getFilters(): array {\n      return [new TwigFilter(\'price\', [$this, \'formatPrice\'])];\n    }\n  }',
        }],
      };
    }

    let text = `Custom Twig Extensions (${extensions.length})\n${'='.repeat(55)}\n`;

    for (const ext of extensions) {
      text += `\n  ${ext.class}  (${ext.file})\n`;

      if (ext.filters.length > 0) {
        text += `    Filters (${ext.filters.length}):   `;
        text += ext.filters.map((f) => {
          const flags = [f.isSafe ? 'safe' : '', f.needsContext ? 'ctx' : ''].filter(Boolean);
          return flags.length > 0 ? `${f.name}[${flags.join(',')}]` : f.name;
        }).join(', ') + '\n';
      }

      if (ext.functions.length > 0) {
        text += `    Functions (${ext.functions.length}): `;
        text += ext.functions.map((f) => f.name).join(', ') + '\n';
      }

      if (ext.tests.length > 0) {
        text += `    Tests (${ext.tests.length}):     ` + ext.tests.map((t) => t.name).join(', ') + '\n';
      }

      if (ext.globals.length > 0) {
        text += `    Globals (${ext.globals.length}):   ` + ext.globals.map((g) => g.name).join(', ') + '\n';
      }

      if (ext.hasTokenParser) text += `    Token parser: yes (custom Twig tag)\n`;
      if (ext.runtimeClass) text += `    Runtime class: ${ext.runtimeClass}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTwigExtensionStats(appPath: string): McpToolResult {
  try {
    const extensions = loadTwigExtensions(appPath);

    const totalFilters = extensions.reduce((s, e) => s + e.filters.length, 0);
    const totalFunctions = extensions.reduce((s, e) => s + e.functions.length, 0);
    const totalTests = extensions.reduce((s, e) => s + e.tests.length, 0);
    const totalGlobals = extensions.reduce((s, e) => s + e.globals.length, 0);

    let text = `Twig Extension Statistics\n${'='.repeat(40)}\n\n`;
    text += `Extension classes: ${extensions.length}\n`;
    text += `Total filters:     ${totalFilters}\n`;
    text += `Total functions:   ${totalFunctions}\n`;
    text += `Total tests:       ${totalTests}\n`;
    text += `Total globals:     ${totalGlobals}\n`;
    text += `Token parsers:     ${extensions.filter((e) => e.hasTokenParser).length}\n`;

    if (totalFilters + totalFunctions > 0) {
      text += `\nAll registered names:\n`;
      const allFilters = extensions.flatMap((e) => e.filters.map((f) => f.name));
      const allFunctions = extensions.flatMap((e) => e.functions.map((f) => f.name));
      if (allFilters.length > 0) text += `  Filters:   ${allFilters.join(', ')}\n`;
      if (allFunctions.length > 0) text += `  Functions: ${allFunctions.join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getTwigExtensionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_twig_extensions',
      description: 'List custom Twig extensions in src/ with their filters, functions, tests, globals, and token parsers',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_twig_extension_stats',
      description: 'Show Twig extension statistics: total filters, functions, tests, globals across all custom extensions',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
