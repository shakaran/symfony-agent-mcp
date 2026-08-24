// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony MakerBundle Custom Makers Inspector
 *
 * Distinct from maker-bundle.ts (standard MakerBundle usage / make:* commands).
 * Focuses on custom makers (MakerInterface implementations):
 *
 * Custom Maker class:
 *   - Implements MakerInterface (or extends AbstractMaker)
 *   - getCommandName(): string — e.g. 'make:domain-event'
 *   - configure(Command $command): void — argument/option definitions
 *   - generate(InputInterface $input, ConsoleStyle $io, Generator $generator): void
 *
 * Template files:
 *   - Located in src/Maker/skeleton/ or resources/skeleton/
 *   - .tpl.php files referenced in generate() via $generator->generateClass()
 *   - $generator->generateFile() for non-class files
 *
 * Registration:
 *   - Auto-discovered if tagged with maker.command (autoconfigure)
 *   - Or tagged manually in services.yaml
 *
 * Analysis:
 *   - Maker that doesn't extend AbstractMaker (misses helper methods)
 *   - Missing getCommandName() method
 *   - generate() body referencing a skeleton file that doesn't exist
 *   - No configure() method (no argument validation — user gets no help)
 *   - Maker named without 'make:' prefix (by convention all start with 'make:')
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CustomMaker {
  class: string;
  file: string;
  commandName?: string;
  extendsAbstractMaker: boolean;
  hasConfigure: boolean;
  hasGenerate: boolean;
  skeletonFiles: string[];
  missingSkeletons: string[];
  issues: string[];
}

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

function findSkeletonDirs(appPath: string): string[] {
  return [
    path.join(appPath, 'src', 'Maker', 'skeleton'),
    path.join(appPath, 'src', 'Maker', 'templates'),
    path.join(appPath, 'resources', 'skeleton'),
    path.join(appPath, 'templates', 'maker'),
  ].filter((d) => fs.existsSync(d));
}

function getSkeletonFiles(dirs: string[]): Set<string> {
  const files = new Set<string>();
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.tpl.php') || f.endsWith('.php.tpl')) files.add(f);
      }
    } catch { /* skip */ }
  }
  return files;
}

function parseMaker(filePath: string, appPath: string, skeletonFiles: Set<string>): CustomMaker | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasMakerInterface = content.includes('MakerInterface') || content.includes('AbstractMaker');
  if (!hasMakerInterface) return null;
  if (content.includes('namespace Symfony\\Bundle\\MakerBundle')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const extendsAbstractMaker = content.includes('extends AbstractMaker');
  const hasConfigure         = content.includes('function configure(');
  const hasGenerate          = content.includes('function generate(');

  const commandNameM = /getCommandName[^{]*\{[^}]*return\s+['"]([^'"]+)['"]/.exec(content);
  const commandName  = commandNameM?.[1];

  // Extract skeleton file references
  const referencedSkeletons: string[] = [];
  for (const m of content.matchAll(/['"]([^'"]+\.tpl\.php|[^'"]+\.php\.tpl)['"]/g)) {
    referencedSkeletons.push(path.basename(m[1]));
  }

  const missingSkeletons = referencedSkeletons.filter((f) => !skeletonFiles.has(f));

  const issues: string[] = [];
  if (!extendsAbstractMaker) {
    issues.push('Maker does not extend AbstractMaker — misses helper methods (addArgument, addOption, etc.)');
  }
  if (!commandName) {
    issues.push('getCommandName() not found — maker cannot be registered');
  } else if (!commandName.startsWith('make:')) {
    issues.push(`Command name "${commandName}" should start with "make:" by convention`);
  }
  if (!hasConfigure) {
    issues.push('No configure() method — users get no argument/option validation or help text');
  }
  for (const f of missingSkeletons) {
    issues.push(`Skeleton template "${f}" referenced in generate() but not found in skeleton directories`);
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    commandName,
    extendsAbstractMaker,
    hasConfigure,
    hasGenerate,
    skeletonFiles: referencedSkeletons,
    missingSkeletons,
    issues,
  };
}

export function listCustomMakers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const skeletonDirs  = findSkeletonDirs(appPath);
    const skeletonFiles = getSkeletonFiles(skeletonDirs);
    const makers: CustomMaker[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const m = parseMaker(file, appPath, skeletonFiles);
      if (m) makers.push(m);
    }

    if (makers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom MakerBundle makers found in src/.\n\nCreate a custom maker:\n  class MakeDomainEvent extends AbstractMaker\n  {\n    public static function getCommandName(): string { return \'make:domain-event\'; }\n    public function generate(InputInterface $input, ConsoleStyle $io, Generator $generator): void { ... }\n  }',
        }],
      };
    }

    const totalIssues = makers.reduce((s, m) => s + m.issues.length, 0);

    let text = `Custom MakerBundle Makers\n${'='.repeat(55)}\n`;
    text += `\nMakers: ${makers.length}  Issues: ${totalIssues}\n`;
    if (skeletonDirs.length > 0) {
      text += `Skeleton dirs: ${skeletonDirs.map((d) => path.relative(appPath, d)).join(', ')}\n`;
    }

    for (const m of makers.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
      const ext = m.extendsAbstractMaker ? '✓ AbstractMaker' : '⚠ raw interface';
      const cfg = m.hasConfigure ? '✓ configure' : '⚠ no configure';
      text += `\n  ${m.class}  command: ${m.commandName ?? '?'}  ${ext}  ${cfg}  (${m.file})\n`;
      for (const issue of m.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMakerCommandStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const skeletonFiles = getSkeletonFiles(findSkeletonDirs(appPath));
    const makers: CustomMaker[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const m = parseMaker(file, appPath, skeletonFiles);
        if (m) makers.push(m);
      }
    }

    let text = `Custom Maker Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom makers:           ${makers.length}\n`;
    text += `  Extends AbstractMaker: ${makers.filter((m) => m.extendsAbstractMaker).length}\n`;
    text += `  With configure():      ${makers.filter((m) => m.hasConfigure).length}\n`;
    text += `  With skeleton files:   ${makers.filter((m) => m.skeletonFiles.length > 0).length}\n`;
    text += `  Missing skeletons:     ${makers.filter((m) => m.missingSkeletons.length > 0).length}\n`;
    text += `Issues:                  ${makers.reduce((s, m) => s + m.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCustomMakerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_custom_makers',
      description: 'Show custom MakerBundle makers: MakerInterface/AbstractMaker subclasses, getCommandName(), configure(), generate(), skeleton file references, missing skeleton warning, no-make:-prefix warning, raw-interface vs AbstractMaker detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_maker_command_stats',
      description: 'Show custom maker statistics: maker count, AbstractMaker extension count, configure() count, skeleton usage count, missing skeleton count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
