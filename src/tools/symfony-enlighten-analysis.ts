// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Enlighten Analysis Inspector
 *
 * Checks for Enlightn (enlightn/enlightn or enlightn/enlightnpro) in composer.json.
 * Scans .enlightn.php or config/enlightn.php for configuration.
 * Performs built-in Enlightn-style checks on the app:
 *   - Exposed .env files
 *   - Missing APP_KEY / APP_ENV
 *   - Debug mode in prod
 *   - .env.example vs .env.local key comparison
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface EnlightenInfo {
  file: string;
  category: 'security' | 'performance' | 'reliability' | 'best-practice';
  check: string;
  status: 'pass' | 'fail' | 'warn';
}

function readFileSafe(filePath: string, appPath: string): string {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(appPath) + path.sep) && resolved !== path.resolve(appPath)) return '';
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function checkEnlightnInstalled(appPath: string): EnlightenInfo {
  const composerPath = path.join(appPath, 'composer.json');
  const content = readFileSafe(composerPath, appPath);
  if (!content) {
    return { file: 'composer.json', category: 'best-practice', check: 'Enlightn package', status: 'warn' };
  }
  const hasEnlightn = content.includes('enlightn/enlightn') || content.includes('enlightn/enlightnpro');
  return {
    file: 'composer.json',
    category: 'best-practice',
    check: hasEnlightn ? 'Enlightn package installed' : 'Enlightn package not installed — add enlightn/enlightn for automated security/performance analysis',
    status: hasEnlightn ? 'pass' : 'warn',
  };
}

function checkEnlightnConfig(appPath: string): EnlightenInfo[] {
  const candidates = [
    path.join(appPath, '.enlightn.php'),
    path.join(appPath, 'config', 'enlightn.php'),
  ];

  for (const configPath of candidates) {
    const resolved = path.resolve(configPath);
    if (!resolved.startsWith(path.resolve(appPath) + path.sep)) continue;
    if (!fs.existsSync(configPath)) continue;
    const content = readFileSafe(configPath, appPath);
    if (!content) continue;

    const results: EnlightenInfo[] = [];
    const relPath = path.relative(appPath, configPath);

    // Check if skip_checks is overly broad
    if (content.includes('skip_checks') && content.includes('all')) {
      results.push({ file: relPath, category: 'security', check: 'skip_checks contains "all" — all checks skipped', status: 'fail' });
    } else {
      results.push({ file: relPath, category: 'best-practice', check: 'Enlightn config file found', status: 'pass' });
    }

    return results;
  }

  return [{ file: '.enlightn.php', category: 'best-practice', check: 'No Enlightn config file found (.enlightn.php / config/enlightn.php)', status: 'warn' }];
}

function checkExposedEnvFile(appPath: string): EnlightenInfo {
  // Check if .env is in public/ directory (exposed)
  const publicEnv = path.join(appPath, 'public', '.env');
  const resolved = path.resolve(publicEnv);
  if (resolved.startsWith(path.resolve(appPath) + path.sep) && fs.existsSync(publicEnv)) {
    return { file: 'public/.env', category: 'security', check: '.env file exposed in public/ directory — critical: move outside web root', status: 'fail' };
  }
  return { file: '.env', category: 'security', check: '.env not exposed in public/ directory', status: 'pass' };
}

