// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Anomaly / Intrusion Detection
 *
 * Detects and flags suspicious patterns in tool usage that may indicate
 * an automated attack, prompt injection, or policy violation:
 *
 *  - Path traversal probing (app_path with ../.. sequences)
 *  - Rapid tool scanning (all tools called in rapid succession)
 *  - Auth failure spikes (rate of rejected requests)
 *  - Error rate spikes per tool
 *  - Repeated attempts after rate-limit blocks
 *
 * All detections are non-blocking by default — they emit structured
 * warnings to stderr and audit-compatible events. Set SYMFONY_MCP_ANOMALY_STRICT=true
 * to block requests on HIGH+ severity detections.
 *
 * Configuration:
 *   SYMFONY_MCP_ANOMALY=false         — disable anomaly detection
 *   SYMFONY_MCP_ANOMALY_STRICT=true   — block requests on HIGH severity events
 *   SYMFONY_MCP_ANOMALY_WINDOW_MS     — detection window in ms (default: 60000)
 */

export type AnomalySeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AnomalyEvent {
  ts: string;
  type: string;
  severity: AnomalySeverity;
  detail: string;
  blocked: boolean;
}

// ─── Configuration ─────────────────────────────────────────────────────────

function isEnabled(): boolean {
  return process.env['SYMFONY_MCP_ANOMALY'] !== 'false';
}

function isStrict(): boolean {
  return process.env['SYMFONY_MCP_ANOMALY_STRICT'] === 'true';
}

function getWindowMs(): number {
  return parseInt(process.env['SYMFONY_MCP_ANOMALY_WINDOW_MS'] ?? '60000', 10) || 60_000;
}

// ─── Sliding-window counters ───────────────────────────────────────────────

interface WindowedCounter {
  timestamps: number[];
}

const counters = new Map<string, WindowedCounter>();

function countEvent(key: string): number {
  const now = Date.now();
  const window = getWindowMs();
  const counter = counters.get(key) ?? { timestamps: [] };

  // Prune expired
  counter.timestamps = counter.timestamps.filter((t) => now - t < window);
  counter.timestamps.push(now);
  counters.set(key, counter);

  return counter.timestamps.length;
}

function getCount(key: string): number {
  const now = Date.now();
  const window = getWindowMs();
  const counter = counters.get(key);
  if (!counter) return 0;
  return counter.timestamps.filter((t) => now - t < window).length;
}

/** Reset all counters (for testing). */
export function resetAnomalyCounters(): void {
  counters.clear();
}

// ─── Detection rules ───────────────────────────────────────────────────────

const PATH_TRAVERSAL_RE = /(?:\.\.[\\/]){2,}|(?:%2e%2e[\\/]){1,}|(?:\.\.%2f){1,}/i;
const NULL_BYTE_RE = /\0/;

const SCANNING_THRESHOLD = 15;   // distinct tools in one window = scanning
const ERROR_SPIKE_THRESHOLD = 10; // errors per tool per window
const AUTH_FAILURE_THRESHOLD = 5; // auth failures per window
const RATE_LIMIT_RETRY_THRESHOLD = 8; // rate-limit retries per window

// Track which tools have been called — used for scan detection
const calledToolsInWindow: Map<string, Set<string>> = new Map();

function trackToolCall(clientKey: string, toolName: string): number {
  let set = calledToolsInWindow.get(clientKey);
  if (!set) {
    set = new Set();
    calledToolsInWindow.set(clientKey, set);
  }
  set.add(toolName);

  // Prune periodically — rebuild based on time-filtered counter
  // (simplified: just count distinct tools, not time-windowed per-tool)
  return set.size;
}

/** Clear tool scan tracking (for testing). */
export function resetScanTracking(): void {
  calledToolsInWindow.clear();
}

// ─── Main detection function ───────────────────────────────────────────────

/**
 * Checks a tool call for anomalous patterns.
 *
 * @param toolName  - Name of the tool being called
 * @param appPath   - App path argument (checked for traversal patterns)
 * @param clientKey - Client identifier (default: 'default')
 * @returns AnomalyEvent if an anomaly was detected, null otherwise
 */
