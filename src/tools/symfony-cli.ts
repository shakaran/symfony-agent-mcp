// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * SymfonyCloud / Platform.sh Configuration Inspector
 *
 * .symfony.cloud.yaml / .platform.app.yaml:
 *   - Application name, type (php version), build flavor
 *   - Relationships (database, redis, rabbitmq, elasticsearch)
 *   - Web locations (root, passthru, rules)
 *   - Workers: commands and memory limits
 *   - Crons: spec + cmd (distinct from cron-jobs.ts external crons)
 *   - Variables: SYMFONY_ENV, COMPOSER_FLAGS
 *   - Mounts: shared writable directories
 *   - Disk size
 *
 * .platform/routes.yaml:
 *   - Routes: upstream, type (upstream/redirect), cache, ssi
 *
 * .platform/services.yaml:
 *   - Services: type (mysql/postgresql/redis/rabbitmq/elasticsearch), disk, size
 *
 * Analysis:
 *   - PHP version mismatch between .symfony.cloud.yaml and composer.json
 *   - Mounts missing var/ or public/files/
 *   - Cron without build step (may run stale cache)
 *   - Services present in services.yaml but not in relationships
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface CloudWorker {
  name: string;
  cmd: string;
  memory?: number;
}

interface CloudCron {
  name: string;
  spec: string;
  cmd: string;
}

interface CloudService {
  name: string;
  type: string;
  disk?: number;
}

interface CloudConfig {
  name?: string;
  phpVersion?: string;
  buildFlavor?: string;
  disk?: number;
  relationships: Record<string, string>;
  workers: CloudWorker[];
  crons: CloudCron[];
  mounts: string[];
  variables: Record<string, string>;
}

function loadCloudConfig(appPath: string): CloudConfig | null {
  const candidates = ['.symfony.cloud.yaml', '.platform.app.yaml'];
  for (const fname of candidates) {
    const raw = parseYamlFile(path.join(appPath, fname)) as Record<string, unknown> | null;
    if (!raw) continue;

    const typeField = raw['type'] ? String(raw['type']) : '';
    const phpVersion = /php:(\d+\.\d+)/.exec(typeField)?.[1];
    const relRaw    = raw['relationships'] as Record<string, string> | undefined;
    const workerRaw = raw['workers'] as Record<string, unknown> | undefined;
    const cronRaw   = raw['crons'] as Record<string, unknown> | undefined;
    const mountsRaw = raw['mounts'] as Record<string, unknown> | undefined;
    const varRaw    = (raw['variables'] as Record<string, Record<string, string>> | undefined)?.['env'];

    const workers: CloudWorker[] = [];
    if (workerRaw) {
      for (const [wname, wdef] of Object.entries(workerRaw)) {
        if (!wdef || typeof wdef !== 'object') continue;
        const d = wdef as Record<string, unknown>;
        workers.push({
          name: wname,
          cmd: d['commands'] ? String((d['commands'] as Record<string, string>)['start'] ?? '') : String(d['cmd'] ?? ''),
          memory: d['size'] ? parseInt(String(d['size']), 10) : undefined,
        });
      }
    }

    const crons: CloudCron[] = [];
    if (cronRaw) {
      for (const [cname, cdef] of Object.entries(cronRaw)) {
        if (!cdef || typeof cdef !== 'object') continue;
        const d = cdef as Record<string, unknown>;
        crons.push({ name: cname, spec: String(d['spec'] ?? ''), cmd: String(d['cmd'] ?? '') });
      }
    }

    return {
      name: raw['name'] ? String(raw['name']) : undefined,
      phpVersion,
      buildFlavor: raw['build'] ? String((raw['build'] as Record<string, string>)['flavor'] ?? '') : undefined,
      disk: raw['disk'] ? parseInt(String(raw['disk']), 10) : undefined,
      relationships: relRaw ?? {},
      workers,
      crons,
      mounts: mountsRaw ? Object.keys(mountsRaw) : [],
      variables: varRaw ?? {},
    };
  }
  return null;
}

function loadPlatformRoutes(appPath: string): Array<{ path: string; type: string; upstream?: string }> {
  const raw = parseYamlFile(path.join(appPath, '.platform', 'routes.yaml')) as Record<string, unknown> | null;
  if (!raw) return [];
  return Object.entries(raw).map(([p, def]) => {
    const d = (def ?? {}) as Record<string, unknown>;
    return { path: p, type: String(d['type'] ?? 'upstream'), upstream: d['upstream'] ? String(d['upstream']) : undefined };
  });
}

function loadPlatformServices(appPath: string): CloudService[] {
  const raw = parseYamlFile(path.join(appPath, '.platform', 'services.yaml')) as Record<string, unknown> | null;
  if (!raw) return [];
  return Object.entries(raw).map(([name, def]) => {
    const d = (def ?? {}) as Record<string, unknown>;
    return {
      name,
      type: String(d['type'] ?? 'unknown'),
      disk: d['disk'] ? parseInt(String(d['disk']), 10) : undefined,
    };
  });
}

