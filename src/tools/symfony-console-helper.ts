/**
 * Symfony Console Helper Inspector
 *
 * Scans src/ PHP for: HelperInterface implementations, HelperSet::set(),
 * $application->getHelperSet()->set(), class extending Helper, getName() returning helper name.
 * Also detects: $this->getHelper('question') usage in commands.
 *
 * Warns about:
 *   - Custom helper not registered in Application (getHelper() will throw)
 *   - HelperInterface::getName() returning empty string (helper unaddressable)
 *   - Helper with heavy constructor dependencies (helpers are shared, deps instantiated once)
 *   - Helper calling output methods directly instead of accepting OutputInterface (not testable)
 *   - $this->getHelper() called in configure() instead of execute() (configure runs before helper set)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ConsoleHelperInfo {
  file: string;
  class: string;
  helperName: string;
  isRegistered: boolean;
  hasHeavyDeps: boolean;
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

function extractClassName(content: string): string {
  const m = content.match(/class\s+([A-Za-z0-9_]{1,120})/);
  return m ? m[1] : '(unknown)';
}

function extractHelperName(content: string): string {
  // Try to extract the string returned from getName()
  const nameMatch = content.match(/function\s+getName\s*\(\s*\)[^{]{0,20}\{[^}]{0,100}return\s*['"]([a-z][a-z0-9_\- ]{0,60})['"]/i);
  if (nameMatch) return nameMatch[1];

  // Try HelperSet::set() with quoted name
  const setMatch = content.match(/->set\s*\(\s*(?:\$this|new\s+[A-Za-z0-9_]+\s*\([^)]{0,100}\)\s*),\s*['"]([a-z][a-z0-9_-]{0,60})['"]/i);
  if (setMatch) return setMatch[1];

  return '(unknown)';
}

function buildConsoleHelperInfos(appPath: string): ConsoleHelperInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  // First pass: collect all registration calls
  const registeredHelpers = new Set<string>();
  const registrationFiles = new Set<string>();

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (content.includes('getHelperSet()->set(') || content.includes('HelperSet(') || content.includes('->set(')) {
      const setMatches = content.matchAll(/->set\s*\(\s*new\s+([A-Za-z0-9_]{1,80})/g);
      for (const m of setMatches) {
        registeredHelpers.add(m[1]);
      }
      registrationFiles.add(file);
    }

    // Also detect named registration
    const namedMatches = content.matchAll(/->set\s*\([^,)]{1,100},\s*['"]([a-z][a-z0-9_-]{0,60})['"]/gi);
    for (const m of namedMatches) {
      registeredHelpers.add(m[1]);
    }
  }

  const results: ConsoleHelperInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isHelper =
      content.includes('HelperInterface') ||
      content.includes('extends Helper') ||
      (content.includes('implements') && /implements[^{]{0,200}HelperInterface/s.test(content));

    const hasGetHelperCall = content.includes('$this->getHelper(') || content.includes('->getHelper(');

    if (!isHelper && !hasGetHelperCall) continue;

    const className = extractClassName(content);
    const helperName = isHelper ? extractHelperName(content) : '(consumer)';
    const issues: string[] = [];

    if (isHelper) {
      const isRegistered =
        registeredHelpers.has(className) ||
        registeredHelpers.has(helperName) ||
        content.includes('getHelperSet()->set(');

      // Check for empty getName() return
      if (helperName === '(unknown)' && content.includes('getName()')) {
        issues.push(`"${className}" implements HelperInterface but getName() return value could not be determined — empty name makes helper unaddressable`);
      }

      if (!isRegistered) {
        issues.push(`"${className}" implements HelperInterface but no registration via HelperSet::set() found — getHelper('${helperName}') will throw InvalidArgumentException`);
      }

      // Detect heavy constructor deps (3+ injected services)
      const ctorMatch = content.match(/function\s+__construct\s*\(([^)]{0,300})\)/);
      const hasHeavyDeps = ctorMatch ? (ctorMatch[1].split(',').length >= 3) : false;
      if (hasHeavyDeps) {
        issues.push(`"${className}" helper has 3+ constructor dependencies — helpers are shared singletons; heavy deps are instantiated once and may hold stale state`);
      }

      // Check if helper outputs directly instead of accepting OutputInterface
      const hasDirectOutput =
        content.includes('echo ') ||
        content.includes('print ') ||
        (content.includes('->writeln') && !content.includes('OutputInterface') && !content.includes('$output'));

      if (hasDirectOutput) {
        issues.push(`"${className}" helper writes output directly instead of accepting OutputInterface — direct output prevents testing and buffered output capture`);
      }

      results.push({
        file,
        class: className,
        helperName,
        isRegistered,
        hasHeavyDeps: !!(ctorMatch && ctorMatch[1].split(',').length >= 3),
        issues,
      });
    }

    // Detect getHelper() called in configure()
    if (hasGetHelperCall) {
      const configureBlock = content.match(/function\s+configure\s*\(\s*\)[^{]{0,20}\{([^}]{0,500})\}/s);
      if (configureBlock && configureBlock[1].includes('getHelper(')) {
        issues.push(`"${className}" calls getHelper() inside configure() — configure() runs before the helper set is attached; call getHelper() in execute() instead`);

        results.push({
          file,
          class: className,
          helperName: '(consumer)',
          isRegistered: true,
          hasHeavyDeps: false,
          issues,
        });
      }
    }
  }

  return results;
}

export function listConsoleHelpers(appPath: string): McpToolResult {
  try {
    const infos = buildConsoleHelperInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom Console helpers (HelperInterface implementations) found in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Console Helper Analysis\n${'='.repeat(55)}\n\n`;
    text += `Helpers: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}\n`;
      text += `    helperName:   ${info.helperName}\n`;
      text += `    registered:   ${info.isRegistered ? 'yes' : 'no'}\n`;
      text += `    heavyDeps:    ${info.hasHeavyDeps ? 'yes' : 'no'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getConsoleHelperStats(appPath: string): McpToolResult {
  try {
    const infos = buildConsoleHelperInfos(appPath);

    let text = `Console Helper Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total helpers:               ${infos.length}\n`;
    text += `  Registered:                ${infos.filter((i) => i.isRegistered).length}\n`;
    text += `  Unregistered:              ${infos.filter((i) => !i.isRegistered).length}\n`;
    text += `  With heavy deps:           ${infos.filter((i) => i.hasHeavyDeps).length}\n`;
    text += `Total issues:                ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getConsoleHelperTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_console_helpers',
      description: 'Inspect custom Symfony Console helpers: HelperInterface implementations, HelperSet registrations, getName() return values; warns on unregistered helpers, heavy constructor deps, direct output (not testable), getHelper() called in configure()',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_console_helper_stats',
      description: 'Statistics for Console helpers: total count, registered vs unregistered, heavy deps count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