export function checkAnomaly(
  toolName: string,
  appPath: string,
  clientKey = 'default'
): AnomalyEvent | null {
  if (!isEnabled()) return null;

  const strict = isStrict();

  // ── Path traversal probing ──────────────────────────────────────────────
  if (appPath && (PATH_TRAVERSAL_RE.test(appPath) || NULL_BYTE_RE.test(appPath))) {
    const count = countEvent(`traversal:${clientKey}`);
    const severity: AnomalySeverity = count >= 3 ? 'CRITICAL' : 'HIGH';
    const event = emit({
      type: 'PATH_TRAVERSAL_PROBE',
      severity,
      detail: `app_path contains traversal pattern (attempt ${count} in window)`,
      blocked: strict && (severity === 'HIGH' || severity === 'CRITICAL'),
    });
    maybeEmitMultiVector(clientKey, 'PATH_TRAVERSAL_PROBE');
    return event;
  }

  // ── Tool scan detection ─────────────────────────────────────────────────
  const distinctTools = trackToolCall(clientKey, toolName);
  if (distinctTools >= SCANNING_THRESHOLD) {
    const count = countEvent(`scan:${clientKey}`);
    if (count === 1) { // emit once per scan event, not every call
      const event = emit({
        type: 'TOOL_SCANNING',
        severity: 'HIGH',
        detail: `${distinctTools} distinct tools called in window (possible reconnaissance)`,
        blocked: false, // never block scanning — too many false positives
      });
      maybeEmitMultiVector(clientKey, 'TOOL_SCANNING');
      return event;
    }
  }

  return null;
}

/**
 * Records an auth failure event and checks for spikes.
 * Call this when request signing or session token validation fails.
 */
export function recordAuthFailure(
  reason: string,
  clientKey = 'default'
): AnomalyEvent | null {
  if (!isEnabled()) return null;

  const count = countEvent(`auth_fail:${clientKey}`);

  if (count >= AUTH_FAILURE_THRESHOLD) {
    const event = emit({
      type: 'AUTH_FAILURE_SPIKE',
      severity: 'CRITICAL',
      detail: `${count} auth failures in window: ${reason}`,
      blocked: isStrict(),
    });
    maybeEmitMultiVector(clientKey, 'AUTH_FAILURE_SPIKE');
    return event;
  }

  return null;
}

/**
 * Records a rate-limit block and checks for persistent hammering.
 */
export function recordRateLimitBlock(
  toolName: string,
  clientKey = 'default'
): AnomalyEvent | null {
  if (!isEnabled()) return null;

  const count = countEvent(`ratelimit:${clientKey}:${toolName}`);

  if (count >= RATE_LIMIT_RETRY_THRESHOLD) {
    const event = emit({
      type: 'RATE_LIMIT_HAMMERING',
      severity: 'HIGH',
      detail: `${count} rate-limit retries for tool "${toolName}" in window`,
      blocked: isStrict(),
    });
    maybeEmitMultiVector(clientKey, 'RATE_LIMIT_HAMMERING');
    return event;
  }

  return null;
}

/**
 * Records a tool error and checks for error-rate spikes.
 */
export function recordToolError(
  toolName: string,
  clientKey = 'default'
): AnomalyEvent | null {
  if (!isEnabled()) return null;

  const count = countEvent(`error:${clientKey}:${toolName}`);

  if (count >= ERROR_SPIKE_THRESHOLD) {
    return emit({
      type: 'ERROR_RATE_SPIKE',
      severity: 'MEDIUM',
      detail: `${count} errors for tool "${toolName}" in window`,
      blocked: false,
    });
  }

  return null;
}

// ─── Multi-vector attack correlation ──────────────────────────────────────────

// Attack-indicator event types (excludes operational events like ERROR_RATE_SPIKE)
const ATTACK_INDICATOR_TYPES = new Set([
  'PATH_TRAVERSAL_PROBE',
  'TOOL_SCANNING',
  'AUTH_FAILURE_SPIKE',
  'RATE_LIMIT_HAMMERING',
]);

// Per-client set of distinct attack event types seen in the current window
const attackTypesPerClient = new Map<string, Map<string, number>>();

