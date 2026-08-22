/**
 * PHP SPL Data Structures Inspector
 *
 * Detects SPL data structure usage: SplStack, SplQueue, SplDoublyLinkedList,
 * SplHeap, SplPriorityQueue, SplFixedArray, SplMinHeap, SplMaxHeap.
 *
 * Warns on: SplStack for small collections, SplFixedArray without constructor size,
 * SplPriorityQueue without custom compare, SplDoublyLinkedList without iteration mode.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface SplUsage {
  file: string;
  className: string;
  splType: string;
  issues: string[];
}

const SPL_TYPES = [
  'SplStack',
  'SplQueue',
  'SplDoublyLinkedList',
  'SplHeap',
  'SplPriorityQueue',
  'SplFixedArray',
  'SplMinHeap',
  'SplMaxHeap',
];

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

function parseSplUsages(filePath: string, appPath: string): SplUsage[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const classM = /\bclass\s+(\w{1,80})/m.exec(content);
  const className = classM ? classM[1] : path.basename(filePath, '.php');

  const usages: SplUsage[] = [];

  for (const splType of SPL_TYPES) {
    if (!content.includes(splType)) continue;

    const issues: string[] = [];

    if (splType === 'SplStack') {
      // SplStack for small collections is overkill
      issues.push(`${className}: SplStack used — array with array_push/array_pop may suffice for small collections`);
    }

    if (splType === 'SplFixedArray') {
      // Check if size passed to constructor: new SplFixedArray(N)
      const ctorM = /new\s+SplFixedArray\s*\(\s*\)/.exec(content);
      if (ctorM) {
        issues.push(`${className}: SplFixedArray instantiated without size in constructor — array remains empty`);
      }
    }

    if (splType === 'SplPriorityQueue') {
      // Custom compare: class extends SplPriorityQueue and overrides compare()
      const hasCustomCompare = /function\s+compare\s*\(/.test(content);
      if (!hasCustomCompare) {
        issues.push(`${className}: SplPriorityQueue without custom compare() — default comparison may be unstable for equal priorities`);
      }
    }

    if (splType === 'SplDoublyLinkedList') {
      // Check for setIteratorMode call
      const hasMode = /setIteratorMode\s*\(/.test(content);
      if (!hasMode) {
        issues.push(`${className}: SplDoublyLinkedList without setIteratorMode() — default LIFO vs FIFO is ambiguous`);
      }
    }

    usages.push({
      file: path.relative(appPath, filePath),
      className,
      splType,
      issues,
    });
  }

  return usages;
}

export function listPhpSplDataStructures(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const usages: SplUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      usages.push(...parseSplUsages(file, appPath));
    }

    if (usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No SPL data structure usage found in src/.\n\nSPL structures: SplStack, SplQueue, SplDoublyLinkedList, SplHeap, SplPriorityQueue, SplFixedArray, SplMinHeap, SplMaxHeap',
        }],
      };
    }

    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);

    let text = `PHP SPL Data Structures\n${'='.repeat(55)}\n`;
    text += `\nUsages: ${usages.length}  Issues: ${totalIssues}\n`;

    // Type counts
    const typeCounts: Record<string, number> = {};
    for (const u of usages) typeCounts[u.splType] = (typeCounts[u.splType] ?? 0) + 1;
    for (const [t, count] of Object.entries(typeCounts).sort()) {
      text += `  ${t.padEnd(25)} ${count}\n`;
    }

    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length || a.className.localeCompare(b.className))) {
      text += `\n  ${u.className.padEnd(30)} ${u.splType}\n`;
      text += `    ${u.file}\n`;
      for (const issue of u.issues) text += `    ! ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpSplDataStructureStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: SplUsage[] = [];

    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        usages.push(...parseSplUsages(file, appPath));
      }
    }

    const typeCounts: Record<string, number> = {};
    for (const u of usages) typeCounts[u.splType] = (typeCounts[u.splType] ?? 0) + 1;

    let text = `PHP SPL Data Structure Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total usages: ${usages.length}\n\n`;
    text += `By type:\n`;
    for (const t of SPL_TYPES) {
      const count = typeCounts[t] ?? 0;
      if (count > 0) text += `  ${t.padEnd(25)} ${count}\n`;
    }
    text += `\nWith issues:  ${usages.filter((u) => u.issues.length > 0).length}\n`;
    text += `Total issues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpSplDataStructureTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_spl_data_structures',
      description: 'List PHP SPL data structure usage: SplStack/Queue/Heap/FixedArray/PriorityQueue, missing constructor size, missing custom compare, missing iteration mode, overkill usage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_spl_data_structure_stats',
      description: 'Statistics for PHP SPL data structure usage: count by type, total usages, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
