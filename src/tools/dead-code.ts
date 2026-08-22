/**
 * Symfony Dead Code Detector
 *
 * Detects potentially unused code through static cross-reference analysis:
 *
 *   1. Orphan controllers — controller classes whose actions have no matching
 *      route defined in YAML/attributes.
 *
 *   2. Uninjected services — services defined in services.yaml that are never
 *      referenced in any other service's constructor or factory.
 *
 *   3. Unused form types — AbstractType subclasses never instantiated in
 *      controllers or other form types.
 *
 *   4. Unused commands — Command subclasses in src/Command/ not referenced
 *      anywhere outside their own file.
 *
 * All detections are HEURISTIC — false positives are possible for services
 * injected via tags, dynamic form creation, or string-based service locators.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseRoutes } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


// ─── File utilities ────────────────────────────────────────────────────────

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

function readSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function extractClassName(content: string): string {
  const m = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  return m ? m[1] : '';
}

function extractNamespace(content: string): string {
  const m = /^namespace\s+([\w\\]+)\s*;/m.exec(content);
  return m ? m[1] : '';
}

function fqn(content: string): string {
  const ns = extractNamespace(content);
  const cl = extractClassName(content);
  if (!cl) return '';
  return ns ? `${ns}\\${cl}` : cl;
}

// ─── 1. Orphan controllers ─────────────────────────────────────────────────

interface OrphanController {
  class: string;
  file: string;
  actions: string[];
  reason: string;
}

function detectOrphanControllers(appPath: string): OrphanController[] {
  const controllerDir = path.join(appPath, 'src', 'Controller');
  if (!fs.existsSync(controllerDir)) return [];

  const routes = parseRoutes(appPath);
  const routedControllers = new Set(
    routes
      .filter((r) => r.controller)
      .map((r) => {
        // controller can be "App\Controller\FooController::barAction" or "App\Controller\FooController"
        const parts = (r.controller ?? '').split('::');
        return parts[0].replace(/\\\\/g, '\\');
      })
  );

  const orphans: OrphanController[] = [];

  for (const file of getAllPhpFiles(controllerDir)) {
    const content = readSafe(file);
    if (!content.includes('Controller')) continue;
    if (/^\s*abstract\s+class/m.test(content)) continue;

    const fullClass = fqn(content);
    if (!fullClass) continue;

    // Check if any route references this controller
    const isRouted =
      routedControllers.has(fullClass) ||
      // Also check short class name references
      Array.from(routedControllers).some((rc) => rc.endsWith('\\' + extractClassName(content)));

    if (!isRouted) {
      // Extract public action methods
      const actions: string[] = [];
      for (const m of content.matchAll(/public\s+function\s+(\w+)\s*\(/g)) {
        if (!['__construct', '__invoke'].includes(m[1])) actions.push(m[1]);
      }

      orphans.push({
        class: fullClass,
        file: path.basename(file),
        actions,
        reason: 'No route references this controller',
      });
    }
  }

  return orphans;
}

// ─── 2. Uninjected services ────────────────────────────────────────────────

interface UninjectedService {
  id: string;
  class: string;
  reason: string;
}

function detectUninjectedServices(appPath: string): UninjectedService[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  // Build a set of all class names referenced in constructor parameters
  const referencedClasses = new Set<string>();
  const referencedStrings = new Set<string>();

  for (const file of getAllPhpFiles(srcDir)) {
    const content = readSafe(file);

    // Constructor injection: function __construct(FooService $foo, ...)
    for (const m of content.matchAll(/function\s+__construct\s*\(([^)]+)\)/g)) {
      const params = m[1];
      for (const pm of params.matchAll(/(\w+)\s+\$/g)) {
        referencedClasses.add(pm[1]);
      }
    }

    // String-based service locator: $locator->get('App\Service\FooService')
    for (const m of content.matchAll(/->get\(\s*['"]([^'"]+)['"]/g)) {
      referencedStrings.add(m[1]);
    }

    // Factory / make calls
    for (const m of content.matchAll(/new\s+([\w\\]+)\s*\(/g)) {
      referencedClasses.add(m[1].split('\\').pop() ?? '');
    }
  }

  // Also check services.yaml for explicit injections
  const servicesYaml = path.join(appPath, 'config', 'services.yaml');
  const yamlContent = readSafe(servicesYaml);
  for (const m of yamlContent.matchAll(/@([\w.]+)/g)) {
    referencedStrings.add(m[1]);
  }

  // Parse service definitions
  const uninjected: UninjectedService[] = [];
  const serviceFiles = getAllPhpFiles(srcDir).filter(
    (f) => !f.includes('/Controller/') && !f.includes('/Command/') &&
            !f.includes('/Entity/') && !f.includes('/Repository/')
  );

  for (const file of serviceFiles) {
    const content = readSafe(file);
    if (!content.includes('class ')) continue;
    if (/^\s*(?:abstract|interface|trait)\s/m.test(content)) continue;

    const className = extractClassName(content);
    const fullClass = fqn(content);
    if (!className || !fullClass) continue;

    const shortName = className;
    const isReferenced =
      referencedClasses.has(shortName) ||
      referencedStrings.has(fullClass) ||
      referencedStrings.has(shortName);

    if (!isReferenced) {
      uninjected.push({
        id: fullClass,
        class: className,
        reason: 'Not found in any constructor or service locator reference',
      });
    }
  }

  // Filter to plausible services (exclude value objects, events, etc.)
  return uninjected.filter((s) =>
    /Service|Handler|Manager|Processor|Resolver|Factory|Builder|Provider|Subscriber|Listener/.test(s.class)
  );
}

// ─── 3. Unused form types ──────────────────────────────────────────────────

interface UnusedFormType {
  class: string;
  file: string;
  reason: string;
}

function detectUnusedFormTypes(appPath: string): UnusedFormType[] {
  const formDir = path.join(appPath, 'src', 'Form');
  if (!fs.existsSync(formDir)) return [];

  const srcDir = path.join(appPath, 'src');

  // Collect all PHP content outside the Form directory
  const allNonFormContent: string[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    if (file.startsWith(formDir)) continue;
    allNonFormContent.push(readSafe(file));
  }

  // Also check Twig templates for form_start($form) usage
  const templateDir = path.join(appPath, 'templates');
  if (fs.existsSync(templateDir)) {
    for (const entry of fs.readdirSync(templateDir, { recursive: true, withFileTypes: true }) as fs.Dirent[]) {
      if (!entry.isFile()) continue;
      const full = path.join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name);
      if (full.endsWith('.twig')) allNonFormContent.push(readSafe(full));
    }
  }

  const combinedContent = allNonFormContent.join('\n');
  const unused: UnusedFormType[] = [];

  for (const file of getAllPhpFiles(formDir)) {
    const content = readSafe(file);
    if (!/extends\s+AbstractType/.test(content)) continue;

    const className = extractClassName(content);
    if (!className) continue;

    // Check if this form type class is referenced anywhere outside Form/
    const isUsed =
      combinedContent.includes(className) ||
      // Also check within other form types (createForm, add with type)
      combinedContent.includes(`${className}::class`);

    if (!isUsed) {
      unused.push({
        class: className,
        file: path.basename(file),
        reason: 'Not referenced in any controller, service, or other form type',
      });
    }
  }

  return unused;
}

// ─── 4. Unused commands ────────────────────────────────────────────────────

interface UnusedCommand {
  name: string;
  class: string;
  file: string;
  reason: string;
}

function detectUnusedCommands(appPath: string): UnusedCommand[] {
  const commandDir = path.join(appPath, 'src', 'Command');
  if (!fs.existsSync(commandDir)) return [];

  const srcDir = path.join(appPath, 'src');
  const allSrcContent: string[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    if (file.startsWith(commandDir)) continue;
    allSrcContent.push(readSafe(file));
  }

  // Also check CI scripts and Makefile for command names
  const ciFiles = [
    path.join(appPath, 'Makefile'),
    path.join(appPath, '.github', 'workflows'),
    path.join(appPath, 'scripts'),
  ];
  for (const f of ciFiles) {
    if (fs.existsSync(f)) {
      try {
        if (fs.statSync(f).isDirectory()) {
          for (const entry of fs.readdirSync(f)) {
            allSrcContent.push(readSafe(path.join(f, entry)));
          }
        } else {
          allSrcContent.push(readSafe(f));
        }
      } catch {
        // Skip
      }
    }
  }

  const combinedContent = allSrcContent.join('\n');
  const unused: UnusedCommand[] = [];

  for (const file of getAllPhpFiles(commandDir)) {
    const content = readSafe(file);
    if (!/extends\s+Command/.test(content) && !/#\[AsCommand/.test(content)) continue;
    if (/^\s*abstract\s+class/m.test(content)) continue;

    const className = extractClassName(content);
    if (!className) continue;

    // Extract command name
    let commandName = '';
    const asCmd = /#\[AsCommand\(([^)]+)\)\]/.exec(content);
    if (asCmd) {
      const nm = /['"]([^'"]+)['"]/.exec(asCmd[1]);
      if (nm) commandName = nm[1];
    }
    if (!commandName) {
      const dn = /static\s+\$defaultName\s*=\s*['"]([^'"]+)['"]/.exec(content);
      if (dn) commandName = dn[1];
    }
    if (!commandName) {
      const sn = /\$this->setName\(\s*['"]([^'"]+)['"]\s*\)/.exec(content);
      if (sn) commandName = sn[1];
    }

    if (!commandName) continue; // skip unnamed

    // A command is "used" if its name appears in Makefile, CI, other PHP, or test files
    const isReferenced =
      combinedContent.includes(className) ||
      combinedContent.includes(commandName);

    if (!isReferenced) {
      unused.push({
        name: commandName,
        class: className,
        file: path.basename(file),
        reason: 'Command name not referenced in Makefile, CI scripts, or PHP files',
      });
    }
  }

  return unused;
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function detectDeadCode(appPath: string): McpToolResult {
  try {
    const orphanControllers = detectOrphanControllers(appPath);
    const uninjectedServices = detectUninjectedServices(appPath);
    const unusedForms = detectUnusedFormTypes(appPath);
    const unusedCommands = detectUnusedCommands(appPath);

    const total = orphanControllers.length + uninjectedServices.length +
                  unusedForms.length + unusedCommands.length;

    if (total === 0) {
      return {
        content: [{
          type: 'text',
          text: '✓ No obvious dead code detected.\n\nNote: Static analysis cannot detect dynamic service locators or tag-based injection patterns.',
        }],
      };
    }

    let text = `Dead Code Analysis\n${'='.repeat(50)}\n`;
    text += `\nNote: Results are heuristic — verify before deleting.\n`;

    if (orphanControllers.length > 0) {
      text += `\nOrphan Controllers (${orphanControllers.length}) — no route points here:\n`;
      for (const c of orphanControllers) {
        text += `  ${c.class}  (${c.file})\n`;
        if (c.actions.length > 0) text += `    Actions: ${c.actions.join(', ')}\n`;
      }
    }

    if (uninjectedServices.length > 0) {
      text += `\nPossibly Uninjected Services (${uninjectedServices.length}):\n`;
      for (const s of uninjectedServices) {
        text += `  ${s.class}\n`;
      }
    }

    if (unusedForms.length > 0) {
      text += `\nUnused Form Types (${unusedForms.length}):\n`;
      for (const f of unusedForms) {
        text += `  ${f.class}  (${f.file})\n`;
      }
    }

    if (unusedCommands.length > 0) {
      text += `\nUnreferenced Commands (${unusedCommands.length}):\n`;
      for (const c of unusedCommands) {
        text += `  ${c.name}  →  ${c.class}  (${c.file})\n`;
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

export function detectOrphanControllersOnly(appPath: string): McpToolResult {
  try {
    const orphans = detectOrphanControllers(appPath);

    if (orphans.length === 0) {
      return { content: [{ type: 'text', text: '✓ All controllers have at least one matching route.' }] };
    }

    let text = `Orphan Controllers (${orphans.length}) — no route references these:\n\n`;
    for (const c of orphans) {
      text += `  ${c.class}\n    File: ${c.file}\n`;
      if (c.actions.length > 0) text += `    Public methods: ${c.actions.join(', ')}\n`;
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function detectUnusedFormTypesOnly(appPath: string): McpToolResult {
  try {
    const unused = detectUnusedFormTypes(appPath);

    if (unused.length === 0) {
      return { content: [{ type: 'text', text: '✓ All form types appear to be referenced in controllers or other form types.' }] };
    }

    let text = `Unused Form Types (${unused.length}):\n\n`;
    for (const f of unused) {
      text += `  ${f.class}  (${f.file})\n    ${f.reason}\n\n`;
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

export function getDeadCodeTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'detect_dead_code',
      description: 'Run full dead code analysis: orphan controllers, uninjected services, unused form types, and unreferenced commands (heuristic — verify before deleting)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'detect_orphan_controllers',
      description: 'Find controller classes with no matching route in YAML or PHP attributes — candidates for removal',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'detect_unused_form_types',
      description: 'Find AbstractType subclasses never instantiated in controllers, other form types, or templates',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
