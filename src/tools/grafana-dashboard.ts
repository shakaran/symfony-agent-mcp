// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface GrafanaDashboardInfo {
  source: string;
  type: 'dashboard' | 'alert' | 'datasource' | 'secret' | 'provisioning';
  pattern: string;
  issues: string[];
}

function buildGrafanaDashboardInfos(appPath: string): GrafanaDashboardInfo[] {
  const results: GrafanaDashboardInfo[] = [];

  // 1. Check grafana/dashboards/*.json
  const dashboardDir = path.join(appPath, 'grafana', 'dashboards');
  if (fs.existsSync(dashboardDir)) {
    let dashboardCount = 0;
    try {
      for (const entry of fs.readdirSync(dashboardDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          dashboardCount++;
          results.push({
            source: path.join('grafana/dashboards', entry.name),
            type: 'dashboard',
            pattern: `Dashboard: ${entry.name}`,
            issues: [],
          });
        }
      }
    } catch { /* skip */ }

    if (dashboardCount === 0) {
      results.push({
        source: 'grafana/dashboards',
        type: 'dashboard',
        pattern: 'No dashboard files',
        issues: ['No Grafana dashboard configurations found — add dashboards to grafana/dashboards/ directory for provisioning'],
      });
    }
  } else {
    results.push({
      source: 'grafana/dashboards',
      type: 'dashboard',
      pattern: 'Dashboard directory missing',
      issues: ['No Grafana dashboard configurations found — add dashboards to grafana/dashboards/ directory for provisioning'],
    });
  }

  // 2. Check grafana/provisioning/datasources/
  const datasourceDir = path.join(appPath, 'grafana', 'provisioning', 'datasources');
  let hasPrometheus = false;
  let hasDatasourceConfig = false;
  if (fs.existsSync(datasourceDir)) {
    try {
      for (const entry of fs.readdirSync(datasourceDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
        hasDatasourceConfig = true;
        let content = '';
        try { content = fs.readFileSync(path.join(datasourceDir, entry.name), 'utf-8'); } catch { continue; }
        const relPath = path.join('grafana/provisioning/datasources', entry.name);

        // Plain-text password
        if (/password:\s*\S+/.test(content) && !/password:\s*\$\{/.test(content)) {
          results.push({
            source: relPath,
            type: 'secret',
            pattern: 'Plain-text datasource password',
            issues: ['Grafana datasource config with plain-text password — use environment variables: password: ${GF_DATASOURCE_PASSWORD}'],
          });
        }

        // Prometheus datasource
        if (/type:\s*prometheus/i.test(content)) {
          hasPrometheus = true;
          results.push({ source: relPath, type: 'datasource', pattern: 'Prometheus datasource configured', issues: [] });
        }
      }
    } catch { /* skip */ }
  }

  if (!hasDatasourceConfig || !hasPrometheus) {
    results.push({
      source: 'grafana/provisioning/datasources',
      type: 'datasource',
      pattern: 'Missing Prometheus/Loki datasource',
      issues: ['No Prometheus/Loki datasource configured in Grafana provisioning — add a Prometheus datasource for application metrics'],
    });
  }

  // 3. Check docker-compose.yml for hardcoded GF_SECURITY_ADMIN_PASSWORD
  const composePath = path.join(appPath, 'docker-compose.yml');
  if (fs.existsSync(composePath)) {
    let content = '';
    try { content = fs.readFileSync(composePath, 'utf-8'); } catch { /* skip */ }
    if (/GF_SECURITY_ADMIN_PASSWORD:\s*\S+/.test(content) && !/GF_SECURITY_ADMIN_PASSWORD:\s*\$\{/.test(content)) {
      results.push({
        source: 'docker-compose.yml',
        type: 'secret',
        pattern: 'Hardcoded Grafana admin password',
        issues: ['Grafana admin password hardcoded in docker-compose.yml — use environment variable: GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD}'],
      });
    }
  }

  // 4. Check grafana/provisioning/alerting/
  const alertDir = path.join(appPath, 'grafana', 'provisioning', 'alerting');
  if (fs.existsSync(alertDir)) {
    let hasAlerts = false;
    try {
      const entries = fs.readdirSync(alertDir, { withFileTypes: true });
      hasAlerts = entries.some((e) => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')));
    } catch { /* skip */ }

    if (hasAlerts) {
      results.push({ source: 'grafana/provisioning/alerting', type: 'alert', pattern: 'Alert rules configured', issues: [] });
    } else {
      results.push({
        source: 'grafana/provisioning/alerting',
        type: 'alert',
        pattern: 'No alert rules',
        issues: ['No Grafana alert rules found — configure alerts for critical metrics (error rate, response time, memory usage)'],
      });
    }
  } else {
    results.push({
      source: 'grafana/provisioning/alerting',
      type: 'alert',
      pattern: 'Alerting directory missing',
      issues: ['No Grafana alert rules found — configure alerts for critical metrics (error rate, response time, memory usage)'],
    });
  }

  return results;
}

export function listGrafanaDashboard(appPath: string): McpToolResult {
  try {
    const infos = buildGrafanaDashboardInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Grafana configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Grafana Dashboard Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGrafanaDashboardStats(appPath: string): McpToolResult {
  try {
    const infos = buildGrafanaDashboardInfos(appPath);
    let text = `Grafana Dashboard Statistics\n${'='.repeat(40)}\n\n`;
    text += `Dashboard:    ${infos.filter((i) => i.type === 'dashboard').length}\n`;
    text += `Alert:        ${infos.filter((i) => i.type === 'alert').length}\n`;
    text += `Datasource:   ${infos.filter((i) => i.type === 'datasource').length}\n`;
    text += `Secret:       ${infos.filter((i) => i.type === 'secret').length}\n`;
    text += `Provisioning: ${infos.filter((i) => i.type === 'provisioning').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGrafanaDashboardTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_grafana_dashboard',
      description: 'Analyse Grafana provisioning: dashboard JSON files, datasource secrets, hardcoded admin passwords, missing Prometheus datasources, and alert rule configuration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_grafana_dashboard_stats',
      description: 'Statistics for Grafana dashboard configuration: counts by type (dashboard/alert/datasource/secret/provisioning) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
