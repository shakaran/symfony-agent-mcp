// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PSR Compliance Inspector
 *
 * Verifies which PSR interfaces are in use vs direct Symfony concrete classes:
 *
 *   PSR-3  LoggerInterface          (Psr\Log\LoggerInterface vs Symfony\Logger)
 *   PSR-6  CacheItemPoolInterface   (Psr\Cache vs Symfony\Cache)
 *   PSR-16 SimpleCache              (Psr\SimpleCache vs Symfony\Cache)
 *   PSR-7  ServerRequestInterface   (Psr\Http\Message — bridge needed)
 *   PSR-11 ContainerInterface       (Psr\Container\ContainerInterface)
 *   PSR-14 EventDispatcherInterface (Psr\EventDispatcher vs Symfony\EventDispatcher)
 *   PSR-18 ClientInterface          (Psr\Http\Client — HttpClient bridge)
 *
 * For each PSR, checks:
 *   - composer.json require/require-dev for the PSR package
 *   - src/ usage: type-hints and use statements for PSR interface vs Symfony concrete
 *
 * Portability score:
 *   - Higher PSR usage → more portable, easier to swap framework
 *   - Symfony concrete type-hints → tighter coupling
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

interface PsrResult {
  psr: string;
  name: string;
  psrInterface: string;
  symfonyAlternative: string;
  psrCount: number;
  concreteCount: number;
  inComposer: boolean;
}

const PSR_DEFINITIONS: Array<{
  psr: string;
  name: string;
  psrInterface: string;
  psrPackage: string;
  symfonyAlternative: string;
}> = [
  {
    psr: 'PSR-3',
    name: 'Logger',
    psrInterface: 'Psr\\Log\\LoggerInterface',
    psrPackage: 'psr/log',
    symfonyAlternative: 'Symfony\\Component\\HttpKernel\\Log',
  },
  {
    psr: 'PSR-6',
    name: 'Cache (Pool)',
    psrInterface: 'Psr\\Cache\\CacheItemPoolInterface',
    psrPackage: 'psr/cache',
    symfonyAlternative: 'Symfony\\Component\\Cache\\Adapter\\',
  },
  {
    psr: 'PSR-16',
    name: 'Cache (Simple)',
    psrInterface: 'Psr\\SimpleCache\\CacheInterface',
    psrPackage: 'psr/simple-cache',
    symfonyAlternative: 'Symfony\\Contracts\\Cache\\CacheInterface',
  },
  {
    psr: 'PSR-7',
    name: 'HTTP Message',
    psrInterface: 'Psr\\Http\\Message\\ServerRequestInterface',
    psrPackage: 'psr/http-message',
    symfonyAlternative: 'Symfony\\Component\\HttpFoundation\\Request',
  },
  {
    psr: 'PSR-11',
    name: 'Container',
    psrInterface: 'Psr\\Container\\ContainerInterface',
    psrPackage: 'psr/container',
    symfonyAlternative: 'Symfony\\Component\\DependencyInjection\\ContainerInterface',
  },
  {
    psr: 'PSR-14',
    name: 'Event Dispatcher',
    psrInterface: 'Psr\\EventDispatcher\\EventDispatcherInterface',
    psrPackage: 'psr/event-dispatcher',
    symfonyAlternative: 'Symfony\\Contracts\\EventDispatcher\\EventDispatcherInterface',
  },
  {
    psr: 'PSR-18',
    name: 'HTTP Client',
    psrInterface: 'Psr\\Http\\Client\\ClientInterface',
    psrPackage: 'psr/http-client',
    symfonyAlternative: 'Symfony\\Contracts\\HttpClient\\HttpClientInterface',
  },
];

