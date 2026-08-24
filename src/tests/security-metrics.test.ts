// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import {
  incToolCall,
  incRateLimitHit,
  incAuthFailure,
  incPathGuardBlock,
  incAnomalyEvent,
  incDlpRedaction,
  renderPrometheus,
  getMetricsSnapshot,
  resetMetrics,
} from '../utils/security-metrics';

beforeEach(() => {
  resetMetrics();
  delete process.env['SYMFONY_MCP_METRICS'];
});

afterEach(() => {
  resetMetrics();
  delete process.env['SYMFONY_MCP_METRICS'];
});

describe('counter increments', () => {
  test('incToolCall increments success counter', () => {
    incToolCall('list_routes', 'success');
    incToolCall('list_routes', 'success');
    incToolCall('list_routes', 'error');

    const output = renderPrometheus();
    expect(output).toContain('symfony_mcp_tool_calls_total{tool="list_routes",status="success"} 2');
    expect(output).toContain('symfony_mcp_tool_calls_total{tool="list_routes",status="error"} 1');
  });

  test('incRateLimitHit increments per tool', () => {
    incRateLimitHit('tail_log');
    incRateLimitHit('tail_log');
    incRateLimitHit('search_log');

    const output = renderPrometheus();
    expect(output).toContain('symfony_mcp_rate_limit_hits_total{tool="tail_log"} 2');
    expect(output).toContain('symfony_mcp_rate_limit_hits_total{tool="search_log"} 1');
  });

  test('incAuthFailure normalizes reason to safe label', () => {
    incAuthFailure('Invalid signature. Check configuration!');
    const output = renderPrometheus();
    expect(output).toContain('symfony_mcp_auth_failures_total{reason=');
    // Special chars should be replaced with _
    expect(output).not.toContain('!');
  });

  test('incPathGuardBlock records reason', () => {
    incPathGuardBlock('not in allowed paths');
    const output = renderPrometheus();
    expect(output).toContain('symfony_mcp_path_guard_blocks_total');
  });

  test('incAnomalyEvent records type and severity', () => {
    incAnomalyEvent('PATH_TRAVERSAL_PROBE', 'HIGH');
    const output = renderPrometheus();
    expect(output).toContain('symfony_mcp_anomaly_events_total{type="PATH_TRAVERSAL_PROBE",severity="HIGH"} 1');
  });

  test('incDlpRedaction records pattern type', () => {
    incDlpRedaction('JWT_TOKEN');
    incDlpRedaction('JWT_TOKEN');
    incDlpRedaction('AWS_ACCESS_KEY');
    const output = renderPrometheus();
    expect(output).toContain('symfony_mcp_dlp_redactions_total{type="JWT_TOKEN"} 2');
    expect(output).toContain('symfony_mcp_dlp_redactions_total{type="AWS_ACCESS_KEY"} 1');
  });
});

describe('renderPrometheus', () => {
  test('includes HELP and TYPE lines for each metric', () => {
    incToolCall('list_routes', 'success');
    const output = renderPrometheus();
    expect(output).toContain('# HELP symfony_mcp_tool_calls_total');
    expect(output).toContain('# TYPE symfony_mcp_tool_calls_total counter');
  });

  test('includes uptime gauge', () => {
    const output = renderPrometheus();
    expect(output).toContain('# HELP symfony_mcp_uptime_seconds');
    expect(output).toMatch(/symfony_mcp_uptime_seconds \d+/);
  });

  test('different labels are tracked separately', () => {
    incToolCall('list_routes', 'success');
    incToolCall('get_entity_details', 'error');
    const output = renderPrometheus();
    expect(output).toContain('tool="list_routes"');
    expect(output).toContain('tool="get_entity_details"');
  });

  test('SYMFONY_MCP_METRICS=false disables collection', () => {
    process.env['SYMFONY_MCP_METRICS'] = 'false';
    incToolCall('list_routes', 'success');
    const output = renderPrometheus();
    expect(output).toContain('disabled');
    expect(output).not.toContain('symfony_mcp_tool_calls_total');
  });
});

describe('getMetricsSnapshot', () => {
  test('returns object with metric arrays', () => {
    incToolCall('list_routes', 'success');
    const snapshot = getMetricsSnapshot();
    expect(snapshot['symfony_mcp_tool_calls_total']).toBeDefined();
    expect(Array.isArray(snapshot['symfony_mcp_tool_calls_total'])).toBe(true);
  });

  test('returns {enabled: false} when metrics disabled', () => {
    process.env['SYMFONY_MCP_METRICS'] = 'false';
    const snapshot = getMetricsSnapshot();
    expect(snapshot).toEqual({ enabled: false });
  });

  test('includes uptimeSeconds', () => {
    const snapshot = getMetricsSnapshot();
    expect(typeof snapshot['uptimeSeconds']).toBe('number');
  });
});
