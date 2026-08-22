/**
 * DI Compiler Pass Inspector
 *
 * Scans src/ for classes implementing CompilerPassInterface:
 *   - Class name, file, detected pass type (BEFORE_OPTIMIZATION, etc.)
 *   - Priority (from addCompilerPass() calls in Extension or Kernel)
 *   - Extension classes that register passes in load() / process()
 *
 * Also reads src/Kernel.php (or src/*Kernel.php) for
 * ->addCompilerPass() calls to capture priority and type.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


type PassType =
  | 'BEFORE_OPTIMIZATION'
  | 'OPTIMIZE'
  | 'BEFORE_REMOVING'
  | 'REMOVING'
  | 'AFTER_REMOVING'
  | 'unknown';

interface CompilerPass {
  class: string;
  file: string;
  passType: PassType;
  priority: number;
  registeredIn?: string;
}

interface BundleExtension {
  class: string;
  file: string;
  registeredPasses: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── Pass type detection ────────────────────────────────────────────────────

const PASS_TYPE_PATTERNS: Array<{ pattern: RegExp; type: PassType }> = [
  { pattern: /BEFORE_OPTIMIZATION/,  type: 'BEFORE_OPTIMIZATION' },
  { pattern: /PassConfig::OPTIMIZE/,  type: 'OPTIMIZE' },
  { pattern: /BEFORE_REMOVING/,       type: 'BEFORE_REMOVING' },
  { pattern: /PassConfig::REMOVING/,  type: 'REMOVING' },
  { pattern: /AFTER_REMOVING/,        type: 'AFTER_REMOVING' },
];

function detectPassType(content: string): PassType {
  for (const { pattern, type } of PASS_TYPE_PATTERNS) {
    if (pattern.test(content)) return type;
  }
  return 'unknown';
}

function detectPriority(content: string, className: string): number {
  // Look for addCompilerPass(new ClassName(), PassConfig::X, PRIORITY)
  const re = new RegExp(`addCompilerPass\\s*\\(\\s*new\\s+${className}[^,)]*(?:,[^,)]*,\\s*(-?\\d+))?`);
  const m = re.exec(content);
  return m?.[1] ? parseInt(m[1], 10) : 0;
}

// ─── Scanning ───────────────────────────────────────────────────────────────

function scanCompilerPasses(appPath: string): CompilerPass[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  // First pass: find all compiler pass classes
  const passFiles = new Map<string, string>(); // className → content
  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (content.length > 500_000) continue;

    if (!content.includes('CompilerPassInterface') || !content.includes('implements')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    passFiles.set(classM[1], content);
  }

  // Second pass: find registrations in Kernel / Extension files
  const registrationMap = new Map<string, { registeredIn: string; priority: number; passType: PassType }>();

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (content.length > 500_000) continue;

    if (!content.includes('addCompilerPass')) continue;

    const registrarM = /class\s+(\w+)/.exec(content);
    if (!registrarM) continue;

    for (const [passClass] of passFiles) {
      if (!content.includes(passClass)) continue;
      const priority = detectPriority(content, passClass);
      const passType = detectPassType(content);
      registrationMap.set(passClass, {
        registeredIn: registrarM[1],
        priority,
        passType,
      });
    }
  }

  // Build results
  const passes: CompilerPass[] = [];
  for (const [className, content] of passFiles) {
    const reg = registrationMap.get(className);
    passes.push({
      class: className,
      file: ((): string => {
        for (const file of getAllPhpFiles(srcDir)) {
          try {
            const c = fs.readFileSync(file, 'utf-8');
            if (c.includes(`class ${className}`)) return path.basename(file);
          } catch { /* skip */ }
        }
        return `${className}.php`;
      })(),
      passType: reg?.passType ?? detectPassType(content),
      priority: reg?.priority ?? 0,
      registeredIn: reg?.registeredIn,
    });
  }

  return passes.sort((a, b) => b.priority - a.priority || a.class.localeCompare(b.class));
}

