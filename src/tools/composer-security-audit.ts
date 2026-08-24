// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ComposerAuditInfo {
  package: string;
  version: string;
  type: 'lock-present' | 'dev-in-prod' | 'platform' | 'abandoned' | 'scripts';
  issues: string[];
}

const DEV_ONLY_PACKAGES = new Set([
  'symfony/debug-bundle', 'symfony/web-profiler-bundle', 'symfony/var-dumper',
  'filp/whoops', 'roave/security-advisories', 'phpunit/phpunit', 'mockery/mockery',
  'behat/behat', 'infection/infection', 'phpstan/phpstan', 'vimeo/psalm',
  'squizlabs/php_codesniffer', 'rector/rector', 'phpmd/phpmd',
]);

const KNOWN_ABANDONED: Record<string, string> = {
  'doctrine/common': 'doctrine/persistence',
  'sensio/framework-extra-bundle': 'symfony/routing + symfony/security attributes',
  'easycorp/easyadmin-bundle': 'use EasyAdmin 4.x (the same vendor, different BC)',
  'friendsofsymfony/rest-bundle': 'api-platform/core or symfony native controllers',
  'nelmio/cors-bundle': 'still maintained but check for upstream activity',
  'jms/serializer-bundle': 'symfony/serializer or api-platform',
  'ocramius/package-versions': 'composer/package-versions-deprecated; use composer-runtime-api',
};

function buildComposerAuditInfos(appPath: string): ComposerAuditInfo[] {
  const results: ComposerAuditInfo[] = [];

  const composerJsonPath = path.join(appPath, 'composer.json');
  const composerLockPath = path.join(appPath, 'composer.lock');

  if (!fs.existsSync(composerJsonPath)) {
    results.push({ package: 'composer.json', version: '', type: 'lock-present', issues: ['composer.json not found — not a Composer project'] });
    return results;
  }

  if (!fs.existsSync(composerLockPath)) {
    results.push({ package: 'composer.lock', version: '', type: 'lock-present', issues: ['composer.lock not found — run "composer install" and commit the lock file to pin dependency versions'] });
  }

  let composerJson: Record<string, unknown>;
  try {
    composerJson = JSON.parse(fs.readFileSync(composerJsonPath, 'utf-8')) as Record<string, unknown>;
  } catch { return results; }

  const require = (composerJson['require'] ?? {}) as Record<string, string>;
  const requireDev = (composerJson['require-dev'] ?? {}) as Record<string, string>;
  const scripts = (composerJson['scripts'] ?? {}) as Record<string, unknown>;
  const config = (composerJson['config'] ?? {}) as Record<string, unknown>;

  for (const [pkg, ver] of Object.entries(require)) {
    if (DEV_ONLY_PACKAGES.has(pkg)) {
      results.push({ package: pkg, version: ver, type: 'dev-in-prod', issues: [`"${pkg}" is a development/debug tool listed in require (not require-dev) — it will be installed in production, increasing attack surface and memory usage`] });
    }
  }

  for (const [pkg, replacement] of Object.entries(KNOWN_ABANDONED)) {
    if (require[pkg] || requireDev[pkg]) {
      const ver = require[pkg] ?? requireDev[pkg] ?? '';
      results.push({ package: pkg, version: ver, type: 'abandoned', issues: [`"${pkg}" may be abandoned or superseded — consider migrating to: ${replacement}`] });
    }
  }

  const phpVer = require['php'] ?? '';
  if (phpVer) {
    const verStr = String(phpVer);
    if (verStr.startsWith('>=') && !verStr.includes('<')) {
      results.push({ package: 'php', version: verStr, type: 'platform', issues: [`PHP version constraint "${verStr}" has no upper bound — use "^8.2" or ">=8.2 <9.0" to prevent accidental PHP 9 installs`] });
    }
    if (verStr.includes('7.') || verStr.includes('^7')) {
      results.push({ package: 'php', version: verStr, type: 'platform', issues: [`PHP version constraint "${verStr}" allows PHP 7 — PHP 7 reached EOL in 2022; require at least PHP 8.1`] });
    }
  }

  if (config['allow-plugins']) {
    const allowPlugins = config['allow-plugins'] as Record<string, boolean>;
    for (const [plugin, allowed] of Object.entries(allowPlugins)) {
      if (allowed === true) {
        results.push({ package: plugin, version: '', type: 'scripts', issues: [] });
      }
    }
  }

  if (scripts['post-install-cmd'] || scripts['post-update-cmd']) {
    const postInstall = scripts['post-install-cmd'];
    const scriptContent = Array.isArray(postInstall) ? postInstall.join(' ') : String(postInstall ?? '');
    if (scriptContent.includes('curl') || scriptContent.includes('wget') || scriptContent.includes('bash')) {
      results.push({ package: 'scripts', version: '', type: 'scripts', issues: ['composer.json post-install-cmd contains network calls (curl/wget) or shell execution — remote script execution during composer install is a supply chain attack vector'] });
    }
  }

  const stability = String(composerJson['minimum-stability'] ?? 'stable');
  if (stability === 'dev' || stability === 'alpha') {
    results.push({ package: 'stability', version: stability, type: 'platform', issues: [`minimum-stability is "${stability}" — this allows unstable packages to be installed automatically; use "stable" with explicit "prefer-stable: true"`] });
  }

  return results;
}

export function listComposerSecurityAudit(appPath: string): McpToolResult {
  try {
    const infos = buildComposerAuditInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Composer Security Audit\n${'='.repeat(55)}\n\nPackages analyzed: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      if (info.issues.length === 0) continue;
      text += `\n  [${info.type.toUpperCase()}] ${info.package}${info.version ? ` (${info.version})` : ''}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    if (totalIssues === 0) {
      text += '\n  No issues found.\n';
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getComposerSecurityAuditStats(appPath: string): McpToolResult {
  try {
    const infos = buildComposerAuditInfos(appPath);
    let text = `Composer Audit Statistics\n${'='.repeat(40)}\n\n`;
    text += `Dev-in-prod:  ${infos.filter((i) => i.type === 'dev-in-prod').length}\n`;
    text += `Abandoned:    ${infos.filter((i) => i.type === 'abandoned').length}\n`;
    text += `Platform:     ${infos.filter((i) => i.type === 'platform').length}\n`;
    text += `Script risks: ${infos.filter((i) => i.type === 'scripts' && i.issues.length > 0).length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getComposerSecurityAuditTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_composer_security_audit', description: 'Audit composer.json for security risks: dev packages in require, known abandoned packages, unbound PHP version constraint, PHP 7 EOL, minimum-stability dev/alpha, post-install network calls', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_composer_security_audit_stats', description: 'Statistics for composer audit: dev-in-prod/abandoned/platform/script-risk count, total issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
