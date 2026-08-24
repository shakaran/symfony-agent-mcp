// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine DBAL driverOptions Inspector
 *
 * Scans config/**\/*.yaml (especially doctrine.yaml) for DBAL driverOptions issues:
 *   - PDO::ATTR_EMULATE_PREPARES set to true (SQL injection risk)
 *   - PDO::ATTR_STRINGIFY_FETCHES set to true (type safety loss)
 *   - charset: utf8 instead of driverOptions SET NAMES utf8mb4
 *   - PDO::ATTR_ERRMODE not set to ERRMODE_EXCEPTION
 *   - connectTimeout / ATTR_TIMEOUT missing
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DbalConnectionInfo {
  file: string;
  connectionName: string;
  driver: string;
  charset: string;
  driverOptions: Record<string, string>;
  hasEmulatePrepares: boolean;
  emulatePreparesValue: string;
  hasStringifyFetches: boolean;
  stringifyFetchesValue: string;
  hasErrMode: boolean;
  errModeValue: string;
  hasConnectTimeout: boolean;
  connectTimeoutValue: string;
  issues: string[];
}

function getAllYamlFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...getAllYamlFiles(full));
      } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

// PDO attribute constants — numeric values used in YAML
const PDO_ATTR_EMULATE_PREPARES = '20';   // PDO::ATTR_EMULATE_PREPARES
const PDO_ATTR_STRINGIFY_FETCHES = '17';  // PDO::ATTR_STRINGIFY_FETCHES
const PDO_ATTR_ERRMODE = '3';             // PDO::ATTR_ERRMODE
const PDO_ERRMODE_EXCEPTION = '2';        // PDO::ERRMODE_EXCEPTION
const PDO_ATTR_TIMEOUT = '2';             // PDO::ATTR_TIMEOUT (note: same numeric as ERRMODE_EXCEPTION for lookup)

function extractDriverOptions(block: string): Record<string, string> {
  const opts: Record<string, string> = {};
  const driverOptsSection = /driverOptions:\s*\n((?:\s+\S[^\n]*\n)*)/m.exec(block) ??
                            /driver_options:\s*\n((?:\s+\S[^\n]*\n)*)/m.exec(block);
  if (!driverOptsSection) return opts;

  const lines = driverOptsSection[1].split('\n');
  for (const line of lines) {
    const kvMatch = /^\s+(\d+|PDO::\w+|\w+):\s*(.+)$/.exec(line);
    if (kvMatch) {
      opts[kvMatch[1].trim()] = kvMatch[2].trim().replace(/['"]/g, '');
    }
  }
  return opts;
}

function analyzeConnection(connectionName: string, block: string, file: string): DbalConnectionInfo {
  const driverMatch = /driver:\s*(\S+)/m.exec(block);
  const charsetMatch = /charset:\s*(\S+)/m.exec(block);
  const driver = driverMatch ? driverMatch[1] : 'pdo_mysql';
  const charset = charsetMatch ? charsetMatch[1].replace(/['"]/g, '') : '';

  const driverOptions = extractDriverOptions(block);

  // Check ATTR_EMULATE_PREPARES (numeric 20 or PDO::ATTR_EMULATE_PREPARES)
  const emulateValue = driverOptions[PDO_ATTR_EMULATE_PREPARES] ??
                       driverOptions['PDO::ATTR_EMULATE_PREPARES'] ??
                       driverOptions['ATTR_EMULATE_PREPARES'] ?? '';
  const hasEmulatePrepares = emulateValue !== '';
  const emulatePreparesValue = emulateValue;

  // Check ATTR_STRINGIFY_FETCHES (numeric 17)
  const stringifyValue = driverOptions[PDO_ATTR_STRINGIFY_FETCHES] ??
                         driverOptions['PDO::ATTR_STRINGIFY_FETCHES'] ??
                         driverOptions['ATTR_STRINGIFY_FETCHES'] ?? '';
  const hasStringifyFetches = stringifyValue !== '';
  const stringifyFetchesValue = stringifyValue;

  // Check ATTR_ERRMODE (numeric 3)
  const errModeValue = driverOptions[PDO_ATTR_ERRMODE] ??
                       driverOptions['PDO::ATTR_ERRMODE'] ??
                       driverOptions['ATTR_ERRMODE'] ?? '';
  const hasErrMode = errModeValue !== '';

  // Check timeout: connectTimeout or ATTR_TIMEOUT
  const connectTimeoutValue = driverOptions['connectTimeout'] ??
                               driverOptions[PDO_ATTR_TIMEOUT] ??
                               driverOptions['PDO::ATTR_TIMEOUT'] ?? '';
  const hasConnectTimeout = connectTimeoutValue !== '' ||
                            block.includes('connectTimeout:') ||
                            block.includes('connect_timeout:');

  const issues: string[] = [];

  if (hasEmulatePrepares && (emulatePreparesValue === 'true' || emulatePreparesValue === '1')) {
    issues.push('PDO::ATTR_EMULATE_PREPARES is set to true — disables real prepared statements, enabling SQL injection via type juggling; set to false');
  }

  if (hasStringifyFetches && (stringifyFetchesValue === 'true' || stringifyFetchesValue === '1')) {
    issues.push('PDO::ATTR_STRINGIFY_FETCHES is true — all column values returned as strings, losing PHP type safety for integers/booleans; set to false');
  }

  if (charset === 'utf8' && driver.includes('mysql')) {
    issues.push('charset: utf8 is set — this does NOT reliably set the connection charset via PDO; use driverOptions with "SET NAMES utf8mb4" or charset: utf8mb4 and verify PDO behavior');
  }

  if (!hasErrMode) {
    issues.push('PDO::ATTR_ERRMODE not configured — default mode is PDO::ERRMODE_SILENT (errors suppressed); add driverOptions: { 3: 2 } for ERRMODE_EXCEPTION');
  } else if (errModeValue !== PDO_ERRMODE_EXCEPTION && errModeValue !== 'PDO::ERRMODE_EXCEPTION' && errModeValue !== '2') {
    issues.push(`PDO::ATTR_ERRMODE is set to "${errModeValue}" — recommended value is PDO::ERRMODE_EXCEPTION (2) to surface DB errors as exceptions`);
  }

  if (!hasConnectTimeout) {
    issues.push('connectTimeout not configured — connection to unreachable DB host will hang indefinitely; add connectTimeout: 5 in driverOptions');
  }

  return {
    file,
    connectionName,
    driver,
    charset,
    driverOptions,
    hasEmulatePrepares,
    emulatePreparesValue,
    hasStringifyFetches,
    stringifyFetchesValue,
    hasErrMode,
    errModeValue,
    hasConnectTimeout,
    connectTimeoutValue,
    issues,
  };
}

function scanDoctrineYamls(appPath: string): DbalConnectionInfo[] {
  const resolvedBase = path.resolve(appPath);
  const configDir = path.join(resolvedBase, 'config');
  if (!fs.existsSync(configDir)) return [];

  const results: DbalConnectionInfo[] = [];

  for (const yamlFile of getAllYamlFiles(configDir)) {
    if (!path.resolve(yamlFile).startsWith(resolvedBase + path.sep)) continue;

    let content = '';
    try { content = fs.readFileSync(yamlFile, 'utf-8'); } catch { continue; }

    if (!content.includes('doctrine') && !content.includes('dbal')) continue;

    const relFile = path.relative(appPath, yamlFile);

    // Single connection (doctrine.dbal.url/dsn/driver)
    if (content.includes('dbal:') && !content.includes('connections:')) {
      const dbalSection = /dbal:\s*\n((?:[ \t]+[^\n]*\n)*)/m.exec(content);
      if (dbalSection) {
        results.push(analyzeConnection('default', dbalSection[1], relFile));
      }
      continue;
    }

    // Multiple connections: doctrine.dbal.connections
    const connectionsSection = /connections:\s*\n((?:[ \t]+[^\n]*\n)*)/m.exec(content);
    if (!connectionsSection) continue;

    const connBlock = connectionsSection[1];
    const connBlockRegex = /^ {8}(\w[\w_]*):\s*\n((?:[ \t]{10,}[^\n]*\n)*)/gm;
    let m: RegExpExecArray | null;
    while ((m = connBlockRegex.exec(connBlock)) !== null) {
      results.push(analyzeConnection(m[1], m[2], relFile));
    }
  }

  return results;
}

export function listDoctrineDbalDriveroptions(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const connections = scanDoctrineYamls(appPath);

    if (connections.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine DBAL configuration found.\n\nExpected in config/packages/doctrine.yaml:\n  doctrine:\n    dbal:\n      driver: pdo_mysql\n      charset: utf8mb4\n      driverOptions:\n        3: 2       # PDO::ATTR_ERRMODE => ERRMODE_EXCEPTION\n        20: false  # PDO::ATTR_EMULATE_PREPARES => false\n        connectTimeout: 5',
        }],
      };
    }

    let text = `Doctrine DBAL driverOptions Audit\n${'='.repeat(55)}\n\n`;

    for (const conn of connections) {
      text += `Connection: ${conn.connectionName}  (${conn.file})\n`;
      text += `  Driver:  ${conn.driver}\n`;
      text += `  Charset: ${conn.charset || '(not set)'}\n`;

      const SENSITIVE_OPTS = /password|ssl_key|ssl_cert|ssl_ca|sslkey|sslcert|sslca|auth|credential|private|\bpass\b|\bkey\b|\btoken\b|\bdsn\b|\bcert\b/i;
      const optKeys = Object.keys(conn.driverOptions);
      if (optKeys.length > 0) {
        text += `  driverOptions: ${optKeys.map((k) => `${k}=${SENSITIVE_OPTS.test(k) ? '***' : conn.driverOptions[k]}`).join(', ')}\n`;
      } else {
        text += `  driverOptions: (none configured)\n`;
      }

      text += `  ATTR_EMULATE_PREPARES: ${conn.hasEmulatePrepares ? conn.emulatePreparesValue : '(not set)'}\n`;
      text += `  ATTR_STRINGIFY_FETCHES: ${conn.hasStringifyFetches ? conn.stringifyFetchesValue : '(not set)'}\n`;
      text += `  ATTR_ERRMODE: ${conn.hasErrMode ? conn.errModeValue : '(not set)'}\n`;
      text += `  connectTimeout: ${conn.hasConnectTimeout ? conn.connectTimeoutValue || 'yes' : '(not set)'}\n`;

      if (conn.issues.length > 0) {
        text += `  Issues (${conn.issues.length}):\n`;
        for (const issue of conn.issues) {
          text += `    - ${issue}\n`;
        }
      } else {
        text += `  [OK — no issues]\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineDbalDriveroptionsStats(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const connections = scanDoctrineYamls(appPath);

    let text = `Doctrine DBAL driverOptions Stats\n${'='.repeat(40)}\n\n`;
    text += `Connections found:              ${connections.length}\n`;
    text += `With EMULATE_PREPARES=true:     ${connections.filter((c) => c.emulatePreparesValue === 'true' || c.emulatePreparesValue === '1').length}\n`;
    text += `With STRINGIFY_FETCHES=true:    ${connections.filter((c) => c.stringifyFetchesValue === 'true' || c.stringifyFetchesValue === '1').length}\n`;
    text += `Without ERRMODE configured:     ${connections.filter((c) => !c.hasErrMode).length}\n`;
    text += `Without connectTimeout:         ${connections.filter((c) => !c.hasConnectTimeout).length}\n`;
    text += `Using charset: utf8 (not utf8mb4): ${connections.filter((c) => c.charset === 'utf8').length}\n`;
    text += `Connections with issues:        ${connections.filter((c) => c.issues.length > 0).length}\n`;
    text += `Total issues:                   ${connections.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineDbalDriveroptionsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_dbal_driveroptions',
      description: 'Audit Doctrine DBAL driverOptions: ATTR_EMULATE_PREPARES=true (SQL injection risk), ATTR_STRINGIFY_FETCHES=true (type loss), charset: utf8 vs utf8mb4, missing ERRMODE_EXCEPTION, missing connectTimeout',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_dbal_driveroptions_stats',
      description: 'Statistics for Doctrine DBAL driverOptions: connection count, emulate-prepares enabled, stringify-fetches enabled, missing errmode, missing timeout',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
