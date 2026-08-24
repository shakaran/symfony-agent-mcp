// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine DBAL Connection Deep Configuration Inspector
 *
 * Reads doctrine.dbal from config/packages/doctrine.yaml:
 *   - Driver (pdo_mysql / pdo_pgsql / pdo_sqlite / pdo_sqlsrv)
 *   - Host, port, dbname, charset, server_version
 *   - URL (env var, masked)
 *   - Connections: default + named (multi-connection setups)
 *   - Replicas (read replicas for read/write splitting)
 *   - use_savepoints, logging, profiling
 *   - SSL options (masked)
 *   - wrapper_class, driver_class
 *   - Pool / persistent connections
 *
 * Different from doctrine-orm-config.ts which covers entity managers and
 * ORM mapping — this covers the DBAL layer (transport/connection only).
 *
 * Pure static analysis.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface DbalReplica {
  name: string;
  host?: string;
  port?: number;
  user?: string;
  dbname?: string;
}

interface DbalConnection {
  name: string;
  driver?: string;
  url?: string;
  host?: string;
  port?: number;
  dbname?: string;
  charset?: string;
  serverVersion?: string;
  useSavepoints: boolean;
  logging: boolean;
  profiling: boolean;
  wrapperClass?: string;
  driverClass?: string;
  persistent: boolean;
  sslEnabled: boolean;
  replicas: DbalReplica[];
}

// ─── Parsing helpers ─────────────────────────────────────────────────────────

function maskUrl(url: string): string {
  return url
    .replace(/:\/\/([^:@]+):([^@]+)@/, '://***:***@')
    .replace(/%[^%]+%/g, '%***%');
}

function parseReplica(name: string, raw: Record<string, unknown>): DbalReplica {
  return {
    name,
    host:   raw['host']   ? String(raw['host'])   : undefined,
    port:   raw['port']   ? Number(raw['port'])   : undefined,
    user:   raw['user']   ? '***'                 : undefined,
    dbname: raw['dbname'] ? String(raw['dbname']) : undefined,
  };
}

function parseConnection(name: string, raw: Record<string, unknown>): DbalConnection {
  const replicasRaw = raw['replicas'] as Record<string, unknown> | undefined
    ?? raw['slaves'] as Record<string, unknown> | undefined;

  const replicas: DbalReplica[] = [];
  if (replicasRaw) {
    for (const [rname, rdef] of Object.entries(replicasRaw)) {
      if (!rdef || typeof rdef !== 'object') continue;
      replicas.push(parseReplica(rname, rdef as Record<string, unknown>));
    }
  }

  const urlRaw = raw['url'] ?? raw['DATABASE_URL'];
  const sslKey = raw['sslkey'] ?? raw['ssl_key'] ?? (raw['options'] as Record<string, unknown>)?.[String(1009)];

  return {
    name,
    driver:        raw['driver']         ? String(raw['driver'])         : undefined,
    url:           urlRaw                ? maskUrl(String(urlRaw))       : undefined,
    host:          raw['host']           ? String(raw['host'])           : undefined,
    port:          raw['port']           ? Number(raw['port'])           : undefined,
    dbname:        raw['dbname']         ? String(raw['dbname'])         : undefined,
    charset:       raw['charset']        ? String(raw['charset'])        : undefined,
    serverVersion: raw['server_version'] ? String(raw['server_version']) : undefined,
    useSavepoints: Boolean(raw['use_savepoints'] ?? false),
    logging:       Boolean(raw['logging']        ?? false),
    profiling:     Boolean(raw['profiling']       ?? false),
    wrapperClass:  raw['wrapper_class']  ? String(raw['wrapper_class'])  : undefined,
    driverClass:   raw['driver_class']   ? String(raw['driver_class'])   : undefined,
    persistent:    Boolean(raw['persistent'] ?? false),
    sslEnabled:    sslKey !== undefined,
    replicas,
  };
}

function loadDbalConfig(appPath: string): DbalConnection[] | null {
  const doctrineFile = path.join(appPath, 'config', 'packages', 'doctrine.yaml');
  const raw = parseYamlFile(doctrineFile) as Record<string, unknown> | null;
  if (!raw) return null;

  const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
  const dbal = doctrine['dbal'] as Record<string, unknown> | undefined;
  if (!dbal) return null;

  // Multiple connections
  const connectionsRaw = dbal['connections'] as Record<string, unknown> | undefined;
  if (connectionsRaw) {
    const connections: DbalConnection[] = [];
    for (const [name, def] of Object.entries(connectionsRaw)) {
      if (!def || typeof def !== 'object') continue;
      connections.push(parseConnection(name, def as Record<string, unknown>));
    }
    return connections;
  }

  // Single connection
  return [parseConnection('default', dbal)];
}

