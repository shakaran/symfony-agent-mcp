/**
 * Symfony Console Hidden Commands Inspector
 *
 * Scans src/**\/*.php for hidden and alias command patterns:
 *   - ->setHidden(true) commands
 *   - Command aliases via ->setAliases([...])
 *   - ContainerCommandLoader usage without console.command service tag
 *   - Duplicate command names registered twice
 *   - #[AsCommand] attribute conflict with protected static $defaultName
 *   - Commands without description
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CommandInfo {
  file: string;
  className: string;
  name: string;
  isHidden: boolean;
  aliases: string[];
  hasDescription: boolean;
  description: string;
  hasAsCommandAttr: boolean;
  hasDefaultName: boolean;
  hasServiceTag: boolean;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...getAllPhpFiles(full));
      } else if (entry.name.endsWith('.php')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

function extractAliases(content: string): string[] {
  const aliasMatch = /->setAliases\(\s*\[([^\]]+)]/m.exec(content);
  if (!aliasMatch) return [];
  return aliasMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter((s) => s.length > 0);
}

function extractCommandName(content: string): string {
  // Try #[AsCommand(name: '...')]
  const asCommandMatch = /#\[AsCommand\s*\(\s*(?:name\s*:\s*)?['"]([^'"]+)['"]/m.exec(content);
  if (asCommandMatch) return asCommandMatch[1];

  // Try protected static $defaultName = '...';
  const defaultNameMatch = /protected\s+static\s+\$defaultName\s*=\s*['"]([^'"]+)['"]/m.exec(content);
  if (defaultNameMatch) return defaultNameMatch[1];

  // Try ->setName('...')
  const setNameMatch = /->setName\(\s*['"]([^'"]+)['"]\s*\)/m.exec(content);
  if (setNameMatch) return setNameMatch[1];

  return '';
}

function scanCommands(appPath: string): CommandInfo[] {
  const resolvedBase = path.resolve(appPath);
  const srcDir = path.join(resolvedBase, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: CommandInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    if (!path.resolve(file).startsWith(resolvedBase + path.sep)) continue;

    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isCommand = content.includes('extends Command') ||
                      content.includes('CommandInterface') ||
                      content.includes('#[AsCommand') ||
                      content.includes('protected static $defaultName');

    if (!isCommand) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    if (!classMatch) continue;
    const className = classMatch[1];

    const name = extractCommandName(content);
    const isHidden = content.includes('->setHidden(true)') ||
                     /setHidden\s*\(\s*true\s*\)/.test(content) ||
                     /#\[AsCommand[^]]*hidden\s*:\s*true/.test(content);
    const aliases = extractAliases(content);

    // Description detection
    const descMatch = /->setDescription\(\s*['"]([^'"]*)['"]\s*\)/m.exec(content) ??
                      /#\[AsCommand[^,)]*,\s*['"]([^'"]*)['"]/m.exec(content);
    const description = descMatch ? descMatch[1] : '';
    const hasDescription = description.length > 0;

    const hasAsCommandAttr = content.includes('#[AsCommand');
    const hasDefaultName = /protected\s+static\s+\$defaultName/.test(content);
    const hasServiceTag = content.includes('console.command') || content.includes('@console.command');

    const issues: string[] = [];

    if (!hasDescription) {
      issues.push('Command has no description — add ->setDescription() or description parameter in #[AsCommand]');
    }

    if (hasAsCommandAttr && hasDefaultName) {
      issues.push('#[AsCommand] attribute present alongside protected static $defaultName — remove $defaultName to avoid conflicts');
    }

    results.push({
      file: path.relative(appPath, file),
      className,
      name,
      isHidden,
      aliases,
      hasDescription,
      description,
      hasAsCommandAttr,
      hasDefaultName,
      hasServiceTag,
      issues,
    });
  }

  return results;
}

function detectDuplicateNames(commands: CommandInfo[]): string[] {
  const nameCounts = new Map<string, string[]>();
  for (const cmd of commands) {
    if (!cmd.name) continue;
    const existing = nameCounts.get(cmd.name) ?? [];
    existing.push(cmd.className);
    nameCounts.set(cmd.name, existing);
  }
  const duplicates: string[] = [];
  for (const [name, classes] of nameCounts.entries()) {
    if (classes.length > 1) {
      duplicates.push(`"${name}" registered by: ${classes.join(', ')}`);
    }
  }
  return duplicates;
}

function checkContainerCommandLoader(appPath: string, commands: CommandInfo[]): string[] {
  const resolvedBase = path.resolve(appPath);
  const servicesYaml = path.join(resolvedBase, 'config', 'services.yaml');
  const issues: string[] = [];

  let servicesContent = '';
  try { servicesContent = fs.readFileSync(servicesYaml, 'utf-8'); } catch { /* skip */ }

  const usesLoader = servicesContent.includes('ContainerCommandLoader') ||
                     servicesContent.includes('console.command_loader');

  if (usesLoader) {
    // Check that each command class has the tag
    for (const cmd of commands) {
      if (!cmd.hasServiceTag && !cmd.hasAsCommandAttr) {
        issues.push(`Command "${cmd.className}" not tagged with "console.command" and no #[AsCommand] — may not be loaded by ContainerCommandLoader`);
      }
    }
  }

  return issues;
}

