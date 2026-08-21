import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface OpensslPatternInfo {
  file: string;
  type: 'weak-cipher' | 'weak-hash' | 'iv-reuse' | 'ecb-mode' | 'key-length' | 'padding';
  pattern: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function buildOpensslPatternInfos(appPath: string): OpensslPatternInfo[] {
  const results: OpensslPatternInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  const checkFiles = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) checkFiles(full);
        else if (e.name.endsWith('.php')) {
          const content = safeRead(full, appPath); if (content === null) return;
          if (!content.includes('openssl_') && !content.includes('openssl') && !content.includes('OPENSSL_')) return;

          const relFile = path.relative(appPath, full);
          const issues: string[] = [];

          const hasWeakCipher = content.includes('DES-') || content.includes('des-') || content.includes('RC4') || content.includes('rc4') || content.includes("'AES-128-ECB'") || content.includes('"AES-128-ECB"');
          if (hasWeakCipher) {
            issues.push(`Weak cipher in "${relFile}" — DES (56-bit), RC4 (broken), and AES-ECB are cryptographically broken; use AES-256-GCM or AES-256-CBC with authentication`);
          }

          const hasEcbMode = /openssl_encrypt[\s\S]{0,100}'[A-Z0-9-]*-ECB'|openssl_encrypt[\s\S]{0,100}"[A-Z0-9-]*-ECB"/.test(content);
          if (hasEcbMode) {
            issues.push(`ECB mode in "${relFile}" — ECB does not use an IV and leaks patterns; use GCM (authenticated) or CBC (with HMAC) mode instead`);
            results.push({ file: relFile, type: 'ecb-mode', pattern: 'ECB cipher mode', issues });
            return;
          }

          const hasIv = content.includes('openssl_random_pseudo_bytes') || content.includes('random_bytes');
          const hasEncrypt = content.includes('openssl_encrypt(');
          if (hasEncrypt && !hasIv) {
            issues.push(`openssl_encrypt in "${relFile}" without random IV — static or missing IV makes encryption deterministic; generate IV with random_bytes(openssl_cipher_iv_length($cipher)) for each encryption`);
          }

          const hasKeyLength = /['"](AES-128|aes-128)/.test(content);
          if (hasKeyLength) {
            issues.push(`AES-128 in "${relFile}" — AES-256 provides significantly more key space than AES-128 at negligible performance cost; upgrade to AES-256-GCM`);
          }

          const hasPkcs1 = content.includes('OPENSSL_PKCS1_PADDING') || content.includes('openssl_public_encrypt');
          if (hasPkcs1) {
            issues.push(`PKCS#1 v1.5 padding in "${relFile}" — vulnerable to Bleichenbacher attacks; use OPENSSL_PKCS1_OAEP_PADDING for RSA encryption or switch to ECDH for key exchange`);
          }

          const hasWeakHash = content.includes("openssl_digest") && (content.includes("'md5'") || content.includes('"md5"') || content.includes("'sha1'") || content.includes('"sha1"'));
          if (hasWeakHash) {
            issues.push(`Weak hash algorithm in "${relFile}" openssl_digest — MD5 and SHA1 are cryptographically broken for security use; use SHA-256 or SHA-3`);
          }

          if (issues.length > 0) {
            results.push({ file: relFile, type: 'weak-cipher', pattern: 'openssl usage', issues });
          }
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  return results;
}

export function listPhpOpensslPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildOpensslPatternInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP OpenSSL security issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP OpenSSL Security Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpOpensslPatternsStats(appPath: string): McpToolResult {
  try {
    const infos = buildOpensslPatternInfos(appPath);
    let text = `PHP OpenSSL Statistics\n${'='.repeat(40)}\n\n`;
    text += `Weak ciphers:  ${infos.filter((i) => i.type === 'weak-cipher').length}\n`;
    text += `ECB mode:      ${infos.filter((i) => i.type === 'ecb-mode').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpOpensslPatternsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_openssl_patterns', description: 'Analyze PHP OpenSSL cryptography for security issues; warns on DES/RC4/ECB ciphers, AES-ECB mode pattern leaking, openssl_encrypt without random IV, AES-128 vs AES-256, PKCS#1 v1.5 padding Bleichenbacher risk, MD5/SHA1 in openssl_digest', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_openssl_patterns_stats', description: 'Statistics for PHP OpenSSL patterns: weak-cipher/ecb count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