function checkAppKey(appPath: string): EnlightenInfo {
  const envPath = path.join(appPath, '.env');
  const content = readFileSafe(envPath, appPath);
  if (!content) {
    return { file: '.env', category: 'security', check: 'APP_KEY check (no .env found)', status: 'warn' };
  }
  const hasAppKey = /APP_KEY\s*=\s*.+/.test(content);
  const hasEmptyKey = /APP_KEY\s*=\s*$/.test(content) || /APP_KEY\s*=\s*['"]?['"]?$/.test(content);
  if (!hasAppKey || hasEmptyKey) {
    return { file: '.env', category: 'security', check: 'APP_KEY not set — generate with php artisan key:generate or set a 32-char random string', status: 'fail' };
  }
  return { file: '.env', category: 'security', check: 'APP_KEY is set', status: 'pass' };
}

function checkDebugMode(appPath: string): EnlightenInfo[] {
  const results: EnlightenInfo[] = [];

  // Check .env for APP_DEBUG=true and APP_ENV=prod combination
  const envPath = path.join(appPath, '.env');
  const envContent = readFileSafe(envPath, appPath);
  if (envContent) {
    const debugOn = /APP_DEBUG\s*=\s*true/i.test(envContent);
    const isProd = /APP_ENV\s*=\s*prod/.test(envContent);
    if (debugOn && isProd) {
      results.push({ file: '.env', category: 'security', check: 'APP_DEBUG=true with APP_ENV=prod — debug mode exposes stack traces to users', status: 'fail' });
    } else if (debugOn) {
      results.push({ file: '.env', category: 'security', check: 'APP_DEBUG=true — ensure this is not deployed to production', status: 'warn' });
    } else {
      results.push({ file: '.env', category: 'security', check: 'APP_DEBUG not enabled in .env', status: 'pass' });
    }
  }

  // Check config/packages/framework.yaml for debug flag
  const frameworkYaml = path.join(appPath, 'config', 'packages', 'framework.yaml');
  const fwContent = readFileSafe(frameworkYaml, appPath);
  if (fwContent && /debug:\s*true/.test(fwContent) && !fwContent.includes('%kernel.debug%')) {
    results.push({ file: 'config/packages/framework.yaml', category: 'security', check: 'Hardcoded debug: true in framework.yaml — use %kernel.debug% instead', status: 'warn' });
  }

  return results;
}

function checkEnvExampleKeys(appPath: string): EnlightenInfo[] {
  const results: EnlightenInfo[] = [];
  const examplePath = path.join(appPath, '.env.example');
  const localPath = path.join(appPath, '.env.local');

  const exampleContent = readFileSafe(examplePath, appPath);
  const localContent = readFileSafe(localPath, appPath);

  if (!exampleContent) {
    results.push({ file: '.env.example', category: 'best-practice', check: 'No .env.example file — add one to document required environment variables', status: 'warn' });
    return results;
  }

  if (!localContent) {
    results.push({ file: '.env.local', category: 'best-practice', check: '.env.example found but no .env.local — ensure environment is configured', status: 'warn' });
    return results;
  }

  // Extract key names from example
  const exampleKeys = (exampleContent.match(/^([A-Z_][A-Z0-9_]+)\s*=/gm) ?? []).map((k) => k.split('=')[0].trim());
  const localKeys = new Set((localContent.match(/^([A-Z_][A-Z0-9_]+)\s*=/gm) ?? []).map((k) => k.split('=')[0].trim()));

  const missingKeys = exampleKeys.filter((k) => !localKeys.has(k));
  if (missingKeys.length > 0) {
    results.push({
      file: '.env.local',
      category: 'reliability',
      check: `Keys in .env.example but missing in .env.local: ${missingKeys.slice(0, 10).join(', ')}${missingKeys.length > 10 ? ` (+${missingKeys.length - 10} more)` : ''}`,
      status: 'warn',
    });
  } else {
    results.push({ file: '.env.local', category: 'reliability', check: 'All .env.example keys present in .env.local', status: 'pass' });
  }

  return results;
}

function buildEnlightenInfos(appPath: string): EnlightenInfo[] {
  const results: EnlightenInfo[] = [];

  results.push(checkEnlightnInstalled(appPath));
  results.push(...checkEnlightnConfig(appPath));
  results.push(checkExposedEnvFile(appPath));
  results.push(checkAppKey(appPath));
  results.push(...checkDebugMode(appPath));
  results.push(...checkEnvExampleKeys(appPath));

  return results;
}

export function listSymfonyEnlightenAnalysis(appPath: string): McpToolResult {
  try {
    const infos = buildEnlightenInfos(appPath);

    const failed = infos.filter((i) => i.status === 'fail');
    const warned = infos.filter((i) => i.status === 'warn');
    const passed = infos.filter((i) => i.status === 'pass');

    let text = `Symfony Enlighten Analysis\n${'='.repeat(55)}\n\n`;
    text += `Checks: ${infos.length}  Passed: ${passed.length}  Warnings: ${warned.length}  Failed: ${failed.length}\n\n`;

    if (failed.length > 0) {
      text += `FAILED:\n`;
      for (const info of failed) {
        text += `  [${info.category.toUpperCase()}] ${info.check}\n`;
        text += `    File: ${info.file}\n`;
      }
      text += '\n';
    }

    if (warned.length > 0) {
      text += `WARNINGS:\n`;
      for (const info of warned) {
        text += `  [${info.category.toUpperCase()}] ${info.check}\n`;
        text += `    File: ${info.file}\n`;
      }
      text += '\n';
    }

    if (passed.length > 0) {
      text += `PASSED:\n`;
      for (const info of passed) {
        text += `  [${info.category.toUpperCase()}] ${info.check}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyEnlightenAnalysisStats(appPath: string): McpToolResult {
  try {
    const infos = buildEnlightenInfos(appPath);

    const byCategory: Record<string, { pass: number; warn: number; fail: number }> = {};
    for (const info of infos) {
      if (!byCategory[info.category]) byCategory[info.category] = { pass: 0, warn: 0, fail: 0 };
      byCategory[info.category][info.status]++;
    }

    let text = `Symfony Enlighten Analysis Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total checks: ${infos.length}\n`;
    text += `  Passed:   ${infos.filter((i) => i.status === 'pass').length}\n`;
    text += `  Warnings: ${infos.filter((i) => i.status === 'warn').length}\n`;
    text += `  Failed:   ${infos.filter((i) => i.status === 'fail').length}\n\n`;
    text += `By category:\n`;
    for (const [cat, counts] of Object.entries(byCategory).sort()) {
      text += `  ${cat.padEnd(15)}  pass:${counts.pass}  warn:${counts.warn}  fail:${counts.fail}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyEnlightenAnalysisTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_enlighten_analysis',
      description: 'Run Enlightn-style static analysis checks: Enlightn package installed, config presence, exposed .env in public/, missing APP_KEY, debug mode in prod, .env.example vs .env.local key coverage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_enlighten_analysis_stats',
      description: 'Show Enlightn analysis statistics: pass/warn/fail counts overall and broken down by category (security/performance/reliability/best-practice)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
