// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface HelmChartInfo {
  file: string;
  chart: string;
  version: string;
  setting: string;
  issues: string[];
}

function safeReadFile(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function safeReadDir(dir: string, base: string): string[] {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return [];
  try { return fs.readdirSync(resolved); } catch { return []; }
}

function parseChartYaml(content: string, relPath: string): HelmChartInfo[] {
  const results: HelmChartInfo[] = [];

  const nameMatch = content.match(/^name\s*:\s*(.+)/m);
  const versionMatch = content.match(/^version\s*:\s*(.+)/m);
  const appVersionMatch = content.match(/^appVersion\s*:\s*(.+)/m);

  const chartName = nameMatch ? nameMatch[1].trim() : path.dirname(relPath);
  const chartVersion = versionMatch ? versionMatch[1].trim() : 'unknown';
  const appVersion = appVersionMatch ? appVersionMatch[1].trim().replace(/^["']|["']$/g, '') : 'unknown';

  results.push({ file: relPath, chart: chartName, version: chartVersion, setting: `appVersion: ${appVersion}`, issues: [] });

  // dependencies
  const depsMatch = content.match(/^dependencies\s*:([\s\S]{0,2000}?)(?=^[a-z]|$)/m);
  if (depsMatch) {
    const depLines = depsMatch[1].split('\n');
    for (const line of depLines) {
      const depNameMatch = line.match(/^\s*-\s*name\s*:\s*(.+)/);
      if (depNameMatch) {
        results.push({ file: relPath, chart: chartName, version: chartVersion, setting: `dependency: ${depNameMatch[1].trim()}`, issues: [] });
      }
    }
  }

  return results;
}

function parseValuesYaml(content: string, relPath: string, chartName: string): HelmChartInfo[] {
  const results: HelmChartInfo[] = [];

  // image.tag
  const imageTagMatch = content.match(/^\s*tag\s*:\s*(.+)/m);
  const imageTag = imageTagMatch ? imageTagMatch[1].trim().replace(/^["']|["']$/g, '') : null;
  if (imageTag) {
    const info: HelmChartInfo = { file: relPath, chart: chartName, version: imageTag, setting: `image.tag: ${imageTag}`, issues: [] };
    if (imageTag === 'latest') {
      info.issues.push('image.tag is "latest" — pin to a specific image tag (e.g., "1.2.3") for reproducible deployments');
    }
    results.push(info);
  }

  // replicaCount
  const replicaMatch = content.match(/^replicaCount\s*:\s*(\d+)/m);
  if (replicaMatch) {
    results.push({ file: relPath, chart: chartName, version: 'n/a', setting: `replicaCount: ${replicaMatch[1]}`, issues: [] });
  }

  // resources.limits
  const hasResourceLimits = /resources\s*:[^#\n]{0,200}limits\s*:/s.test(content);
  if (!hasResourceLimits) {
    results.push({
      file: relPath,
      chart: chartName,
      version: 'n/a',
      setting: 'resources.limits',
      issues: ['No resources.limits configured — set cpu and memory limits to prevent resource exhaustion and enable QoS guarantees'],
    });
  } else {
    // Check for actual values
    const cpuLimitMatch = content.match(/cpu\s*:\s*(.+)/);
    const memLimitMatch = content.match(/memory\s*:\s*(.+)/);
    results.push({
      file: relPath,
      chart: chartName,
      version: 'n/a',
      setting: `resources.limits cpu=${cpuLimitMatch ? cpuLimitMatch[1].trim() : '?'} memory=${memLimitMatch ? memLimitMatch[1].trim() : '?'}`,
      issues: [],
    });
  }

  // livenessProbe
  if (!/livenessProbe\s*:/.test(content)) {
    results.push({
      file: relPath,
      chart: chartName,
      version: 'n/a',
      setting: 'livenessProbe',
      issues: ['No livenessProbe configured — add livenessProbe to allow Kubernetes to restart unhealthy containers'],
    });
  } else {
    results.push({ file: relPath, chart: chartName, version: 'n/a', setting: 'livenessProbe: configured', issues: [] });
  }

  // readinessProbe
  if (!/readinessProbe\s*:/.test(content)) {
    results.push({
      file: relPath,
      chart: chartName,
      version: 'n/a',
      setting: 'readinessProbe',
      issues: ['No readinessProbe configured — add readinessProbe to prevent traffic from reaching unready pods'],
    });
  } else {
    results.push({ file: relPath, chart: chartName, version: 'n/a', setting: 'readinessProbe: configured', issues: [] });
  }

  return results;
}

function findHelmDirs(appPath: string): string[] {
  const candidates = ['helm', 'charts', 'k8s'];
  const found: string[] = [];
  for (const dir of candidates) {
    const fullPath = path.join(appPath, dir);
    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) found.push(fullPath);
    } catch { /* skip */ }
  }
  return found;
}

function findChartRoots(searchDir: string, base: string, depth: number = 0): string[] {
  if (depth > 3) return [];
  const chartRoots: string[] = [];
  const entries = safeReadDir(searchDir, base);
  if (entries.includes('Chart.yaml')) {
    chartRoots.push(searchDir);
    return chartRoots; // Don't recurse into sub-charts from here
  }
  for (const entry of entries) {
    const fullPath = path.join(searchDir, entry);
    let stat: fs.Stats;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    if (stat.isDirectory() && entry !== 'node_modules' && entry !== '.git') {
      chartRoots.push(...findChartRoots(fullPath, base, depth + 1));
    }
  }
  return chartRoots;
}

function buildHelmChartsConfigInfos(appPath: string): HelmChartInfo[] {
  const results: HelmChartInfo[] = [];
  const helmDirs = findHelmDirs(appPath);

  // Also check root level for Chart.yaml
  const rootChartYaml = path.join(appPath, 'Chart.yaml');
  const rootContent = safeReadFile(rootChartYaml, appPath);
  if (rootContent !== null) {
    const chartInfos = parseChartYaml(rootContent, 'Chart.yaml');
    results.push(...chartInfos);
    const chartName = chartInfos[0]?.chart ?? 'unknown';
    const valuesContent = safeReadFile(path.join(appPath, 'values.yaml'), appPath);
    if (valuesContent !== null) results.push(...parseValuesYaml(valuesContent, 'values.yaml', chartName));
  }

  for (const helmDir of helmDirs) {
    const chartRoots = findChartRoots(helmDir, appPath);
    for (const chartRoot of chartRoots) {
      const chartYamlPath = path.join(chartRoot, 'Chart.yaml');
      const chartContent = safeReadFile(chartYamlPath, appPath);
      if (chartContent === null) continue;
      const relChartYaml = path.relative(appPath, chartYamlPath);
      const chartInfos = parseChartYaml(chartContent, relChartYaml);
      results.push(...chartInfos);
      const chartName = chartInfos[0]?.chart ?? path.basename(chartRoot);

      const valuesYamlPath = path.join(chartRoot, 'values.yaml');
      const valuesContent = safeReadFile(valuesYamlPath, appPath);
      if (valuesContent !== null) {
        results.push(...parseValuesYaml(valuesContent, path.relative(appPath, valuesYamlPath), chartName));
      }
    }
  }

  return results;
}

export function listHelmChartsConfig(appPath: string): McpToolResult {
  try {
    const infos = buildHelmChartsConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Helm chart files found (Chart.yaml, values.yaml under helm/, charts/, k8s/ or root).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Helm Charts Configuration Analysis\n${'='.repeat(55)}\n\nSettings: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.chart}] ${info.setting}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHelmChartsConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildHelmChartsConfigInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    const charts = [...new Set(infos.map((i) => i.chart))];
    let text = `Helm Charts Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Charts found:        ${charts.length}\n`;
    text += `Settings analyzed:   ${infos.length}\n`;
    text += `Image tag issues:    ${infos.filter((i) => i.issues.some((x) => x.includes('latest'))).length}\n`;
    text += `Resource limit issues:${infos.filter((i) => i.setting === 'resources.limits' && i.issues.length > 0).length}\n`;
    text += `Probe issues:        ${infos.filter((i) => i.issues.some((x) => x.includes('Probe'))).length}\n`;
    text += `Total issues:        ${totalIssues}\n`;
    if (charts.length > 0) text += `\nCharts:\n${charts.map((c) => `  ${c}`).join('\n')}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHelmChartsConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_helm_charts_config',
      description: 'Analyse Helm Chart.yaml and values.yaml under helm/, charts/, k8s/ for image.tag:latest, missing resource limits, missing liveness/readiness probes, replicaCount, and chart dependencies',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_helm_charts_config_stats',
      description: 'Statistics for Helm chart configuration: chart count, settings analyzed, image tag/resource limit/probe issues, and total issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
