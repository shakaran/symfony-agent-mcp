/**
 * Symfony VarExporter Component Inspector
 *
 * Distinct from symfony-lazy-services.ts (DI lazy proxies) and cache.ts (caching).
 * Focuses on the VarExporter component (symfony/var-exporter):
 *
 * VarExporter::export():
 *   $exportedPhp = VarExporter::export(['a' => 1, 'b' => new Foo()]);
 *   // Returns PHP code string ready for include
 *
 * Instantiator (bypass constructor):
 *   $object = Instantiator::instantiate(Foo::class);
 *   // Useful for hydrating objects from serialized data without calling __construct
 *
 * LazyProxyTrait (DI lazy proxy without interface, Symfony 6.2+):
 *   class FooProxy extends Foo {
 *     use LazyProxyTrait;
 *   }
 *
 * LazyGhostTrait (lazy ghost without parent class, Symfony 6.2+):
 *   class FooGhost implements FooInterface {
 *     use LazyGhostTrait;
 *   }
 *
 * IsLazyGhost / IsLazyProxy interfaces — mark proxied classes.
 *
 * Analysis:
 *   - LazyProxyTrait used on a class that doesn't extend the proxied class (wrong setup)
 *   - LazyGhostTrait without implementing any interface (ghost with no contract)
 *   - Instantiator::instantiate() used without unserialize logic (may leave object uninitialized)
 *   - VarExporter::export() called on user-provided data (potential code injection risk if eval'd)
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

interface VarExporterUsage {
  file: string;
  class?: string;
  usesLazyProxy: boolean;
  usesLazyGhost: boolean;
  usesInstantiator: boolean;
  usesVarExporter: boolean;
  implementsInterface: boolean;
  extendsClass: boolean;
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

function parseVarExporterUsage(filePath: string, appPath: string): VarExporterUsage | null {
  const content = safeRead(filePath, path.join(appPath, 'src'));
  if (content === null) return null;

  const usesLazyProxy   = content.includes('LazyProxyTrait');
  const usesLazyGhost   = content.includes('LazyGhostTrait');
  const usesInstantiator = content.includes('Instantiator::instantiate') || content.includes('Instantiator::');
  const usesVarExporter  = content.includes('VarExporter::export') || content.includes('VarExporter::');

  if (!usesLazyProxy && !usesLazyGhost && !usesInstantiator && !usesVarExporter) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  const implementsInterface = /class\s+\w+[^{]*implements/.test(content);
  const extendsClass        = /class\s+\w+[^{]*extends/.test(content);

  const issues: string[] = [];

  if (usesLazyProxy && !extendsClass) {
    issues.push('LazyProxyTrait used without extends — proxy must extend the real class');
  }
  if (usesLazyGhost && !implementsInterface) {
    issues.push('LazyGhostTrait without implementing any interface — ghost object has no contract');
  }
  if (usesVarExporter && content.includes('eval(')) {
    issues.push('VarExporter::export() combined with eval() — potential code injection if input is user-controlled');
  }
  if (usesInstantiator) {
    const hasHydrate = content.includes('->hydrate(') || content.includes('unserialize');
    if (!hasHydrate) {
      issues.push('Instantiator::instantiate() without hydration — object properties may remain uninitialized');
    }
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM?.[1],
    usesLazyProxy,
    usesLazyGhost,
    usesInstantiator,
    usesVarExporter,
    implementsInterface,
    extendsClass,
    issues,
  };
}

export function listVarExporterUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const usages: VarExporterUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseVarExporterUsage(file, appPath);
      if (u) usages.push(u);
    }

    if (usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No VarExporter/LazyProxyTrait/LazyGhostTrait/Instantiator usage found.\n\nPackage: symfony/var-exporter\n\nExample:\n  use Symfony\\Component\\VarExporter\\LazyGhostTrait;\n\n  class LazyService implements ServiceInterface {\n    use LazyGhostTrait;\n    public function init(): void { /* real init */ }\n  }',
        }],
      };
    }

    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);

    let text = `Symfony VarExporter Component\n${'='.repeat(55)}\n`;
    text += `\nFiles using VarExporter: ${usages.length}  Issues: ${totalIssues}\n`;
    text += `  LazyProxyTrait:   ${usages.filter((u) => u.usesLazyProxy).length}\n`;
    text += `  LazyGhostTrait:   ${usages.filter((u) => u.usesLazyGhost).length}\n`;
    text += `  Instantiator:     ${usages.filter((u) => u.usesInstantiator).length}\n`;
    text += `  VarExporter::     ${usages.filter((u) => u.usesVarExporter).length}\n`;

    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      const tags = [
        u.usesLazyProxy   ? 'LazyProxyTrait'   : '',
        u.usesLazyGhost   ? 'LazyGhostTrait'   : '',
        u.usesInstantiator ? 'Instantiator'     : '',
        u.usesVarExporter  ? 'VarExporter::export' : '',
      ].filter(Boolean).join('  ');
      text += `\n  ${u.class ?? '(file)'}  ${tags}  (${u.file})\n`;
      for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getVarExporterStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: VarExporterUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseVarExporterUsage(file, appPath);
        if (u) usages.push(u);
      }
    }

    let text = `VarExporter Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total usages:       ${usages.length}\n`;
    text += `  LazyProxyTrait:   ${usages.filter((u) => u.usesLazyProxy).length}\n`;
    text += `  LazyGhostTrait:   ${usages.filter((u) => u.usesLazyGhost).length}\n`;
    text += `  Instantiator:     ${usages.filter((u) => u.usesInstantiator).length}\n`;
    text += `  VarExporter::     ${usages.filter((u) => u.usesVarExporter).length}\n`;
    text += `Issues:             ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getVarExporterTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_var_exporter_usage',
      description: 'Show Symfony VarExporter component usage: LazyProxyTrait/LazyGhostTrait/Instantiator/VarExporter::export() detection, proxy-without-extends warning, ghost-without-interface warning, Instantiator without hydration warning, VarExporter+eval code-injection warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_var_exporter_stats',
      description: 'Show VarExporter statistics: file count, LazyProxyTrait/LazyGhostTrait/Instantiator/VarExporter:: counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
