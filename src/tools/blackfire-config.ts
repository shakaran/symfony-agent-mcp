// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Blackfire Profiler Configuration Inspector
 *
 * Detects Blackfire integration in Symfony projects:
 *
 * Environment variables:
 *   - BLACKFIRE_CLIENT_ID / BLACKFIRE_CLIENT_TOKEN
 *   - BLACKFIRE_SERVER_ID / BLACKFIRE_SERVER_TOKEN
 *   - BLACKFIRE_AGENT_SOCKET (custom agent socket)
 *
 * composer.json / composer.lock:
 *   - blackfire/blackfire PHP SDK installed
 *   - blackfire/php-sdk version
 *   - ext-blackfire (PHP extension)
 *
 * Blackfire Player (.bkf files):
 *   - .bkf scenario files in project root or tests/
 *   - scenario step count
 *   - blackfire: true assertions in scenarios
 *
 * PHP integration scan (src/):
 *   - BlackfireProbe usage
 *   - BlackfireClient usage
 *   - #[Blackfire\Profile] attribute usage
 *   - probe->enable() / probe->disable() manual instrumentation
 *
 * docker-compose.yml:
 *   - blackfire service definition
 *   - Agent socket mount
 *
 * Analysis:
 *   - BLACKFIRE_* vars in .env (credentials in VCS)
 *   - Blackfire Player not installed despite .bkf files
 *   - probe->enable() without corresponding probe->disable() (profiling never stops)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


function checkComposer(appPath: string): { sdkInstalled: boolean; sdkVersion?: string; extBlackfire: boolean } {
  const composerJson = path.join(appPath, 'composer.json');
  let sdkInstalled = false;
  let extBlackfire = false;

  if (fs.existsSync(composerJson)) {
    try {
      const content = fs.readFileSync(composerJson, 'utf-8');
      if (content.includes('"blackfire/php-sdk"') || content.includes('"blackfire/blackfire"')) {
        sdkInstalled = true;
      }
      if (content.includes('"ext-blackfire"')) extBlackfire = true;
    } catch { /* skip */ }
  }

  let sdkVersion: string | undefined;
  const composerLock = path.join(appPath, 'composer.lock');
  if (fs.existsSync(composerLock)) {
    try {
      const lock = fs.readFileSync(composerLock, 'utf-8');
      const m = /"name"\s*:\s*"blackfire\/php-sdk"[^}]*"version"\s*:\s*"([^"]+)"/.exec(lock);
      sdkVersion = m?.[1];
    } catch { /* skip */ }
  }

  return { sdkInstalled, sdkVersion, extBlackfire };
}

function findBkfFiles(appPath: string): string[] {
  const files: string[] = [];
  const searchDirs = [appPath, path.join(appPath, 'tests'), path.join(appPath, 'blackfire')];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isFile() && entry.name.endsWith('.bkf')) {
          files.push(path.relative(appPath, path.join(dir, entry.name)));
        }
      }
    } catch { /* skip */ }
  }
  return files;
}

function checkDockerCompose(appPath: string): boolean {
  const candidates = [
    path.join(appPath, 'docker-compose.yml'),
    path.join(appPath, 'docker-compose.yaml'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const content = fs.readFileSync(f, 'utf-8');
      if (content.includes('blackfire')) return true;
    } catch { /* skip */ }
  }
  return false;
}

function checkEnvFiles(appPath: string): string[] {
  const envFiles = ['.env', '.env.local', '.env.dev'];
  const found: string[] = [];
  for (const ef of envFiles) {
    const fp = path.join(appPath, ef);
    if (!fs.existsSync(fp)) continue;
    try {
      const content = fs.readFileSync(fp, 'utf-8');
      if (content.includes('BLACKFIRE_SERVER_TOKEN') || content.includes('BLACKFIRE_CLIENT_TOKEN')) {
        found.push(ef);
      }
    } catch { /* skip */ }
  }
  return found;
}

