/**
 * Security Metrics Collector
 *
 * Collects Prometheus-compatible security event counters, exported via
 * GET /metrics on the HTTP transport (or printed to stderr on demand).
 *
 * Metrics:
 *   symfony_mcp_tool_calls_total{tool,status}     — tool invocations (success|error)
 *   symfony_mcp_rate_limit_hits_total{tool}        — rate limit blocks per tool
 *   symfony_mcp_auth_failures_total{reason}        — auth/signing rejections
 *   symfony_mcp_path_guard_blocks_total{reason}    — app_path guard rejections
 *   symfony_mcp_anomaly_events_total{type,severity}— anomaly detector events
 *   symfony_mcp_dlp_redactions_total{type}         — DLP pattern matches redacted
 *   symfony_mcp_uptime_seconds                     — server uptime
 *
 * No external dependencies — pure in-process counters.
 *
 * Configuration:
 *   SYMFONY_MCP_METRICS=false  — disable metrics collection
 */

const startTime = Date.now();

function isEnabled(): boolean {
  return process.env['SYMFONY_MCP_METRICS'] !== 'false';
}

// ─── Counter storage ───────────────────────────────────────────────────────

type Labels = Record<string, string>;

interface MetricFamily {
  help: string;
  type: 'counter' | 'gauge';
  values: Map<string, { labels: Labels; value: number }>;
}

const registry = new Map<string, MetricFamily>();

function ensureMetric(name: string, help: string, type: 'counter' | 'gauge'): MetricFamily {
  let family = registry.get(name);
  if (!family) {
    family = { help, type, values: new Map() };
    registry.set(name, family);
  }
  return family;
}

function labelKey(labels: Labels): string {
  return Object.keys(labels).sort().map((k) => `${k}="${labels[k]}"`).join(',');
}

function inc(name: string, help: string, labels: Labels = {}, by = 1): void {
  if (!isEnabled()) return;
  const family = ensureMetric(name, help, 'counter');
  const key = labelKey(labels);
  const existing = family.values.get(key);
  if (existing) {
    existing.value += by;
  } else {
    family.values.set(key, { labels, value: by });
  }
}

// No isEnabled() guard here: renderPrometheus is the only caller and has
// already returned when metrics are off.
function set(name: string, help: string, labels: Labels = {}, value: number): void {
  const family = ensureMetric(name, help, 'gauge');
  const key = labelKey(labels);
  family.values.set(key, { labels, value });
}

// ─── Public increment functions ────────────────────────────────────────────

export function incToolCall(tool: string, status: 'success' | 'error'): void {
  inc(
    'symfony_mcp_tool_calls_total',
    'Total tool invocations by tool name and status',
    { tool, status }
  );
}

export function incRateLimitHit(tool: string): void {
  inc(
    'symfony_mcp_rate_limit_hits_total',
    'Rate limit blocks per tool',
    { tool }
  );
}

export function incAuthFailure(reason: string): void {
  // Normalize reason to a stable label value
  const normalizedReason = reason
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 64);

  inc(
    'symfony_mcp_auth_failures_total',
    'Authentication/signing rejections by reason',
    { reason: normalizedReason }
  );
}

export function incPathGuardBlock(reason: string): void {
  const normalizedReason = reason
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 64);

  inc(
    'symfony_mcp_path_guard_blocks_total',
    'App path guard rejections by reason',
    { reason: normalizedReason }
  );
}

export function incAnomalyEvent(type: string, severity: string): void {
  inc(
    'symfony_mcp_anomaly_events_total',
    'Anomaly detector events by type and severity',
    { type, severity }
  );
}

export function incDlpRedaction(dlpType: string): void {
  inc(
    'symfony_mcp_dlp_redactions_total',
    'DLP pattern matches redacted by pattern type',
    { type: dlpType }
  );
}

export function incHttpRequest(path: string, method: string, status: string): void {
  inc(
    'symfony_mcp_http_requests_total',
    'HTTP requests to the SSE transport by path, method, and status code',
    { path, method, status }
  );
}

export function incSseSession(action: 'open' | 'close'): void {
  inc(
    'symfony_mcp_sse_sessions_total',
    'SSE session lifecycle events',
    { action }
  );
}

// ─── Serialisation ─────────────────────────────────────────────────────────

/**
 * Renders all metrics in Prometheus text format (exposition format v0.0.4).
 */
export function renderPrometheus(): string {
  if (!isEnabled()) return '# Metrics collection disabled (SYMFONY_MCP_METRICS=false)\n';

  // Always update uptime gauge before rendering
  set(
    'symfony_mcp_uptime_seconds',
    'Server uptime in seconds',
    {},
    Math.floor((Date.now() - startTime) / 1000)
  );

  const lines: string[] = [];

  for (const [name, family] of registry.entries()) {
    lines.push(`# HELP ${name} ${family.help}`);
    lines.push(`# TYPE ${name} ${family.type}`);

    for (const { labels, value } of family.values.values()) {
      const labelStr = Object.keys(labels).length > 0
        ? '{' + Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',') + '}'
        : '';
      lines.push(`${name}${labelStr} ${value}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Returns metrics as a structured object for JSON consumers.
 */
export function getMetricsSnapshot(): Record<string, unknown> {
  if (!isEnabled()) return { enabled: false };

  const snapshot: Record<string, unknown> = {
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
  };

  for (const [name, family] of registry.entries()) {
    const values: Array<{ labels: Labels; value: number }> = [];
    for (const v of family.values.values()) values.push(v);
    snapshot[name] = values;
  }

  return snapshot;
}

/** Resets all counters (for testing). */
export function resetMetrics(): void {
  registry.clear();
}
