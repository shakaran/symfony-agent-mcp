// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface IntercomIntegrationInfo {
  file: string;
  type: 'auth' | 'identity' | 'pii' | 'ratelimit' | 'config';
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function maskSecret(value: string): string {
  if (value.trim() === '') return value;
  return '***';
}

function buildIntercomIntegrationInfos(appPath: string): IntercomIntegrationInfo[] {
  const results: IntercomIntegrationInfo[] = [];

  // Check composer.json for Intercom PHP client
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent && composerContent.includes('intercom/intercom-php')) {
    results.push({ file: 'composer.json', type: 'config', issues: ['intercom/intercom-php detected in composer.json'] });
  }

  // Scan .env* for Intercom access tokens
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;
    const issues: string[] = [];

    const tokenPatterns: Array<{ re: RegExp; label: string; sensitive?: boolean }> = [
      { re: /INTERCOM_TOKEN\s*=\s*([^\n]+)/, label: 'INTERCOM_TOKEN', sensitive: true },
      { re: /INTERCOM_ACCESS_TOKEN\s*=\s*([^\n]+)/, label: 'INTERCOM_ACCESS_TOKEN', sensitive: true },
      { re: /INTERCOM_SECRET\s*=\s*([^\n]+)/, label: 'INTERCOM_SECRET', sensitive: true },
    ];
    for (const { re, label } of tokenPatterns) {
      const m = re.exec(content);
      if (m) {
        const raw = m[1].trim();
        if (raw && !raw.startsWith('%env(') && !raw.startsWith('${')) {
          issues.push(`${label} set to non-env-var value in ${fname} (value masked: ${maskSecret(raw)}) — inject via CI secrets; never commit Intercom access tokens`);
        }
      }
    }
    if (issues.length > 0) {
      results.push({ file: fname, type: 'auth', issues });
    }
  }

  // Scan src/**/*.php for Intercom patterns
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    const lc = content.toLowerCase();
    const hasIntercom = lc.includes('intercom');
    if (!hasIntercom) continue;

    const relFile = path.relative(appPath, filePath);

    // Identity verification hash missing
    const hasMessengerSetup =
      content.includes('intercom_settings') ||
      content.includes('app_id') ||
      lc.includes('intercom.boot') ||
      lc.includes('intercom_user_hash');
    if (hasMessengerSetup && !content.includes("hash_hmac('sha256'") && !content.includes('hash_hmac("sha256"')) {
      results.push({
        file: relFile,
        type: 'identity',
        issues: [
          `Intercom Messenger setup in ${relFile} without hash_hmac('sha256', ...) identity verification — compute user_hash = hash_hmac('sha256', userId, INTERCOM_SECRET) and pass it to Messenger to prevent account takeover`,
        ],
      });
    }

    // PII in custom_attributes
    const piiKeys = ['phone', 'ssn', 'credit_card', 'creditcard', 'social_security', 'date_of_birth', 'dob', 'passport'];
    if (content.includes('custom_attributes')) {
      const piiFound: string[] = [];
      for (const key of piiKeys) {
        if (content.includes(`'${key}'`) || content.includes(`"${key}"`)) {
          piiFound.push(key);
        }
      }
      if (piiFound.length > 0) {
        results.push({
          file: relFile,
          type: 'pii',
          issues: [
            `Potential PII keys [${piiFound.join(', ')}] found in custom_attributes in ${relFile} — avoid storing sensitive personal data in Intercom attributes; check GDPR/CCPA compliance and use pseudonymous identifiers instead`,
          ],
        });
      }
    }

    // Access token hardcoded in source (not env)
    if (
      (content.includes('INTERCOM_TOKEN') || content.includes('INTERCOM_ACCESS_TOKEN')) &&
      !content.includes('getenv') &&
      !content.includes('$_ENV') &&
      !content.includes('%env(') &&
      !content.includes('$this->') &&
      !content.includes('$params')
    ) {
      results.push({
        file: relFile,
        type: 'auth',
        issues: [
          `Possible hardcoded Intercom token reference in ${relFile} without getenv/$_ENV/%%env( — ensure access tokens are retrieved from environment variables, not hardcoded in source`,
        ],
      });
    }

    // createOrUpdate/create called without external_id
    const hasCreate =
      content.includes('->contacts()->create(') ||
      content.includes('->users()->create(') ||
      content.includes('->contacts()->createOrUpdate(') ||
      content.includes('->users()->createOrUpdate(');
    if (hasCreate && !content.includes('external_id')) {
      results.push({
        file: relFile,
        type: 'identity',
        issues: [
          `Intercom contact/user create or createOrUpdate called in ${relFile} without external_id — always provide external_id to link Intercom contacts to your own user records and prevent duplicate contact creation`,
        ],
      });
    }

    // Rate limit handling absent
    const hasApiUsage =
      content.includes('->contacts()') ||
      content.includes('->users()') ||
      content.includes('->events()') ||
      content.includes('->messages()') ||
      content.includes('IntercomClient') ||
      content.includes('Intercom\\Client');
    if (hasApiUsage && !content.includes('429') && !content.includes('RateLimitException') && !content.includes('Retry-After')) {
      results.push({
        file: relFile,
        type: 'ratelimit',
        issues: [
          `Intercom API used in ${relFile} without 429/RateLimitException/Retry-After handling — catch HTTP 429 responses and implement exponential back-off to avoid dropping API calls under load`,
        ],
      });
    }
  }

  // Scan config/**/*.yaml for Intercom patterns
  const yamlFiles = scanDirRecursive(path.join(appPath, 'config'), '.yaml');
  for (const filePath of yamlFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (!content.toLowerCase().includes('intercom')) continue;
    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    if (/INTERCOM_TOKEN\s*:/.test(content) || /INTERCOM_ACCESS_TOKEN\s*:/.test(content)) {
      issues.push(`Intercom token key referenced in ${relFile} — ensure value resolves through %%env() or secrets manager, not hardcoded`);
    }
    if (issues.length > 0) {
      results.push({ file: relFile, type: 'config', issues });
    }
  }

  return results;
}

export function listIntercomIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildIntercomIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Intercom integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Intercom Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getIntercomIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildIntercomIntegrationInfos(appPath);
    let text = `Intercom Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Auth patterns:     ${infos.filter((i) => i.type === 'auth').length}\n`;
    text += `Identity patterns: ${infos.filter((i) => i.type === 'identity').length}\n`;
    text += `PII patterns:      ${infos.filter((i) => i.type === 'pii').length}\n`;
    text += `Ratelimit patterns:${infos.filter((i) => i.type === 'ratelimit').length}\n`;
    text += `Config patterns:   ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Total issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getIntercomIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_intercom_integration',
      description: 'Scan the Symfony application for Intercom PHP integration patterns: missing Messenger identity verification, PII in custom attributes, hardcoded access tokens, createOrUpdate without external_id, and absent rate-limit handling.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_intercom_integration_stats',
      description: 'Return aggregated counts of Intercom auth/identity/pii/ratelimit/config patterns and total issues found.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
