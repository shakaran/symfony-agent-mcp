// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Two-Factor Authentication Inspector (scheb/2fa-bundle)
 *
 * Detects scheb/2fa-bundle or scheb/two-factor-bundle in composer.json.
 *
 * Reads configuration:
 *   - scheb_two_factor.yaml or security.yaml two_factor section
 *   - Enabled providers: totp, email, google
 *   - trusted_device config, backup_codes config
 *   - TOTP window parameter, email code TTL
 *
 * Scans src/ PHP for:
 *   - TwoFactorInterface, TotpAuthenticatorInterface
 *   - EmailTwoFactorInterface, GoogleAuthenticatorTwoFactorInterface implementations
 *
 * Warns about:
 *   - 2FA enabled without trusted_device config (UX issue)
 *   - Email 2FA without code TTL (code valid forever)
 *   - TOTP without window parameter (clock drift issues)
 *   - 2FA without backup_codes (locked-out risk)
 *   - TwoFactorInterface implemented but firewall not configured
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TwoFactorInfo {
  bundleDetected: boolean;
  providers: string[];
  hasTrustedDevice: boolean;
  hasBackupCodes: boolean;
  totpWindow?: number;
  emailCodeTtl?: number;
  implementingClasses: string[];
  issues: string[];
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

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch { return null; }
}

function detect2faBundleInComposer(appPath: string): boolean {
  const composer = readJsonFile(path.join(appPath, 'composer.json'));
  if (!composer) return false;
  const require = (composer['require'] ?? {}) as Record<string, string>;
  const requireDev = (composer['require-dev'] ?? {}) as Record<string, string>;
  const all = { ...require, ...requireDev };
  return Object.keys(all).some((k) =>
    k.includes('scheb/2fa') || k.includes('scheb/two-factor')
  );
}

function readYamlRaw(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function parseTwoFactorConfig(appPath: string): {
  providers: string[];
  hasTrustedDevice: boolean;
  hasBackupCodes: boolean;
  totpWindow?: number;
  emailCodeTtl?: number;
  firewallHas2fa: boolean;
} {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'scheb_two_factor.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'scheb_two_factor.yaml'),
  ];

  const providers: string[] = [];
  let hasTrustedDevice = false;
  let hasBackupCodes = false;
  let totpWindow: number | undefined;
  let emailCodeTtl: number | undefined;
  let firewallHas2fa = false;

  for (const filePath of candidates) {
    const content = readYamlRaw(filePath);
    if (!content) continue;

    if (/\btotp\s*:/.test(content) && /\benabled\s*:\s*true/.test(content)) {
      if (!providers.includes('totp')) providers.push('totp');
    }
    if (/\bemail\s*:/.test(content) && /\benabled\s*:\s*true/.test(content)) {
      if (!providers.includes('email')) providers.push('email');
    }
    if (/\bgoogle\s*:/.test(content) && /\benabled\s*:\s*true/.test(content)) {
      if (!providers.includes('google')) providers.push('google');
    }

    if (/\btrusted_device\s*:/.test(content)) hasTrustedDevice = true;
    if (/\bbackup_codes\s*:/.test(content)) hasBackupCodes = true;

    const windowMatch = /\bwindow\s*:\s*(\d{1,4})/.exec(content);
    if (windowMatch) totpWindow = parseInt(windowMatch[1], 10);

    const ttlMatch = /\bcode_ttl\s*:\s*(\d{1,6})/.exec(content);
    if (ttlMatch) emailCodeTtl = parseInt(ttlMatch[1], 10);

    if (/\btwo_factor\s*:/.test(content)) firewallHas2fa = true;
  }

  return { providers, hasTrustedDevice, hasBackupCodes, totpWindow, emailCodeTtl, firewallHas2fa };
}

const TWO_FACTOR_INTERFACES = [
  'TwoFactorInterface',
  'TotpAuthenticatorInterface',
  'EmailTwoFactorInterface',
  'GoogleAuthenticatorTwoFactorInterface',
  'TwoFactorProviderInterface',
];

function scanImplementingClasses(appPath: string): string[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const classes: string[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const hasInterface = TWO_FACTOR_INTERFACES.some((iface) => content.includes(iface));
    if (!hasInterface) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    if (classMatch) classes.push(classMatch[1]);
  }
  return classes;
}

