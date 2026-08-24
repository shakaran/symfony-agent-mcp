// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony #[Autowire*] Attribute Inspector (Symfony 6.1+)
 *
 * Distinct from services.ts (service definitions) and symfony-lazy-services.ts (lazy proxies).
 * Focuses on PHP attribute-based DI targeting (Symfony 6.1+):
 *
 * #[Autowire]:
 *   #[Autowire(service: 'mailer')]               — explicit service ID
 *   #[Autowire('%mailer.dsn%')]                  — parameter value
 *   #[Autowire(env: 'MAILER_DSN')]               — env variable
 *   #[Autowire(expression: '@service.method()')] — expression language
 *
 * #[AutowireLocator] (Symfony 6.3+):
 *   #[AutowireLocator(HandlerInterface::class)]
 *   private ContainerInterface $handlers;
 *
 * #[AutowireIterator] (Symfony 6.3+):
 *   #[AutowireIterator(HandlerInterface::class)]
 *   private iterable $handlers;
 *
 * #[TaggedLocator] (Symfony 5.3+, deprecated in favor of AutowireLocator):
 *   #[TaggedLocator('handler.tag')]
 *
 * #[TaggedIterator] (Symfony 5.3+, deprecated in favor of AutowireIterator):
 *   #[TaggedIterator('handler.tag')]
 *
 * Analysis:
 *   - #[Autowire('%param%')] with parameter that doesn't match %word.word% pattern (malformed)
 *   - #[TaggedLocator] or #[TaggedIterator] usage (deprecated in Symfony 6.3+)
 *   - #[AutowireLocator] on non-ContainerInterface type hint
 *   - #[AutowireIterator] on non-iterable type hint
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface AutowireAttrUsage {
  file: string;
  class: string;
  autowireCount: number;
  autowireLocatorCount: number;
  autowireIteratorCount: number;
  taggedLocatorCount: number;
  taggedIteratorCount: number;
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

function parseAutowireAttrs(filePath: string, appPath: string): AutowireAttrUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasAny = content.includes('#[Autowire') || content.includes('#[TaggedLocator') ||
                 content.includes('#[TaggedIterator');
  if (!hasAny) return null;
  if (content.includes('namespace Symfony\\') || content.includes('abstract class')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const autowireCount         = [...content.matchAll(/#\[Autowire\b/g)].length;
  const autowireLocatorCount  = [...content.matchAll(/#\[AutowireLocator/g)].length;
  const autowireIteratorCount = [...content.matchAll(/#\[AutowireIterator/g)].length;
  const taggedLocatorCount    = [...content.matchAll(/#\[TaggedLocator/g)].length;
  const taggedIteratorCount   = [...content.matchAll(/#\[TaggedIterator/g)].length;

  const issues: string[] = [];

  if (taggedLocatorCount > 0) {
    issues.push(`#[TaggedLocator] is deprecated since Symfony 6.3 — migrate to #[AutowireLocator]`);
  }
  if (taggedIteratorCount > 0) {
    issues.push(`#[TaggedIterator] is deprecated since Symfony 6.3 — migrate to #[AutowireIterator]`);
  }

  // Detect malformed parameter references in #[Autowire('%...%')]
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('#[Autowire(')) continue;
    const paramM = /#\[Autowire\s*\(\s*'%([^%]+)%'\s*\)/.exec(line);
    if (paramM) {
      const paramName = paramM[1];
      if (!/^[\w.]+$/.test(paramName)) {
        issues.push(`Potentially malformed parameter reference: %${paramName}% — verify parameter name`);
      }
    }
  }

  // Check #[AutowireLocator] without ContainerInterface type hint
  for (let i = 0; i < lines.length - 3; i++) {
    if (lines[i].includes('#[AutowireLocator')) {
      const block = lines.slice(i, Math.min(i + 4, lines.length)).join('\n');
      if (!block.includes('ContainerInterface') && !block.includes('ServiceLocator')) {
        issues.push('#[AutowireLocator] should type-hint ContainerInterface (or ServiceLocator)');
      }
    }
    if (lines[i].includes('#[AutowireIterator')) {
      const block = lines.slice(i, Math.min(i + 4, lines.length)).join('\n');
      if (!block.includes('iterable') && !block.includes('array') && !block.includes('Iterator')) {
        issues.push('#[AutowireIterator] should type-hint iterable or array');
      }
    }
  }

  if (autowireCount + autowireLocatorCount + autowireIteratorCount +
      taggedLocatorCount + taggedIteratorCount === 0) return null;

  return {
    file: path.relative(appPath, filePath),
    class: classM[1],
    autowireCount,
    autowireLocatorCount,
    autowireIteratorCount,
    taggedLocatorCount,
    taggedIteratorCount,
    issues,
  };
}

export function listAutowireAttributes(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const usages: AutowireAttrUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseAutowireAttrs(file, appPath);
      if (u) usages.push(u);
    }

    if (usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No #[Autowire*] attributes found.\n\nExample usage (Symfony 6.1+):\n  use Symfony\\Component\\DependencyInjection\\Attribute\\Autowire;\n\n  class MyService {\n    public function __construct(\n      #[Autowire(env: \'API_KEY\')] private string $apiKey,\n      #[AutowireIterator(HandlerInterface::class)] private iterable $handlers,\n    ) {}\n  }',
        }],
      };
    }

    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);

    let text = `Symfony #[Autowire*] Attributes\n${'='.repeat(55)}\n`;
    text += `\nClasses with Autowire attrs: ${usages.length}  Issues: ${totalIssues}\n`;
    text += `  #[Autowire]:          ${usages.reduce((s, u) => s + u.autowireCount, 0)}\n`;
    text += `  #[AutowireLocator]:   ${usages.reduce((s, u) => s + u.autowireLocatorCount, 0)}\n`;
    text += `  #[AutowireIterator]:  ${usages.reduce((s, u) => s + u.autowireIteratorCount, 0)}\n`;
    text += `  #[TaggedLocator]:     ${usages.reduce((s, u) => s + u.taggedLocatorCount, 0)} (deprecated)\n`;
    text += `  #[TaggedIterator]:    ${usages.reduce((s, u) => s + u.taggedIteratorCount, 0)} (deprecated)\n`;

    const withIssues = usages.filter((u) => u.issues.length > 0);
    if (withIssues.length > 0) {
      text += `\nClasses with issues:\n`;
      for (const u of withIssues) {
        text += `\n  ${u.class}  (${u.file})\n`;
        for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
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

export function getAutowireAttributeStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: AutowireAttrUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseAutowireAttrs(file, appPath);
        if (u) usages.push(u);
      }
    }

    let text = `Autowire Attribute Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with Autowire attrs:  ${usages.length}\n`;
    text += `  #[Autowire]:               ${usages.reduce((s, u) => s + u.autowireCount, 0)}\n`;
    text += `  #[AutowireLocator]:        ${usages.reduce((s, u) => s + u.autowireLocatorCount, 0)}\n`;
    text += `  #[AutowireIterator]:       ${usages.reduce((s, u) => s + u.autowireIteratorCount, 0)}\n`;
    text += `  #[TaggedLocator] (dep.):   ${usages.reduce((s, u) => s + u.taggedLocatorCount, 0)}\n`;
    text += `  #[TaggedIterator] (dep.):  ${usages.reduce((s, u) => s + u.taggedIteratorCount, 0)}\n`;
    text += `Issues:                       ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getAutowireAttributeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_autowire_attributes',
      description: 'Show Symfony #[Autowire]/#[AutowireLocator]/#[AutowireIterator]/#[TaggedLocator]/#[TaggedIterator] usage: count per type, deprecated TaggedLocator/TaggedIterator warning, malformed parameter reference detection, type-hint mismatch warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_autowire_attribute_stats',
      description: 'Show Autowire attribute statistics: class count, per-attribute-type count (including deprecated), issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
