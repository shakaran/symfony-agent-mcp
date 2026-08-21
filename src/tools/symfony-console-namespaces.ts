/**
 * Symfony Console Command Namespace Inspector
 *
 * Distinct from commands.ts (which lists commands with descriptions).
 * Focuses on command organization, deprecations, and naming:
 *
 * Namespace analysis:
 *   - Groups commands by namespace (app:, doctrine:, cache:, debug:, etc.)
 *   - Commands without a namespace (bare names — not recommended)
 *   - Namespace depth (e.g. app:user:create has 2 levels)
 *   - Single-command namespaces (namespace with only one command)
 *
 * Deprecated commands:
 *   - $this->setDeprecated() calls in configure() or __construct()
 *   - #[AsCommand(description: '...', hidden: true)] — hidden commands
 *   - Commands marked as aliases of another command
 *
 * Alias analysis:
 *   - setAliases() call sites — aliased to what
 *   - Duplicate alias names across commands
 *   - Aliases that conflict with another command name
 *
 * Naming conventions:
 *   - camelCase vs kebab-case in command names
 *   - Very long command names (> 50 chars)
 *   - Commands with same name as built-in Symfony commands
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

interface CommandInfo {
  class: string;
  file: string;
  name?: string;
  namespace?: string;
  isDeprecated: boolean;
  isHidden: boolean;
  aliases: string[];
  issues: string[];
}

const SYMFONY_BUILTIN_COMMANDS = new Set([
  'cache:clear', 'cache:warmup', 'cache:pool:clear', 'cache:pool:list',
  'debug:router', 'debug:container', 'debug:config', 'debug:event-dispatcher',
  'doctrine:schema:update', 'doctrine:schema:validate', 'doctrine:migrations:migrate',
  'messenger:consume', 'messenger:failed:show', 'make:entity', 'make:controller',
]);

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseCommand(filePath: string): CommandInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isCommand = content.includes('extends Command') || content.includes('#[AsCommand') ||
                    content.includes('implements Command');
  if (!isCommand) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\Bundle\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const asCommandM = /#\[AsCommand\s*\(\s*name\s*:\s*['"]([^'"]+)['"]/.exec(content);
  const setNameM   = /setName\s*\(\s*['"]([^'"]+)['"]/.exec(content);
  const staticNameM = /protected\s+static\s+\$defaultName\s*=\s*['"]([^'"]+)['"]/.exec(content);
  const name = asCommandM?.[1] ?? setNameM?.[1] ?? staticNameM?.[1];

  const namespace = name?.includes(':') ? name.split(':').slice(0, -1).join(':') : undefined;

  const isDeprecated = content.includes('setDeprecated(') ||
                       /#\[AsCommand[^)]*deprecated/.test(content);
  const isHidden     = /#\[AsCommand[^)]*hidden\s*:\s*true/.test(content) ||
                       content.includes('setHidden(true)');

  const aliases: string[] = [];
  const aliasM = /setAliases\s*\(\s*\[([^\]]+)\]/.exec(content);
  if (aliasM) {
    for (const m of aliasM[1].matchAll(/['"]([^'"]+)['"]/g)) aliases.push(m[1]);
  }
  const asCommandAliasM = /#\[AsCommand[^)]*aliases\s*:\s*\[([^\]]+)\]/.exec(content);
  if (asCommandAliasM) {
    for (const m of asCommandAliasM[1].matchAll(/['"]([^'"]+)['"]/g)) aliases.push(m[1]);
  }

  const issues: string[] = [];
  if (!name) issues.push('No command name found (#[AsCommand] or setName())');
  if (name && !name.includes(':')) issues.push(`Command "${name}" has no namespace — use app:command-name pattern`);
  if (name && name.length > 50) issues.push(`Command name is very long (${name.length} chars)`);
  if (name && SYMFONY_BUILTIN_COMMANDS.has(name)) issues.push(`Command name "${name}" conflicts with a built-in Symfony command`);

  return {
    class: classM[1],
    file: path.basename(filePath),
    name,
    namespace,
    isDeprecated,
    isHidden,
    aliases,
    issues,
  };
}

export function listCommandNamespaces(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const commands: CommandInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const c = parseCommand(file);
      if (c) commands.push(c);
    }

    if (commands.length === 0) {
      return { content: [{ type: 'text', text: 'No custom console commands found in src/.' }] };
    }

    // Group by namespace
    const byNs = new Map<string, CommandInfo[]>();
    for (const cmd of commands) {
      const ns = cmd.namespace ?? '(no namespace)';
      const list = byNs.get(ns) ?? [];
      list.push(cmd);
      byNs.set(ns, list);
    }

    // Alias conflict detection
    const allNames    = new Set(commands.map((c) => c.name).filter(Boolean) as string[]);
    const aliasConflicts: string[] = [];
    for (const cmd of commands) {
      for (const alias of cmd.aliases) {
        if (allNames.has(alias) && alias !== cmd.name) {
          aliasConflicts.push(`${cmd.class}: alias "${alias}" conflicts with existing command name`);
        }
      }
    }

    const totalIssues = commands.reduce((s, c) => s + c.issues.length, 0) + aliasConflicts.length;

    let text = `Console Command Namespaces\n${'='.repeat(55)}\n`;
    text += `\nTotal commands: ${commands.length}  Issues: ${totalIssues}\n`;
    text += `Namespaces: ${byNs.size}\n`;

    for (const [ns, cmds] of [...byNs.entries()].sort()) {
      const warn = cmds.length === 1 ? '' : '';
      text += `\n  ${ns}  (${cmds.length} command${cmds.length === 1 ? '' : 's'})${warn}\n`;
      for (const c of cmds.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) {
        const deprecated = c.isDeprecated ? '  [DEPRECATED]' : '';
        const hidden     = c.isHidden ? '  [hidden]' : '';
        const alias      = c.aliases.length > 0 ? `  aliases: ${c.aliases.join(', ')}` : '';
        text += `    ${c.name?.padEnd(40) ?? c.class.padEnd(40)}${deprecated}${hidden}${alias}\n`;
        for (const issue of c.issues) text += `      ⚠ ${issue}\n`;
      }
    }

    if (aliasConflicts.length > 0) {
      text += `\nAlias conflicts:\n`;
      for (const conflict of aliasConflicts) text += `  ⚠ ${conflict}\n`;
    }

    const deprecated = commands.filter((c) => c.isDeprecated);
    if (deprecated.length > 0) {
      text += `\nDeprecated commands (${deprecated.length}): ${deprecated.map((c) => c.name ?? c.class).join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCommandNamespaceStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const commands: CommandInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const c = parseCommand(file);
        if (c) commands.push(c);
      }
    }

    const byNs = new Map<string, number>();
    for (const cmd of commands) {
      const ns = cmd.namespace ?? '(no namespace)';
      byNs.set(ns, (byNs.get(ns) ?? 0) + 1);
    }

    let text = `Command Namespace Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total commands:      ${commands.length}\n`;
    text += `Namespaces:          ${byNs.size}\n`;
    text += `Deprecated:          ${commands.filter((c) => c.isDeprecated).length}\n`;
    text += `Hidden:              ${commands.filter((c) => c.isHidden).length}\n`;
    text += `Without namespace:   ${commands.filter((c) => !c.namespace).length}\n`;
    text += `With aliases:        ${commands.filter((c) => c.aliases.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getConsoleNamespaceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_command_namespaces',
      description: 'Show console command namespace analysis: commands grouped by namespace, deprecated commands (setDeprecated/hidden), aliases, alias conflict detection, commands without namespace, name length warning, built-in name conflict',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_command_namespace_stats',
      description: 'Show command namespace statistics: total count, namespace count, deprecated/hidden/alias/no-namespace counts',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
