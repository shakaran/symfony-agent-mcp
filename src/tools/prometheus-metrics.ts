import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface PrometheusMetricInfo {
  file: string;
  type: 'counter' | 'gauge' | 'histogram' | 'summary' | 'endpoint' | 'config';
  name: string;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildPrometheusInfos(appPath: string): PrometheusMetricInfo[] {
  const results: PrometheusMetricInfo[] = [];

  let hasPrometheusLib = false;
  let hasSymfonyMetrics = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      const reqDev = (composer['require-dev'] ?? {}) as Record<string, string>;
      if (req['promphp/prometheus_client_php'] || req['bref/bref'] || req['enqueue/prometheus']) hasPrometheusLib = true;
      if (req['open-telemetry/opentelemetry-auto-symfony'] || req['symfony/metrics-bundle'] || reqDev['prometheus/client_model']) hasSymfonyMetrics = true;
    } catch { /* ignore */ }
  }

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) {
    if (!hasPrometheusLib && !hasSymfonyMetrics) {
      results.push({ file: 'composer.json', type: 'config', name: 'prometheus', issues: ['No Prometheus client library found (promphp/prometheus_client_php) — no metrics instrumentation detected'] });
    }
    return results;
  }

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const relFile = path.relative(appPath, file);

    if (content.includes('getOrRegisterCounter') || content.includes('registerCounter') || content.includes("'counter'")) {
      const nameMatch = /getOrRegisterCounter\([^,]{0,100},\s*['"]([^'"]{1,80})['"]/.exec(content);
      const metricName = nameMatch ? nameMatch[1] : 'counter';
      const issues: string[] = [];
      if (!content.includes('->inc(') && !content.includes('->incBy(')) {
        issues.push(`Counter "${metricName}" registered but never incremented — dead metric`);
      }
      if (content.includes('->set(') && content.includes('counter')) {
        issues.push(`Counter "${metricName}" has ->set() call — counters should only increment, never be set (use a gauge instead)`);
      }
      results.push({ file: relFile, type: 'counter', name: metricName, issues });
    }

    if (content.includes('getOrRegisterGauge') || content.includes('registerGauge')) {
      const nameMatch = /getOrRegisterGauge\([^,]{0,100},\s*['"]([^'"]{1,80})['"]/.exec(content);
      const metricName = nameMatch ? nameMatch[1] : 'gauge';
      const issues: string[] = [];
      if (!content.includes('->set(') && !content.includes('->incBy(') && !content.includes('->inc(')) {
        issues.push(`Gauge "${metricName}" registered but never updated`);
      }
      results.push({ file: relFile, type: 'gauge', name: metricName, issues });
    }

    if (content.includes('getOrRegisterHistogram') || content.includes('registerHistogram')) {
      const nameMatch = /getOrRegisterHistogram\([^,]{0,100},\s*['"]([^'"]{1,80})['"]/.exec(content);
      const metricName = nameMatch ? nameMatch[1] : 'histogram';
      const issues: string[] = [];
      if (!content.includes('->observe(')) {
        issues.push(`Histogram "${metricName}" registered but observe() never called`);
      }
      const bucketMatch = /\[([^\]]{1,300})\]/.exec(content);
      if (!bucketMatch) {
        issues.push(`Histogram "${metricName}" uses default buckets — define explicit buckets appropriate for the measured range`);
      }
      results.push({ file: relFile, type: 'histogram', name: metricName, issues });
    }

    const isMetricsController = content.includes('/metrics') && content.includes('RenderTextFormat');
    if (isMetricsController) {
      const hasAuthCheck = content.includes('denyAccessUnlessGranted') || content.includes('IsGranted') ||
        content.includes('getUser()') || content.includes('ROLE_');
      const issues: string[] = [];
      if (!hasAuthCheck) {
        issues.push('Prometheus /metrics endpoint has no authentication — exposes all metric labels (which may contain user IDs, email addresses, or operational secrets) to unauthenticated requests');
      }
      results.push({ file: relFile, type: 'endpoint', name: '/metrics', issues });
    }
  }

  if (!hasPrometheusLib && !hasSymfonyMetrics && results.length === 0) {
    results.push({ file: 'composer.json', type: 'config', name: 'prometheus', issues: ['No Prometheus client library or metrics instrumentation found'] });
  }

  return results;
}

export function listPrometheusMetrics(appPath: string): McpToolResult {
  try {
    const infos = buildPrometheusInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Prometheus metric registrations found (no promphp/prometheus_client_php usage).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Prometheus Metrics Analysis\n${'='.repeat(55)}\n\nMetrics: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.name}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPrometheusMetricsStats(appPath: string): McpToolResult {
  try {
    const infos = buildPrometheusInfos(appPath);
    let text = `Prometheus Statistics\n${'='.repeat(40)}\n\n`;
    text += `Counters:    ${infos.filter((i) => i.type === 'counter').length}\n`;
    text += `Gauges:      ${infos.filter((i) => i.type === 'gauge').length}\n`;
    text += `Histograms:  ${infos.filter((i) => i.type === 'histogram').length}\n`;
    text += `Endpoints:   ${infos.filter((i) => i.type === 'endpoint').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPrometheusMetricsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_prometheus_metrics', description: 'Detect Prometheus metric instrumentation (counters/gauges/histograms); warns on dead metrics, counter set() usage, histogram without explicit buckets, unauthenticated /metrics endpoint', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_prometheus_metrics_stats', description: 'Statistics for Prometheus: counter/gauge/histogram/endpoint count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
