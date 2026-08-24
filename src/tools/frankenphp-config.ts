// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FrankenPhpConfigInfo {
  file: string;
  type: 'worker' | 'tls' | 'compression' | 'http3' | 'mercure' | 'env';
  pattern: string;
  issues: string[];
}

function buildFrankenPhpConfigInfos(appPath: string): FrankenPhpConfigInfo[] {
  const results: FrankenPhpConfigInfo[] = [];

  // 1. Check Caddyfile in root or docker/
  const caddyfilePaths = [
    path.join(appPath, 'Caddyfile'),
    path.join(appPath, 'docker', 'Caddyfile'),
  ];
  for (const caddyPath of caddyfilePaths) {
    if (!fs.existsSync(caddyPath)) continue;
    let content = '';
    try { content = fs.readFileSync(caddyPath, 'utf-8'); } catch { continue; }
    const relPath = path.relative(appPath, caddyPath);

    if (/php_server|php_fastcgi/.test(content)) {
      results.push({ file: relPath, type: 'worker', pattern: 'php_server / php_fastcgi directive', issues: [] });
    }

    if (/\btls\b/.test(content)) {
      const info: FrankenPhpConfigInfo = { file: relPath, type: 'tls', pattern: 'TLS configured', issues: [] };
      if (/tls\s+internal|self_signed/.test(content)) {
        info.issues.push('FrankenPHP using self-signed TLS certificate — suitable only for development; use Let\'s Encrypt or a trusted CA in production');
      }
      results.push(info);
    } else if (!/localhost|127\.0\.0\.1/.test(content)) {
      results.push({
        file: relPath,
        type: 'tls',
        pattern: 'Missing TLS configuration',
        issues: ["FrankenPHP without TLS configuration — production deployments should use TLS; add 'tls' directive or configure Let's Encrypt"],
      });
    }

    if (/encode\s+(?:zstd|br|gzip)/.test(content)) {
      results.push({ file: relPath, type: 'compression', pattern: 'encode zstd/br/gzip compression', issues: [] });
    }

    if (/\bhttp3\b|\bquic\b/.test(content)) {
      results.push({ file: relPath, type: 'http3', pattern: 'HTTP/3 / QUIC enabled', issues: [] });
    }

    if (/\bmercure\b/.test(content)) {
      results.push({ file: relPath, type: 'mercure', pattern: 'Mercure hub configured', issues: [] });
    }
  }

  // 2. Check docker-compose.yml for FrankenPHP
  const composePath = path.join(appPath, 'docker-compose.yml');
  if (fs.existsSync(composePath)) {
    let content = '';
    try { content = fs.readFileSync(composePath, 'utf-8'); } catch { /* skip */ }

    if (/FRANKENPHP_WORKER/.test(content)) {
      results.push({ file: 'docker-compose.yml', type: 'worker', pattern: 'FRANKENPHP_WORKER env var', issues: [] });
    }

    if (/APP_WORKER_COUNT/.test(content)) {
      results.push({ file: 'docker-compose.yml', type: 'env', pattern: 'APP_WORKER_COUNT configured', issues: [] });
    }
  }

  // 3. Check Dockerfile for FrankenPHP base image
  const dockerfilePaths = [
    path.join(appPath, 'Dockerfile'),
    path.join(appPath, 'Dockerfile.prod'),
    path.join(appPath, 'docker', 'Dockerfile'),
  ];
  for (const dfPath of dockerfilePaths) {
    if (!fs.existsSync(dfPath)) continue;
    let content = '';
    try { content = fs.readFileSync(dfPath, 'utf-8'); } catch { continue; }

    if (/FROM\s+dunglas\/frankenphp/.test(content)) {
      results.push({
        file: path.relative(appPath, dfPath),
        type: 'worker',
        pattern: 'FROM dunglas/frankenphp base image',
        issues: [],
      });
    }
  }

  return results;
}

export function listFrankenPhpConfig(appPath: string): McpToolResult {
  try {
    const infos = buildFrankenPhpConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No FrankenPHP configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `FrankenPHP Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFrankenPhpConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildFrankenPhpConfigInfos(appPath);
    let text = `FrankenPHP Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Worker:      ${infos.filter((i) => i.type === 'worker').length}\n`;
    text += `TLS:         ${infos.filter((i) => i.type === 'tls').length}\n`;
    text += `Compression: ${infos.filter((i) => i.type === 'compression').length}\n`;
    text += `HTTP/3:      ${infos.filter((i) => i.type === 'http3').length}\n`;
    text += `Mercure:     ${infos.filter((i) => i.type === 'mercure').length}\n`;
    text += `Env:         ${infos.filter((i) => i.type === 'env').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFrankenPhpConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_frankenphp_config',
      description: 'Analyse FrankenPHP Caddyfile, docker-compose, and Dockerfile for worker mode, TLS, compression, HTTP/3, Mercure, and environment configuration issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_frankenphp_config_stats',
      description: 'Statistics for FrankenPHP configuration: counts by type (worker/tls/compression/http3/mercure/env) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
