// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PrometheusAlertingRuleInfo {
  source: string;
  type: 'alert' | 'record';
  name: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

function analyzeRulesContent(content: string, source: string): PrometheusAlertingRuleInfo[] {
  const results: PrometheusAlertingRuleInfo[] = [];
  const lines = content.split('\n');
  let currentAlertName = '';
  let currentRecordName = '';
  let inAlertBlock = false;
  let inRecordBlock = false;
  let alertStart = 0;
  let alertHasFor = false;
  let alertHasSeverity = false;
  let alertHasSummary = false;
  let alertHasDescription = false;
  let alertExpr = '';
  let recordHasLabels = false;
  let recordStart = 0;

  const flushAlert = (): void => {
    if (!currentAlertName) return;
    const issues: string[] = [];

    if (!alertHasFor) {
      issues.push(`Alert "${currentAlertName}" missing for: duration — fires immediately on first scrape causing flapping alerts; add a for: duration (e.g., for: 5m)`);
    }
    if (!alertHasSeverity) {
      issues.push(`Alert "${currentAlertName}" missing severity label — add labels: { severity: critical|warning|info } for proper routing in Alertmanager`);
    }
    if (!alertHasSummary) {
      issues.push(`Alert "${currentAlertName}" missing summary annotation — add annotations: { summary: "..." } to describe the alert condition`);
    }
    if (!alertHasDescription) {
      issues.push(`Alert "${currentAlertName}" missing description annotation — add annotations: { description: "..." } for runbook/remediation context`);
    }
    if (!isPascalCase(currentAlertName)) {
      issues.push(`Alert name "${currentAlertName}" does not follow PascalCase naming convention — rename to PascalCase (e.g., HighCpuUsage)`);
    }
    if (/count_values\s*\(/.test(alertExpr)) {
      issues.push(`Alert "${currentAlertName}" uses deprecated count_values() function — use count() by (label) instead`);
    }
    if (/topk\s*\(\s*[^,)]+\s*,/.test(alertExpr) && !/topk\s*\(\s*\d+/.test(alertExpr)) {
      issues.push(`Alert "${currentAlertName}" uses topk without numeric limit — always specify an explicit limit (e.g., topk(5, ...))`);
    }

    const lineRef = `${source}:${alertStart}`;
    if (issues.length > 0) {
      for (const issue of issues) {
        results.push({ source: lineRef, type: 'alert', name: currentAlertName, issue });
      }
    } else {
      results.push({ source: lineRef, type: 'alert', name: currentAlertName, issue: null });
    }

    currentAlertName = '';
    inAlertBlock = false;
    alertHasFor = false;
    alertHasSeverity = false;
    alertHasSummary = false;
    alertHasDescription = false;
    alertExpr = '';
  };

  const flushRecord = (): void => {
    if (!currentRecordName) return;
    const lineRef = `${source}:${recordStart}`;
    results.push({
      source: lineRef,
      type: 'record',
      name: currentRecordName,
      issue: recordHasLabels ? null : `Recording rule "${currentRecordName}" has no labels: block — add labels for federation and multi-cluster aggregation so the metric is properly scoped`,
    });
    currentRecordName = '';
    inRecordBlock = false;
    recordHasLabels = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect start of alert rule
    const alertMatch = /^\s*-?\s*alert\s*:\s*(.+)/.exec(line);
    if (alertMatch) {
      if (inAlertBlock) flushAlert();
      if (inRecordBlock) flushRecord();
      currentAlertName = alertMatch[1].trim().replace(/['"]/g, '');
      inAlertBlock = true;
      inRecordBlock = false;
      alertStart = i + 1;
      alertHasFor = false;
      alertHasSeverity = false;
      alertHasSummary = false;
      alertHasDescription = false;
      alertExpr = '';
      continue;
    }

    // Detect start of record rule
    const recordMatch = /^\s*-?\s*record\s*:\s*(.+)/.exec(line);
    if (recordMatch) {
      if (inAlertBlock) flushAlert();
      if (inRecordBlock) flushRecord();
      currentRecordName = recordMatch[1].trim().replace(/['"]/g, '');
      inRecordBlock = true;
      inAlertBlock = false;
      recordStart = i + 1;
      recordHasLabels = false;
      continue;
    }

    if (inAlertBlock) {
      if (/^\s*for\s*:/.test(trimmed)) alertHasFor = true;
      if (/severity\s*:/.test(trimmed)) alertHasSeverity = true;
      if (/summary\s*:/.test(trimmed)) alertHasSummary = true;
      if (/description\s*:/.test(trimmed)) alertHasDescription = true;
      if (/^\s*expr\s*:/.test(trimmed)) alertExpr = trimmed;
    }

    if (inRecordBlock) {
      if (/^\s*labels\s*:/.test(trimmed)) recordHasLabels = true;
    }
  }

  if (inAlertBlock) flushAlert();
  if (inRecordBlock) flushRecord();

  return results;
}

function collectRulesFiles(appPath: string): string[] {
  const files: string[] = [];
  const searchDirs = ['prometheus', 'monitoring', 'alerting', 'observability', '.'];
  for (const subdir of searchDirs) {
    const dir = subdir === '.' ? appPath : path.join(appPath, subdir);
    if (!fs.existsSync(dir)) continue;
    const yamlFiles = [
      ...scanDirRecursive(dir, '.yml'),
      ...scanDirRecursive(dir, '.yaml'),
    ];
    for (const f of yamlFiles) {
      const name = path.basename(f);
      if (name.endsWith('.rules.yml') || name.endsWith('.rules.yaml') || name.includes('rules')) {
        files.push(f);
      }
    }
  }
  // Deduplicate
  return [...new Set(files)];
}

function buildPrometheusAlertingRulesInfos(appPath: string): PrometheusAlertingRuleInfo[] {
  const results: PrometheusAlertingRuleInfo[] = [];
  const files = collectRulesFiles(appPath);

  for (const fpath of files) {
    const content = safeRead(fpath, appPath);
    if (!content) continue;
    if (!content.includes('alert:') && !content.includes('record:')) continue;
    const relFile = path.relative(appPath, fpath);
    results.push(...analyzeRulesContent(content, relFile));
  }

  return results;
}

export function listPrometheusAlertingRules(appPath: string): McpToolResult {
  try {
    const infos = buildPrometheusAlertingRulesInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Prometheus alerting rules found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Prometheus Alerting Rules Analysis\n${'='.repeat(55)}\n\nRules: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  ${info.name}  (${info.source})\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPrometheusAlertingRulesStats(appPath: string): McpToolResult {
  try {
    const infos = buildPrometheusAlertingRulesInfos(appPath);
    const alerts = infos.filter((i) => i.type === 'alert');
    const records = infos.filter((i) => i.type === 'record');
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Prometheus Alerting Rules Statistics\n${'='.repeat(40)}\n\n`;
    text += `Alert rules:      ${alerts.length}\n`;
    text += `Recording rules:  ${records.length}\n`;
    text += `Issues:           ${issues.length}\n`;
    if (issues.length > 0) {
      text += `\nIssue breakdown:\n`;
      for (const info of issues) {
        text += `  - [${info.name}] ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPrometheusAlertingRulesTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_prometheus_alerting_rules',
      description: 'Scan *.rules.yml/*.rules.yaml, prometheus/, monitoring/, alerting/ for Prometheus alerting issues: alert rules without for: duration (flapping), missing severity label, deprecated expr functions (count_values/topk without limit), non-PascalCase alert names, missing summary/description annotations, recording rules without labels: block.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_prometheus_alerting_rules_stats',
      description: 'Statistics for Prometheus alerting rules: alert/recording rule counts and issue breakdown.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
