// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Permissions-Policy Header Inspector
 *
 * Scans:
 * - config/packages/security.yaml and config/packages/*.yaml for Permissions-Policy
 * - src/**\/*.php for Response header 'Permissions-Policy' or 'Feature-Policy'
 * - public/.htaccess and nginx config files for Permissions-Policy
 * - Flags: missing Permissions-Policy, outdated Feature-Policy,
 *           camera/microphone/geolocation set to allow all
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PermissionsPolicyInfo {
  file: string;
  directive: string;
  value: string;
  recommendation: string;
}

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

const SENSITIVE_DIRECTIVES = ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial', 'bluetooth'];

function evaluatePermissionValue(directive: string, value: string): string {
  const lower = value.toLowerCase().trim();
  if (lower === '*' || lower === '()' || lower === 'allow' || lower === 'true') {
    if (SENSITIVE_DIRECTIVES.includes(directive.toLowerCase())) {
      return `Allowing all origins for '${directive}' is a privacy/security risk; use 'self' or specific origins`;
    }
  }
  if (lower === 'self' || lower === "'self'") {
    return `'${directive}=self' is a safe, recommended setting`;
  }
  if (lower === '()' || lower === 'none' || lower === "'none'" || lower === 'false') {
    return `'${directive}=()' disables the feature entirely — good for security`;
  }
  return '';
}

function parsePermissionsPolicyHeader(headerValue: string, relFile: string): PermissionsPolicyInfo[] {
  const infos: PermissionsPolicyInfo[] = [];
  // Parse comma-separated directives: camera=(), microphone=(self)
  const parts = headerValue.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const directive = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    const recommendation = evaluatePermissionValue(directive, value);
    if (recommendation) {
      infos.push({ file: relFile, directive, value, recommendation });
    }
  }
  return infos;
}

function scanPhpFilesForPermissionsPolicy(appPath: string): PermissionsPolicyInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: PermissionsPolicyInfo[] = [];
  const files = collectPhpFiles(srcDir, appPath);

  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!/Permissions-Policy|Feature-Policy/i.test(content)) continue;

    const relFile = path.relative(appPath, file);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect Feature-Policy (deprecated)
      if (/Feature-Policy/i.test(line)) {
        results.push({
          file: relFile,
          directive: 'Feature-Policy',
          value: line.trim(),
          recommendation: 'Feature-Policy header is deprecated — replace with Permissions-Policy',
        });
      }

      // Detect Permissions-Policy header being set
      const ppMatch = /['"]Permissions-Policy['"]\s*,\s*['"]([^'"]+)['"]/.exec(line);
      if (ppMatch) {
        const parsed = parsePermissionsPolicyHeader(ppMatch[1], relFile);
        results.push(...parsed);
        if (parsed.length === 0) {
          results.push({
            file: relFile,
            directive: 'Permissions-Policy',
            value: ppMatch[1],
            recommendation: 'Permissions-Policy header configured',
          });
        }
      }
    }
  }

  return results;
}

function scanConfigFilesForPermissionsPolicy(appPath: string): PermissionsPolicyInfo[] {
  const configDir = path.join(appPath, 'config', 'packages');
  const results: PermissionsPolicyInfo[] = [];

  let configFiles: string[] = [];
  try {
    configFiles = fs.readdirSync(configDir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => path.join(configDir, f));
  } catch { return results; }

  let found = false;
  for (const file of configFiles) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!/Permissions-Policy|Feature-Policy|permissions_policy/i.test(content)) continue;

    found = true;
    const relFile = path.relative(appPath, file);
    const lines = content.split('\n');

    for (const line of lines) {
      if (/Feature-Policy/i.test(line)) {
        results.push({
          file: relFile,
          directive: 'Feature-Policy',
          value: line.trim(),
          recommendation: 'Feature-Policy is deprecated — use Permissions-Policy',
        });
      }
      const ppLineMatch = /Permissions-Policy:\s*(.+)/.exec(line);
      if (ppLineMatch) {
        const parsed = parsePermissionsPolicyHeader(ppLineMatch[1], relFile);
        results.push(...parsed);
      }
    }
  }

  if (!found) {
    results.push({
      file: 'config/packages/ (not found)',
      directive: 'Permissions-Policy',
      value: '(not configured)',
      recommendation: 'Permissions-Policy header not found in security/nelmio config — add to HTTP response headers',
    });
  }

  return results;
}

function scanHtaccessForPermissionsPolicy(appPath: string): PermissionsPolicyInfo[] {
  const results: PermissionsPolicyInfo[] = [];
  const htaccess = path.join(appPath, 'public', '.htaccess');
  const content = safeRead(htaccess, appPath);
  if (content === null) return results;

  const relFile = 'public/.htaccess';
  const lines = content.split('\n');
  let found = false;

  for (const line of lines) {
    if (/Permissions-Policy/i.test(line)) {
      found = true;
      const valueMatch = /Permissions-Policy['"]?\s+['"]?([^'"\n]+)/.exec(line);
      if (valueMatch) {
        const parsed = parsePermissionsPolicyHeader(valueMatch[1], relFile);
        results.push(...parsed);
      }
    }
    if (/Feature-Policy/i.test(line)) {
      results.push({
        file: relFile,
        directive: 'Feature-Policy',
        value: line.trim(),
        recommendation: 'Feature-Policy in .htaccess is deprecated — replace with Permissions-Policy',
      });
    }
  }

  if (!found) {
    results.push({
      file: relFile,
      directive: 'Permissions-Policy',
      value: '(not set)',
      recommendation: 'Permissions-Policy header not set in .htaccess — add: Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(self)"',
    });
  }

  return results;
}

function buildPermissionsPolicyInfos(appPath: string): PermissionsPolicyInfo[] {
  const results: PermissionsPolicyInfo[] = [];
  results.push(...scanConfigFilesForPermissionsPolicy(appPath));
  results.push(...scanPhpFilesForPermissionsPolicy(appPath));
  results.push(...scanHtaccessForPermissionsPolicy(appPath));
  return results;
}

export function listSymfonyPermissionsPolicy(appPath: string): McpToolResult {
  try {
    const infos = buildPermissionsPolicyInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Permissions-Policy configuration found.' }] };
    }

    let text = `Symfony Permissions-Policy Header Analysis\n${'='.repeat(55)}\n\n`;
    text += `Entries found: ${infos.length}\n\n`;

    const issues = infos.filter((i) => !i.recommendation.includes('safe') && !i.recommendation.includes('disables') && !i.recommendation.includes('configured'));
    const ok = infos.filter((i) => i.recommendation.includes('safe') || i.recommendation.includes('disables'));

    if (issues.length > 0) {
      text += `Issues / Recommendations:\n`;
      for (const info of issues) {
        text += `  [${info.directive}] ${info.file}\n`;
        text += `    Value: ${info.value}\n`;
        text += `    ${info.recommendation}\n`;
      }
      text += '\n';
    }

    if (ok.length > 0) {
      text += `Properly configured directives: ${ok.length}\n`;
      for (const info of ok) {
        text += `  [${info.directive}] ${info.file} — ${info.recommendation}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyPermissionsPolicyStats(appPath: string): McpToolResult {
  try {
    const infos = buildPermissionsPolicyInfos(appPath);

    const featurePolicy = infos.filter((i) => i.directive === 'Feature-Policy').length;
    const missing = infos.filter((i) => i.value.includes('not') || i.value.includes('(not')).length;
    const riskyAllowAll = infos.filter((i) => i.recommendation.includes('privacy/security risk')).length;
    const properlySet = infos.filter((i) => i.recommendation.includes('safe') || i.recommendation.includes('disables')).length;
    const filesAffected = new Set(infos.map((i) => i.file)).size;

    let text = `Symfony Permissions-Policy Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total directives/findings: ${infos.length}\n`;
    text += `Files scanned:             ${filesAffected}\n\n`;
    text += `Issues:\n`;
    text += `  Feature-Policy (deprecated): ${featurePolicy}\n`;
    text += `  Missing Permissions-Policy:  ${missing}\n`;
    text += `  Allow-all for sensitive:     ${riskyAllowAll}\n`;
    text += `  Properly configured:         ${properlySet}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyPermissionsPolicyTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_permissions_policy',
      description: 'List Symfony Permissions-Policy header configuration: deprecated Feature-Policy usage, missing headers, camera/microphone/geolocation allowed for all origins, .htaccess and config coverage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_permissions_policy_stats',
      description: 'Get Symfony Permissions-Policy statistics: deprecated Feature-Policy count, missing headers, allow-all for sensitive directives, properly configured count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
