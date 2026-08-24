// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Anomaly notifier — the three outbound channels.
 *
 * anomaly-notifier.test.ts covers severity gating and the no-channel case
 * against a dead port. This file mocks `http` and `https` instead, so the
 * payload each channel actually sends can be inspected, along with the
 * failure handling: a webhook that errors, times out or returns a non-2xx
 * must never propagate, because a failed alert must not take down the tool
 * call that triggered it.
 */

import { EventEmitter } from 'events';

jest.mock('https');
jest.mock('http');

import * as https from 'https';
import * as http from 'http';

import { notifyAnomalyEvent, getNotifierStatus } from '../utils/anomaly-notifier';
import type { AnomalyEvent } from '../utils/anomaly-detector';

const ENV_KEYS = [
  'SYMFONY_MCP_WEBHOOK_URL',
  'SYMFONY_MCP_SLACK_WEBHOOK',
  'SYMFONY_MCP_PAGERDUTY_KEY',
  'SYMFONY_MCP_NOTIFY_MIN_SEVERITY',
];

let saved: Record<string, string | undefined>;
let stderrSpy: jest.SpyInstance;

/** Captured request bodies, in call order. */
let sent: Array<{ opts: Record<string, unknown>; body: string }>;

type Behaviour = { status?: number; error?: string; timeout?: boolean };
let behaviour: Behaviour;

function makeRequest(opts: Record<string, unknown>, cb?: (r: unknown) => void): EventEmitter {
  const req = new EventEmitter() as EventEmitter & {
    setTimeout: (ms: number, fn: () => void) => void;
    destroy: () => void;
    write: (chunk: string) => void;
    end: () => void;
  };
  let body = '';
  req.write = (chunk: string): void => { body += chunk; };
  req.end = (): void => {
    sent.push({ opts, body });
    if (behaviour.error) {
      setImmediate(() => req.emit('error', new Error(behaviour.error)));
      return;
    }
    if (behaviour.timeout) return; // never calls back; the timeout fires instead
    const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
    res.statusCode = behaviour.status ?? 200;
    res.resume = (): void => { /* drained */ };
    setImmediate(() => cb?.(res));
  };
  req.setTimeout = (_ms: number, fn: () => void): void => {
    if (behaviour.timeout) setImmediate(fn);
  };
  req.destroy = (): void => { /* no-op */ };
  return req;
}

const event = (over: Partial<AnomalyEvent> = {}): AnomalyEvent => ({
  type: 'PATH_TRAVERSAL_PROBE',
  severity: 'HIGH',
  detail: 'app_path contains traversal pattern',
  blocked: true,
  ts: new Date(1_700_000_000_000).toISOString(),
  ...over,
} as AnomalyEvent);

beforeEach(() => {
  jest.clearAllMocks();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];

  sent = [];
  behaviour = {};
  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);

  for (const lib of [https, http]) {
    (lib.request as unknown as jest.Mock).mockImplementation(
      (opts: Record<string, unknown>, cb?: (r: unknown) => void) => makeRequest(opts, cb)
    );
  }
});

