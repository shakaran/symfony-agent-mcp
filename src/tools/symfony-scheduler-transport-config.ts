/**
 * Symfony Scheduler Transport Configuration Inspector
 *
 * Scans config/packages/scheduler.yaml and config/packages/messenger.yaml:
 * - framework.scheduler transports
 * - DSN patterns: doctrine://, redis://, memory://, filesystem://
 * - Persistence check (doctrine/redis) vs ephemeral (memory/filesystem)
 * - Flags: memory transport in prod, no lock for distributed
 *
 * Masks credentials in DSNs.
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SchedulerTransportInfo {
  name: string;
  transport: 'doctrine' | 'redis' | 'in-memory' | 'filesystem' | 'unknown';
  dsn: string;
  options: string[];
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskDsnCredentials(dsn: string): string {
  return dsn
    .replace(/:\/\/[^@\s]{1,200}@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret|key)=[^&\s]*/gi, '$1$2=***');
}

function detectTransportType(dsn: string): SchedulerTransportInfo['transport'] {
  const lower = dsn.toLowerCase();
  if (lower.startsWith('doctrine://') || lower.includes('doctrine')) return 'doctrine';
  if (lower.startsWith('redis://') || lower.startsWith('rediss://') || lower.includes('redis')) return 'redis';
  if (lower.startsWith('memory://') || lower === 'memory' || lower.includes('in-memory') || lower.includes('memory')) return 'in-memory';
  if (lower.startsWith('filesystem://') || lower.includes('filesystem') || lower.includes('cache.app')) return 'filesystem';
  return 'unknown';
}

function buildTransportIssues(name: string, transport: SchedulerTransportInfo['transport'], options: string[]): string[] {
  const issues: string[] = [];

  if (transport === 'in-memory') {
    issues.push(`Transport '${name}': memory:// is ephemeral — scheduled tasks are lost on process restart; not suitable for production`);
    issues.push(`Transport '${name}': memory:// does not support distributed locking — only use for testing`);
  }

  if (transport === 'filesystem') {
    issues.push(`Transport '${name}': filesystem:// stores tasks locally — not shared across servers in a cluster`);
  }

  if (transport === 'unknown') {
    issues.push(`Transport '${name}': unrecognised DSN — verify transport configuration`);
  }

  if (transport === 'doctrine' || transport === 'redis') {
    const hasLock = options.some((o) => /lock/i.test(o));
    if (!hasLock) {
      issues.push(`Transport '${name}': no lock configuration found — add a lock store to prevent duplicate execution in distributed environments`);
    }
  }

  return issues;
}

function parseSchedulerYaml(content: string, relFile: string): SchedulerTransportInfo[] {
  const infos: SchedulerTransportInfo[] = [];
  const lines = content.split('\n');

  // Look for scheduler section: framework.scheduler or top-level scheduler:
  let inSchedulerSection = false;
  let inTransportBlock = false;
  let currentName = '';
  let currentDsn = '';
  const currentOptions: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^scheduler:/.test(trimmed) || /^\s+scheduler:/.test(line)) {
      inSchedulerSection = true;
      continue;
    }

    if (inSchedulerSection && /^[a-z_]+:/.test(trimmed) && !/scheduler:|transport:|options:|lock:/.test(trimmed)) {
      // New top-level section, end scheduler block
      if (/^\S/.test(line)) {
        inSchedulerSection = false;
        inTransportBlock = false;
      }
    }

    if (!inSchedulerSection) continue;

    // Detect transport name entries (indented keys under scheduler:)
    const nameMatch = /^\s{2,4}(\w[\w_-]*):\s*$/.exec(line);
    if (nameMatch && !['transport', 'options', 'lock', 'failure_transport'].includes(nameMatch[1])) {
      // Save previous
      if (currentName && currentDsn) {
        const transport = detectTransportType(currentDsn);
        const maskedDsn = maskDsnCredentials(currentDsn);
        const issues = buildTransportIssues(currentName, transport, currentOptions.slice());
        infos.push({ name: currentName, transport, dsn: maskedDsn, options: currentOptions.slice(), issues });
        currentOptions.length = 0;
      }
      currentName = nameMatch[1];
      currentDsn = '';
      inTransportBlock = true;
      continue;
    }

    if (inTransportBlock) {
      const dsnMatch = /^\s+(?:dsn|transport)\s*:\s*['"]?([^'"#\n]+)['"]?/.exec(line);
      if (dsnMatch) {
        currentDsn = dsnMatch[1].trim();
      }
      const optMatch = /^\s+(\w[\w_]+)\s*:\s*['"]?([^'"#\n]+)['"]?/.exec(line);
      if (optMatch && !['dsn', 'transport'].includes(optMatch[1])) {
        currentOptions.push(`${optMatch[1]}: ${optMatch[2].trim()}`);
      }
    }

    // Inline DSN: schedule.transport: 'doctrine://default'
    const inlineDsnMatch = /schedule\.transport\s*:\s*['"]?([^'"#\n]+)['"]?/.exec(trimmed);
    if (inlineDsnMatch) {
      const rawDsn = inlineDsnMatch[1].trim();
      const transport = detectTransportType(rawDsn);
      const maskedDsn = maskDsnCredentials(rawDsn);
      infos.push({
        name: 'schedule.transport',
        transport,
        dsn: maskedDsn,
        options: [],
        issues: buildTransportIssues('schedule.transport', transport, []),
      });
    }
  }

  // Save last transport block
  if (currentName && currentDsn) {
    const transport = detectTransportType(currentDsn);
    const maskedDsn = maskDsnCredentials(currentDsn);
    const issues = buildTransportIssues(currentName, transport, currentOptions.slice());
    infos.push({ name: currentName, transport, dsn: maskedDsn, options: currentOptions.slice(), issues });
  }

  void relFile;
  return infos;
}

