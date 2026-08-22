/**
 * Symfony VarDumper Customization Inspector
 *
 * Detects custom casters, VarDumper::setHandler, dump()/dd() calls
 * and warns on production-unsafe usage.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import * as fs from 'fs';
import { McpToolResult } from '../server.js';


interface VarDumperEntry {
  file: string;
  className: string;
  casterTypes: string[];
  hasDumpCalls: boolean;
  isTestFile: boolean;
  issues: string[];
}

// ─── PHP scanning ────────────────────────────────────────────────────────────

function collectPhpFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

function extractClassName(content: string, file: string): string {
  const m = /class\s+(\w{1,120})/u.exec(content);
  return m ? m[1] : path.basename(file, '.php');
}

function isTestFile(filePath: string, content: string): boolean {
  return (
    filePath.includes('/tests/') ||
    filePath.includes('/test/') ||
    /Test\.php$/u.test(filePath) ||
    /extends\s+(?:KernelTestCase|WebTestCase|TestCase)/u.test(content)
  );
}

const CASTER_PATTERNS: Array<[RegExp, string]> = [
  [/ReflectionCaster/u, 'ReflectionCaster'],
  [/DoctrineCaster/u, 'DoctrineCaster'],
  [/AbstractCloner::addCasters/u, 'addCasters (static)'],
  [/Caster::PREFIX_/u, 'Caster::PREFIX_*'],
];

function extractCasterTypes(content: string): string[] {
  const found: string[] = [];
  for (const [re, label] of CASTER_PATTERNS) {
    if (re.test(content)) found.push(label);
  }
  return found;
}

function hasDumpCalls(content: string): boolean {
  return /\bdump\s*\(/u.test(content) || /\bdd\s*\(/u.test(content);
}

function scanPhpForVarDumper(appPaths: string[]): VarDumperEntry[] {
  const results: VarDumperEntry[] = [];

  for (const dir of appPaths) {
    const files = collectPhpFiles(dir);
    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      const isVarDumperRelated =
        /VarDumper::setHandler/u.test(content) ||
        /AbstractCloner::addCasters/u.test(content) ||
        /use\s+Symfony\\Component\\VarDumper/u.test(content) ||
        hasDumpCalls(content);

      if (!isVarDumperRelated) continue;

      const className = extractClassName(content, file);
      const casterTypes = extractCasterTypes(content);
      const dumpCallsPresent = hasDumpCalls(content);
      const testFile = isTestFile(file, content);
      const issues: string[] = [];

      // setHandler in production code
      if (/VarDumper::setHandler/u.test(content) && !testFile) {
        issues.push(
          'VarDumper::setHandler() found in non-test file — custom dump handler may be active in production, changing debug output routing'
        );
      }

      // addCasters without restoration (global state mutation)
      if (/AbstractCloner::addCasters/u.test(content)) {
        const hasRestore =
          /addCasters\s*\(\s*\[\s*\]\s*\)/u.test(content) ||
          /setDefaultCasters/u.test(content);
        if (!hasRestore) {
          issues.push(
            'AbstractCloner::addCasters() called statically without restoration — mutates global caster state; wrap in try/finally with restoration'
          );
        }
      }

      // dump()/dd() in non-test files
      if (dumpCallsPresent && !testFile) {
        issues.push(
          'dump() or dd() call found in non-test PHP file — debug output leaks to production responses'
        );
      }

      results.push({
        file,
        className,
        casterTypes,
        hasDumpCalls: dumpCallsPresent,
        isTestFile: testFile,
        issues,
      });
    }
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listSymfonyDebugVarDumpers(appPath: string): McpToolResult {
  try {
    const scanDirs = [
      path.join(appPath, 'src'),
      path.join(appPath, 'tests'),
    ];

    const allEntries = scanPhpForVarDumper(scanDirs);
    const entries = allEntries.map((e) => ({
      ...e,
      file: path.relative(appPath, e.file),
    }));

    if (entries.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No VarDumper customizations or dump()/dd() calls found.',
        }],
      };
    }

    const withIssues = entries.filter((e) => e.issues.length > 0);
    const dumpInProd = entries.filter((e) => e.hasDumpCalls && !e.isTestFile);

    let text = `Symfony VarDumper Inspector  (${entries.length} files)\n${'='.repeat(55)}\n`;

    if (dumpInProd.length > 0) {
      text += `\n[!!] dump()/dd() calls in non-test files: ${dumpInProd.length}\n`;
    }

    for (const e of entries) {
      const prefix = e.issues.length > 0 ? '[!]' : '   ';
      text += `\n${prefix} ${e.file}`;
      if (e.isTestFile) text += '  (test)';
      text += '\n';
      if (e.className) text += `    Class: ${e.className}\n`;
      if (e.casterTypes.length > 0) text += `    Casters: ${e.casterTypes.join(', ')}\n`;
      text += `    dump()/dd() calls: ${e.hasDumpCalls ? 'YES' : 'no'}\n`;
      for (const issue of e.issues) {
        text += `    [!] ${issue}\n`;
      }
    }

    if (withIssues.length === 0) {
      text += `\nAll entries look correct.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyDebugVarDumperStats(appPath: string): McpToolResult {
  try {
    const scanDirs = [
      path.join(appPath, 'src'),
      path.join(appPath, 'tests'),
    ];

    const entries = scanPhpForVarDumper(scanDirs);
    const withIssues = entries.filter((e) => e.issues.length > 0);
    const dumpInProd = entries.filter((e) => e.hasDumpCalls && !e.isTestFile);
    let text = `Symfony VarDumper Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with VarDumper usage:   ${entries.length}\n`;
    text += `Files with issues:            ${withIssues.length}\n`;
    text += `dump()/dd() in prod files:    ${dumpInProd.length}\n`;
    text += `Test files with dump():       ${entries.filter((e) => e.hasDumpCalls && e.isTestFile).length}\n`;
    text += `Files with custom casters:    ${entries.filter((e) => e.casterTypes.length > 0).length}\n`;
    text += `Total issues:                 ${entries.reduce((s, e) => s + e.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getSymfonyDebugVarDumperTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_symfony_debug_var_dumpers',
      description: 'Detect Symfony VarDumper customizations (custom casters, setHandler) and dump()/dd() calls; warns on setHandler in production code, addCasters without global state restoration, and dump()/dd() in non-test files',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_symfony_debug_var_dumper_stats',
      description: 'Statistics on VarDumper usage: file count, dump() in prod files, custom casters, issues detected',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