function getComposerDeps(appPath: string): Set<string> {
  try {
    const composer = JSON.parse(fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8')) as
      Record<string, Record<string, string>>;
    return new Set([...Object.keys(composer['require'] ?? {}), ...Object.keys(composer['require-dev'] ?? {})]);
  } catch { return new Set(); }
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

function countUsages(srcDir: string, pattern: string): number {
  let count = 0;
  const short = pattern.split('\\').pop() ?? pattern;
  try {
    for (const file of getAllPhpFiles(srcDir)) {
      const content = safeRead(file, srcDir);
      if (content === null) continue;
      if (content.includes(pattern) || content.includes(short)) count++;
    }
  } catch { /* skip */ }
  return count;
}

export function listPsrCompliance(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const deps   = getComposerDeps(appPath);

    const results: PsrResult[] = [];
    for (const def of PSR_DEFINITIONS) {
      const psrCount      = fs.existsSync(srcDir) ? countUsages(srcDir, def.psrInterface) : 0;
      const concreteCount = fs.existsSync(srcDir) ? countUsages(srcDir, def.symfonyAlternative) : 0;
      const inComposer    = deps.has(def.psrPackage);
      results.push({
        psr: def.psr,
        name: def.name,
        psrInterface: def.psrInterface,
        symfonyAlternative: def.symfonyAlternative,
        psrCount,
        concreteCount,
        inComposer,
      });
    }

    const used    = results.filter((r) => r.psrCount > 0 || r.concreteCount > 0 || r.inComposer);
    const notUsed = results.filter((r) => !r.psrCount && !r.concreteCount && !r.inComposer);

    if (used.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PSR interface usage detected.\n\nUsing PSR interfaces improves portability:\n  // Instead of Symfony-specific:\n  use Symfony\\Contracts\\HttpClient\\HttpClientInterface;\n\n  // Use PSR-18:\n  use Psr\\Http\\Client\\ClientInterface;',
        }],
      };
    }

    let text = `PSR Compliance Analysis\n${'='.repeat(55)}\n\n`;
    text += `PSR           Used     Concrete  PSR interface type-hints\n`;
    text += `${'─'.repeat(70)}\n`;

    for (const r of results) {
      if (r.psrCount === 0 && r.concreteCount === 0 && !r.inComposer) continue;
      const psrCol      = r.psrCount > 0 ? `PSR:${r.psrCount}` : '─';
      const concreteCol = r.concreteCount > 0 ? `Concrete:${r.concreteCount}` : '─';
      const inComp      = r.inComposer ? '✓' : '─';
      const status      = r.psrCount > 0 && r.concreteCount === 0 ? '✓ portable'
        : r.psrCount > 0 && r.concreteCount > 0 ? '⚠ mixed'
        : r.concreteCount > 0 ? '⚠ coupled'
        : '✓ in composer';
      text += `${r.psr} (${r.name.padEnd(14)}) ${psrCol.padEnd(8)} ${concreteCol.padEnd(14)} composer:${inComp}  ${status}\n`;
    }

    const coupledCount = results.filter((r) => r.concreteCount > 0 && r.psrCount === 0).length;
    const mixedCount   = results.filter((r) => r.concreteCount > 0 && r.psrCount > 0).length;

    if (coupledCount + mixedCount > 0) {
      text += `\n⚠ ${coupledCount} PSR(s) use only concrete Symfony classes — consider PSR interfaces for portability\n`;
    }

    if (notUsed.length > 0) {
      text += `\nNot detected: ${notUsed.map((r) => r.psr).join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPsrStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const deps   = getComposerDeps(appPath);

    let psrTotal = 0, concreteTotal = 0, inComposerTotal = 0;
    for (const def of PSR_DEFINITIONS) {
      if (fs.existsSync(srcDir)) {
        psrTotal      += countUsages(srcDir, def.psrInterface);
        concreteTotal += countUsages(srcDir, def.symfonyAlternative);
      }
      if (deps.has(def.psrPackage)) inComposerTotal++;
    }

    let text = `PSR Compliance Statistics\n${'='.repeat(40)}\n\n`;
    text += `PSRs in composer.json: ${inComposerTotal}/${PSR_DEFINITIONS.length}\n`;
    text += `PSR interface usages:  ${psrTotal}\n`;
    text += `Concrete class usages: ${concreteTotal}\n`;
    const score = psrTotal + concreteTotal > 0 ? Math.round(100 * psrTotal / (psrTotal + concreteTotal)) : 0;
    text += `Portability score:     ${score}% PSR-typed\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPsrComplianceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_psr_compliance',
      description: 'Analyze PSR interface compliance (PSR-3/6/7/11/14/16/18): usage counts of PSR interfaces vs Symfony concrete classes in src/, composer.json presence, portability assessment',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_psr_stats',
      description: 'Show PSR compliance statistics: PSRs in composer.json, PSR interface usage count, concrete class usage count, portability score percentage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
