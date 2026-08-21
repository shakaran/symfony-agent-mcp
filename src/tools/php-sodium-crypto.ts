import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface SodiumCryptoInfo {
  file: string;
  type: 'sodium' | 'deprecated' | 'weak' | 'config';
  pattern: string;
  issues: string[];
}

const DEPRECATED_FUNCTIONS = [
  'mcrypt_encrypt', 'mcrypt_decrypt', 'md5(', 'sha1(', 'crc32(',
  'base64_encode', 'pack(', 'unpack(',
];

const WEAK_HASH_PATTERNS = [
  "'md5'", '"md5"', "'sha1'", '"sha1"', "'crc32'", '"crc32"',
  "'ripemd128'", '"ripemd128"', "'md4'", '"md4"',
];

const SODIUM_SECURE_FUNCTIONS = [
  'sodium_crypto_secretbox', 'sodium_crypto_aead_', 'sodium_crypto_box',
  'sodium_crypto_sign', 'sodium_crypto_pwhash', 'sodium_crypto_generichash',
  'sodium_randombytes_buf', 'sodium_memzero', 'sodium_memcmp',
];

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

function buildSodiumInfos(appPath: string): SodiumCryptoInfo[] {
  const results: SodiumCryptoInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const relFile = path.relative(appPath, file);

    const hasSodium = SODIUM_SECURE_FUNCTIONS.some((fn) => content.includes(fn));
    if (hasSodium) {
      const issues: string[] = [];

      if (content.includes('sodium_crypto_secretbox(') && !content.includes('sodium_randombytes_buf(')) {
        issues.push('sodium_crypto_secretbox used without sodium_randombytes_buf — nonce must be random; reusing nonces with the same key breaks confidentiality');
      }

      if (content.includes('sodium_crypto_pwhash(') && !content.includes('SODIUM_CRYPTO_PWHASH_')) {
        issues.push('sodium_crypto_pwhash without explicit OPSLIMIT/MEMLIMIT constants — use SODIUM_CRYPTO_PWHASH_OPSLIMIT_INTERACTIVE and MEMLIMIT_INTERACTIVE minimums');
      }

      if (content.includes('sodium_memzero')) {
        results.push({ file: relFile, type: 'sodium', pattern: 'sodium_memzero (secure wipe)', issues: [] });
      }

      const nonceLengthRe = /sodium_randombytes_buf\(\s*(\d{1,4})\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = nonceLengthRe.exec(content)) !== null) {
        const size = parseInt(match[1], 10);
        if (size < 24) {
          issues.push(`sodium_randombytes_buf(${size}) — nonce size ${size} bytes is below the 24-byte minimum for secretbox; use SODIUM_CRYPTO_SECRETBOX_NONCEBYTES`);
        }
      }

      if (!content.includes('sodium_memcmp(') && (content.includes('=== sodium_') || content.includes('== sodium_'))) {
        issues.push('MAC comparison with === instead of sodium_memcmp() — timing side-channel vulnerability; use sodium_memcmp() for constant-time comparison');
      }

      results.push({ file: relFile, type: 'sodium', pattern: 'libsodium usage', issues });
    }

    for (const fn of DEPRECATED_FUNCTIONS) {
      if (content.includes(fn)) {
        const isCrypto = content.includes('encrypt') || content.includes('decrypt') || content.includes('hash') || content.includes('cipher');
        if (isCrypto || fn.startsWith('mcrypt')) {
          results.push({ file: relFile, type: 'deprecated', pattern: fn.replace('(', '()'), issues: [`"${fn.replace('(', '()')}" used in cryptographic context — use sodium_crypto_* equivalent: mcrypt→sodium_crypto_secretbox, md5→sodium_crypto_generichash`] });
        }
      }
    }

    for (const pattern of WEAK_HASH_PATTERNS) {
      if (content.includes(pattern) && (content.includes('hash(') || content.includes('hash_hmac('))) {
        results.push({ file: relFile, type: 'weak', pattern: `hash algorithm: ${pattern}`, issues: [`Weak hash algorithm ${pattern} detected — use sodium_crypto_generichash (BLAKE2b) or hash('sha3-256', ...) for non-password hashing; password_hash() for passwords`] });
        break;
      }
    }

    if (content.includes('openssl_encrypt(') && content.includes("'AES-128-CBC'")) {
      results.push({ file: relFile, type: 'weak', pattern: 'AES-128-CBC', issues: ['AES-128-CBC without authentication — use authenticated encryption: sodium_crypto_aead_chacha20poly1305_encrypt() or AES-256-GCM with tag verification'] });
    }
  }

  return results;
}

export function listPhpSodiumCrypto(appPath: string): McpToolResult {
  try {
    const infos = buildSodiumInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No cryptographic patterns found (no libsodium, mcrypt, or hash usage detected).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP Cryptography Analysis\n${'='.repeat(50)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpSodiumCryptoStats(appPath: string): McpToolResult {
  try {
    const infos = buildSodiumInfos(appPath);
    let text = `PHP Cryptography Statistics\n${'='.repeat(40)}\n\n`;
    text += `Sodium usages:  ${infos.filter((i) => i.type === 'sodium').length}\n`;
    text += `Deprecated:     ${infos.filter((i) => i.type === 'deprecated').length}\n`;
    text += `Weak patterns:  ${infos.filter((i) => i.type === 'weak').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpSodiumCryptoTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_sodium_crypto', description: 'Analyze PHP cryptographic patterns; warns on deprecated mcrypt/md5 in crypto context, nonce reuse risk, missing OPSLIMIT for pwhash, === instead of sodium_memcmp, AES-CBC without authentication, weak hash algorithms', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_sodium_crypto_stats', description: 'Statistics for PHP crypto: sodium/deprecated/weak pattern count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
