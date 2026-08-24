// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine Multi-Connection Inspector
 *
 * Reads doctrine.yaml: dbal.connections map, orm.entity_managers map.
 * Detects driver/host per connection, EM-connection bindings, entity dir mappings.
 *
 * Pure static analysis only.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface ConnectionInfo {
  name: string;
  driver: string | null;
  host: string | null;
  hasCharset: boolean;
  charset: string | null;
}

interface EntityManagerInfo {
  name: string;
  connection: string | null;
  mappingDirs: string[];
}

interface MultiConnectionInfo {
  connections: ConnectionInfo[];
  entityManagers: EntityManagerInfo[];
  issues: string[];
}

function loadDoctrineConfig(appPath: string): Record<string, unknown> | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'doctrine.yaml'),
  ];
  for (const candidate of candidates) {
    const raw = parseYamlFile(candidate) as Record<string, unknown> | null;
    if (raw) return raw;
  }
  return null;
}

function parseConnections(dbal: Record<string, unknown>): ConnectionInfo[] {
  const connections: ConnectionInfo[] = [];

  const connectionsMap = dbal['connections'] as Record<string, unknown> | undefined;
  if (connectionsMap && typeof connectionsMap === 'object') {
    for (const [name, def] of Object.entries(connectionsMap)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const driver = d['driver'] ? String(d['driver']) : null;
      const host = d['host'] ? String(d['host']) : null;
      const charset = d['charset'] ? String(d['charset']) : null;
      const hasCharset = charset !== null;
      connections.push({ name, driver, host, hasCharset, charset });
    }
  } else {
    // Single connection (default)
    const driver = dbal['driver'] ? String(dbal['driver']) : null;
    const host = dbal['host'] ? String(dbal['host']) : null;
    const charset = dbal['charset'] ? String(dbal['charset']) : null;
    connections.push({ name: 'default', driver, host, hasCharset: charset !== null, charset });
  }

  return connections;
}

function parseEntityManagers(orm: Record<string, unknown>): EntityManagerInfo[] {
  const ems: EntityManagerInfo[] = [];

  const emsMap = orm['entity_managers'] as Record<string, unknown> | undefined;
  if (emsMap && typeof emsMap === 'object') {
    for (const [name, def] of Object.entries(emsMap)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const connection = d['connection'] ? String(d['connection']) : null;

      const mappingDirs: string[] = [];
      const mappings = d['mappings'] as Record<string, unknown> | undefined;
      if (mappings) {
        for (const [, mapDef] of Object.entries(mappings)) {
          if (!mapDef || typeof mapDef !== 'object') continue;
          const md = mapDef as Record<string, unknown>;
          if (md['dir']) mappingDirs.push(String(md['dir']));
        }
      }

      ems.push({ name, connection, mappingDirs });
    }
  } else {
    // Single default EM
    const connection = orm['connection'] ? String(orm['connection']) : null;
    const mappingDirs: string[] = [];
    const mappings = orm['mappings'] as Record<string, unknown> | undefined;
    if (mappings) {
      for (const [, mapDef] of Object.entries(mappings)) {
        if (!mapDef || typeof mapDef !== 'object') continue;
        const md = mapDef as Record<string, unknown>;
        if (md['dir']) mappingDirs.push(String(md['dir']));
      }
    }
    ems.push({ name: 'default', connection, mappingDirs });
  }

  return ems;
}

