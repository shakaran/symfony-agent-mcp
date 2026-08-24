// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP FTP/SFTP Patterns Inspector
 *
 * Scans src/**\/*.php for FTP/SFTP usage patterns and .env* files for credentials.
 *
 * Detection:
 * - ftp_connect() — plain FTP (unencrypted); recommends ftp_ssl_connect()
 * - ftp_ssl_connect() — SSL FTP (acceptable)
 * - ftp_login() — checks for hardcoded credentials in nearby lines
 * - ftp_pasv() — flags absence after ftp_connect/ftp_ssl_connect
 * - ftp_put()/ftp_get() with variable filenames — path traversal risk
 * - League Flysystem: FtpAdapter vs SftpV3Adapter/SftpAdapter (prefer SFTP)
 * - ssh2_connect()/ssh2_auth_password()/ssh2_sftp() — SSH2 extension usage
 * - .env* files: FTP_HOST, FTP_USER, FTP_PASSWORD, SFTP_* — masks password values
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpFtpSftpInfo {
  file: string;
  line: number;
  fn: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}


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

function getEnvFiles(appPath: string): string[] {
  const found: string[] = [];
  try {
    for (const entry of fs.readdirSync(appPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (/^\.env/.test(entry.name)) {
        found.push(path.join(appPath, entry.name));
      }
    }
  } catch { /* skip */ }
  return found;
}

function scanEnvFile(filePath: string, appPath: string): PhpFtpSftpInfo[] {
  const raw = safeRead(filePath, appPath);
  if (!raw) return [];
  const relFile = path.relative(appPath, filePath);
  const results: PhpFtpSftpInfo[] = [];
  const lines = raw.split('\n');

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].slice(0, 300);
    const lineNum = idx + 1;

    // FTP_PASSWORD / SFTP_PASSWORD / SFTP_PASS — mask and flag
    if (/\bFTP_PASSWORD\s*=/.test(line) || /\bSFTP_PASSWORD\s*=/.test(line) || /\bSFTP_PASS\s*=/.test(line)) {
      // M-14: password vars are fully redacted regardless of length. Partial
      // masking was dropped because it needed {8,} and skipped $#'" chars.
      const varName = line.match(/\b(FTP_PASSWORD|SFTP_PASSWORD|SFTP_PASS)/)?.[1] ?? 'PASSWORD';
      const masked = `${varName}=***`;
      results.push({
        file: relFile,
        line: lineNum,
        fn: '.env',
        issue: `FTP/SFTP password in env file (${masked}) — ensure this file is in .gitignore and not committed`,
        severity: 'high',
      });
    } else if (/\b(FTP_HOST|FTP_USER|FTP_PORT|SFTP_HOST|SFTP_USER|SFTP_PORT|SFTP_ROOT)\s*=/.test(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        fn: '.env',
        issue: `FTP/SFTP configuration key found: ${line.trim().slice(0, 60)} — ensure credentials use .env.local (not committed)`,
        severity: 'low',
      });
    }
  }

  return results;
}

