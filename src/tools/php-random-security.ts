// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RandomSecurityInfo {
  file: string;
  type: 'weak' | 'secure' | 'seed' | 'token';
  pattern: string;
  issues: string[];
}

const WEAK_RANDOM = ['rand(', 'mt_rand(', 'array_rand(', 'shuffle(', 'str_shuffle(', 'lcg_value(', 'srand(', 'mt_srand('];
const SECURE_RANDOM = ['random_int(', 'random_bytes(', 'sodium_randombytes_buf(', 'sodium_randombytes_random16(', 'openssl_random_pseudo_bytes('];

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function buildRandomSecurityInfos(appPath: string): RandomSecurityInfo[] {
  const results: RandomSecurityInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath); if (content === null) continue;

    const hasAnyRandom = WEAK_RANDOM.some((fn) => content.includes(fn)) || SECURE_RANDOM.some((fn) => content.includes(fn));
    if (!hasAnyRandom) continue;

    const relFile = path.relative(appPath, file);

    const isSecurityContext = content.includes('token') || content.includes('Token') || content.includes('password') ||
      content.includes('secret') || content.includes('key') || content.includes('nonce') ||
      content.includes('csrf') || content.includes('CSRF') || content.includes('salt') ||
      content.includes('session') || content.includes('auth');

    for (const fn of WEAK_RANDOM) {
      if (!content.includes(fn)) continue;

      const issues: string[] = [];
      if (isSecurityContext) {
        issues.push(`${fn.replace('(', '()')} used in security-sensitive context — weak PRNG predictable by observing output; use random_int() for integers, random_bytes() for byte strings`);
      }

      if (fn === 'srand(' || fn === 'mt_srand(') {
        const seedMatch = /(?:mt_)?srand\(\s*time\(\)/.exec(content);
        if (seedMatch) {
          issues.push('PRNG seeded with time() — attacker can brute-force seed by trying nearby timestamps; use random_int() instead of manual seeding');
        }
      }

      if (fn === 'rand(' || fn === 'mt_rand(') {
        const constRangeMatch = /(?:mt_)?rand\(\s*0\s*,\s*(\d{1,20})\s*\)/.exec(content);
        if (constRangeMatch && isSecurityContext) {
          const max = parseInt(constRangeMatch[1], 10);
          if (max < 100000) {
            issues.push(`rand(0, ${max}) generates only ${max + 1} values — trivially guessable; use random_int() for security-sensitive tokens`);
          }
        }
      }

      results.push({ file: relFile, type: 'weak', pattern: fn.replace('(', '()'), issues });
    }

    for (const fn of SECURE_RANDOM) {
      if (!content.includes(fn)) continue;

      const issues: string[] = [];

      if (fn === 'openssl_random_pseudo_bytes(') {
        const hasStrong = content.includes('$strong') || content.includes(', $strong') || content.includes(', true');
        if (!hasStrong) {
          issues.push('openssl_random_pseudo_bytes() without checking $strong parameter — if cryptographically strong random source is unavailable, $strong will be false; use random_bytes() instead');
        }
      }

      if (fn === 'random_bytes(') {
        const sizeMatch = /random_bytes\(\s*(\d{1,4})\s*\)/.exec(content);
        if (sizeMatch) {
          const size = parseInt(sizeMatch[1], 10);
          if (size < 16 && isSecurityContext) {
            issues.push(`random_bytes(${size}) — ${size} bytes (${size * 8} bits) of entropy is below the 128-bit minimum for security tokens; use random_bytes(32) for 256-bit tokens`);
          }
        }
      }

      results.push({ file: relFile, type: 'secure', pattern: fn.replace('(', '()'), issues });
    }

    const tokenGenPatterns = ['bin2hex(random_bytes', 'base64_encode(random_bytes', 'rtrim(strtr(base64_encode'];
    for (const tp of tokenGenPatterns) {
      if (content.includes(tp)) {
        results.push({ file: relFile, type: 'token', pattern: tp, issues: [] });
      }
    }
  }

  return results;
}

export function listPhpRandomSecurity(appPath: string): McpToolResult {
  try {
    const infos = buildRandomSecurityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No random number generation patterns found in src/.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP Random Number Security Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpRandomSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = buildRandomSecurityInfos(appPath);
    let text = `PHP Random Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `Weak PRNG:   ${infos.filter((i) => i.type === 'weak').length}\n`;
    text += `Secure RNG:  ${infos.filter((i) => i.type === 'secure').length}\n`;
    text += `Token gen:   ${infos.filter((i) => i.type === 'token').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpRandomSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_random_security', description: 'Detect insecure random number generation; warns on rand()/mt_rand() in security context, time() seeding, small value range for tokens, openssl_random_pseudo_bytes without $strong check, random_bytes with <16 bytes', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_random_security_stats', description: 'Statistics for random security: weak/secure/token count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
