// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface WebAuthnIntegrationInfo {
  source: string;
  type: 'credential-store' | 'challenge' | 'origin' | 'rp-config' | 'verification';
  pattern: string;
  issues: string[];
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...scanDirRecursive(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

function buildWebAuthnIntegrationInfos(appPath: string): WebAuthnIntegrationInfo[] {
  const results: WebAuthnIntegrationInfo[] = [];

  // Check composer.json for WebAuthn packages
  const composerPath = path.join(appPath, 'composer.json');
  let webAuthnInstalled = false;
  if (fs.existsSync(composerPath)) {
    const composerContent = fs.readFileSync(composerPath, 'utf8');
    webAuthnInstalled =
      composerContent.includes('web-auth/webauthn-framework') ||
      composerContent.includes('web-auth/webauthn-lib');

    if (composerContent.includes('spomky-labs/cbor-php')) {
      results.push({
        source: 'composer.json',
        type: 'credential-store',
        pattern: 'cbor-php-dependency',
        issues: [],
      });
    }
  }

  // Scan PHP files for WebAuthn patterns
  const phpFiles = [
    ...scanDirRecursive(path.join(appPath, 'src'), '.php'),
    ...scanDirRecursive(path.join(appPath, 'config'), '.php'),
  ];

  let webAuthnFilesFound = false;

  for (const filePath of phpFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relPath = path.relative(appPath, filePath);

    if (
      !content.includes('WebAuthn') &&
      !content.includes('PublicKeyCredential') &&
      !content.includes('webauthn') &&
      !content.includes('passkey')
    ) {
      continue;
    }

    webAuthnFilesFound = true;

    // PublicKeyCredentialCreationOptions — challenge generation
    if (content.includes('PublicKeyCredentialCreationOptions')) {
      const hasSecureRandom =
        /random_bytes\s*\(|sodium_randombytes_buf\s*\(/.test(content);
      results.push({
        source: relPath,
        type: 'challenge',
        pattern: 'PublicKeyCredentialCreationOptions',
        issues: hasSecureRandom
          ? []
          : [
              'WebAuthn challenge not using cryptographic random bytes — use random_bytes(32) for challenge generation; non-random challenges are vulnerable to replay attacks',
            ],
      });
    }

    // PublicKeyCredentialRequestOptions — verification
    if (content.includes('PublicKeyCredentialRequestOptions')) {
      results.push({
        source: relPath,
        type: 'verification',
        pattern: 'PublicKeyCredentialRequestOptions',
        issues: [],
      });
    }

    // CredentialRepository
    if (
      content.includes('CredentialRepository') ||
      content.includes('PublicKeyCredentialSourceRepository')
    ) {
      results.push({
        source: relPath,
        type: 'credential-store',
        pattern: 'CredentialRepository',
        issues: [],
      });
    }
  }

  // Check if WebAuthn files found without the package installed
  if (webAuthnFilesFound && !webAuthnInstalled) {
    results.push({
      source: 'composer.json',
      type: 'credential-store',
      pattern: 'missing-webauthn-dependency',
      issues: [
        'WebAuthn PHP files without web-auth/webauthn-framework — install with: composer require web-auth/webauthn-framework',
      ],
    });
  }

  // Check config files for RP config
  const configFiles = [
    ...scanDirRecursive(path.join(appPath, 'config'), '.yaml'),
    ...scanDirRecursive(path.join(appPath, 'config'), '.yml'),
  ];

  let hasAllowedOrigins = false;

  for (const configFile of configFiles) {
    const content = fs.readFileSync(configFile, 'utf8');
    const relPath = path.relative(appPath, configFile);

    if (!content.includes('webauthn') && !content.includes('relying_party') && !content.includes('rpId')) continue;

    // rpId configuration
    const rpIdMatch = content.match(/rpId\s*:\s*(.+)|relying_party_id\s*:\s*(.+)/);
    if (rpIdMatch) {
      const rpId = (rpIdMatch[1] || rpIdMatch[2] || '').trim().replace(/['"]/g, '');
      results.push({
        source: relPath,
        type: 'rp-config',
        pattern: `rpId:${rpId}`,
        issues: rpId === '*' || rpId.startsWith('*.')
          ? ['WebAuthn relying party ID too broad — rpId should match your origin domain exactly; wildcards allow credential reuse across subdomains']
          : [],
      });
    }

    // Allowed origins
    if (/allowedOrigins|allowed_origins/i.test(content)) {
      hasAllowedOrigins = true;
      results.push({
        source: relPath,
        type: 'origin',
        pattern: 'allowed-origins-configured',
        issues: [],
      });
    }
  }

  // If WebAuthn is installed but no allowed origins configured
  if (webAuthnInstalled && !hasAllowedOrigins) {
    results.push({
      source: 'config/',
      type: 'origin',
      pattern: 'missing-allowed-origins',
      issues: [
        'WebAuthn without explicit allowed origins — configure allowed origins to prevent credential reuse from other domains',
      ],
    });
  }

  return results;
}

export function listWebAuthnIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildWebAuthnIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No WebAuthn integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `WebAuthn Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getWebAuthnIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildWebAuthnIntegrationInfos(appPath);
    let text = `WebAuthn Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Credential-store: ${infos.filter((i) => i.type === 'credential-store').length}\n`;
    text += `Challenge: ${infos.filter((i) => i.type === 'challenge').length}\n`;
    text += `Origin: ${infos.filter((i) => i.type === 'origin').length}\n`;
    text += `Rp-config: ${infos.filter((i) => i.type === 'rp-config').length}\n`;
    text += `Verification: ${infos.filter((i) => i.type === 'verification').length}\n`;
    text += `Issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getWebAuthnIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_webauthn_integration',
      description: 'Analyze WebAuthn/passkey integration configuration and detect security issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_webauthn_integration_stats',
      description: 'Statistics for WebAuthn integration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
