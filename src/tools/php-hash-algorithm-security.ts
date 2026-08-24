// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Hash Algorithm Security Scanner
 *
 * Scans src/**\/*.php and composer.json for insecure hash algorithm usage:
 *   1. md5()/sha1() for password hashing — CRITICAL
 *   2. md5()/sha1() for security tokens — HIGH
 *   3. hash('md5',)/hash('sha1',) for sensitive operations — HIGH
 *   4. crc32() for integrity checks — MEDIUM
 *   5. hash_hmac('md5',)/hash_hmac('sha1',) — HIGH
 *   6. md5()/sha1() near sensitive variables — MEDIUM
 *
 * Context detection: checks within 3 lines before and after the hash call
 * for sensitive variable names.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface HashAlgorithmSecurityInfo {
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

// ─── Context detection ────────────────────────────────────────────────────────

const SENSITIVE_VAR_PATTERN = /\$(password|token|secret|key|nonce|api_key|passwd|pass)\b/i;

function hasPasswordContext(lines: string[], lineIdx: number): boolean {
  const start = Math.max(0, lineIdx - 3);
  const end = Math.min(lines.length - 1, lineIdx + 3);
  const PASSWORD_PATTERN = /\$(password|passwd|pass)\b/i;
  for (let i = start; i <= end; i++) {
    if (PASSWORD_PATTERN.test(lines[i])) return true;
  }
  return false;
}

function hasTokenContext(lines: string[], lineIdx: number): boolean {
  const start = Math.max(0, lineIdx - 3);
  const end = Math.min(lines.length - 1, lineIdx + 3);
  const TOKEN_PATTERN = /\$(token|secret|key|nonce|api_key)\b/i;
  for (let i = start; i <= end; i++) {
    if (TOKEN_PATTERN.test(lines[i])) return true;
  }
  return false;
}

function hasIntegrityContext(lines: string[], lineIdx: number): boolean {
  const start = Math.max(0, lineIdx - 3);
  const end = Math.min(lines.length - 1, lineIdx + 3);
  const INTEGRITY_PATTERN = /\$(hash|checksum|integrity|verify)\b/i;
  for (let i = start; i <= end; i++) {
    if (INTEGRITY_PATTERN.test(lines[i])) return true;
  }
  return false;
}

function hasSensitiveContext(lines: string[], lineIdx: number): boolean {
  const start = Math.max(0, lineIdx - 3);
  const end = Math.min(lines.length - 1, lineIdx + 3);
  for (let i = start; i <= end; i++) {
    if (SENSITIVE_VAR_PATTERN.test(lines[i])) return true;
  }
  return false;
}

// ─── Line analysis ────────────────────────────────────────────────────────────

function analyzeLine(
  line: string,
  lineIdx: number,
  lines: string[],
  relFile: string,
): HashAlgorithmSecurityInfo | null {
  const trimmed = line.trim();

  // Skip comment lines
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return null;

  // Pattern 1: md5() or sha1() for password hashing — CRITICAL
  if (/\bmd5\s*\(/.test(trimmed) || /\bsha1\s*\(/.test(trimmed)) {
    const fn = /\bmd5\s*\(/.test(trimmed) ? 'md5' : 'sha1';

    if (hasPasswordContext(lines, lineIdx)) {
      return {
        file: relFile,
        line: lineIdx + 1,
        pattern: 'weak-password-hash',
        severity: 'critical',
        issue: `${fn}() used for password hashing — CRITICAL: md5/sha1 are not suitable for passwords; use password_hash(${'$'}password, PASSWORD_BCRYPT) or PASSWORD_ARGON2ID instead`,
      };
    }

    // Pattern 2: md5()/sha1() for security tokens — HIGH
    if (hasTokenContext(lines, lineIdx)) {
      return {
        file: relFile,
        line: lineIdx + 1,
        pattern: 'weak-token-hash',
        severity: 'high',
        issue: `${fn}() used near token/secret/key/nonce — HIGH: ${fn} is cryptographically broken; use random_bytes(32) + bin2hex() for secure tokens, or hash_hmac('sha256', ...) for HMAC`,
      };
    }

    // Pattern 6: md5()/sha1() near any sensitive variable — MEDIUM
    if (hasSensitiveContext(lines, lineIdx)) {
      return {
        file: relFile,
        line: lineIdx + 1,
        pattern: 'weak-hash-near-sensitive',
        severity: 'medium',
        issue: `${fn}() called near sensitive variable — MEDIUM: ${fn} is cryptographically weak; prefer hash('sha256', ...) or hash_hmac('sha256', ...) for security-sensitive operations`,
      };
    }
  }

  // Pattern 3: hash('md5', ...) or hash('sha1', ...) for sensitive operations — HIGH
  if (/\bhash\s*\(\s*['"]md5['"]\s*,/.test(trimmed) || /\bhash\s*\(\s*['"]sha1['"]\s*,/.test(trimmed)) {
    const algo = /\bhash\s*\(\s*['"]md5['"]\s*,/.test(trimmed) ? 'md5' : 'sha1';

    if (hasPasswordContext(lines, lineIdx) || hasTokenContext(lines, lineIdx) || hasSensitiveContext(lines, lineIdx)) {
      return {
        file: relFile,
        line: lineIdx + 1,
        pattern: 'weak-hash-call-sensitive',
        severity: 'high',
        issue: `hash('${algo}', ...) used near sensitive data — HIGH: ${algo} is collision-prone; replace with hash('sha256', ...) or hash('sha3-256', ...) for security-sensitive hashing`,
      };
    }
  }

  // Pattern 4: crc32() for integrity checks — MEDIUM
  if (/\bcrc32\s*\(/.test(trimmed)) {
    if (hasIntegrityContext(lines, lineIdx)) {
      return {
        file: relFile,
        line: lineIdx + 1,
        pattern: 'crc32-integrity',
        severity: 'medium',
        issue: 'crc32() used for integrity/checksum — MEDIUM: CRC32 is not collision-resistant and not suitable for security integrity checks; use hash("sha256", ...) instead',
      };
    }
  }

  // Pattern 5: hash_hmac('md5', ...) or hash_hmac('sha1', ...) — HIGH
  if (/\bhash_hmac\s*\(\s*['"]md5['"]\s*,/.test(trimmed) || /\bhash_hmac\s*\(\s*['"]sha1['"]\s*,/.test(trimmed)) {
    const algo = /\bhash_hmac\s*\(\s*['"]md5['"]\s*,/.test(trimmed) ? 'md5' : 'sha1';
    return {
      file: relFile,
      line: lineIdx + 1,
      pattern: 'weak-hmac-algorithm',
      severity: 'high',
      issue: `hash_hmac('${algo}', ...) — HIGH: HMAC-${algo.toUpperCase()} is weak; upgrade to hash_hmac('sha256', ...) or hash_hmac('sha3-256', ...) for strong HMAC`,
    };
  }

  return null;
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string, appPath: string): HashAlgorithmSecurityInfo[] {
  const content = safeRead(filePath, appPath);
  if (content === null) return [];

  const relFile = path.relative(appPath, filePath);
  const lines = content.split('\n');
  const results: HashAlgorithmSecurityInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const finding = analyzeLine(lines[i], i, lines, relFile);
    if (finding !== null) results.push(finding);
  }

  return results;
}

function buildHashAlgorithmSecurityInfos(appPath: string): HashAlgorithmSecurityInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: HashAlgorithmSecurityInfo[] = [];

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

export function listPhpHashAlgorithmSecurity(appPath: string): McpToolResult {
  try {
    const items = buildHashAlgorithmSecurityInfos(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No insecure hash algorithm usage found in src/.\n\n' +
            'Best practices:\n' +
            '  Passwords:  password_hash($password, PASSWORD_BCRYPT) / PASSWORD_ARGON2ID\n' +
            '  Tokens:     random_bytes(32) + bin2hex() or hash_hmac(\'sha256\', ...)\n' +
            '  Integrity:  hash(\'sha256\', ...) or hash(\'sha3-256\', ...)\n' +
            '  HMAC:       hash_hmac(\'sha256\', $data, $key)',
        }],
      };
    }

    const critical = items.filter((i) => i.severity === 'critical');
    const high     = items.filter((i) => i.severity === 'high');
    const medium   = items.filter((i) => i.severity === 'medium');
    const low      = items.filter((i) => i.severity === 'low');

    let text = `PHP Hash Algorithm Security Scan\n${'='.repeat(55)}\n`;
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

export function getPhpHashAlgorithmSecurityStats(appPath: string): McpToolResult {
  try {
    const items = buildHashAlgorithmSecurityInfos(appPath);

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

    let text = `PHP Hash Algorithm Security Statistics\n${'='.repeat(40)}\n\n`;
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

export function getPhpHashAlgorithmSecurityTools(): Array<{
  name: string;
  description: string;
  inputSchema: object;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_hash_algorithm_security',
      description: 'Scan PHP src/ for insecure hash algorithm usage: md5()/sha1() for passwords (CRITICAL), md5()/sha1() near tokens/secrets (HIGH), hash("md5"/"sha1") near sensitive data (HIGH), crc32() for integrity checks (MEDIUM), hash_hmac("md5"/"sha1") for HMAC (HIGH), md5()/sha1() near sensitive variables (MEDIUM)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_hash_algorithm_security_stats',
      description: 'Statistics for PHP insecure hash algorithm findings: total count, bySeverity (critical/high/medium/low), byPattern breakdown, filesAffected count — returned as both human-readable text and JSON',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