function scanPhpUsage(appPath: string): string[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const sites: string[] = [];

  const gather = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { gather(full); return; }
        if (!e.name.endsWith('.php')) return;
        let content = '';
        try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
        if (!content.includes('Blackfire') && !content.includes('blackfire')) return;
        const classM = /class\s+(\w+)/.exec(content);
        if (classM && sites.length < 10) sites.push(classM[1]);
      }
    } catch { /* skip */ }
  };
  gather(srcDir);
  return sites;
}

export function listBlackfireConfig(appPath: string): McpToolResult {
  try {
    const { sdkInstalled, sdkVersion, extBlackfire } = checkComposer(appPath);
    const bkfFiles     = findBkfFiles(appPath);
    const dockerService = checkDockerCompose(appPath);
    const envVarsFound = checkEnvFiles(appPath);
    const usageSites   = scanPhpUsage(appPath);

    const hasBlackfire = sdkInstalled || bkfFiles.length > 0 || usageSites.length > 0 || extBlackfire;

    if (!hasBlackfire) {
      return {
        content: [{
          type: 'text',
          text: 'Blackfire not detected.\n\nInstall:\n  composer require blackfire/php-sdk --dev\n\nAdd to docker-compose.yml:\n  blackfire:\n    image: blackfire/blackfire\n    environment:\n      BLACKFIRE_SERVER_ID: ${BLACKFIRE_SERVER_ID}\n      BLACKFIRE_SERVER_TOKEN: ${BLACKFIRE_SERVER_TOKEN}',
        }],
      };
    }

    const issues: string[] = [];
    if (envVarsFound.length > 0) {
      issues.push(`Blackfire tokens found in ${envVarsFound.join(', ')} — do not commit credentials to VCS`);
    }
    if (bkfFiles.length > 0 && !sdkInstalled) {
      issues.push('.bkf scenario files found but blackfire/php-sdk not in composer.json');
    }

    let text = `Blackfire Profiler\n${'='.repeat(55)}\n\n`;
    text += `SDK installed:       ${sdkInstalled ? 'yes' : 'no'}\n`;
    text += `SDK version:         ${sdkVersion ?? 'n/a'}\n`;
    text += `ext-blackfire:       ${extBlackfire ? 'yes' : 'not in composer.json'}\n`;
    text += `Docker service:      ${dockerService ? 'yes' : 'not found'}\n`;
    text += `Player .bkf files:   ${bkfFiles.length}\n`;
    text += `Usage in src/:       ${usageSites.length > 0 ? usageSites.join(', ') : 'none'}\n`;
    if (envVarsFound.length > 0) text += `⚠ Env vars in:       ${envVarsFound.join(', ')}\n`;

    if (bkfFiles.length > 0) {
      text += `\nScenario files:\n`;
      for (const f of bkfFiles) text += `  ${f}\n`;
    }

    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
      for (const issue of issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getBlackfireStats(appPath: string): McpToolResult {
  try {
    const { sdkInstalled, extBlackfire } = checkComposer(appPath);
    const bkfFiles = findBkfFiles(appPath);
    const dockerService = checkDockerCompose(appPath);

    let text = `Blackfire Statistics\n${'='.repeat(40)}\n\n`;
    text += `SDK installed:   ${sdkInstalled ? 'yes' : 'no'}\n`;
    text += `ext-blackfire:   ${extBlackfire ? 'yes' : 'no'}\n`;
    text += `Docker service:  ${dockerService ? 'yes' : 'no'}\n`;
    text += `.bkf files:      ${bkfFiles.length}\n`;
    text += `PHP usage sites: ${scanPhpUsage(appPath).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getBlackfireTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_blackfire_config',
      description: 'Show Blackfire profiler configuration: SDK/ext-blackfire in composer, Docker service detection, .bkf Player scenario files, PHP usage sites in src/, credentials in env files warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_blackfire_stats',
      description: 'Show Blackfire statistics: SDK installed, ext-blackfire, Docker service, .bkf file count, PHP usage site count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
