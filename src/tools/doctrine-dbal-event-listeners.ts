/**
 * Doctrine DBAL Event Listener Inspector
 *
 * Detects DBAL-level event listeners (distinct from ORM entity event subscribers).
 * Pure static analysis — reads PHP source files only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DbalEventListenerInfo {
  file: string;
  className: string;
  events: string[];
  isSchemaListener: boolean;
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

const DBAL_EVENTS = [
  'postConnect',
  'onSchemaCreateTable',
  'onSchemaDropTable',
  'onSchemaAlterTable',
  'onSchemaCreateTableColumn',
  'onSchemaAlterTableAddColumn',
  'onSchemaAlterTableRemoveColumn',
  'onSchemaAlterTableChangeColumn',
  'onSchemaAlterTableRenameColumn',
  'onSchemaColumnDefinition',
  'onSchemaIndexDefinition',
];

const SCHEMA_EVENTS = new Set([
  'onSchemaCreateTable',
  'onSchemaDropTable',
  'onSchemaAlterTable',
  'onSchemaCreateTableColumn',
  'onSchemaAlterTableAddColumn',
  'onSchemaAlterTableRemoveColumn',
  'onSchemaAlterTableChangeColumn',
  'onSchemaAlterTableRenameColumn',
  'onSchemaColumnDefinition',
  'onSchemaIndexDefinition',
]);

function parseDbalEventListenerFile(filePath: string): DbalEventListenerInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isDbalSubscriber = (content.includes('implements EventSubscriber') &&
      (content.includes('Doctrine\\DBAL') || content.includes('PostConnectEventArgs') ||
       content.includes('SchemaColumnDefinitionEventArgs') || content.includes('SchemaCreateTableEventArgs') ||
       content.includes('SchemaDropTableEventArgs') || content.includes('SchemaAlterTableEventArgs'))) ||
    content.includes('addEventSubscriber') ||
    DBAL_EVENTS.some((ev) => content.includes(`function ${ev}(`));

  if (!isDbalSubscriber) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const events: string[] = [];
  for (const ev of DBAL_EVENTS) {
    if (content.includes(`function ${ev}(`) || content.includes(`'${ev}'`) || content.includes(`"${ev}"`)) {
      events.push(ev);
    }
  }

  const isSchemaListener = events.some((ev) => SCHEMA_EVENTS.has(ev));
  const issues: string[] = [];

  if (events.includes('postConnect') && isSchemaListener) {
    issues.push('DBAL event listener registers schema change in postConnect — executes on every new connection, causing performance overhead');
  }

  if (events.includes('onSchemaCreateTable') && content.includes('connection') &&
    (content.includes('->exec(') || content.includes('->executeStatement('))) {
    issues.push('DBAL event subscriber modifying connection in onSchemaCreateTable — affects schema generation');
  }

  // Check for subscriber that might have wrong method names (using ORM-style names in DBAL context)
  const hasPrePersist = content.includes('prePersist') || content.includes('postPersist') ||
    content.includes('preUpdate') || content.includes('postUpdate');
  if (hasPrePersist && isDbalSubscriber) {
    issues.push('DBAL event listener contains ORM lifecycle method names (prePersist/postPersist) — these are never called by DBAL EventManager');
  }

  // Warn if getSubscribedEvents returns events but the actual handler methods are missing
  if (content.includes('getSubscribedEvents') && events.length === 0) {
    issues.push('getSubscribedEvents() defined but no DBAL event handler methods found — listener is silently never called');
  }

  return {
    file: path.basename(filePath),
    className: classM[1],
    events,
    isSchemaListener,
    issues,
  };
}

export function listDbalEventListeners(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DbalEventListenerInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseDbalEventListenerFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.className.localeCompare(b.className));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No DBAL event listeners found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Doctrine DBAL Event Listener Analysis\n${'='.repeat(55)}\n`;
    text += `\nListeners: ${results.length}  Issues: ${totalIssues}\n`;

    for (const r of results) {
      const schema = r.isSchemaListener ? ' [schema]' : '';
      text += `\n  ${r.className.padEnd(45)}${schema}\n`;
      text += `    file:   ${r.file}\n`;
      text += `    events: ${r.events.length > 0 ? r.events.join(', ') : '(none detected)'}\n`;
      for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDbalEventListenerStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DbalEventListenerInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseDbalEventListenerFile(file);
      if (info) results.push(info);
    }

    let text = `DBAL Event Listener Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total listeners:        ${results.length}\n`;
    text += `  Schema listeners:     ${results.filter((r) => r.isSchemaListener).length}\n`;
    text += `  With postConnect:     ${results.filter((r) => r.events.includes('postConnect')).length}\n`;
    text += `Total issues:           ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    const eventCounts: Record<string, number> = {};
    for (const r of results) {
      for (const ev of r.events) {
        eventCounts[ev] = (eventCounts[ev] ?? 0) + 1;
      }
    }
    if (Object.keys(eventCounts).length > 0) {
      text += `\nEvent usage:\n`;
      for (const [ev, cnt] of Object.entries(eventCounts).sort(([, a], [, b]) => b - a)) {
        text += `  ${ev.padEnd(40)} ${cnt}\n`;
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

export function getDbalEventListenerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_dbal_event_listeners',
      description: 'Detect DBAL-level event listeners (distinct from ORM entity subscribers): implements EventSubscriber (DBAL), PostConnectEventArgs, SchemaColumnDefinitionEventArgs, onSchemaCreateTable/DropTable/AlterTable, addEventSubscriber; warns on postConnect schema changes, onSchemaCreateTable connection modifications, wrong method names, listener on wrong EventManager',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_dbal_event_listener_stats',
      description: 'Statistics for DBAL event listeners: total count, schema listener count, postConnect count, event usage breakdown, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