function buildTwoFactorInfo(appPath: string): TwoFactorInfo {
  const bundleDetected = detect2faBundleInComposer(appPath);
  const config = parseTwoFactorConfig(appPath);
  const implementingClasses = scanImplementingClasses(appPath);
  const issues: string[] = [];

  if (bundleDetected || implementingClasses.length > 0 || config.providers.length > 0) {
    if (config.providers.length > 0 && !config.hasTrustedDevice) {
      issues.push('2FA enabled but trusted_device not configured — every login requires 2FA (UX issue)');
    }
    if (config.providers.includes('email') && !config.emailCodeTtl) {
      issues.push('Email 2FA enabled without code_ttl — verification codes never expire');
    }
    if ((config.providers.includes('totp') || config.providers.includes('google')) && config.totpWindow === undefined) {
      issues.push('TOTP 2FA without window parameter — clock drift between client and server may cause failures');
    }
    if (config.providers.length > 0 && !config.hasBackupCodes) {
      issues.push('2FA enabled without backup_codes — users may be permanently locked out if they lose their device');
    }
    if (implementingClasses.length > 0 && !config.firewallHas2fa) {
      issues.push(`TwoFactorInterface implemented by [${implementingClasses.join(', ')}] but no firewall two_factor section found in security.yaml`);
    }
    if (!bundleDetected && implementingClasses.length > 0) {
      issues.push('TwoFactorInterface implementations found but scheb/2fa-bundle not in composer.json');
    }
  }

  return {
    bundleDetected,
    providers: config.providers,
    hasTrustedDevice: config.hasTrustedDevice,
    hasBackupCodes: config.hasBackupCodes,
    totpWindow: config.totpWindow,
    emailCodeTtl: config.emailCodeTtl,
    implementingClasses,
    issues,
  };
}

export function listTwoFactorConfig(appPath: string): McpToolResult {
  try {
    const info = buildTwoFactorInfo(appPath);

    if (!info.bundleDetected && info.implementingClasses.length === 0 && info.providers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'Two-factor authentication (scheb/2fa-bundle) not detected.\n\nInstall 2FA bundle:\n  composer require scheb/2fa-bundle\n  composer require scheb/2fa-totp      # for TOTP\n  composer require scheb/2fa-email     # for email codes',
        }],
      };
    }

    let text = `Two-Factor Authentication (scheb/2fa)\n${'='.repeat(55)}\n\n`;
    text += `Bundle installed:      ${info.bundleDetected ? 'yes' : 'no'}\n`;
    text += `Providers enabled:     ${info.providers.length > 0 ? info.providers.join(', ') : 'none'}\n`;
    text += `trusted_device:        ${info.hasTrustedDevice ? 'configured' : 'not configured'}\n`;
    text += `backup_codes:          ${info.hasBackupCodes ? 'configured' : 'not configured'}\n`;

    if (info.totpWindow !== undefined) {
      text += `TOTP window:           ${info.totpWindow}\n`;
    }
    if (info.emailCodeTtl !== undefined) {
      text += `Email code TTL:        ${info.emailCodeTtl}s\n`;
    }

    if (info.implementingClasses.length > 0) {
      text += `\nImplementing classes:\n`;
      for (const cls of info.implementingClasses) {
        text += `  ${cls}\n`;
      }
    }

    if (info.issues.length > 0) {
      text += `\nWarnings:\n`;
      for (const issue of info.issues) {
        text += `  WARNING: ${issue}\n`;
      }
    } else {
      text += '\nNo issues detected.\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTwoFactorStats(appPath: string): McpToolResult {
  try {
    const info = buildTwoFactorInfo(appPath);

    let text = `Two-Factor Authentication Statistics\n${'='.repeat(40)}\n\n`;
    text += `Bundle installed:          ${info.bundleDetected ? 'yes' : 'no'}\n`;
    text += `Providers:                 ${info.providers.length} (${info.providers.join(', ') || 'none'})\n`;
    text += `trusted_device:            ${info.hasTrustedDevice ? 'yes' : 'no'}\n`;
    text += `backup_codes:              ${info.hasBackupCodes ? 'yes' : 'no'}\n`;
    text += `Implementing classes:      ${info.implementingClasses.length}\n`;
    text += `Warnings:                  ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTwoFactorTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_two_factor',
      description: 'Analyze scheb/2fa-bundle 2FA setup: detect enabled providers (totp/email/google), trusted_device config, backup_codes config, TOTP window, email code TTL, implementing classes, firewall configuration, common 2FA misconfigurations',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_security_two_factor_stats',
      description: 'Statistics for 2FA configuration: bundle presence, provider count, trusted_device/backup_codes flags, implementing class count, warning count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
