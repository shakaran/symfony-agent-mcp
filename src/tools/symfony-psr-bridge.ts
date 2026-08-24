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

interface PsrBridgeInfo {
  file: string;
  type: 'psr7' | 'psr15' | 'psr17';
  adapter: string;
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

function buildPsrBridgeInfos(appPath: string): PsrBridgeInfo[] {
  const results: PsrBridgeInfo[] = [];

  let hasPsrBridge = false;
  let hasNyholm = false;
  let hasGuzzlePsr7 = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      const dev = (composer['require-dev'] ?? {}) as Record<string, string>;
      if (req['symfony/psr-http-message-bridge'] || dev['symfony/psr-http-message-bridge']) hasPsrBridge = true;
      if (req['nyholm/psr7'] || dev['nyholm/psr7']) hasNyholm = true;
      if (req['guzzlehttp/psr7'] || dev['guzzlehttp/psr7']) hasGuzzlePsr7 = true;
    } catch { /* ignore */ }
  }

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    const usesPsr7 = content.includes('HttpMessageFactoryInterface') ||
      content.includes('HttpFoundationFactoryInterface') ||
      content.includes('PsrHttpFactory') ||
      content.includes('ServerRequestInterface') && content.includes('Request');

    const usesPsr15 = content.includes('MiddlewareInterface') &&
      content.includes('RequestHandlerInterface') &&
      content.includes('process(');

    const usesPsr17 = content.includes('RequestFactoryInterface') ||
      content.includes('ResponseFactoryInterface') ||
      content.includes('StreamFactoryInterface');

    if (usesPsr7) {
      let adapter = 'unknown';
      if (hasNyholm) adapter = 'nyholm/psr7';
      else if (hasGuzzlePsr7) adapter = 'guzzlehttp/psr7';

      if (!hasPsrBridge) {
        issues.push('PSR-7 bridge used but symfony/psr-http-message-bridge not in composer.json');
      }
      if (!hasNyholm && !hasGuzzlePsr7) {
        issues.push('No PSR-7 implementation found (nyholm/psr7 or guzzlehttp/psr7) — bridge cannot function without a PSR-7 factory');
      }

      const mutatesRequest = /\$request\s*=\s*\$request->with/.test(content);
      if (mutatesRequest) {
        issues.push('PSR-7 request mutation via withXxx() — PSR-7 is immutable; always use the returned copy');
      }

      results.push({ file: relFile, type: 'psr7', adapter, issues });
    }

    if (usesPsr15) {
      const isRegistered = content.includes('#[AsTaggedItem') ||
        content.includes('kernel.event_subscriber') ||
        content.includes('middleware');
      if (!isRegistered) {
        issues.push('PSR-15 middleware class found but no DI registration detected — middleware must be tagged in DI container');
      }
      results.push({ file: relFile, type: 'psr15', adapter: 'psr/http-server-middleware', issues });
    }

    if (usesPsr17) {
      results.push({ file: relFile, type: 'psr17', adapter: 'psr/http-factory', issues: [] });
    }
  }

  return results;
}

export function listSymfonyPsrBridge(appPath: string): McpToolResult {
  try {
    const infos = buildPsrBridgeInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PSR-7/PSR-15/PSR-17 bridge usage found in src/.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony PSR Bridge Analysis\n${'='.repeat(50)}\n\nUsages: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] adapter: ${info.adapter}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyPsrBridgeStats(appPath: string): McpToolResult {
  try {
    const infos = buildPsrBridgeInfos(appPath);
    let text = `PSR Bridge Statistics\n${'='.repeat(40)}\n\n`;
    text += `PSR-7 usages:   ${infos.filter((i) => i.type === 'psr7').length}\n`;
    text += `PSR-15 usages:  ${infos.filter((i) => i.type === 'psr15').length}\n`;
    text += `PSR-17 usages:  ${infos.filter((i) => i.type === 'psr17').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyPsrBridgeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_psr_bridge', description: 'Detect PSR-7/PSR-15/PSR-17 bridge adapters; warns on missing psr-bridge package, no PSR-7 implementation, PSR-15 middleware not registered, PSR-7 request mutation', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_psr_bridge_stats', description: 'Statistics for PSR bridge: PSR-7/15/17 usage count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