function buildAnalysis(appPath: string): { commands: CommandInfo[]; duplicates: string[]; loaderIssues: string[] } {
  const commands = scanCommands(appPath);
  const duplicates = detectDuplicateNames(commands);
  const loaderIssues = checkContainerCommandLoader(appPath, commands);
  return { commands, duplicates, loaderIssues };
}

export function listSymfonyConsoleHiddenCommands(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { commands, duplicates, loaderIssues } = buildAnalysis(appPath);

    if (commands.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony console command classes found in src/.\n\nCommands extend Symfony\\Component\\Console\\Command\\Command or use #[AsCommand].',
        }],
      };
    }

    let text = `Symfony Console Command Audit\n${'='.repeat(55)}\n\n`;

    const hiddenCmds = commands.filter((c) => c.isHidden);
    if (hiddenCmds.length > 0) {
      text += `Hidden commands (${hiddenCmds.length}) — not shown in "bin/console list" but still executable:\n`;
      for (const cmd of hiddenCmds) {
        text += `  ${cmd.name || '(no name)'}  [${cmd.className}]  ${cmd.file}\n`;
      }
      text += '\n';
    }

    const withAliases = commands.filter((c) => c.aliases.length > 0);
    if (withAliases.length > 0) {
      text += `Commands with aliases (${withAliases.length}):\n`;
      for (const cmd of withAliases) {
        text += `  ${cmd.name}  aliases: [${cmd.aliases.join(', ')}]\n`;
      }
      text += '\n';
    }

    if (duplicates.length > 0) {
      text += `Duplicate command names (${duplicates.length}):\n`;
      for (const dup of duplicates) {
        text += `  - ${dup}\n`;
      }
      text += '\n';
    }

    const withIssues = commands.filter((c) => c.issues.length > 0);
    if (withIssues.length > 0) {
      text += `Commands with issues (${withIssues.length}):\n`;
      for (const cmd of withIssues) {
        text += `  ${cmd.className} (${cmd.name || 'no name'}):\n`;
        for (const issue of cmd.issues) {
          text += `    - ${issue}\n`;
        }
      }
      text += '\n';
    }

    if (loaderIssues.length > 0) {
      text += `ContainerCommandLoader issues (${loaderIssues.length}):\n`;
      for (const issue of loaderIssues) {
        text += `  - ${issue}\n`;
      }
      text += '\n';
    }

    if (hiddenCmds.length === 0 && withAliases.length === 0 && withIssues.length === 0 && duplicates.length === 0) {
      text += `All ${commands.length} command(s) look healthy.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyConsoleHiddenCommandsStats(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { commands, duplicates, loaderIssues } = buildAnalysis(appPath);

    let text = `Symfony Console Hidden Commands Stats\n${'='.repeat(40)}\n\n`;
    text += `Total commands:           ${commands.length}\n`;
    text += `Hidden commands:          ${commands.filter((c) => c.isHidden).length}\n`;
    text += `Commands with aliases:    ${commands.filter((c) => c.aliases.length > 0).length}\n`;
    text += `Without description:      ${commands.filter((c) => !c.hasDescription).length}\n`;
    text += `Using #[AsCommand]:       ${commands.filter((c) => c.hasAsCommandAttr).length}\n`;
    text += `Using $defaultName:       ${commands.filter((c) => c.hasDefaultName).length}\n`;
    text += `Attribute+property clash: ${commands.filter((c) => c.hasAsCommandAttr && c.hasDefaultName).length}\n`;
    text += `Duplicate names:          ${duplicates.length}\n`;
    text += `Loader issues:            ${loaderIssues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyConsoleHiddenCommandsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_console_hidden_commands',
      description: 'Audit Symfony console commands: hidden commands (setHidden(true)), aliases list, duplicate command names, ContainerCommandLoader tag issues, #[AsCommand] vs $defaultName conflicts, commands without description',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_console_hidden_commands_stats',
      description: 'Statistics for Symfony console commands: total, hidden, aliased, without description, attribute/property conflicts, duplicate names',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