// ─── Driver labels ────────────────────────────────────────────────────────────

const DRIVER_LABELS: Record<string, string> = {
  pdo_mysql:  'MySQL/MariaDB (PDO)',
  pdo_pgsql:  'PostgreSQL (PDO)',
  pdo_sqlite: 'SQLite (PDO)',
  pdo_sqlsrv: 'SQL Server (PDO)',
  mysqli:     'MySQL (MySQLi)',
  oci8:       'Oracle (OCI8)',
  ibm_db2:    'IBM DB2',
};

// ─── Tool functions ────────────────────────────────────────────────────────

export function listDbalConfig(appPath: string): McpToolResult {
  try {
    const connections = loadDbalConfig(appPath);

    if (!connections) {
      return {
        content: [{ type: 'text', text: 'doctrine.dbal not found in config/packages/doctrine.yaml.' }],
      };
    }

    let text = `Doctrine DBAL Configuration (${connections.length} connection${connections.length > 1 ? 's' : ''})\n${'='.repeat(60)}\n`;

    for (const conn of connections) {
      text += `\nConnection: ${conn.name}\n`;

      if (conn.url) {
        text += `  URL:            ${conn.url}\n`;
      } else {
        if (conn.driver) text += `  Driver:         ${DRIVER_LABELS[conn.driver] ?? conn.driver}\n`;
        if (conn.host)   text += `  Host:           ${conn.host}${conn.port ? `:${conn.port}` : ''}\n`;
        if (conn.dbname) text += `  Database:       ${conn.dbname}\n`;
      }
      if (conn.charset)       text += `  Charset:        ${conn.charset}\n`;
      if (conn.serverVersion) text += `  Server version: ${conn.serverVersion}\n`;

      const flags: string[] = [];
      if (conn.useSavepoints) flags.push('use_savepoints');
      if (conn.logging)       flags.push('logging');
      if (conn.profiling)     flags.push('profiling');
      if (conn.persistent)    flags.push('persistent');
      if (conn.sslEnabled)    flags.push('SSL');
      if (flags.length > 0)   text += `  Flags:          ${flags.join(', ')}\n`;

      if (conn.wrapperClass) text += `  Wrapper class:  ${conn.wrapperClass.split('\\').pop()}\n`;
      if (conn.driverClass)  text += `  Driver class:   ${conn.driverClass.split('\\').pop()}\n`;

      if (conn.replicas.length > 0) {
        text += `  Read replicas (${conn.replicas.length}):\n`;
        for (const r of conn.replicas) {
          const host = r.host ? `${r.host}${r.port ? `:${r.port}` : ''}` : '(from URL)';
          const db   = r.dbname ? `  db: ${r.dbname}` : '';
          text += `    ${r.name.padEnd(15)} ${host}${db}\n`;
        }
      } else {
        text += `  Read replicas:  none (single-server, no read/write splitting)\n`;
      }
    }

    if (connections.length > 1) {
      text += `\nMultiple connections detected — ensure entity managers reference the correct connection.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDbalStats(appPath: string): McpToolResult {
  try {
    const connections = loadDbalConfig(appPath);

    let text = `DBAL Statistics\n${'='.repeat(40)}\n\n`;

    if (!connections) {
      text += 'doctrine.dbal: not configured\n';
      return { content: [{ type: 'text', text }] };
    }

    const totalReplicas = connections.reduce((s, c) => s + c.replicas.length, 0);
    const withSsl       = connections.filter((c) => c.sslEnabled).length;
    const withLogging   = connections.filter((c) => c.logging).length;
    const drivers       = [...new Set(connections.map((c) => c.driver).filter(Boolean))];

    text += `Connections:    ${connections.length}\n`;
    text += `Driver(s):      ${drivers.map((d) => DRIVER_LABELS[d!] ?? d).join(', ') || 'from URL'}\n`;
    text += `Read replicas:  ${totalReplicas}\n`;
    text += `SSL:            ${withSsl > 0 ? 'yes' : 'no'}\n`;
    text += `Logging:        ${withLogging > 0 ? 'yes' : 'no'}\n`;

    if (totalReplicas === 0) {
      text += `\nNo read replicas — consider adding for read-heavy workloads.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getDbalConfigTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_dbal_config',
      description: 'Show Doctrine DBAL connection config: driver, host, charset, server_version, read replicas, SSL, logging, persistent connections',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_dbal_stats',
      description: 'Show DBAL statistics: connection count, driver, read replica count, SSL, logging flags',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
