/**
 * Anomaly Event Notifier
 *
 * Sends anomaly detector events to external alerting systems in real time.
 * Integrations: Slack webhook, PagerDuty Events API v2, generic HTTP webhook.
 *
 * All notifications are fire-and-forget (non-blocking). Failures are logged
 * to stderr but never surface to the tool caller.
 *
 * Configuration:
 *   SYMFONY_MCP_WEBHOOK_URL        — Generic HTTP webhook (POST JSON)
 *   SYMFONY_MCP_SLACK_WEBHOOK      — Slack Incoming Webhook URL
 *   SYMFONY_MCP_PAGERDUTY_KEY      — PagerDuty Integration Key (Events API v2)
 *   SYMFONY_MCP_NOTIFY_MIN_SEVERITY — Minimum severity to notify: LOW|MEDIUM|HIGH|CRITICAL
 *                                     (default: HIGH)
 */

import * as https from 'https';
import * as http from 'http';
import { AnomalyEvent, AnomalySeverity } from './anomaly-detector.js';

// ─── Configuration ─────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<AnomalySeverity, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

function getMinSeverity(): AnomalySeverity {
  const val = (process.env['SYMFONY_MCP_NOTIFY_MIN_SEVERITY'] ?? 'HIGH').toUpperCase() as AnomalySeverity;
  return SEVERITY_ORDER[val] !== undefined ? val : 'HIGH';
}

function shouldNotify(severity: AnomalySeverity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[getMinSeverity()];
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function postJson(url: string, body: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify(body);
      const lib = url.startsWith('https') ? https : http;
      const parsed = new URL(url);

      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (url.startsWith('https') ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'User-Agent': 'symfony-agent-mcp/notifier',
          },
        },
        (res) => {
          res.resume(); // drain response
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            process.stderr.write(`[symfony-mcp][notify] Webhook returned ${res.statusCode}\n`);
          }
          resolve();
        }
      );

      req.on('error', (err) => {
        process.stderr.write(`[symfony-mcp][notify] Webhook error: ${err.message}\n`);
        resolve(); // non-fatal
      });

      req.setTimeout(5000, () => {
        req.destroy();
        process.stderr.write(`[symfony-mcp][notify] Webhook timed out\n`);
        resolve();
      });

      req.write(payload);
      req.end();
    } catch (err) {
      process.stderr.write(`[symfony-mcp][notify] Failed to send notification: ${(err as Error).message}\n`);
      resolve();
    }
  });
}

// ─── Payload builders ─────────────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<AnomalySeverity, string> = {
  LOW: 'ℹ️',
  MEDIUM: '⚠️',
  HIGH: '🚨',
  CRITICAL: '🔴',
};

const PAGERDUTY_SEVERITY_MAP: Record<AnomalySeverity, string> = {
  LOW: 'info',
  MEDIUM: 'warning',
  HIGH: 'error',
  CRITICAL: 'critical',
};

function buildGenericPayload(event: AnomalyEvent): Record<string, unknown> {
  return {
    source: 'symfony-agent-mcp',
    event_type: event.type,
    severity: event.severity,
    detail: event.detail,
    blocked: event.blocked,
    timestamp: event.ts,
  };
}

function buildSlackPayload(event: AnomalyEvent): Record<string, unknown> {
  const emoji = SEVERITY_EMOJI[event.severity];
  const blocked = event.blocked ? ' — *REQUEST BLOCKED*' : '';

  return {
    text: `${emoji} *symfony-agent-mcp security alert*`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} Security Alert: ${event.type}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Severity:*\n${event.severity}${blocked}` },
          { type: 'mrkdwn', text: `*Time:*\n${event.ts}` },
          { type: 'mrkdwn', text: `*Detail:*\n${event.detail}` },
        ],
      },
    ],
  };
}

function buildPagerDutyPayload(event: AnomalyEvent, routingKey: string): Record<string, unknown> {
  return {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: `symfony-mcp-${event.type}-${new Date(event.ts).getTime()}`,
    payload: {
      summary: `[symfony-mcp] ${event.type}: ${event.detail}`,
      source: 'symfony-agent-mcp',
      severity: PAGERDUTY_SEVERITY_MAP[event.severity],
      timestamp: event.ts,
      custom_details: {
        type: event.type,
        blocked: event.blocked,
        detail: event.detail,
      },
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Sends an anomaly event to all configured notification channels.
 * Fire-and-forget — never throws, never blocks the caller.
 *
 * Called automatically from anomaly-detector when an event is emitted.
 */
export async function notifyAnomalyEvent(event: AnomalyEvent): Promise<void> {
  if (!shouldNotify(event.severity)) return;

  const promises: Promise<void>[] = [];

  const genericUrl = process.env['SYMFONY_MCP_WEBHOOK_URL'];
  if (genericUrl) {
    promises.push(postJson(genericUrl, buildGenericPayload(event)));
  }

  const slackUrl = process.env['SYMFONY_MCP_SLACK_WEBHOOK'];
  if (slackUrl) {
    promises.push(postJson(slackUrl, buildSlackPayload(event)));
  }

  const pdKey = process.env['SYMFONY_MCP_PAGERDUTY_KEY'];
  if (pdKey) {
    promises.push(
      postJson('https://events.pagerduty.com/v2/enqueue', buildPagerDutyPayload(event, pdKey))
    );
  }

  if (promises.length === 0) return; // No channels configured

  // Fire-and-forget with a safety net
  await Promise.allSettled(promises);
}

/**
 * Returns notification channel status for diagnostics.
 */
export function getNotifierStatus(): {
  genericWebhook: boolean;
  slack: boolean;
  pagerDuty: boolean;
  minSeverity: AnomalySeverity;
} {
  return {
    genericWebhook: !!process.env['SYMFONY_MCP_WEBHOOK_URL'],
    slack: !!process.env['SYMFONY_MCP_SLACK_WEBHOOK'],
    pagerDuty: !!process.env['SYMFONY_MCP_PAGERDUTY_KEY'],
    minSeverity: getMinSeverity(),
  };
}
