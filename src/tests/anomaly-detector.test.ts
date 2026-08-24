// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import {
  checkAnomaly,
  recordAuthFailure,
  recordRateLimitBlock,
  recordToolError,
  getRecentAnomalyEvents,
  getAnomalySummary,
  resetAnomalyCounters,
  resetScanTracking,
} from '../utils/anomaly-detector';

beforeEach(() => {
  resetAnomalyCounters();
  resetScanTracking();
  delete process.env['SYMFONY_MCP_ANOMALY'];
  delete process.env['SYMFONY_MCP_ANOMALY_STRICT'];
  delete process.env['SYMFONY_MCP_ANOMALY_WINDOW_MS'];
});

afterEach(() => {
  resetAnomalyCounters();
  resetScanTracking();
  delete process.env['SYMFONY_MCP_ANOMALY'];
  delete process.env['SYMFONY_MCP_ANOMALY_STRICT'];
  delete process.env['SYMFONY_MCP_ANOMALY_WINDOW_MS'];
});

describe('checkAnomaly', () => {
  test('returns null for normal tool call', () => {
    const result = checkAnomaly('list_routes', '/var/www/app');
    expect(result).toBeNull();
  });

  test('detects path traversal pattern', () => {
    const result = checkAnomaly('list_routes', '../../etc/passwd');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('PATH_TRAVERSAL_PROBE');
    expect(result!.severity).toMatch(/HIGH|CRITICAL/);
  });

  test('detects URL-encoded traversal', () => {
    const result = checkAnomaly('tail_log', '%2e%2e/etc');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('PATH_TRAVERSAL_PROBE');
  });

  test('detects null byte injection', () => {
    const result = checkAnomaly('list_routes', '/app\0evil');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('PATH_TRAVERSAL_PROBE');
  });

  test('escalates severity after repeated traversal attempts', () => {
    // First attempt = HIGH, repeated = CRITICAL
    checkAnomaly('list_routes', '../../etc/1');
    checkAnomaly('list_routes', '../../etc/2');
    const third = checkAnomaly('list_routes', '../../etc/3');
    expect(third!.severity).toBe('CRITICAL');
  });

  test('detects tool scanning after threshold', () => {
    // Call 15+ distinct tools
    const tools = Array.from({ length: 16 }, (_, i) => `tool_${i}`);
    let scanDetected = false;

    for (const tool of tools) {
      const result = checkAnomaly(tool, '/var/www/app');
      if (result?.type === 'TOOL_SCANNING') scanDetected = true;
    }

    expect(scanDetected).toBe(true);
  });

  test('returns null when SYMFONY_MCP_ANOMALY=false', () => {
    process.env['SYMFONY_MCP_ANOMALY'] = 'false';
    const result = checkAnomaly('list_routes', '../../etc/passwd');
    expect(result).toBeNull();
  });

  test('sets blocked=true in strict mode for HIGH severity', () => {
    process.env['SYMFONY_MCP_ANOMALY_STRICT'] = 'true';
    // Three traversal attempts to reach CRITICAL
    checkAnomaly('t', '../../1');
    checkAnomaly('t', '../../2');
    const result = checkAnomaly('t', '../../3');
    expect(result!.blocked).toBe(true);
  });
});

describe('recordAuthFailure', () => {
  test('returns null below threshold', () => {
    const result = recordAuthFailure('bad signature', 'client1');
    expect(result).toBeNull();
  });

  test('returns anomaly event at threshold (5)', () => {
    let event = null;
    for (let i = 0; i < 5; i++) {
      event = recordAuthFailure('bad signature', 'client-spike');
    }
    expect(event).not.toBeNull();
    expect(event!.type).toBe('AUTH_FAILURE_SPIKE');
    expect(event!.severity).toBe('CRITICAL');
  });

  test('isolates per clientKey', () => {
    // 4 failures from client1 should not trigger for client2
    for (let i = 0; i < 4; i++) recordAuthFailure('bad sig', 'client1');
    const result = recordAuthFailure('bad sig', 'client2');
    expect(result).toBeNull();
  });
});

describe('recordRateLimitBlock', () => {
  test('returns null below threshold', () => {
    const result = recordRateLimitBlock('list_routes');
    expect(result).toBeNull();
  });

  test('detects hammering at threshold (8)', () => {
    let event = null;
    for (let i = 0; i < 8; i++) {
      event = recordRateLimitBlock('tail_log', 'hammer-client');
    }
    expect(event).not.toBeNull();
    expect(event!.type).toBe('RATE_LIMIT_HAMMERING');
    expect(event!.severity).toBe('HIGH');
  });
});

describe('recordToolError', () => {
  test('returns null below threshold', () => {
    const result = recordToolError('list_routes');
    expect(result).toBeNull();
  });

  test('detects error spike at threshold (10)', () => {
    let event = null;
    for (let i = 0; i < 10; i++) {
      event = recordToolError('broken_tool', 'errclient');
    }
    expect(event).not.toBeNull();
    expect(event!.type).toBe('ERROR_RATE_SPIKE');
    expect(event!.severity).toBe('MEDIUM');
  });
});

describe('getRecentAnomalyEvents and getAnomalySummary', () => {
  test('getRecentAnomalyEvents returns up to N events', () => {
    for (let i = 0; i < 3; i++) {
      checkAnomaly('t', '../../evil');
    }
    const events = getRecentAnomalyEvents(2);
    expect(events.length).toBe(2);
  });

  test('getAnomalySummary counts by type', () => {
    checkAnomaly('t', '../../evil');
    checkAnomaly('t', '../../evil');
    const summary = getAnomalySummary();
    expect(summary['PATH_TRAVERSAL_PROBE']).toBeGreaterThanOrEqual(1);
  });
});