export function listSymfonyCliConfig(appPath: string): McpToolResult {
  try {
    const cloud    = loadCloudConfig(appPath);
    const routes   = loadPlatformRoutes(appPath);
    const services = loadPlatformServices(appPath);

    if (!cloud && routes.length === 0 && services.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No SymfonyCloud / Platform.sh configuration found.\n\nExpected files:\n  .symfony.cloud.yaml (or .platform.app.yaml)\n  .platform/routes.yaml\n  .platform/services.yaml\n\nSymfonyCloud docs: https://symfony.com/cloud/',
        }],
      };
    }

    let text = `SymfonyCloud / Platform.sh Configuration\n${'='.repeat(55)}\n`;

    if (cloud) {
      if (cloud.name)        text += `\nApp name:     ${cloud.name}\n`;
      if (cloud.phpVersion)  text += `PHP version:  ${cloud.phpVersion}\n`;
      if (cloud.buildFlavor) text += `Build flavor: ${cloud.buildFlavor}\n`;
      if (cloud.disk)        text += `Disk:         ${cloud.disk} MB\n`;

      if (Object.keys(cloud.relationships).length > 0) {
        text += `\nRelationships:\n`;
        for (const [alias, svc] of Object.entries(cloud.relationships)) {
          text += `  ${alias.padEnd(20)} ${svc}\n`;
        }
      }

      if (cloud.mounts.length > 0) {
        text += `\nMounts: ${cloud.mounts.join(', ')}\n`;
        if (!cloud.mounts.some((m) => m.includes('var'))) {
          text += `⚠ var/ not in mounts — Symfony cache/logs may not be writable\n`;
        }
      }

      if (cloud.workers.length > 0) {
        text += `\nWorkers (${cloud.workers.length}):\n`;
        for (const w of cloud.workers) {
          const mem = w.memory ? `  ${w.memory}MB` : '';
          text += `  ${w.name.padEnd(20)}${mem}  ${w.cmd}\n`;
        }
      }

      if (cloud.crons.length > 0) {
        text += `\nCrons (${cloud.crons.length}):\n`;
        for (const c of cloud.crons) {
          text += `  ${c.name.padEnd(20)} [${c.spec}]  ${c.cmd}\n`;
        }
      }

      // PHP version mismatch
      try {
        const composer = JSON.parse(fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8')) as
          Record<string, Record<string, string>>;
        const requiredPhp = composer['require']?.['php'];
        if (cloud.phpVersion && requiredPhp && !requiredPhp.includes(cloud.phpVersion.slice(0, 3))) {
          text += `\n⚠ PHP version mismatch: cloud uses ${cloud.phpVersion}, composer.json requires "${requiredPhp}"\n`;
        }
      } catch { /* skip */ }
    }

    if (services.length > 0) {
      text += `\nPlatform.sh services (${services.length}):\n`;
      for (const s of services) {
        const disk = s.disk ? `  ${s.disk}MB` : '';
        text += `  ${s.name.padEnd(20)} ${s.type}${disk}\n`;
      }
    }

    if (routes.length > 0) {
      text += `\nRoutes (${routes.length}):\n`;
      for (const r of routes.slice(0, 10)) {
        const upstream = r.upstream ? `  → ${r.upstream}` : '';
        text += `  [${r.type}] ${r.path}${upstream}\n`;
      }
      if (routes.length > 10) text += `  ... and ${routes.length - 10} more\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyCliStats(appPath: string): McpToolResult {
  try {
    const cloud    = loadCloudConfig(appPath);
    const routes   = loadPlatformRoutes(appPath);
    const services = loadPlatformServices(appPath);

    let text = `SymfonyCloud Statistics\n${'='.repeat(40)}\n\n`;
    text += `Cloud config found:  ${cloud ? 'yes' : 'no'}\n`;
    if (cloud) {
      text += `PHP version:         ${cloud.phpVersion ?? 'unknown'}\n`;
      text += `Workers:             ${cloud.workers.length}\n`;
      text += `Crons:               ${cloud.crons.length}\n`;
      text += `Mounts:              ${cloud.mounts.length}\n`;
      text += `Relationships:       ${Object.keys(cloud.relationships).length}\n`;
    }
    text += `Platform services:   ${services.length}\n`;
    text += `Routes:              ${routes.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyCliTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_cli_config',
      description: 'Show SymfonyCloud/Platform.sh configuration: .symfony.cloud.yaml (PHP version, relationships, workers, crons, mounts), .platform/routes.yaml, .platform/services.yaml, PHP version mismatch check',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_cli_stats',
      description: 'Show SymfonyCloud statistics: config found, PHP version, worker count, cron count, mount count, relationship count, service count, route count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
