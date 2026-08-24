// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface SignedUrlInfo {
  file: string;
  type: 'generation' | 'validation' | 'config' | 'expiry';
  pattern: string;
  issues: string[];
}

function buildSignedUrlInfos(appPath: string): SignedUrlInfo[] {
  const results: SignedUrlInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  const checkFiles = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) checkFiles(full);
        else if (e.name.endsWith('.php')) {
          const content = safeRead(full, appPath);
          if (content === null) return;
          if (!content.includes('UriSigner') && !content.includes('sign(') && !content.includes('generateSignedUrl') && !content.includes('generateTemporarySignedUrl')) return;

          const relFile = path.relative(appPath, full);
          const issues: string[] = [];

          const usesUriSigner = content.includes('UriSigner') || content.includes('uri_signer');
          const usesSymfonyRouteUrl = content.includes('generateSignedUrl') || content.includes('generateTemporarySignedUrl');

          if (usesSymfonyRouteUrl || usesUriSigner) {
            const hasExpiry = content.includes('generateTemporarySignedUrl') || content.includes('expir') || content.includes('lifetime') || content.includes('ttl');
            if (!hasExpiry && usesUriSigner) {
              issues.push(`Signed URL in "${relFile}" without expiry — URL is valid forever; use UriSigner::sign() with expiration or generateTemporarySignedUrl() instead of generateSignedUrl()`);
            }

            const hasIsValid = content.includes('isValid(') || content.includes('checkRequest(') || content.includes('verify(');
            if (!hasIsValid) {
              issues.push(`Signed URL generated in "${relFile}" without corresponding isValid() check — verify the signature on the receiving endpoint to prevent forgery`);
            }

            const hasPublicSecret = /UriSigner\s*\(\s*['"]/.test(content);
            if (hasPublicSecret) {
              issues.push(`Hardcoded secret in UriSigner constructor in "${relFile}" — pass secret via container parameter bound to %env(APP_SECRET)% instead`);
            }

            results.push({ file: relFile, type: 'generation', pattern: 'signed URL generation', issues });
          }
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  const securityYaml = path.join(appPath, 'config', 'packages', 'security.yaml');
  if (fs.existsSync(securityYaml)) {
    let content = '';
    try { content = fs.readFileSync(securityYaml, 'utf-8'); } catch { /* skip */ }
    if (content.includes('login_link')) {
      const issues: string[] = [];
      const hasMaxUses = content.includes('max_uses:');
      if (!hasMaxUses) {
        issues.push('login_link configuration without max_uses — a link can be used unlimited times; add max_uses: 1 to prevent link reuse');
      }
      const hasLifetime = content.includes('lifetime:');
      if (!hasLifetime) {
        issues.push('login_link configuration without lifetime — link never expires; add lifetime: 600 (10 minutes) to limit exposure window');
      }
      results.push({ file: 'config/packages/security.yaml', type: 'config', pattern: 'login_link signed URL', issues });
    }
  }

  return results;
}

export function listSymfonySignedUrl(appPath: string): McpToolResult {
  try {
    const infos = buildSignedUrlInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No signed URL patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Signed URL Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySignedUrlStats(appPath: string): McpToolResult {
  try {
    const infos = buildSignedUrlInfos(appPath);
    let text = `Signed URL Statistics\n${'='.repeat(40)}\n\n`;
    text += `Generation:  ${infos.filter((i) => i.type === 'generation').length}\n`;
    text += `Validation:  ${infos.filter((i) => i.type === 'validation').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySignedUrlTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_signed_url', description: 'Analyze Symfony signed URL and UriSigner usage; warns on URLs without expiry, missing isValid() validation, hardcoded secrets, login_link without max_uses or lifetime', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_signed_url_stats', description: 'Statistics for signed URL usage: generation/validation count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