function analyzeMultiConnection(appPath: string): MultiConnectionInfo {
  const raw = loadDoctrineConfig(appPath);
  const issues: string[] = [];

  if (!raw) {
    return { connections: [], entityManagers: [], issues: ['doctrine.yaml not found'] };
  }

  const doctrineSection = raw['doctrine'] as Record<string, unknown> | undefined ?? raw;
  const dbal = doctrineSection['dbal'] as Record<string, unknown> | undefined ?? {};
  const orm = doctrineSection['orm'] as Record<string, unknown> | undefined ?? {};

  const connections = parseConnections(dbal);
  const entityManagers = parseEntityManagers(orm);

  // Warn: connection without charset utf8mb4
  for (const conn of connections) {
    if (!conn.hasCharset) {
      issues.push(`Connection "${conn.name}" has no charset set — use charset: utf8mb4 to avoid emoji/multibyte issues`);
    } else if (conn.charset && conn.charset !== 'utf8mb4') {
      issues.push(`Connection "${conn.name}" uses charset "${conn.charset}" — consider utf8mb4 for full Unicode support`);
    }
  }

  const hasMultipleConnections = connections.length > 1;

  // Warn: EM without explicit connection name when multiple connections exist
  if (hasMultipleConnections) {
    for (const em of entityManagers) {
      if (!em.connection) {
        issues.push(`EntityManager "${em.name}" has no explicit connection binding — ambiguous when multiple connections exist`);
      }
    }
  }

  // Warn: entity dir mapped to default EM when custom EMs exist
  const hasCustomEms = entityManagers.some(em => em.name !== 'default');
  const defaultEm = entityManagers.find(em => em.name === 'default');
  if (hasCustomEms && defaultEm && defaultEm.mappingDirs.length > 0) {
    issues.push(`Entity directories mapped to default EM while custom EMs exist — verify intended EM assignment`);
  }

  return { connections, entityManagers, issues };
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listDoctrineMultiConnection(appPath: string): McpToolResult {
  try {
    const info = analyzeMultiConnection(appPath);

    if (info.connections.length === 0 && info.entityManagers.length === 0) {
      return {
        content: [{ type: 'text', text: 'doctrine.yaml not found or no connections/entity managers configured.' }],
      };
    }

    let text = `Doctrine Multi-Connection Configuration\n${'='.repeat(50)}\n`;
    text += `Connections: ${info.connections.length}  |  Entity Managers: ${info.entityManagers.length}  |  Issues: ${info.issues.length}\n`;

    text += `\nConnections:\n`;
    for (const conn of info.connections) {
      text += `  ${conn.name}\n`;
      if (conn.driver) text += `    driver:  ${conn.driver}\n`;
      if (conn.host)   text += `    host:    ${conn.host}\n`;
      text += `    charset: ${conn.charset ?? '(not set)'}\n`;
    }

    text += `\nEntity Managers:\n`;
    for (const em of info.entityManagers) {
      text += `  ${em.name}\n`;
      text += `    connection: ${em.connection ?? '(default)'}\n`;
      if (em.mappingDirs.length > 0) {
        text += `    mapping dirs: ${em.mappingDirs.join(', ')}\n`;
      }
    }

    if (info.issues.length > 0) {
      text += `\nIssues:\n`;
      for (const issue of info.issues) {
        text += `  ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error scanning Doctrine multi-connection config: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDoctrineMultiConnectionStats(appPath: string): McpToolResult {
  try {
    const info = analyzeMultiConnection(appPath);

    const connectionsWithCharset = info.connections.filter(c => c.hasCharset).length;
    const emsWithExplicitConnection = info.entityManagers.filter(em => em.connection !== null).length;

    const text = [
      'Doctrine Multi-Connection Statistics',
      '='.repeat(45),
      `Connections:                   ${info.connections.length}`,
      `  With charset set:            ${connectionsWithCharset}`,
      `  With utf8mb4:                ${info.connections.filter(c => c.charset === 'utf8mb4').length}`,
      `Entity managers:               ${info.entityManagers.length}`,
      `  With explicit connection:    ${emsWithExplicitConnection}`,
      `Total issues:                  ${info.issues.length}`,
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error computing Doctrine multi-connection stats: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDoctrineMultiConnectionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'list_doctrine_multi_connection',
      description: 'List all Doctrine DBAL connections and ORM entity managers, their bindings, and configuration issues like missing charset or unbound entity managers.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_doctrine_multi_connection_stats',
      description: 'Get statistics about Doctrine multi-connection configuration.',
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
