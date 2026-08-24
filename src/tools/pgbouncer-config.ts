// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PgBouncerConfigInfo {
  source: string;
  type: 'pool-mode' | 'pool-size' | 'auth' | 'prepared-stmt' | 'connection';
  setting: string;
  value: string;
  issues: string[];
}

function buildPgBouncerConfigInfos(appPath: string): PgBouncerConfigInfo[] {
  const results: PgBouncerConfigInfo[] = [];

  const pgbouncerPaths = [
    path.join(appPath, 'pgbouncer.ini'),
    path.join(appPath, 'pgbouncer', 'pgbouncer.ini'),
    path.join(appPath, 'config', 'pgbouncer.ini'),
    path.join(appPath, 'docker', 'pgbouncer', 'pgbouncer.ini'),
    path.join(appPath, '.docker', 'pgbouncer', 'pgbouncer.ini'),
  ];

  let foundPgBouncer = false;

  for (const pgbouncerPath of pgbouncerPaths) {
    if (!fs.existsSync(pgbouncerPath)) continue;
    let content = '';
    try { content = fs.readFileSync(pgbouncerPath, 'utf-8'); } catch { continue; }

    foundPgBouncer = true;
    const relFile = path.relative(appPath, pgbouncerPath);

    const poolModeMatch = /pool_mode\s*=\s*(\w+)/.exec(content);
    if (poolModeMatch) {
      const poolMode = poolModeMatch[1].trim();
      const poolModeIssues: string[] = [];

      if (poolMode === 'transaction') {
        poolModeIssues.push(
          'pool_mode=transaction breaks prepared statements — ensure PDO::ATTR_EMULATE_PREPARES=true or use PDO_PGSQL with native prepared statements disabled',
        );
      } else if (poolMode === 'statement') {
        poolModeIssues.push(
          'pool_mode=statement is the most restrictive — transactions longer than one statement will fail; only use for simple query workloads',
        );
      }

      results.push({
        source: relFile,
        type: 'pool-mode',
        setting: 'pool_mode',
        value: poolMode,
        issues: poolModeIssues,
      });
    }

    const maxClientConnMatch = /max_client_conn\s*=\s*(\d+)/.exec(content);
    if (maxClientConnMatch) {
      const maxClientConn = parseInt(maxClientConnMatch[1], 10);
      const connIssues: string[] = [];
      if (maxClientConn > 1000) {
        connIssues.push(
          `max_client_conn=${maxClientConn} is very high — PgBouncer can handle many connections but PostgreSQL has connection overhead; ensure PostgreSQL max_connections is set appropriately`,
        );
      }
      results.push({
        source: relFile,
        type: 'pool-size',
        setting: 'max_client_conn',
        value: String(maxClientConn),
        issues: connIssues,
      });
    }

    const authTypeMatch = /auth_type\s*=\s*(\w+)/.exec(content);
    if (authTypeMatch) {
      const authType = authTypeMatch[1].trim();
      const authIssues: string[] = [];
      if (authType === 'trust') {
        authIssues.push(
          'PgBouncer auth_type=trust — any connection from the configured host is allowed without password; use md5 or scram-sha-256',
        );
      }
      results.push({
        source: relFile,
        type: 'auth',
        setting: 'auth_type',
        value: authType,
        issues: authIssues,
      });
    }

    const defaultPoolSizeMatch = /default_pool_size\s*=\s*(\d+)/.exec(content);
    if (defaultPoolSizeMatch) {
      results.push({
        source: relFile,
        type: 'pool-size',
        setting: 'default_pool_size',
        value: defaultPoolSizeMatch[1].trim(),
        issues: [],
      });
    }
  }

  if (!foundPgBouncer) {
    const envFiles = [
      path.join(appPath, '.env'),
      path.join(appPath, '.env.local'),
    ];

    for (const envFile of envFiles) {
      if (!fs.existsSync(envFile)) continue;
      let content = '';
      try { content = fs.readFileSync(envFile, 'utf-8'); } catch { continue; }

      const dbUrlMatch = /DATABASE_URL\s*=\s*(.+)/.exec(content);
      if (dbUrlMatch) {
        const dbUrl = dbUrlMatch[1].trim();
        if (dbUrl.includes(':5432') || dbUrl.includes('postgres://') || dbUrl.includes('postgresql://')) {
          results.push({
            source: path.relative(appPath, envFile),
            type: 'connection',
            setting: 'DATABASE_URL',
            value: 'postgres:5432',
            issues: [
              'No PgBouncer configuration found — for high-traffic PHP applications, PgBouncer reduces PostgreSQL connection overhead; each PHP-FPM worker opens a DB connection',
            ],
          });
        }
        break;
      }
    }
  }

  return results;
}

export function listPgBouncerConfig(appPath: string): McpToolResult {
  try {
    const infos = buildPgBouncerConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PgBouncer configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PgBouncer Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.setting}=${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPgBouncerConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildPgBouncerConfigInfos(appPath);
    let text = `PgBouncer Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Pool-mode:     ${infos.filter((i) => i.type === 'pool-mode').length}\n`;
    text += `Pool-size:     ${infos.filter((i) => i.type === 'pool-size').length}\n`;
    text += `Auth:          ${infos.filter((i) => i.type === 'auth').length}\n`;
    text += `Prepared-stmt: ${infos.filter((i) => i.type === 'prepared-stmt').length}\n`;
    text += `Connection:    ${infos.filter((i) => i.type === 'connection').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPgBouncerConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_pgbouncer_config', description: 'Analyze PgBouncer configuration; warns on transaction pool_mode breaking prepared statements, statement mode restrictions, trust auth, very high max_client_conn, and missing PgBouncer for Postgres apps', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_pgbouncer_config_stats', description: 'Statistics for PgBouncer configuration: counts by type, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
