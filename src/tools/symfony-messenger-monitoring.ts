import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface MessengerMonitoringInfo {
  source: string;
  type: 'failure-transport' | 'supervisor' | 'metrics' | 'health' | 'limits';
  pattern: string;
  issues: string[];
}

function readFileSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function findSupervisorConfig(appPath: string): boolean {
  const supervisorPaths = [
    path.join(appPath, 'supervisor'),
    path.join(appPath, 'etc', 'supervisor.d'),
    path.join(appPath, 'supervisord.conf'),
    path.join(appPath, '.docker', 'supervisor'),
    path.join(appPath, 'docker', 'supervisor'),
  ];
  for (const p of supervisorPaths) {
    if (!fs.existsSync(p)) continue;
    try {
      const stat = fs.statSync(p);
      if (stat.isFile()) {
        const content = readFileSafe(p);
        if (content.includes('messenger:consume') || content.includes('messenger')) return true;
      } else if (stat.isDirectory()) {
        const files = fs.readdirSync(p);
        for (const f of files) {
          const fStat = fs.lstatSync(path.join(p, f));
          if (fStat.isSymbolicLink()) continue;
          const content = readFileSafe(path.join(p, f));
          if (content.includes('messenger:consume') || content.includes('messenger')) return true;
        }
      }
    } catch { /* skip */ }
  }
  return false;
}

function buildSymfonyMessengerMonitoringInfos(appPath: string): MessengerMonitoringInfo[] {
  const results: MessengerMonitoringInfo[] = [];

  // Check messenger.yaml
  const messengerYaml = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  if (fs.existsSync(messengerYaml)) {
    const content = readFileSafe(messengerYaml);

    if (content.includes('transports:')) {
      if (!content.includes('failure_transport')) {
        results.push({ source: 'config/packages/messenger.yaml', type: 'failure-transport', pattern: 'transports without failure_transport', issues: ["Messenger transports without failure_transport — failed messages will be lost; configure failure_transport: failed to preserve failed messages for inspection and retry"] });
      } else {
        results.push({ source: 'config/packages/messenger.yaml', type: 'failure-transport', pattern: 'failure_transport configured', issues: [] });
      }

      if (!content.includes('retry_strategy')) {
        results.push({ source: 'config/packages/messenger.yaml', type: 'failure-transport', pattern: 'transport without retry_strategy', issues: ['Messenger transport without retry_strategy — use retry_strategy: max_retries: 3 delay: 1000 multiplier: 2 to handle transient failures'] });
      }
    }

    if (content.includes('limits:') || content.includes('memory_limit') || content.includes('time_limit')) {
      results.push({ source: 'config/packages/messenger.yaml', type: 'limits', pattern: 'worker limits configured', issues: [] });
    }
  }

  // Check for supervisor config
  if (findSupervisorConfig(appPath)) {
    results.push({ source: 'supervisor config', type: 'supervisor', pattern: 'supervisor/systemd worker config', issues: [] });
  } else {
    results.push({ source: 'project', type: 'supervisor', pattern: 'no supervisor config', issues: ['No supervisor configuration found for Messenger workers — configure supervisor/systemd to manage workers in production; workers can die silently otherwise'] });
  }

  // Check composer.json for monitoring bundles
  const composerJson = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerJson)) {
    const content = readFileSafe(composerJson);
    if (content.includes('zenstruck/messenger-monitor-bundle')) {
      results.push({ source: 'composer.json', type: 'metrics', pattern: 'zenstruck/messenger-monitor-bundle', issues: [] });
    }
    if (content.includes('sentry/sentry-symfony')) {
      results.push({ source: 'composer.json', type: 'health', pattern: 'sentry/sentry-symfony', issues: [] });
    }
  }

  // Check routing files for queue monitoring routes
  const routingDirs = [path.join(appPath, 'config', 'routes')];
  for (const dir of routingDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        const fPath = path.join(dir, f);
        const fStat = fs.lstatSync(fPath);
        if (fStat.isSymbolicLink()) continue;
        const content = readFileSafe(fPath);
        if (content.includes('/_messenger') || content.includes('/admin/messenger')) {
          results.push({ source: path.join('config/routes', f), type: 'health', pattern: 'messenger monitoring route', issues: [] });
        }
      }
    } catch { /* skip */ }
  }

  return results;
}

export function listSymfonyMessengerMonitoring(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyMessengerMonitoringInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Messenger monitoring configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Messenger Monitoring Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerMonitoringStats(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyMessengerMonitoringInfos(appPath);
    let text = `Symfony Messenger Monitoring Statistics\n${'='.repeat(40)}\n\n`;
    text += `Failure-transport:  ${infos.filter((i) => i.type === 'failure-transport').length}\n`;
    text += `Supervisor:         ${infos.filter((i) => i.type === 'supervisor').length}\n`;
    text += `Metrics:            ${infos.filter((i) => i.type === 'metrics').length}\n`;
    text += `Health:             ${infos.filter((i) => i.type === 'health').length}\n`;
    text += `Limits:             ${infos.filter((i) => i.type === 'limits').length}\n`;
    text += `Issues:             ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerMonitoringTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_messenger_monitoring', description: 'Analyze Symfony Messenger monitoring: failure transport, retry strategy, supervisor/systemd config, monitoring bundles, worker limits', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_messenger_monitoring_stats', description: 'Statistics for Messenger monitoring: counts by type (failure-transport/supervisor/metrics/health/limits) and total issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