function readEnvSchedulerDsn(appPath: string): string | null {
  const envFiles = ['.env', '.env.local', '.env.prod', '.env.production'];
  for (const envFile of envFiles) {
    const filePath = path.join(appPath, envFile);
    const resolved = path.resolve(filePath);
    const resolvedBase = path.resolve(appPath);
    if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) continue;
    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      for (const line of content.split('\n')) {
        const m = /^SCHEDULER_DSN\s*=\s*(.+)/.exec(line);
        if (m) return maskDsnCredentials(m[1].trim());
      }
    } catch { continue; }
  }
  return null;
}

function buildSchedulerTransportInfos(appPath: string): SchedulerTransportInfo[] {
  const results: SchedulerTransportInfo[] = [];
  const configDir = path.join(appPath, 'config', 'packages');

  const schedulerFiles = ['scheduler.yaml', 'scheduler.yml', 'messenger.yaml', 'messenger.yml'];
  for (const fname of schedulerFiles) {
    const filePath = path.join(configDir, fname);
    const content = safeRead(filePath, appPath);
    if (content === null) continue;
    if (!/scheduler|schedule\.transport/.test(content)) continue;
    const infos = parseSchedulerYaml(content, path.relative(appPath, filePath));
    results.push(...infos);
  }

  // Also scan all config packages for scheduler references
  let allConfigs: string[] = [];
  try {
    allConfigs = fs.readdirSync(configDir)
      .filter((f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !schedulerFiles.includes(f))
      .map((f) => path.join(configDir, f));
  } catch { /* skip */ }

  for (const file of allConfigs) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!/scheduler/.test(content)) continue;
    const infos = parseSchedulerYaml(content, path.relative(appPath, file));
    results.push(...infos);
  }

  // Fallback to .env
  if (results.length === 0) {
    const envDsn = readEnvSchedulerDsn(appPath);
    if (envDsn) {
      const transport = detectTransportType(envDsn);
      results.push({
        name: 'SCHEDULER_DSN (env)',
        transport,
        dsn: envDsn,
        options: [],
        issues: buildTransportIssues('SCHEDULER_DSN', transport, []),
      });
    }
  }

  return results;
}

export function listSymfonySchedulerTransportConfig(appPath: string): McpToolResult {
  try {
    const infos = buildSchedulerTransportInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony scheduler transport configuration found (config/packages/scheduler.yaml, messenger.yaml, .env SCHEDULER_DSN).' }] };
    }

    let text = `Symfony Scheduler Transport Configuration\n${'='.repeat(55)}\n\n`;
    text += `Transports found: ${infos.length}\n\n`;

    for (const info of infos) {
      text += `Transport: ${info.name}\n`;
      text += `  Type: ${info.transport}\n`;
      text += `  DSN:  ${info.dsn}\n`;
      if (info.options.length > 0) {
        text += `  Options: ${info.options.join(', ')}\n`;
      }
      if (info.issues.length > 0) {
        text += `  Issues:\n`;
        for (const issue of info.issues) {
          text += `    - ${issue}\n`;
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySchedulerTransportConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildSchedulerTransportInfos(appPath);

    const typeCounts: Record<string, number> = {};
    for (const info of infos) {
      typeCounts[info.transport] = (typeCounts[info.transport] ?? 0) + 1;
    }
    const withIssues = infos.filter((i) => i.issues.length > 0).length;
    const ephemeral = infos.filter((i) => i.transport === 'in-memory' || i.transport === 'filesystem').length;
    const persistent = infos.filter((i) => i.transport === 'doctrine' || i.transport === 'redis').length;

    let text = `Symfony Scheduler Transport Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total transports:     ${infos.length}\n`;
    text += `Transports w/ issues: ${withIssues}\n`;
    text += `  Persistent:         ${persistent}\n`;
    text += `  Ephemeral:          ${ephemeral}\n\n`;
    text += `By type:\n`;
    for (const [t, count] of Object.entries(typeCounts)) {
      text += `  ${t.padEnd(12)}: ${count}\n`;
    }
    if (ephemeral > 0) {
      text += `\nWARNING: Ephemeral transport(s) found — tasks lost on restart; use doctrine:// or redis:// in production\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySchedulerTransportConfigTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_scheduler_transport_config',
      description: 'List Symfony scheduler transport configuration: DSNs (credentials masked), transport types (doctrine/redis/memory/filesystem), issues like ephemeral in-memory transport or missing distributed lock',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_scheduler_transport_config_stats',
      description: 'Get Symfony scheduler transport statistics: counts by type, persistent vs ephemeral breakdown, issues summary, production readiness warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
