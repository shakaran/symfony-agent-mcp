// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine Entity Listener Inspector
 *
 * Scans src/ PHP for:
 *   - Entities with #[EntityListeners(['SomeListener'])] attribute
 *   - Listener classes with postLoad/preUpdate/postRemove etc. lifecycle methods
 *   - EntityListenerResolver and listener registration in doctrine.yaml
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface EntityListenerInfo {
  file: string;
  class: string;
  listenerClasses: string[];
  lifecycleMethods: string[];
  isRegistered: boolean;
  issues: string[];
}

const LIFECYCLE_METHODS = [
  'postLoad', 'prePersist', 'postPersist', 'preUpdate', 'postUpdate',
  'preRemove', 'postRemove', 'postFlush', 'preFlush', 'onClear',
];


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

function extractEntityListenerClasses(content: string): string[] {
  const listeners: string[] = [];
  // Match #[EntityListeners(['App\Entity\Listener\FooListener'])] or similar
  const attrPattern = /#\[(?:\w+\\){0,10}EntityListeners\s*\(\s*\[([^\]]{0,500})\]/g;
  let m: RegExpExecArray | null;
  while ((m = attrPattern.exec(content)) !== null) {
    const inner = m[1];
    const classPattern = /['"]([\\a-zA-Z_][\\a-zA-Z0-9_]{0,200})['"]/g;
    let cm: RegExpExecArray | null;
    while ((cm = classPattern.exec(inner)) !== null) {
      const shortName = cm[1].split('\\').pop() ?? cm[1];
      listeners.push(shortName);
    }
  }
  // Also match annotation style @ORM\EntityListeners({"App\Entity\Listener\FooListener"})
  const annotPattern = /@(?:\w+\\){0,5}EntityListeners\s*\(\s*\{([^}]{0,500})\}/g;
  while ((m = annotPattern.exec(content)) !== null) {
    const inner = m[1];
    const classPattern = /['"]([\\a-zA-Z_][\\a-zA-Z0-9_]{0,200})['"]/g;
    let cm: RegExpExecArray | null;
    while ((cm = classPattern.exec(inner)) !== null) {
      const shortName = cm[1].split('\\').pop() ?? cm[1];
      listeners.push(shortName);
    }
  }
  return [...new Set(listeners)];
}

function findLifecycleMethodsInClass(content: string): string[] {
  const found: string[] = [];
  for (const method of LIFECYCLE_METHODS) {
    const pattern = new RegExp(`function\\s+${method}\\s*\\(`, 'g');
    if (pattern.test(content)) found.push(method);
  }
  return found;
}

function isListenerRegistered(content: string): boolean {
  return (
    content.includes('#[AsDoctrineListener') ||
    content.includes('#[AsEntityListener') ||
    content.includes('AsDoctrineListener') ||
    content.includes('AsEntityListener') ||
    content.includes('doctrine.event_listener') ||
    content.includes('doctrine.orm.entity_listener')
  );
}

function loadRegisteredListenersFromYaml(appPath: string): Set<string> {
  const registered = new Set<string>();
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'doctrine.yaml'),
    path.join(appPath, 'config', 'services.yaml'),
  ];

  for (const candidate of candidates) {
    const raw = parseYamlFile(candidate) as Record<string, unknown> | null;
    if (!raw) continue;
    const text = JSON.stringify(raw);
    // Heuristic: look for entity_listener or AsEntityListener references
    const classPattern = /Listener['":]/g;
    const matches = text.match(/\w{1,60}Listener/g) ?? [];
    for (const m of matches) {
      registered.add(m);
    }
    // Suppress unused-variable warning from classPattern
    void classPattern;
  }

  return registered;
}

function scanEntityListeners(appPath: string): EntityListenerInfo[] {
  const results: EntityListenerInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = getAllPhpFiles(srcDir);

  const yamlRegistered = loadRegisteredListenersFromYaml(appPath);

  // Collect all listener class names declared in PHP files (via annotation or attribute)
  const allListenerClasses = new Set<string>();
  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (isListenerRegistered(content)) {
      const cls = extractClassFromContent(content);
      if (cls) allListenerClasses.add(cls);
    }
  }

  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const listenerClasses = extractEntityListenerClasses(content);
    const lifecycleMethods = findLifecycleMethodsInClass(content);
    const registered = isListenerRegistered(content);

    // Only include: entities with EntityListeners OR listener classes with lifecycle methods
    const isEntity = listenerClasses.length > 0;
    const isListenerClass = lifecycleMethods.length > 0 && (
      registered ||
      allListenerClasses.has(extractClassFromContent(content) ?? '') ||
      /Listener\.php$/.test(file)
    );

    if (!isEntity && !isListenerClass) continue;

    const className = extractClassFromContent(content) ?? path.basename(file, '.php');
    const issues: string[] = [];

    // Check if listener class is registered
    if (isListenerClass && !registered) {
      const inYaml = yamlRegistered.has(className);
      if (!inYaml) {
        issues.push(`Listener class "${className}" may not be registered (missing #[AsDoctrineListener] or service config)`);
      }
    }

    // Check listener class has lifecycle methods
    if (isListenerClass && lifecycleMethods.length === 0) {
      issues.push(`Listener class "${className}" has no lifecycle methods — it will never be called`);
    }

    // Check EntityListeners point to existing classes
    for (const listenerClass of listenerClasses) {
      if (!allListenerClasses.has(listenerClass) && !yamlRegistered.has(listenerClass)) {
        issues.push(`Entity "${className}" references listener "${listenerClass}" which was not found in src/ or config`);
      }
    }

    const isReg = registered || listenerClasses.every(lc => allListenerClasses.has(lc) || yamlRegistered.has(lc));

    results.push({
      file: path.relative(appPath, file),
      class: className,
      listenerClasses,
      lifecycleMethods,
      isRegistered: isReg,
      issues,
    });
  }

  return results;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listDoctrineEntityListeners(appPath: string): McpToolResult {
  try {
    const infos = scanEntityListeners(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine entity listeners found in src/.\n\nExample:\n  #[ORM\\Entity]\n  #[EntityListeners([UserListener::class])]\n  class User { ... }\n\n  #[AsDoctrineListener(event: Events::postLoad)]\n  class UserListener { ... }',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Entity Listeners\n${'='.repeat(50)}\n`;
    text += `Files: ${infos.length}  |  Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n${info.file}  (${info.class})\n`;
      if (info.listenerClasses.length > 0) {
        text += `  Listener classes: ${info.listenerClasses.join(', ')}\n`;
      }
      if (info.lifecycleMethods.length > 0) {
        text += `  Lifecycle methods: ${info.lifecycleMethods.join(', ')}\n`;
      }
      text += `  Registered: ${info.isRegistered ? 'yes' : 'no'}\n`;
      for (const issue of info.issues) {
        text += `  ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error scanning Doctrine entity listeners: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDoctrineEntityListenerStats(appPath: string): McpToolResult {
  try {
    const infos = scanEntityListeners(appPath);

    const withListenerClasses = infos.filter(i => i.listenerClasses.length > 0).length;
    const withLifecycleMethods = infos.filter(i => i.lifecycleMethods.length > 0).length;
    const registered = infos.filter(i => i.isRegistered).length;
    const unregistered = infos.filter(i => !i.isRegistered).length;
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);

    const methodCounts: Record<string, number> = {};
    for (const info of infos) {
      for (const m of info.lifecycleMethods) {
        methodCounts[m] = (methodCounts[m] ?? 0) + 1;
      }
    }

    let text = `Doctrine Entity Listener Statistics\n${'='.repeat(45)}\n`;
    text += `Total files:                ${infos.length}\n`;
    text += `Entities with listeners:    ${withListenerClasses}\n`;
    text += `Listener classes:           ${withLifecycleMethods}\n`;
    text += `  Registered:               ${registered}\n`;
    text += `  Potentially unregistered: ${unregistered}\n`;
    text += `Total issues:               ${totalIssues}\n`;

    if (Object.keys(methodCounts).length > 0) {
      text += `\nLifecycle method usage:\n`;
      for (const [method, count] of Object.entries(methodCounts).sort((a, b) => b[1] - a[1])) {
        text += `  ${method}: ${count}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error computing Doctrine entity listener stats: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDoctrineEntityListenerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'list_doctrine_entity_listeners',
      description: 'List Doctrine entity listeners, their lifecycle methods, registration status, and issues like unregistered listeners or missing lifecycle methods.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_doctrine_entity_listener_stats',
      description: 'Get statistics about Doctrine entity listener usage and registration.',
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