function scanPhpFile(filePath: string, appPath: string): PhpFtpSftpInfo[] {
  const raw = safeRead(filePath, appPath);
  if (!raw) return [];
  const relFile = path.relative(appPath, filePath);
  const lines = raw.split('\n');
  const results: PhpFtpSftpInfo[] = [];

  // Track connection calls to check for passive mode
  const connectLines: number[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].slice(0, 400);
    const lineNum = idx + 1;

    // Plain FTP
    if (/\bftp_connect\s*\(/.test(line)) {
      connectLines.push(lineNum);
      results.push({
        file: relFile,
        line: lineNum,
        fn: 'ftp_connect',
        issue: 'Plain FTP (ftp_connect) transmits credentials and data unencrypted — use ftp_ssl_connect() or SFTP (ssh2_sftp / League Flysystem SftpV3Adapter)',
        severity: 'high',
      });
    }

    // SSL FTP — acceptable but note it
    if (/\bftp_ssl_connect\s*\(/.test(line)) {
      connectLines.push(lineNum);
      results.push({
        file: relFile,
        line: lineNum,
        fn: 'ftp_ssl_connect',
        issue: 'ftp_ssl_connect() detected — encrypted FTP; verify passive mode (ftp_pasv) is enabled for firewall compatibility',
        severity: 'low',
      });
    }

    // ftp_login — check for hardcoded credentials in surrounding ±5 lines
    if (/\bftp_login\s*\(/.test(line)) {
      const start = Math.max(0, idx - 5);
      const end = Math.min(lines.length - 1, idx + 5);
      const context = lines.slice(start, end + 1).join('\n').slice(0, 800);
      // Hardcoded string literal assigned to $user/$pass/$password/$username
      if (/\$(?:user|username|pass|password)\s*=\s*['"][^'"]{1,100}['"]/.test(context)) {
        results.push({
          file: relFile,
          line: lineNum,
          fn: 'ftp_login',
          issue: 'ftp_login() with nearby hardcoded credential variable — move credentials to environment variables via $_ENV or Symfony secrets',
          severity: 'high',
        });
      } else {
        results.push({
          file: relFile,
          line: lineNum,
          fn: 'ftp_login',
          issue: 'ftp_login() detected — ensure credentials come from environment variables, not hardcoded values',
          severity: 'low',
        });
      }
    }

    // ftp_pasv — note it is present (good)
    if (/\bftp_pasv\s*\(/.test(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        fn: 'ftp_pasv',
        issue: 'ftp_pasv() found — passive mode configured (good for firewall traversal)',
        severity: 'low',
      });
    }

    // ftp_put / ftp_get with variable filenames — path traversal risk
    if (/\bftp_put\s*\([^)]{0,200}\$/.test(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        fn: 'ftp_put',
        issue: 'ftp_put() with variable filename — if the path is user-controlled, validate and sanitize to prevent path traversal (use basename() and whitelist approach)',
        severity: 'medium',
      });
    }
    if (/\bftp_get\s*\([^)]{0,200}\$/.test(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        fn: 'ftp_get',
        issue: 'ftp_get() with variable filename — if the path is user-controlled, validate and sanitize to prevent path traversal',
        severity: 'medium',
      });
    }

    // Flysystem FtpAdapter — recommend SFTP
    if (/\bFtpAdapter\s*\(/.test(line) || /League\\Flysystem\\Ftp\\FtpAdapter/.test(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        fn: 'FtpAdapter',
        issue: 'League Flysystem FtpAdapter (plain FTP) — consider replacing with SftpV3Adapter (league/flysystem-sftp-v3) for encrypted transfers',
        severity: 'medium',
      });
    }

    // Flysystem SftpV3Adapter / SftpAdapter — acceptable, low note
    if (/\bSftpV3Adapter\s*\(/.test(line) || /\bSftpAdapter\s*\(/.test(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        fn: 'SftpAdapter',
        issue: 'League Flysystem SFTP adapter detected (good — encrypted transfer)',
        severity: 'low',
      });
    }

    // SSH2 extension
    if (/\bssh2_connect\s*\(/.test(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        fn: 'ssh2_connect',
        issue: 'ssh2_connect() (SSH2 PECL extension) detected — consider using phpseclib or League Flysystem SftpV3Adapter for better portability and no PECL dependency',
        severity: 'low',
      });
    }
    if (/\bssh2_auth_password\s*\(/.test(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        fn: 'ssh2_auth_password',
        issue: 'ssh2_auth_password() detected — prefer ssh2_auth_pubkey_file() (key-based auth) over password authentication where possible',
        severity: 'medium',
      });
    }
    if (/\bssh2_sftp\s*\(/.test(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        fn: 'ssh2_sftp',
        issue: 'ssh2_sftp() (SSH2 PECL extension) detected — consider League Flysystem SftpV3Adapter for abstracted SFTP access',
        severity: 'low',
      });
    }
  }

  // Check for ftp_connect/ftp_ssl_connect without ftp_pasv in the same file
  if (connectLines.length > 0) {
    const hasPasv = /\bftp_pasv\s*\(/.test(raw);
    if (!hasPasv) {
      for (const connectLine of connectLines) {
        results.push({
          file: relFile,
          line: connectLine,
          fn: 'ftp_connect/ftp_ssl_connect',
          issue: 'FTP connection without ftp_pasv() call in this file — passive mode is needed for firewall and NAT traversal; add ftp_pasv($conn, true) after connecting',
          severity: 'medium',
        });
      }
    }
  }

  return results;
}

function buildPhpFtpSftpInfos(appPath: string): PhpFtpSftpInfo[] {
  const results: PhpFtpSftpInfo[] = [];

  // Scan .env files for credentials
  for (const envFile of getEnvFiles(appPath)) {
    results.push(...scanEnvFile(envFile, appPath));
  }

  // Scan src/ PHP files
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const f of getAllPhpFiles(srcDir)) {
      results.push(...scanPhpFile(f, appPath));
    }
  }

  return results;
}

