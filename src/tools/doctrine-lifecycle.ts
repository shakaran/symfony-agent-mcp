/**
 * Doctrine Entity Lifecycle Callback Inspector
 *
 * Scans entities for Doctrine lifecycle attributes and annotations:
 *   - #[HasLifecycleCallbacks] — marks the entity as using lifecycle events
 *   - #[PrePersist]  — called before INSERT
 *   - #[PostPersist] — called after INSERT
 *   - #[PreUpdate]   — called before UPDATE
 *   - #[PostUpdate]  — called after UPDATE
 *   - #[PreRemove]   — called before DELETE
 *   - #[PostRemove]  — called after DELETE
 *   - #[PostLoad]    — called after SELECT / entity hydration
 *   - #[PreFlush]    — called before flush
 *
 * Also detects Doctrine Entity Listeners (separate listener classes).
 * Pure static analysis — no database queries.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

type LifecycleEvent =
  | 'PrePersist' | 'PostPersist'
  | 'PreUpdate' | 'PostUpdate'
  | 'PreRemove' | 'PostRemove'
  | 'PostLoad' | 'PreFlush';

interface LifecycleCallback {
  event: LifecycleEvent;
  method: string;
}

interface EntityLifecycle {
  entity: string;
  file: string;
  hasLifecycleCallbacks: boolean;
  callbacks: LifecycleCallback[];
  entityListeners: string[];
}

const ALL_EVENTS: LifecycleEvent[] = [
  'PrePersist', 'PostPersist',
  'PreUpdate', 'PostUpdate',
  'PreRemove', 'PostRemove',
  'PostLoad', 'PreFlush',
];

// ─── File scanning ─────────────────────────────────────────────────────────

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

function extractClassName(content: string): string {
  const m = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  return m ? m[1] : '';
}

// ─── Lifecycle parsing ─────────────────────────────────────────────────────

function parseEntityLifecycle(filePath: string): EntityLifecycle | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  // Must be an entity
  if (!content.includes('#[ORM\\Entity') && !content.includes('#[Entity') &&
      !content.includes('@ORM\\Entity') && !content.includes('@Entity')) {
    return null;
  }

  const className = extractClassName(content);
  if (!className) return null;

  const hasLifecycleCallbacks = content.includes('HasLifecycleCallbacks');
  const callbacks: LifecycleCallback[] = [];

  if (hasLifecycleCallbacks) {
    // Parse method-level lifecycle attributes
    // Match: #[PrePersist] or #[ORM\PrePersist] before function declaration
    for (const event of ALL_EVENTS) {
      const pattern = new RegExp(
        `#\\[(?:ORM\\\\)?${event}\\]\\s*(?:public|protected|private)?\\s*function\\s+(\\w+)`,
        'g'
      );
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        callbacks.push({ event, method: m[1] });
      }
    }

    // Also handle legacy @ORM\PrePersist docblock annotations
    for (const event of ALL_EVENTS) {
      const pattern = new RegExp(
        `@ORM\\\\${event}\\s*\\*/[^/]*?(?:public|protected|private)?\\s*function\\s+(\\w+)`,
        'gs'
      );
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const alreadyAdded = callbacks.some((c) => c.event === event && c.method === m![1]);
        if (!alreadyAdded) callbacks.push({ event, method: m[1] });
      }
    }
  }

  // Detect entity listeners
  const entityListeners: string[] = [];
  for (const m of content.matchAll(/#\[EntityListeners?\s*\(\s*\[([^\]]+)\]/g)) {
    for (const lm of m[1].matchAll(/[\w\\]+::class|['"][\w\\]+'['"]/g)) {
      const listener = lm[0].replace(/::class|['"]/g, '').split('\\').pop() ?? '';
      if (listener) entityListeners.push(listener);
    }
  }

  if (!hasLifecycleCallbacks && entityListeners.length === 0) return null;

  return {
    entity: className,
    file: path.basename(filePath),
    hasLifecycleCallbacks,
    callbacks,
    entityListeners,
  };
}

function loadEntityLifecycles(appPath: string): EntityLifecycle[] {
  const entityDir = path.join(appPath, 'src', 'Entity');
  if (!fs.existsSync(entityDir)) return [];

  const lifecycles: EntityLifecycle[] = [];
  for (const file of getAllPhpFiles(entityDir)) {
    const lc = parseEntityLifecycle(file);
    if (lc) lifecycles.push(lc);
  }

  return lifecycles.sort((a, b) => a.entity.localeCompare(b.entity));
}

// ─── Event descriptions ────────────────────────────────────────────────────

const EVENT_DESCRIPTIONS: Record<LifecycleEvent, string> = {
  PrePersist:  'before INSERT (entity not yet saved)',
  PostPersist: 'after INSERT (ID is available)',
  PreUpdate:   'before UPDATE (only on managed entities with changes)',
  PostUpdate:  'after UPDATE',
  PreRemove:   'before DELETE',
  PostRemove:  'after DELETE (entity detached)',
  PostLoad:    'after SELECT / hydration (every load from DB)',
  PreFlush:    'before flush() — use carefully, runs on every flush',
};

// ─── Tool functions ────────────────────────────────────────────────────────

export function listEntityLifecycles(appPath: string): McpToolResult {
  try {
    const lifecycles = loadEntityLifecycles(appPath);

    if (lifecycles.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No entities with lifecycle callbacks or listeners found.\n\nAdd to an entity:\n  #[HasLifecycleCallbacks]\n  #[PrePersist]\n  public function onPrePersist(): void { ... }',
        }],
      };
    }

    let text = `Doctrine Lifecycle Callbacks (${lifecycles.length} entities)\n${'='.repeat(60)}\n`;

    for (const lc of lifecycles) {
      text += `\n  ${lc.entity}  (${lc.file})\n`;

      if (lc.callbacks.length > 0) {
        for (const cb of lc.callbacks) {
          text += `    #[${cb.event}]  ${cb.method}()  — ${EVENT_DESCRIPTIONS[cb.event]}\n`;
        }
      }

      if (lc.entityListeners.length > 0) {
        text += `    Entity listeners: ${lc.entityListeners.join(', ')}\n`;
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

export function getLifecycleByEvent(appPath: string, eventName: string): McpToolResult {
  try {
    const lifecycles = loadEntityLifecycles(appPath);
    const lq = eventName.toLowerCase().replace(/[^a-z]/g, '');

    const matches = lifecycles.filter((lc) =>
      lc.callbacks.some((cb) => cb.event.toLowerCase().replace(/[^a-z]/g, '').includes(lq))
    );

    if (matches.length === 0) {
      const events = ALL_EVENTS.join(', ');
      return {
        content: [{ type: 'text', text: `No entities with lifecycle event matching "${eventName}".\n\nValid events: ${events}` }],
      };
    }

    let text = `Entities with lifecycle event matching "${eventName}" (${matches.length}):\n\n`;

    for (const lc of matches) {
      const matchedCallbacks = lc.callbacks.filter((cb) =>
        cb.event.toLowerCase().replace(/[^a-z]/g, '').includes(lq)
      );
      text += `  ${lc.entity}  (${lc.file})\n`;
      for (const cb of matchedCallbacks) {
        text += `    ${cb.event} → ${cb.method}()\n`;
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

export function getLifecycleStats(appPath: string): McpToolResult {
  try {
    const lifecycles = loadEntityLifecycles(appPath);

    if (lifecycles.length === 0) {
      return { content: [{ type: 'text', text: 'No entity lifecycle callbacks found.' }] };
    }

    const eventCounts: Record<string, number> = {};
    let totalCallbacks = 0;
    let withListeners = 0;

    for (const lc of lifecycles) {
      for (const cb of lc.callbacks) {
        eventCounts[cb.event] = (eventCounts[cb.event] ?? 0) + 1;
        totalCallbacks++;
      }
      if (lc.entityListeners.length > 0) withListeners++;
    }

    let text = `Lifecycle Callback Statistics\n${'='.repeat(40)}\n\n`;
    text += `Entities with callbacks:  ${lifecycles.length}\n`;
    text += `Total callback methods:   ${totalCallbacks}\n`;
    text += `With entity listeners:    ${withListeners}\n`;

    if (Object.keys(eventCounts).length > 0) {
      text += `\nBy event type:\n`;
      for (const event of ALL_EVENTS) {
        if (eventCounts[event]) {
          text += `  ${event.padEnd(15)} ${eventCounts[event]}  — ${EVENT_DESCRIPTIONS[event]}\n`;
        }
      }
    }

    const postLoadCount = eventCounts['PostLoad'] ?? 0;
    if (postLoadCount > 0) {
      text += `\n⚠ ${postLoadCount} PostLoad callback(s) detected.\n`;
      text += `  PostLoad runs on EVERY entity load — ensure these methods are fast.\n`;
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

export function getDoctrineLifecycleTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_entity_lifecycles',
      description: 'List all Doctrine entities with lifecycle callbacks (#[PrePersist], #[PostLoad], etc.) and entity listeners, with event timing descriptions',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_lifecycle_by_event',
      description: 'Find all entities that have a callback for a specific lifecycle event (e.g. PrePersist, PostLoad, PreUpdate)',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          event_name: { type: 'string', description: 'Lifecycle event name (PrePersist, PostLoad, PreUpdate, PostUpdate, PreRemove, PostRemove, PostPersist, PreFlush)' },
        },
        required: ['app_path', 'event_name'],
      },
    },
    {
      name: 'get_lifecycle_stats',
      description: 'Show lifecycle callback statistics: entity count, callbacks per event type, PostLoad warning (runs on every load)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
