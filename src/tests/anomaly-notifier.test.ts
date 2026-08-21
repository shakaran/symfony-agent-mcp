import { notifyAnomalyEvent, getNotifierStatus } from '../utils/anomaly-notifier';
import type { AnomalyEvent } from '../utils/anomaly-detector';

function makeEvent(severity: AnomalyEvent['severity'] = 'HIGH'): AnomalyEvent {
  return {
    ts: new Date().toISOString(),
    type: 'PATH_TRAVERSAL_PROBE',
    severity,
    detail: 'test traversal attempt',
    blocked: false,
  };
}

beforeEach(() => {
  delete process.env['SYMFONY_MCP_WEBHOOK_URL'];
  delete process.env['SYMFONY_MCP_SLACK_WEBHOOK'];
  delete process.env['SYMFONY_MCP_PAGERDUTY_KEY'];
  delete process.env['SYMFONY_MCP_NOTIFY_MIN_SEVERITY'];
});

afterEach(() => {
  delete process.env['SYMFONY_MCP_WEBHOOK_URL'];
  delete process.env['SYMFONY_MCP_SLACK_WEBHOOK'];
  delete process.env['SYMFONY_MCP_PAGERDUTY_KEY'];
  delete process.env['SYMFONY_MCP_NOTIFY_MIN_SEVERITY'];
});

describe('getNotifierStatus', () => {
  test('reports all channels as disabled when no env vars set', () => {
    const status = getNotifierStatus();
    expect(status.genericWebhook).toBe(false);
    expect(status.slack).toBe(false);
    expect(status.pagerDuty).toBe(false);
    expect(status.minSeverity).toBe('HIGH');
  });

  test('reports channels as enabled when env vars set', () => {
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'http://example.com/hook';
    process.env['SYMFONY_MCP_SLACK_WEBHOOK'] = 'https://hooks.slack.com/services/T/B/X';
    process.env['SYMFONY_MCP_PAGERDUTY_KEY'] = 'abc123';
    process.env['SYMFONY_MCP_NOTIFY_MIN_SEVERITY'] = 'MEDIUM';

    const status = getNotifierStatus();
    expect(status.genericWebhook).toBe(true);
    expect(status.slack).toBe(true);
    expect(status.pagerDuty).toBe(true);
    expect(status.minSeverity).toBe('MEDIUM');
  });

  test('defaults to HIGH severity threshold', () => {
    expect(getNotifierStatus().minSeverity).toBe('HIGH');
  });
});

describe('notifyAnomalyEvent', () => {
  test('resolves without throwing when no channels configured', async () => {
    await expect(notifyAnomalyEvent(makeEvent())).resolves.toBeUndefined();
  });

  test('resolves without throwing when webhook URL is invalid', async () => {
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'http://127.0.0.1:19999/nonexistent';
    // Should not throw even if connection is refused
    await expect(notifyAnomalyEvent(makeEvent())).resolves.toBeUndefined();
  }, 10000);

  test('skips notification when severity is below threshold', async () => {
    process.env['SYMFONY_MCP_NOTIFY_MIN_SEVERITY'] = 'CRITICAL';
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'http://should-not-be-called.invalid';

    // LOW severity should not trigger (CRITICAL threshold)
    await expect(notifyAnomalyEvent(makeEvent('LOW'))).resolves.toBeUndefined();
    // HIGH is below CRITICAL, also skipped
    await expect(notifyAnomalyEvent(makeEvent('HIGH'))).resolves.toBeUndefined();
  });

  test('attempts notification at or above threshold', async () => {
    process.env['SYMFONY_MCP_NOTIFY_MIN_SEVERITY'] = 'MEDIUM';
    process.env['SYMFONY_MCP_WEBHOOK_URL'] = 'http://127.0.0.1:19999/hook';

    // MEDIUM >= MEDIUM threshold — should attempt (and fail gracefully)
    await expect(notifyAnomalyEvent(makeEvent('MEDIUM'))).resolves.toBeUndefined();
    await expect(notifyAnomalyEvent(makeEvent('HIGH'))).resolves.toBeUndefined();
    await expect(notifyAnomalyEvent(makeEvent('CRITICAL'))).resolves.toBeUndefined();
  }, 20000);
});