afterEach(() => {
  stderrSpy.mockRestore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('channel selection', () => {
  test('sends nothing when no channel is configured', async () => {
    await notifyAnomalyEvent(event());
    expect(sent).toHaveLength(0);
  });

  test('posts to the generic webhook when configured', async () => {
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'https://hooks.example.com/generic';
    await notifyAnomalyEvent(event());

    expect(sent).toHaveLength(1);
  });

  test('posts to every configured channel at once', async () => {
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'https://hooks.example.com/generic';
    process.env['SYMFONY_MCP_SLACK_WEBHOOK'] = 'https://hooks.example.com/slack';
    process.env['SYMFONY_MCP_PAGERDUTY_KEY'] = 'pd-key-123';

    await notifyAnomalyEvent(event());

    expect(sent).toHaveLength(3);
  });

  test('stays silent below the minimum severity', async () => {
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'https://hooks.example.com/generic';
    process.env['SYMFONY_MCP_NOTIFY_MIN_SEVERITY'] = 'CRITICAL';

    await notifyAnomalyEvent(event({ severity: 'HIGH' }));

    expect(sent).toHaveLength(0);
  });

  test('notifies at or above the minimum severity', async () => {
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'https://hooks.example.com/generic';
    process.env['SYMFONY_MCP_NOTIFY_MIN_SEVERITY'] = 'MEDIUM';

    await notifyAnomalyEvent(event({ severity: 'HIGH' }));

    expect(sent).toHaveLength(1);
  });

  test('uses plain http for an http:// webhook', async () => {
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'http://hooks.internal/generic';
    await notifyAnomalyEvent(event());

    expect(http.request).toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  });
});

describe('payloads', () => {
  test('the generic payload carries the event fields', async () => {
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'https://hooks.example.com/generic';
    await notifyAnomalyEvent(event());

    const payload = JSON.parse(sent[0].body);
    expect(payload).toMatchObject({
      source: 'symfony-agent-mcp',
      event_type: 'PATH_TRAVERSAL_PROBE',
      severity: 'HIGH',
      detail: 'app_path contains traversal pattern',
      blocked: true,
      timestamp: new Date(1_700_000_000_000).toISOString(),
    });
  });

  test('the Slack payload uses blocks and marks a blocked request', async () => {
    process.env['SYMFONY_MCP_SLACK_WEBHOOK'] = 'https://hooks.example.com/slack';
    await notifyAnomalyEvent(event({ blocked: true }));

    const payload = JSON.parse(sent[0].body);
    expect(payload.text).toContain('symfony-agent-mcp');
    expect(Array.isArray(payload.blocks)).toBe(true);
  });

  test('the PagerDuty payload triggers with a routing key and dedup key', async () => {
    process.env['SYMFONY_MCP_PAGERDUTY_KEY'] = 'pd-key-123';
    await notifyAnomalyEvent(event());

    const payload = JSON.parse(sent[0].body);
    expect(payload.routing_key).toBe('pd-key-123');
    expect(payload.event_action).toBe('trigger');
    expect(payload.dedup_key).toContain('PATH_TRAVERSAL_PROBE');
    expect(payload.payload.summary).toContain('PATH_TRAVERSAL_PROBE');
  });

  test('PagerDuty goes to the Events API host', async () => {
    process.env['SYMFONY_MCP_PAGERDUTY_KEY'] = 'pd-key-123';
    await notifyAnomalyEvent(event());

    expect(String(sent[0].opts['hostname'])).toContain('pagerduty.com');
  });

  test('sends JSON with a matching Content-Length', async () => {
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'https://hooks.example.com/generic';
    await notifyAnomalyEvent(event());

    const headers = sent[0].opts['headers'] as Record<string, string | number>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Content-Length']).toBe(Buffer.byteLength(sent[0].body));
    expect(String(headers['User-Agent'])).toContain('symfony-agent-mcp');
  });
});

describe('failure handling', () => {
  beforeEach(() => {
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'https://hooks.example.com/generic';
  });

  test('a connection error is logged, not thrown', async () => {
    behaviour = { error: 'ECONNREFUSED' };

    await expect(notifyAnomalyEvent(event())).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Webhook error: ECONNREFUSED'));
  });

  test('a non-2xx response is logged, not thrown', async () => {
    behaviour = { status: 500 };

    await expect(notifyAnomalyEvent(event())).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Webhook returned 500'));
  });

  test('a 2xx response logs nothing', async () => {
    behaviour = { status: 204 };
    await notifyAnomalyEvent(event());

    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('Webhook returned'));
  });

  test('a timeout is logged, not thrown', async () => {
    behaviour = { timeout: true };

    await expect(notifyAnomalyEvent(event())).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  test('one failing channel does not stop the others', async () => {
    process.env['SYMFONY_MCP_SLACK_WEBHOOK'] = 'https://hooks.example.com/slack';
    behaviour = { error: 'ECONNREFUSED' };

    await expect(notifyAnomalyEvent(event())).resolves.toBeUndefined();
    expect(sent).toHaveLength(2);
  });
});

describe('getNotifierStatus', () => {
  test('reports nothing configured by default, at HIGH', () => {
    expect(getNotifierStatus()).toEqual({
      genericWebhook: false, slack: false, pagerDuty: false, minSeverity: 'HIGH',
    });
  });

  test('reports each channel independently', () => {
    process.env['SYMFONY_MCP_SLACK_WEBHOOK'] = 'https://hooks.example.com/slack';
    const s = getNotifierStatus();

    expect(s.slack).toBe(true);
    expect(s.genericWebhook).toBe(false);
    expect(s.pagerDuty).toBe(false);
  });

  test('reflects a configured minimum severity, case-insensitively', () => {
    process.env['SYMFONY_MCP_NOTIFY_MIN_SEVERITY'] = 'low';
    expect(getNotifierStatus().minSeverity).toBe('LOW');
  });
});