function scanBundleExtensions(appPath: string): BundleExtension[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const extensions: BundleExtension[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (content.length > 500_000) continue;

    if (!content.includes('Extension') || !content.includes('addCompilerPass')) continue;
    if (!content.includes('extends Extension') && !content.includes('extends AbstractExtension')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const passes: string[] = [];
    for (const m of content.matchAll(/addCompilerPass\s*\(\s*new\s+(\w+)/g)) {
      passes.push(m[1]);
    }

    if (passes.length > 0) {
      extensions.push({
        class: classM[1],
        file: path.basename(file),
        registeredPasses: passes,
      });
    }
  }

  return extensions;
}

// ─── Tool functions ────────────────────────────────────────────────────────

const PASS_TYPE_DESCRIPTIONS: Record<PassType, string> = {
  BEFORE_OPTIMIZATION: 'Runs before container optimization',
  OPTIMIZE:            'Runs during optimization phase',
  BEFORE_REMOVING:     'Runs before unused services are removed',
  REMOVING:            'Runs during service removal phase',
  AFTER_REMOVING:      'Runs after unused services are removed',
  unknown:             'Type not specified (defaults to BEFORE_OPTIMIZATION)',
};

export function listCompilerPasses(appPath: string): McpToolResult {
  try {
    const passes = scanCompilerPasses(appPath);
    const extensions = scanBundleExtensions(appPath);

    if (passes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom DI Compiler Passes found.\n\nCreate:\n  class MyCompilerPass implements CompilerPassInterface {\n    public function process(ContainerBuilder $container): void {\n      // modify container\n    }\n  }\n\nRegister in Kernel::build():\n  $container->addCompilerPass(new MyCompilerPass());',
        }],
      };
    }

    let text = `DI Compiler Passes (${passes.length})\n${'='.repeat(55)}\n`;

    const byType = new Map<PassType, CompilerPass[]>();
    for (const p of passes) {
      const list = byType.get(p.passType) ?? [];
      list.push(p);
      byType.set(p.passType, list);
    }

    const typeOrder: PassType[] = ['BEFORE_OPTIMIZATION', 'OPTIMIZE', 'BEFORE_REMOVING', 'REMOVING', 'AFTER_REMOVING', 'unknown'];
    for (const type of typeOrder) {
      const group = byType.get(type);
      if (!group) continue;
      text += `\n${type}  — ${PASS_TYPE_DESCRIPTIONS[type]}\n`;
      for (const p of group) {
        const reg = p.registeredIn ? `  registered in: ${p.registeredIn}` : '';
        const prio = p.priority !== 0 ? `  priority: ${p.priority}` : '';
        text += `  ${p.class.padEnd(40)} (${p.file})${prio}${reg}\n`;
      }
    }

    if (extensions.length > 0) {
      text += `\nBundle Extensions registering passes:\n`;
      for (const e of extensions) {
        text += `  ${e.class}  →  ${e.registeredPasses.join(', ')}\n`;
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

export function getCompilerPassStats(appPath: string): McpToolResult {
  try {
    const passes = scanCompilerPasses(appPath);
    const extensions = scanBundleExtensions(appPath);

    let text = `Compiler Pass Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total passes:     ${passes.length}\n`;
    text += `With priority:    ${passes.filter((p) => p.priority !== 0).length}\n`;
    text += `Bundle extensions registering passes: ${extensions.length}\n`;

    const byType: Partial<Record<PassType, number>> = {};
    for (const p of passes) byType[p.passType] = (byType[p.passType] ?? 0) + 1;

    if (Object.keys(byType).length > 0) {
      text += `\nBy phase:\n`;
      for (const [type, count] of Object.entries(byType)) {
        text += `  ${type.padEnd(25)} ${count}\n`;
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

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getCompilerPassTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_compiler_passes',
      description: 'List custom DI Compiler Passes (CompilerPassInterface) grouped by phase (BEFORE_OPTIMIZATION/REMOVING/etc.), with priority and registration class',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_compiler_pass_stats',
      description: 'Show compiler pass statistics: total count, passes by phase, passes with explicit priority, bundle extensions registering passes',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