function recordAttackType(clientKey: string, type: string): void {
  let clientMap = attackTypesPerClient.get(clientKey);
  if (!clientMap) {
    clientMap = new Map();
    attackTypesPerClient.set(clientKey, clientMap);
  }
  clientMap.set(type, Date.now());
}

function getActiveAttackTypes(clientKey: string): Set<string> {
  const clientMap = attackTypesPerClient.get(clientKey);
  /* istanbul ignore next -- callers run recordAttackType first, which creates
     the entry, so the map is always present here. */
  if (!clientMap) return new Set();
  const now = Date.now();
  const window = getWindowMs();
  const active = new Set<string>();
  for (const [type, ts] of clientMap) {
    if (now - ts < window) active.add(type);
  }
  return active;
}

function checkMultiVector(clientKey: string): AnomalyEvent | null {
  const active = getActiveAttackTypes(clientKey);
  const attackIndicators = [...active].filter(t => ATTACK_INDICATOR_TYPES.has(t));

  // Two or more distinct attack-indicator types in the same window = multi-vector attack
  if (attackIndicators.length >= 2) {
    // Only fire once per combination per window — check if already emitted recently
    const correlKey = `multivector:${clientKey}:${[...attackIndicators].sort().join('+')}`;
    const existingCount = getCount(correlKey);
    if (existingCount > 0) return null; // already emitted this combination
    countEvent(correlKey);

    return emit({
      type: 'MULTI_VECTOR_ATTACK',
      severity: 'CRITICAL',
      detail: `${attackIndicators.length} simultaneous attack indicators: ${attackIndicators.join(', ')}`,
      blocked: true, // always block multi-vector
    });
  }
  return null;
}

/** Reset correlation tracking (for testing). */
export function resetCorrelationTracking(): void {
  attackTypesPerClient.clear();
}

// ─── Event emission ────────────────────────────────────────────────────────

const recentEvents: AnomalyEvent[] = [];
const MAX_RECENT_EVENTS = 100;

function emit(partial: Omit<AnomalyEvent, 'ts'>): AnomalyEvent {
  const event: AnomalyEvent = { ts: new Date().toISOString(), ...partial };

  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();

  const emoji = event.severity === 'CRITICAL' ? '🚨' : event.severity === 'HIGH' ? '⚠️' : 'ℹ️';
  process.stderr.write(
    `[symfony-mcp][anomaly][${event.severity}] ${emoji} ${event.type}: ${event.detail}${event.blocked ? ' — REQUEST BLOCKED' : ''}\n`
  );

  // Fire-and-forget webhook notification (non-blocking, imported lazily to avoid circular dep)
  /* istanbul ignore next -- both handlers exist so a notification failure can
     never reach the tool call. notifyAnomalyEvent resolves even when a webhook
     errors, and the import only fails if the build is broken, so neither runs
     in practice. */
  import('./anomaly-notifier.js').then(({ notifyAnomalyEvent }) => {
    notifyAnomalyEvent(event).catch(() => { /* non-fatal */ });
  }).catch(() => { /* non-fatal */ });

  return event;
}

/** Called after every emitted attack event to trigger correlation check. */
function maybeEmitMultiVector(clientKey: string, type: string): void {
  /* istanbul ignore next -- all four call sites pass a literal that is in the
     set; this guards a future caller passing something else. */
  if (!ATTACK_INDICATOR_TYPES.has(type)) return;
  recordAttackType(clientKey, type);
  checkMultiVector(clientKey); // result is fire-and-forget (side-effects via emit)
}

/**
 * Returns recent anomaly events for diagnostics.
 */
export function getRecentAnomalyEvents(count = 20): AnomalyEvent[] {
  return recentEvents.slice(-count);
}

/**
 * Returns summary counts per anomaly type for the current window.
 */
export function getAnomalySummary(): Record<string, number> {
  const summary: Record<string, number> = {};
  const window = getWindowMs();
  const now = Date.now();

  for (const event of recentEvents) {
    const age = now - new Date(event.ts).getTime();
    if (age < window) {
      summary[event.type] = (summary[event.type] ?? 0) + 1;
    }
  }

  return summary;
}
