// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RoadrunnerConfigInfo {
  section: string;
  key: string;
  value: string;
  issues: string[];
}

function parseSimpleYamlValue(line: string): string {
  const m = /:\s*(.+)$/.exec(line.trim());
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

function safeKeyPath(p: string): string {
  return p.replace(/\S+\.(key|p12|pfx|der|crt|pem)$/i, '[KEY-PATH]');
}

function buildRoadrunnerInfos(appPath: string): RoadrunnerConfigInfo[] {
  const candidates = [
    path.join(appPath, '.rr.yaml'),
    path.join(appPath, '.rr.yml'),
    path.join(appPath, 'rr.yaml'),
  ];

  const rrFile = candidates.find((c) => fs.existsSync(c)) ?? null;
  const results: RoadrunnerConfigInfo[] = [];

  if (!rrFile) {
    results.push({ section: 'config', key: 'rr.yaml', value: 'not found', issues: ['No .rr.yaml configuration file found — if using RoadRunner, it must be present for worker pool tuning'] });
    return results;
  }

  let content = '';
  try { content = fs.readFileSync(rrFile, 'utf-8'); } catch { return results; }

  const lines = content.split('\n');
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (/^[a-z_]+:/.test(trimmed) && !trimmed.includes('  ')) {
      currentSection = trimmed.replace(':', '').trim();
    }

    if (currentSection === 'http') {
      if (trimmed.startsWith('pool:')) {
        results.push({ section: 'http.pool', key: 'pool', value: 'configured', issues: [] });
      }
      if (trimmed.startsWith('num_workers:') || trimmed.startsWith('workers:')) {
        const val = parseSimpleYamlValue(trimmed);
        const num = parseInt(val, 10);
        const issues: string[] = [];
        if (!isNaN(num) && num === 1) {
          issues.push('http.pool num_workers=1 — single worker is fine for dev but insufficient for production; set to at least 4 or use "command: auto"');
        }
        if (!isNaN(num) && num > 256) {
          issues.push(`http.pool num_workers=${num} is very high — excessive workers cause memory pressure; tune to CPU count × 2`);
        }
        results.push({ section: 'http.pool', key: 'num_workers', value: val, issues });
      }
      if (trimmed.startsWith('max_jobs:')) {
        const val = parseSimpleYamlValue(trimmed);
        const num = parseInt(val, 10);
        const issues: string[] = [];
        if (!isNaN(num) && num === 0) {
          issues.push('max_jobs=0 means workers never restart — memory leaks in worker accumulate; set to 500–2000 to recycle workers periodically');
        }
        results.push({ section: 'http.pool', key: 'max_jobs', value: val, issues });
      }
    }

    if (currentSection === 'server') {
      if (trimmed.startsWith('command:')) {
        const val = parseSimpleYamlValue(trimmed);
        const issues: string[] = [];
        if (val.includes('php') && !val.includes('-d') && !val.includes('opcache')) {
          issues.push(`Worker command "${val}" does not explicitly disable opcache.validate_timestamps — add "-d opcache.validate_timestamps=0" for production`);
        }
        results.push({ section: 'server', key: 'command', value: val, issues });
      }
      if (trimmed.startsWith('user:')) {
        const val = parseSimpleYamlValue(trimmed);
        if (val === 'root') {
          results.push({ section: 'server', key: 'user', value: val, issues: ['RoadRunner workers running as root — use a non-privileged user for security'] });
        }
      }
    }

    if (currentSection === 'logs') {
      if (trimmed.startsWith('level:')) {
        const val = parseSimpleYamlValue(trimmed);
        if (val === 'debug') {
          results.push({ section: 'logs', key: 'level', value: val, issues: ['Log level is "debug" — produces excessive output in production; use "warn" or "error"'] });
        }
      }
    }

    if (trimmed.includes('ssl:') || trimmed.includes('tls:')) {
      if (!content.includes('cert:') && !content.includes('certificate:')) {
        results.push({ section: 'ssl', key: 'ssl', value: 'enabled', issues: ['SSL section present but no cert/key configured — TLS will fail to start'] });
      }
    }
  }

  const hasSupervisor = content.includes('supervisor') || content.includes('SERVICE_SUPERVISOR');
  if (!hasSupervisor && !results.some((r) => r.key === 'num_workers')) {
    results.push({ section: 'http.pool', key: 'pool', value: 'unconfigured', issues: ['No http.pool section found in .rr.yaml — worker pool will use defaults (1 worker); configure num_workers for production'] });
  }

  return results;
}

export function listSymfonyRoadrunnerConfig(appPath: string): McpToolResult {
  try {
    const infos = buildRoadrunnerInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `RoadRunner Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.section}] ${info.key}: ${safeKeyPath(info.value)}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyRoadrunnerStats(appPath: string): McpToolResult {
  try {
    const infos = buildRoadrunnerInfos(appPath);
    const found = !infos.some((i) => i.value === 'not found');
    let text = `RoadRunner Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config found: ${found ? 'yes' : 'no'}\n`;
    text += `Settings:     ${infos.length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyRoadrunnerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_roadrunner_config', description: 'Analyze .rr.yaml RoadRunner configuration; warns on single worker, excessive workers (>256), max_jobs=0, root user, debug log level, SSL without cert, unconfigured pool', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_roadrunner_stats', description: 'Statistics for RoadRunner: config found, settings count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
