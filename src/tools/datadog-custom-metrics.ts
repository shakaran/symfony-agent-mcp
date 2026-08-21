import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DatadogCustomMetricInfo {
  file: string;
  line: number;
  metric: string | null;
  type: string;
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

// Metric name validation: only [a-zA-Z0-9._-] allowed by DataDog
function hasInvalidMetricChars(name: string): boolean {
  return /[^a-zA-Z0-9._-]/.test(name);
}

// Detect PII in tag values
function hasPiiTags(tagsString: string): boolean {
  return (
    /['"]user_id\s*:/.test(tagsString) ||
    /['"]email\s*:/.test(tagsString) ||
    /['"]ip\s*:/.test(tagsString) ||
    tagsString.includes('email:') ||
    tagsString.includes('user_id:') ||
    tagsString.includes('ip:')
  );
}

type MetricCallType = 'increment' | 'gauge' | 'histogram' | 'timing' | 'set' | 'event' | 'constructor' | 'unknown';

function classifyMetricCall(line: string): MetricCallType {
  if (line.includes('::increment(') || line.includes('->increment(')) return 'increment';
  if (line.includes('::gauge(') || line.includes('->gauge(')) return 'gauge';
  if (line.includes('::histogram(') || line.includes('->histogram(')) return 'histogram';
  if (line.includes('::timing(') || line.includes('->timing(')) return 'timing';
  if (line.includes('::set(') || line.includes('->set(')) return 'set';
  if (line.includes('::event(') || line.includes('->event(')) return 'event';
  if (line.includes('new DogStatsd(') || line.includes('new Datadogstatsd(')) return 'constructor';
  return 'unknown';
}

function extractMetricName(line: string): string | null {
  // Match first string argument: ('metric.name', ...) or ("metric.name", ...)
  const m = /\(\s*['"]([^'"]{1,100})['"]\s*[,)]/.exec(line);
  return m ? m[1] : null;
}

function buildDatadogCustomMetricInfos(appPath: string): DatadogCustomMetricInfo[] {
  const results: DatadogCustomMetricInfo[] = [];

  // composer.json — check datadog/php-datadogstatsd
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent && composerContent.includes('datadog/php-datadogstatsd')) {
    results.push({ file: 'composer.json', line: 0, metric: null, type: 'composer', issue: null });
  }

  // src/**/*.php
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasDatadog =
      content.includes('Datadogstatsd::') ||
      content.includes('DogStatsd') ||
      content.includes('Datadogstatsd(') ||
      content.includes('->increment(') ||
      content.includes('->gauge(') ||
      content.includes('->histogram(') ||
      content.includes('->timing(');

    if (!hasDatadog) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const isMetricCall =
        /Datadogstatsd::(increment|gauge|histogram|timing|set|event)\s*\(/.test(line) ||
        /->(increment|gauge|histogram|timing|set|event)\s*\(/.test(line) ||
        line.includes('new DogStatsd(') ||
        line.includes('new Datadogstatsd(');

      if (!isMetricCall) continue;

      const callType = classifyMetricCall(line);
      const metricName = callType !== 'constructor' ? extractMetricName(line) : null;

      const issues: string[] = [];

      // Check for invalid metric name characters
      if (metricName && hasInvalidMetricChars(metricName)) {
        issues.push(`Metric name "${metricName}" contains invalid characters — DataDog only allows [a-zA-Z0-9._-]; spaces or special chars cause the metric to be silently dropped`);
      }

      // Check for missing sampling_rate (3rd or 4th argument for statsd calls)
      if (callType !== 'constructor' && callType !== 'event') {
        // Look for sampling_rate in the call: increment('name', 1, 0.5, [...]) — typically 4 args
        const hasSamplingRate = /\(\s*['"][^'"]{1,100}['"]\s*,\s*[^,)]{1,100},\s*[01]\.[0-9]/.test(line) ||
          /sample_rate/.test(line) ||
          /sampleRate/.test(line);
        if (!hasSamplingRate) {
          issues.push(`${callType}() called without explicit sampling_rate — defaults to 1.0 (every request tracked); pass a sampling rate (e.g., 0.1) for high-frequency metrics to reduce DogStatsD traffic`);
        }
      }

      // Check PII in tags
      const tagsMatch = /\[\s*(['"][^\]]{1,500})\]/.exec(line);
      if (tagsMatch && hasPiiTags(tagsMatch[1])) {
        issues.push(`Tag array may contain PII (user_id/email/ip detected) — avoid tagging metrics with personal data; use opaque user identifiers if correlation is needed`);
      }

      // Constructor without host/port
      if (callType === 'constructor') {
        const hasHostOrPort = line.includes('host') || line.includes('port') || line.includes('socket_path');
        if (!hasHostOrPort) {
          issues.push('DogStatsd/Datadogstatsd constructor called without host/port — uses default localhost:8125 which may not be configured in all environments; explicitly set host/port');
        }
        results.push({ file: relFile, line: lineNum, metric: null, type: callType, issue: issues.length > 0 ? issues.join('; ') : null });
        continue;
      }

      results.push({
        file: relFile,
        line: lineNum,
        metric: metricName,
        type: callType,
        issue: issues.length > 0 ? issues.join('; ') : null,
      });
    }
  }

  return results;
}

export function listDatadogCustomMetrics(appPath: string): McpToolResult {
  try {
    const infos = buildDatadogCustomMetricInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Datadog custom metrics (DogStatsD) usage found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Datadog Custom Metrics Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      const metricStr = info.metric ? ` metric:"${info.metric}"` : '';
      text += `\n  [${info.type.toUpperCase()}]${metricStr}  ${info.file}:${info.line}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDatadogCustomMetricsStats(appPath: string): McpToolResult {
  try {
    const infos = buildDatadogCustomMetricInfos(appPath);
    const byType: Record<string, number> = {};
    for (const info of infos) {
      byType[info.type] = (byType[info.type] ?? 0) + 1;
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Datadog Custom Metrics Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total patterns: ${infos.length}\n`;
    for (const [t, count] of Object.entries(byType)) {
      text += `  ${t}: ${count}\n`;
    }
    text += `Issues:         ${issues.length}\n`;
    if (issues.length > 0) {
      text += `\nIssue breakdown:\n`;
      for (const info of issues) {
        text += `  - [${info.file}:${info.line}] ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDatadogCustomMetricsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_datadog_custom_metrics',
      description: 'Scan for DogStatsD / Datadog custom metrics in PHP: composer.json datadog/php-datadogstatsd, PHP Datadogstatsd::increment/gauge/histogram/timing/set/event, new DogStatsd/Datadogstatsd. Validates metric name characters ([a-zA-Z0-9._-] only), detects PII in tags (user_id/email/ip), flags missing sampling_rate parameter and constructor without host/port.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_datadog_custom_metrics_stats',
      description: 'Statistics for Datadog custom metrics: call type breakdown (increment/gauge/histogram/timing/set/event/constructor) and issue count.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
