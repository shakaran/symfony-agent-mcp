// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface EntityManagerScopeInfo {
  file: string;
  type: 'closed-em' | 'static-em' | 'scope' | 'reset';
  pattern: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function buildEntityManagerScopeInfos(appPath: string): EntityManagerScopeInfo[] {
  const results: EntityManagerScopeInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  const checkFiles = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) checkFiles(full);
        else if (e.name.endsWith('.php')) {
          const content = safeRead(full, srcDir);
          if (content === null) return;
          if (!content.includes('EntityManager') && !content.includes('EntityManagerInterface') && !content.includes('ManagerRegistry')) return;

          const relFile = path.relative(appPath, full);
          const issues: string[] = [];

          const hasClosed = content.includes('isOpen()') || content.includes('resetManager') || content.includes('EntityManager is closed');
          if (!hasClosed && (content.includes('EntityManagerInterface') || content.includes('EntityManager'))) {
            const isCommandOrWorker = content.includes('Command') || content.includes('MessageHandler') || content.includes('Messenger') || content.includes('ConsoleCommand');
            if (isCommandOrWorker) {
              issues.push(`Long-running process "${relFile}" injects EntityManager without isOpen() check — after a failed transaction the EM closes and becomes unusable; inject ManagerRegistry and call resetManager() in catch blocks`);
            }
          }

          const hasStaticEm = /static\s+\$(?:em|entityManager|manager)\b/.test(content) || /static\s+EntityManager/.test(content);
          if (hasStaticEm) {
            issues.push(`Static EntityManager reference in "${relFile}" — static EMs are shared across requests in non-stateless runtimes (RoadRunner, Swoole) and retain identity map state; inject via constructor instead`);
            results.push({ file: relFile, type: 'static-em', pattern: 'static EntityManager', issues });
            return;
          }

          const hasFlushInLoop = /foreach[\s\S]{0,300}->flush\(\)|for\s*\([\s\S]{0,300}->flush\(\)/.test(content);
          if (hasFlushInLoop) {
            issues.push(`EntityManager::flush() called inside a loop in "${relFile}" — each flush executes a round-trip to the database; batch inserts/updates and flush once after the loop`);
          }

          const hasClear = content.includes('->clear()') || content.includes('->detach(');
          const hasBigLoop = content.includes('foreach') && (content.includes('findAll') || content.includes('getResult'));
          if (hasBigLoop && !hasClear) {
            issues.push(`Large result set iteration in "${relFile}" without clear()/detach() — identity map grows unboundedly; call $em->clear() periodically in batch loops to avoid memory exhaustion`);
          }

          results.push({ file: relFile, type: 'scope', pattern: 'EntityManager usage', issues });
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  return results;
}

export function listDoctrineEntityManagerScope(appPath: string): McpToolResult {
  try {
    const infos = buildEntityManagerScopeInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No EntityManager scope issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine EntityManager Scope Analysis\n${'='.repeat(55)}\n\nUsage sites: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineEntityManagerScopeStats(appPath: string): McpToolResult {
  try {
    const infos = buildEntityManagerScopeInfos(appPath);
    let text = `Doctrine EntityManager Scope Statistics\n${'='.repeat(40)}\n\n`;
    text += `Closed EM risk:  ${infos.filter((i) => i.type === 'closed-em').length}\n`;
    text += `Static EM:       ${infos.filter((i) => i.type === 'static-em').length}\n`;
    text += `Scope issues:    ${infos.filter((i) => i.type === 'scope').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineEntityManagerScopeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_entity_manager_scope', description: 'Analyze Doctrine EntityManager lifecycle issues; warns on closed EM in long-running processes without resetManager, static EM references, flush() in loop, large result iteration without clear()/detach()', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_entity_manager_scope_stats', description: 'Statistics for EntityManager scope: static/closed/scope issues, total issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
