/**
 * Symfony Console Command Inspector
 *
 * Scans src/Command/ for classes extending Command or using #[AsCommand] attribute.
 * Extracts: command name, description, arguments, options, aliases.
 *
 * No PHP execution — pure static analysis of PHP source files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CommandArgument {
  name: string;
  mode: 'required' | 'optional' | 'array';
  description: string;
  default?: string;
}

interface CommandOption {
  name: string;
  shortcut?: string;
  mode: 'none' | 'required' | 'optional' | 'array';
  description: string;
  default?: string;
}

interface ConsoleCommand {
  name: string;
  description: string;
  aliases: string[];
  class: string;
  file: string;
  namespace: string;
  hidden: boolean;
  arguments: CommandArgument[];
  options: CommandOption[];
}

// ─── PHP parsing ───────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch {
    // Skip
  }
  return files;
}

function extractClassName(content: string): string {
  const m = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  return m ? m[1] : '';
}

function extractNamespace(content: string): string {
  const m = /^namespace\s+([\w\\]+)\s*;/m.exec(content);
  return m ? m[1] : '';
}

function parseCommandFile(content: string, filePath: string): ConsoleCommand | null {
  const isCommand =
    /extends\s+Command/.test(content) ||
    /extends\s+ContainerAwareCommand/.test(content) ||
    /#\[AsCommand/.test(content);

  if (!isCommand) return null;

  const className = extractClassName(content);
  if (!className) return null;

  const namespace = extractNamespace(content);

  // Extract name from #[AsCommand(name: 'app:do-thing')]
  let name = '';
  let description = '';
  let hidden = false;
  const aliases: string[] = [];

  const asCommandMatch = /#\[AsCommand\(([^)]+)\)\]/.exec(content);
  if (asCommandMatch) {
    const args = asCommandMatch[1];
    const nameMatch = /(?:name\s*:\s*|^)\s*['"]([^'"]+)['"]/.exec(args);
    const descMatch = /description\s*:\s*['"]([^'"]+)['"]/.exec(args);
    const hiddenMatch = /hidden\s*:\s*(true|false)/.exec(args);
    const aliasMatch = /aliases\s*:\s*\[([^\]]+)\]/.exec(args);
    if (nameMatch) name = nameMatch[1];
    if (descMatch) description = descMatch[1];
    if (hiddenMatch) hidden = hiddenMatch[1] === 'true';
    if (aliasMatch) {
      aliases.push(
        ...aliasMatch[1].split(',').map((a) => a.trim().replace(/['"]/g, '')).filter(Boolean)
      );
    }
  }

  // Fallback: static $defaultName
  if (!name) {
    const defaultNameMatch = /static\s+\$defaultName\s*=\s*['"]([^'"]+)['"]/.exec(content);
    if (defaultNameMatch) name = defaultNameMatch[1];
  }

  // Fallback: $this->setName('app:foo') in configure()
  if (!name) {
    const setNameMatch = /\$this->setName\(\s*['"]([^'"]+)['"]\s*\)/.exec(content);
    if (setNameMatch) name = setNameMatch[1];
  }

  if (!name) return null; // Skip abstract / base classes

  // Extract description from configure() or static $defaultDescription
  if (!description) {
    const defaultDescMatch = /static\s+\$defaultDescription\s*=\s*['"]([^'"]+)['"]/.exec(content);
    if (defaultDescMatch) description = defaultDescMatch[1];
  }
  if (!description) {
    const setDescMatch = /\$this->setDescription\(\s*['"]([^'"]+)['"]\s*\)/.exec(content);
    if (setDescMatch) description = setDescMatch[1];
  }

  const commandArguments = parseArguments(content);
  const commandOptions = parseOptions(content);

  return {
    name,
    description,
    aliases,
    class: namespace ? `${namespace}\\${className}` : className,
    file: path.basename(filePath),
    namespace: namespace,
    hidden,
    arguments: commandArguments,
    options: commandOptions,
  };
}

function parseArguments(content: string): CommandArgument[] {
  const args: CommandArgument[] = [];
  // ->addArgument('name', InputArgument::REQUIRED, 'description', 'default')
  const pattern = /->addArgument\(\s*['"](\w+)['"]\s*(?:,\s*(InputArgument::\w+|\d+))?\s*(?:,\s*['"]([^'"]*)['"])?\s*(?:,\s*['"]([^'"]*)['"])?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    const modeStr = m[2] ?? 'InputArgument::OPTIONAL';
    let mode: CommandArgument['mode'] = 'optional';
    if (modeStr.includes('REQUIRED')) mode = 'required';
    else if (modeStr.includes('IS_ARRAY')) mode = 'array';
    args.push({
      name: m[1],
      mode,
      description: m[3] ?? '',
      default: m[4],
    });
  }
  return args;
}

function parseOptions(content: string): CommandOption[] {
  const opts: CommandOption[] = [];
  // ->addOption('name', 'n', InputOption::VALUE_REQUIRED, 'description', 'default')
  const pattern = /->addOption\(\s*['"](\w+)['"]\s*(?:,\s*(?:null|['"](\w+)['"]))?\s*(?:,\s*(InputOption::\w+|\d+))?\s*(?:,\s*['"]([^'"]*)['"])?\s*(?:,\s*['"]([^'"]*)['"])?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    const modeStr = m[3] ?? 'InputOption::VALUE_NONE';
    let mode: CommandOption['mode'] = 'none';
    if (modeStr.includes('VALUE_REQUIRED')) mode = 'required';
    else if (modeStr.includes('VALUE_OPTIONAL')) mode = 'optional';
    else if (modeStr.includes('VALUE_IS_ARRAY')) mode = 'array';
    opts.push({
      name: m[1],
      shortcut: m[2],
      mode,
      description: m[4] ?? '',
      default: m[5],
    });
  }
  return opts;
}

function loadCommands(appPath: string): ConsoleCommand[] {
  const commandDir = path.join(appPath, 'src', 'Command');
  if (!fs.existsSync(commandDir)) return [];

  const commands: ConsoleCommand[] = [];
  for (const file of getAllPhpFiles(commandDir)) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.length > 500_000) continue;
      const cmd = parseCommandFile(content, file);
      if (cmd) commands.push(cmd);
    } catch {
      // Skip
    }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listCommands(appPath: string): McpToolResult {
  try {
    const commands = loadCommands(appPath);

    if (commands.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No console commands found in src/Command/.\n\nCreate with: php bin/console make:command',
        }],
      };
    }

    // Group by namespace prefix (app:user:*, app:order:*, etc.)
    const groups: Record<string, ConsoleCommand[]> = {};
    for (const cmd of commands) {
      const prefix = cmd.name.includes(':') ? cmd.name.split(':')[0] : '(global)';
      (groups[prefix] ??= []).push(cmd);
    }

    let text = `Console Commands (${commands.length}):\n${'─'.repeat(60)}\n`;

    for (const [prefix, cmds] of Object.entries(groups).sort()) {
      text += `\n  ${prefix}\n`;
      for (const cmd of cmds) {
        const hidden = cmd.hidden ? '  [hidden]' : '';
        text += `    ${cmd.name.padEnd(40)} ${cmd.description}${hidden}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error listing commands: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCommandDetails(appPath: string, commandName: string): McpToolResult {
  try {
    const commands = loadCommands(appPath);
    const cmd = commands.find(
      (c) => c.name === commandName ||
        c.name.toLowerCase().includes(commandName.toLowerCase()) ||
        c.aliases.includes(commandName)
    );

    if (!cmd) {
      const names = commands.map((c) => c.name).join(', ');
      return {
        content: [{ type: 'text', text: `Command "${commandName}" not found.\n\nAvailable: ${names || 'none'}` }],
        isError: true,
      };
    }

    let text = `Command: ${cmd.name}\n${'='.repeat(50)}\n\n`;
    text += `Description: ${cmd.description || '(none)'}\n`;
    text += `Class:       ${cmd.class}\n`;
    text += `File:        ${cmd.file}\n`;
    if (cmd.hidden) text += `Hidden:      yes\n`;
    if (cmd.aliases.length > 0) text += `Aliases:     ${cmd.aliases.join(', ')}\n`;

    if (cmd.arguments.length > 0) {
      text += `\nArguments:\n`;
      for (const arg of cmd.arguments) {
        text += `  <${arg.name}>  [${arg.mode}]`;
        if (arg.description) text += `  — ${arg.description}`;
        if (arg.default !== undefined) text += `  (default: ${arg.default})`;
        text += '\n';
      }
    }

    if (cmd.options.length > 0) {
      text += `\nOptions:\n`;
      for (const opt of cmd.options) {
        const shortcut = opt.shortcut ? `-${opt.shortcut}, ` : '    ';
        text += `  ${shortcut}--${opt.name}`;
        if (opt.mode !== 'none') text += `[=${opt.mode.toUpperCase()}]`;
        if (opt.description) text += `  — ${opt.description}`;
        if (opt.default !== undefined) text += `  (default: ${opt.default})`;
        text += '\n';
      }
    }

    text += `\nUsage:\n  php bin/console ${cmd.name}`;
    for (const arg of cmd.arguments) {
      text += arg.mode === 'required' ? ` <${arg.name}>` : ` [<${arg.name}>]`;
    }
    text += '\n';

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function searchCommands(appPath: string, query: string): McpToolResult {
  try {
    const commands = loadCommands(appPath);
    const lq = query.toLowerCase();
    const matches = commands.filter(
      (c) => c.name.toLowerCase().includes(lq) ||
        c.description.toLowerCase().includes(lq) ||
        c.class.toLowerCase().includes(lq) ||
        c.aliases.some((a) => a.toLowerCase().includes(lq))
    );

    if (matches.length === 0) {
      return { content: [{ type: 'text', text: `No commands matching "${query}" found.` }] };
    }

    let text = `Commands matching "${query}" (${matches.length}):\n\n`;
    for (const cmd of matches) {
      text += `  ${cmd.name.padEnd(40)} ${cmd.description}\n`;
      if (cmd.aliases.length > 0) text += `    Aliases: ${cmd.aliases.join(', ')}\n`;
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

export function getCommandTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_commands',
      description: 'List all Symfony console commands from src/Command/ grouped by namespace prefix, with name and description',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_command_details',
      description: 'Get full details for a console command: description, class, arguments, options, and usage example',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          command_name: { type: 'string', description: 'Command name (e.g. app:send-email) or partial match' },
        },
        required: ['app_path', 'command_name'],
      },
    },
    {
      name: 'search_commands',
      description: 'Search console commands by name, description, class, or alias',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          query: { type: 'string', description: 'Search query' },
        },
        required: ['app_path', 'query'],
      },
    },
  ];
}