export function listPhpFtpSftpPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildPhpFtpSftpInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No FTP/SFTP patterns found in src/ PHP files or .env* files.' }] };
    }

    const highSeverity = infos.filter((i) => i.severity === 'high');
    const mediumSeverity = infos.filter((i) => i.severity === 'medium');
    const lowSeverity = infos.filter((i) => i.severity === 'low');

    let text = `PHP FTP/SFTP Pattern Analysis\n${'='.repeat(55)}\n\n`;
    text += `Findings: ${infos.length}  (high: ${highSeverity.length}, medium: ${mediumSeverity.length}, low: ${lowSeverity.length})\n\n`;

    for (const info of [...highSeverity, ...mediumSeverity, ...lowSeverity]) {
      const badge = info.severity === 'high' ? '[HIGH]  ' : info.severity === 'medium' ? '[MED]   ' : '[LOW]   ';
      text += `${badge} ${info.file}:${info.line}  fn: ${info.fn}\n`;
      text += `         ${info.issue}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFtpSftpPatternsStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpFtpSftpInfos(appPath);

    const highCount = infos.filter((i) => i.severity === 'high').length;
    const medCount = infos.filter((i) => i.severity === 'medium').length;
    const lowCount = infos.filter((i) => i.severity === 'low').length;
    const plainFtp = infos.filter((i) => i.fn === 'ftp_connect').length;
    const sslFtp = infos.filter((i) => i.fn === 'ftp_ssl_connect').length;
    const sftpAdapters = infos.filter((i) => i.fn === 'SftpAdapter').length;
    const ftpAdapters = infos.filter((i) => i.fn === 'FtpAdapter').length;
    const hardcodedCreds = infos.filter((i) => i.issue.includes('hardcoded credential')).length;
    const envCreds = infos.filter((i) => i.file.includes('.env')).length;

    let text = `PHP FTP/SFTP Patterns Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings:            ${infos.length}\n`;
    text += `  High severity:           ${highCount}\n`;
    text += `  Medium severity:         ${medCount}\n`;
    text += `  Low severity:            ${lowCount}\n`;
    text += `\nPattern breakdown:\n`;
    text += `  Plain FTP (ftp_connect): ${plainFtp}\n`;
    text += `  SSL FTP:                 ${sslFtp}\n`;
    text += `  FtpAdapter (Flysystem):  ${ftpAdapters}\n`;
    text += `  SftpAdapter (Flysystem): ${sftpAdapters}\n`;
    text += `  Hardcoded FTP creds:     ${hardcodedCreds}\n`;
    text += `  Env file FTP/SFTP keys:  ${envCreds}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFtpSftpPatternsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_ftp_sftp_patterns',
      description: 'Scan src/ PHP files and .env* for FTP/SFTP patterns: plain FTP vs SSL FTP vs SFTP, hardcoded credentials, missing passive mode, path traversal risk in ftp_put/ftp_get, League Flysystem adapter recommendations, SSH2 extension usage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_ftp_sftp_patterns_stats',
      description: 'Show FTP/SFTP pattern statistics: finding counts by severity (high/medium/low), breakdown by pattern type (plain FTP, SSL FTP, Flysystem adapters), hardcoded credential count, env file keys',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
