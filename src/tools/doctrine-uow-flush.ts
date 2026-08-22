/**
 * Doctrine Unit of Work Flush Inspector
 *
 * Scans src/ PHP files for classes implementing EventSubscriberInterface or lifecycle annotations.
 * Detects postFlush/preUpdate/onClear methods with dangerous patterns:
 *   - flush() inside postFlush (infinite loop)
 *   - persist() inside onClear (cleared immediately)
 *   - preUpdate modifying related entities without cascade
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface MethodAnalysis {
  name: string;
  hasFlushedInside: boolean;
  hasPersistInClear: boolean;
  issues: string[];
}

interface UowFlushInfo {
  file: string;
  class: string;
  methods: MethodAnalysis[];
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractClassFromContent(content: string): string | null {
  const m = /class\s+(\w{1,120})\b/.exec(content);
  return m ? m[1] : null;
}

// Extract body of a method by finding the opening brace and matching closing brace
function extractMethodBody(content: string, methodName: string): string | null {
  const methodPattern = new RegExp(`function\\s+${methodName}\\s*\\([^)]{0,500}\\)\\s*(?::[^{]{0,60})?\\s*\\{`, 'g');
  const m = methodPattern.exec(content);
  if (!m) return null;

  let depth = 1;
  let pos = m.index + m[0].length;
  const maxLen = Math.min(content.length, pos + 4000);

  while (pos < maxLen && depth > 0) {
    const ch = content[pos];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    pos++;
  }

  return content.slice(m.index + m[0].length, pos - 1);
}

function analyzeLifecycleMethods(content: string): MethodAnalysis[] {
  const lifecycleMethodNames = ['postFlush', 'preUpdate', 'postUpdate', 'prePersist', 'postPersist', 'preRemove', 'postRemove', 'onClear'];
  const methods: MethodAnalysis[] = [];

  for (const methodName of lifecycleMethodNames) {
    const methodDeclPattern = new RegExp(`function\\s+${methodName}\\s*\\(`, 'g');
    if (!methodDeclPattern.test(content)) continue;

    const body = extractMethodBody(content, methodName) ?? '';
    const issues: string[] = [];

    const hasFlushedInside = /->flush\s*\(/.test(body);
    const hasPersistInClear = methodName === 'onClear' && /->persist\s*\(/.test(body);

    if (methodName === 'postFlush' && hasFlushedInside) {
      issues.push(`${methodName}: calling flush() inside postFlush causes infinite recursive flush loop`);
    }

    if (hasPersistInClear) {
      issues.push(`${methodName}: calling persist() inside onClear — entity is immediately cleared from UoW`);
    }

    if (methodName === 'onClear') {
      const hasBusinessLogic = /->(?:send|dispatch|notify|log|mail|queue|publish)\s*\(/.test(body);
      if (hasBusinessLogic) {
        issues.push(`${methodName}: contains business logic (send/dispatch/notify) — onClear should only reset internal state`);
      }
    }

    if (methodName === 'preUpdate' && /->persist\s*\(/.test(body)) {
      issues.push(`${methodName}: calling persist() in preUpdate without cascade may cause ignored changes on related entities`);
    }

    if (body !== '' || issues.length > 0) {
      methods.push({ name: methodName, hasFlushedInside, hasPersistInClear, issues });
    }
  }

  return methods;
}

function isEventSubscriberOrListener(content: string): boolean {
  return (
    content.includes('EventSubscriberInterface') ||
    content.includes('EventListener') ||
    content.includes('#[AsDoctrineListener') ||
    content.includes('#[AsEntityListener') ||
    content.includes('@ORM\\HasLifecycleCallbacks') ||
    content.includes('#[ORM\\HasLifecycleCallbacks') ||
    content.includes('HasLifecycleCallbacks') ||
    content.includes('PostFlush') ||
    content.includes('PreUpdate') ||
    content.includes('OnClear')
  );
}

function scanUowFlushFiles(appPath: string): UowFlushInfo[] {
  const results: UowFlushInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = getAllPhpFiles(srcDir);

  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!isEventSubscriberOrListener(content)) continue;

    const className = extractClassFromContent(content) ?? path.basename(file, '.php');
    const methods = analyzeLifecycleMethods(content);

    if (methods.length === 0) continue;

    const fileIssues = methods.flatMap(m => m.issues);

    results.push({
      file: path.relative(appPath, file),
      class: className,
      methods,
      issues: fileIssues,
    });
  }

  return results;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listDoctrineUowFlush(appPath: string): McpToolResult {
  try {
    const infos = scanUowFlushFiles(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine lifecycle event listeners with UoW flush patterns detected in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine UoW Flush Analysis\n${'='.repeat(50)}\n`;
    text += `Files: ${infos.length}  |  Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n${info.file}  (${info.class})\n`;
      for (const method of info.methods) {
        text += `  ${method.name}()\n`;
        if (method.hasFlushedInside) text += `    flush() inside: YES\n`;
        if (method.hasPersistInClear) text += `    persist() in onClear: YES\n`;
        for (const issue of method.issues) {
          text += `    ⚠ ${issue}\n`;
        }
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error scanning Doctrine UoW flush patterns: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDoctrineUowFlushStats(appPath: string): McpToolResult {
  try {
    const infos = scanUowFlushFiles(appPath);

    const totalFiles = infos.length;
    const totalMethods = infos.reduce((s, i) => s + i.methods.length, 0);
    const withFlushInPostFlush = infos.flatMap(i => i.methods).filter(m => m.name === 'postFlush' && m.hasFlushedInside).length;
    const withPersistInClear = infos.flatMap(i => i.methods).filter(m => m.hasPersistInClear).length;
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);

    const text = [
      'Doctrine UoW Flush Statistics',
      '='.repeat(45),
      `Files with lifecycle listeners: ${totalFiles}`,
      `Total lifecycle methods:        ${totalMethods}`,
      `flush() inside postFlush:       ${withFlushInPostFlush}`,
      `persist() inside onClear:       ${withPersistInClear}`,
      `Total issues:                   ${totalIssues}`,
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error computing Doctrine UoW flush stats: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDoctrineUowFlushTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'list_doctrine_uow_flush',
      description: 'Detect dangerous Doctrine UoW flush patterns: flush() inside postFlush (infinite loop), persist() inside onClear, preUpdate side effects.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_doctrine_uow_flush_stats',
      description: 'Get statistics about Doctrine UoW lifecycle listener patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
  ];
}
