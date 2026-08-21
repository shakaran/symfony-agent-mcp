/**
 * PHP Socket Programming Issue Scanner
 *
 * Scans src/**\/*.php for PHP socket programming problems:
 *   1. socket_create()/fsockopen()/stream_socket_client() without timeout — MEDIUM
 *   2. socket_read()/socket_recv() without explicit length limit — MEDIUM
 *   3. Missing socket_close() in finally block — MEDIUM
 *   4. Hardcoded IP/port combinations — LOW
 *   5. stream_socket_server() without TLS — MEDIUM
 *
 * Masks sensitive data (IPs) in output using [MASKED].
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SocketProgrammingInfo {
  file: string;
  line: number;
  pattern: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  issue: string;
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

// ─── Pattern 1: socket creation without timeout ───────────────────────────────

function checkSocketCreationWithoutTimeout(
  lines: string[],
  lineIdx: number,
  relFile: string,
): SocketProgrammingInfo | null {
  const line = lines[lineIdx];

  const hasSocketCreate = /\bsocket_create\s*\(/.test(line);
  const hasFsockopen    = /\bfsockopen\s*\(/.test(line);
  const hasStreamClient = /\bstream_socket_client\s*\(/.test(line);

  if (!hasSocketCreate && !hasFsockopen && !hasStreamClient) return null;

  const start = Math.max(0, lineIdx - 2);
  const end   = Math.min(lines.length - 1, lineIdx + 5);
  const window = lines.slice(start, end + 1).join('\n');

  const hasSocketOpt    = window.includes('socket_set_option(');
  const hasStreamTimeout = window.includes('stream_set_timeout(');

  // For fsockopen: check if 4th/5th parameter (timeout) is provided in the call
  // fsockopen(host, port, &errno, &errstr, timeout)
  let hasFsockopenTimeout = false;
  if (hasFsockopen) {
    // Count commas in the fsockopen call — 4 commas means 5 params (timeout present)
    const fsockopenMatch = /\bfsockopen\s*\(([^)]{0,500})\)/.exec(line);
    if (fsockopenMatch) {
      const args = fsockopenMatch[1];
      const commaCount = (args.match(/,/g) ?? []).length;
      hasFsockopenTimeout = commaCount >= 4;
    }
  }

  if (hasSocketOpt || hasStreamTimeout || hasFsockopenTimeout) return null;

  let fn = 'socket_create';
  if (hasFsockopen) fn = 'fsockopen';
  if (hasStreamClient) fn = 'stream_socket_client';

  return {
    file: relFile,
    line: lineIdx + 1,
    pattern: 'socket-no-timeout',
    severity: 'medium',
    issue: `${fn}() called without timeout — MEDIUM: connections may block indefinitely; set a timeout via socket_set_option() / stream_set_timeout() or the timeout parameter of fsockopen()`,
  };
}

// ─── Pattern 2: socket_read/socket_recv without length limit ─────────────────

function checkSocketReadWithoutLengthLimit(
  line: string,
  lineIdx: number,
  relFile: string,
): SocketProgrammingInfo | null {
  const hasSocketRead = /\bsocket_read\s*\(/.test(line);
  const hasSocketRecv = /\bsocket_recv\s*\(/.test(line);

  if (!hasSocketRead && !hasSocketRecv) return null;

  const fn = hasSocketRead ? 'socket_read' : 'socket_recv';

  // Extract arguments from the call
  const callMatch = new RegExp(`\\b${fn}\\s*\\(([^)]{0,500})\\)`).exec(line);
  if (callMatch) {
    const args = callMatch[1].trim();
    const parts = args.split(',');
    // socket_read(socket, length) — check if length argument exists
    if (parts.length >= 2) {
      const lengthArg = parts[1].trim();
      // Check if the length is a very large number (>65536)
      const numMatch = /^\s*(\d+)\s*$/.exec(lengthArg);
      if (numMatch) {
        const lengthVal = parseInt(numMatch[1], 10);
        if (lengthVal > 65536) {
          return {
            file: relFile,
            line: lineIdx + 1,
            pattern: 'socket-large-read',
            severity: 'medium',
            issue: `${fn}() called with very large length limit (${lengthVal} > 65536) — MEDIUM: excessively large read buffers can lead to memory exhaustion; cap at 65536 bytes or less`,
          };
        }
      }
      // Has a second argument that isn't obviously too large — OK
      return null;
    }
  }

  // No length argument found
  return {
    file: relFile,
    line: lineIdx + 1,
    pattern: 'socket-no-length',
    severity: 'medium',
    issue: `${fn}() called without explicit length limit — MEDIUM: unbounded reads can cause memory exhaustion; always specify a maximum byte length (e.g. 4096 or 65536)`,
  };
}

// ─── Pattern 3: Missing socket_close() in file ────────────────────────────────

function checkMissingSocketClose(
  content: string,
  relFile: string,
): SocketProgrammingInfo | null {
  const hasSocketCreate = /\bsocket_create\s*\(/.test(content);
  const hasFsockopen    = /\bfsockopen\s*\(/.test(content);

  if (!hasSocketCreate && !hasFsockopen) return null;

  const hasSocketClose = /\bsocket_close\s*\(/.test(content);
  const hasFclose      = /\bfclose\s*\(/.test(content);

  if (hasSocketClose || hasFclose) return null;

  // Find the line where socket is created for reporting
  const lines = content.split('\n');
  let createLine = 1;
  for (let i = 0; i < lines.length; i++) {
    if (/\bsocket_create\s*\(/.test(lines[i]) || /\bfsockopen\s*\(/.test(lines[i])) {
      createLine = i + 1;
      break;
    }
  }

  const fn = hasSocketCreate ? 'socket_create' : 'fsockopen';

  return {
    file: relFile,
    line: createLine,
    pattern: 'socket-no-close',
    severity: 'medium',
    issue: `${fn}() used but no socket_close() / fclose() found in the file — MEDIUM: socket resources are not explicitly released; wrap in try/finally and call socket_close() or fclose() to prevent resource leaks`,
  };
}

// ─── Pattern 4: Hardcoded IP/port combinations ────────────────────────────────

// Well-known service ports to flag
const SENSITIVE_PORTS = [':6379', ':3306', ':5432', ':6380', ':27017'];

function checkHardcodedIpPort(
  line: string,
  lineIdx: number,
  relFile: string,
): SocketProgrammingInfo | null {
  const trimmed = line.trim();

  // Skip comment lines
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return null;

  const hasLocalhost = trimmed.includes("'127.0.0.1'") || trimmed.includes('"127.0.0.1"');
  const hasAnyAddr   = trimmed.includes("'0.0.0.0'")   || trimmed.includes('"0.0.0.0"');
  const hasLocalhostName = trimmed.includes("'localhost'") || trimmed.includes('"localhost"');

  if (!hasLocalhost && !hasAnyAddr && !hasLocalhostName) return null;

  let portFound = false;
  for (const port of SENSITIVE_PORTS) {
    if (trimmed.includes(port)) {
      portFound = true;
      break;
    }
  }

  if (!portFound) return null;

  return {
    file: relFile,
    line: lineIdx + 1,
    pattern: 'hardcoded-ip-port',
    severity: 'low',
    issue: 'Hardcoded IP address ([MASKED]) with known service port found — LOW: extract connection details to environment variables (DATABASE_HOST, REDIS_URL, etc.) for portability and security',
  };
}

// ─── Pattern 5: stream_socket_server() without TLS ────────────────────────────

function checkStreamSocketServerWithoutTls(
  line: string,
  lineIdx: number,
  relFile: string,
): SocketProgrammingInfo | null {
  if (!/\bstream_socket_server\s*\(/.test(line)) return null;

  // Check string argument for ssl:// or tls:// prefix
  // Extract first string argument
  const argMatch = /\bstream_socket_server\s*\(\s*['"]([^'"]{0,200})['"]/.exec(line);
  if (argMatch) {
    const socketAddr = argMatch[1];
    if (socketAddr.startsWith('ssl://') || socketAddr.startsWith('tls://')) return null;
  } else {
    // If we can't determine the argument, check for ssl:// or tls:// anywhere in the line
    if (line.includes('ssl://') || line.includes('tls://')) return null;
  }

  return {
    file: relFile,
    line: lineIdx + 1,
    pattern: 'socket-server-no-tls',
    severity: 'medium',
    issue: 'stream_socket_server() without ssl:// or tls:// transport — MEDIUM: server is accepting unencrypted connections; use stream_socket_server("tls://0.0.0.0:PORT", ...) with an SSL context for encrypted communication',
  };
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string, appPath: string): SocketProgrammingInfo[] {
  const content = safeRead(filePath, appPath);
  if (content === null) return [];

  const relFile = path.relative(appPath, filePath);
  const lines = content.split('\n');
  const results: SocketProgrammingInfo[] = [];

  // File-level check (pattern 3)
  const noCloseIssue = checkMissingSocketClose(content, relFile);
  if (noCloseIssue !== null) results.push(noCloseIssue);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pattern 1
    const timeoutIssue = checkSocketCreationWithoutTimeout(lines, i, relFile);
    if (timeoutIssue !== null) results.push(timeoutIssue);

    // Pattern 2
    const readIssue = checkSocketReadWithoutLengthLimit(line, i, relFile);
    if (readIssue !== null) results.push(readIssue);

    // Pattern 4
    const ipPortIssue = checkHardcodedIpPort(line, i, relFile);
    if (ipPortIssue !== null) results.push(ipPortIssue);

    // Pattern 5
    const tlsIssue = checkStreamSocketServerWithoutTls(line, i, relFile);
    if (tlsIssue !== null) results.push(tlsIssue);
  }

  return results;
}

function buildSocketProgrammingInfos(appPath: string): SocketProgrammingInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: SocketProgrammingInfo[] = [];

  if (fs.existsSync(srcDir)) {
    const files = collectPhpFiles(srcDir, appPath);
    for (const filePath of files) {
      results.push(...analyzeFile(filePath, appPath));
    }
  }

  // Sort by severity then file then line
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return results.sort((a, b) =>
    (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line,
  );
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listPhpSocketProgramming(appPath: string): McpToolResult {
  try {
    const items = buildSocketProgrammingInfos(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHP socket programming issues found in src/.\n\n' +
            'Best practices:\n' +
            '  Timeouts:   socket_set_option($sock, SOL_SOCKET, SO_RCVTIMEO, [\'sec\' => 5, \'usec\' => 0])\n' +
            '  Encryption: stream_socket_server("tls://0.0.0.0:443", ...)\n' +
            '  Cleanup:    try { ... } finally { socket_close($sock); }\n' +
            '  Config:     store host/port in env vars (REDIS_HOST, DB_PORT, etc.)',
        }],
      };
    }

    const critical = items.filter((i) => i.severity === 'critical');
    const high     = items.filter((i) => i.severity === 'high');
    const medium   = items.filter((i) => i.severity === 'medium');
    const low      = items.filter((i) => i.severity === 'low');

    let text = `PHP Socket Programming Issue Scan\n${'='.repeat(55)}\n`;
    text += `  Total findings:    ${items.length}\n`;
    text += `  Critical:          ${critical.length}\n`;
    text += `  High:              ${high.length}\n`;
    text += `  Medium:            ${medium.length}\n`;
    text += `  Low:               ${low.length}\n\n`;

    for (const item of items) {
      text += `[${item.severity.toUpperCase()}] ${item.file}:${item.line}  pattern=${item.pattern}\n`;
      text += `  ${item.issue}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpSocketProgrammingStats(appPath: string): McpToolResult {
  try {
    const items = buildSocketProgrammingInfos(appPath);

    const bySeverity = {
      critical: items.filter((i) => i.severity === 'critical').length,
      high:     items.filter((i) => i.severity === 'high').length,
      medium:   items.filter((i) => i.severity === 'medium').length,
      low:      items.filter((i) => i.severity === 'low').length,
    };

    const byPattern: Record<string, number> = {};
    for (const item of items) {
      byPattern[item.pattern] = (byPattern[item.pattern] ?? 0) + 1;
    }

    const filesAffected = new Set(items.map((i) => i.file)).size;

    const stats = {
      total: items.length,
      bySeverity,
      byPattern,
      filesAffected,
    };

    let text = `PHP Socket Programming Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings:           ${items.length}\n`;
    text += `Files affected:           ${filesAffected}\n\n`;
    text += `By severity:\n`;
    text += `  Critical:               ${bySeverity.critical}\n`;
    text += `  High:                   ${bySeverity.high}\n`;
    text += `  Medium:                 ${bySeverity.medium}\n`;
    text += `  Low:                    ${bySeverity.low}\n\n`;
    text += `By pattern:\n`;
    for (const [pattern, count] of Object.entries(byPattern)) {
      text += `  ${pattern}: ${count}\n`;
    }
    text += `\n${JSON.stringify(stats, null, 2)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function getPhpSocketProgrammingTools(): Array<{
  name: string;
  description: string;
  inputSchema: object;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_socket_programming',
      description: 'Scan PHP src/ for socket programming issues: socket_create/fsockopen/stream_socket_client without timeout (MEDIUM), socket_read/socket_recv without length limit (MEDIUM), missing socket_close/fclose (MEDIUM), hardcoded IP/port combinations (LOW), stream_socket_server without TLS (MEDIUM) — masks IP addresses in output',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_socket_programming_stats',
      description: 'Statistics for PHP socket programming findings: total count, bySeverity (critical/high/medium/low), byPattern breakdown, filesAffected count — returned as both human-readable text and JSON',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_socket_programming_tools',
      description: 'List available PHP socket programming tool definitions for MCP registration',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ];
}
