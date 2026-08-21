/**
 * Security Startup Audit
 *
 * Scans the environment on startup for dangerous or insecure configurations.
 * Emits warnings to stderr with severity levels so operators know what is disabled.
 *
 * This is advisory — the server starts regardless, but operators are informed
 * about any gaps. Use SYMFONY_MCP_STARTUP_AUDIT=false to silence in production
 * once all warnings have been acknowledged.
 *
 * Severity levels:
 *   CRITICAL — configuration makes the server effectively insecure
 *   HIGH     — important security layer is disabled or absent
 *   MEDIUM   — defence-in-depth gap; acceptable in some environments
 *   INFO     — informational, no security impact
 */

export type AuditFinding = {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'INFO';
  code: string;
  message: string;
  env?: string;       // which env var to set to fix it
  suggestion: string;
};

// ─── Individual checks ────────────────────────────────────────────────────────

function checks(): AuditFinding[] {
  const findings: AuditFinding[] = [];

  // ── Request signing ────────────────────────────────────────────────────────
  if (!process.env['SYMFONY_MCP_SIGNING_SECRET']) {
    findings.push({
      severity: 'HIGH',
      code: 'NO_REQUEST_SIGNING',
      message: 'Request signing is disabled — tool calls are not authenticated',
      env: 'SYMFONY_MCP_SIGNING_SECRET',
      suggestion: 'Generate a 32+ character random secret and set it on both the client and server',
    });
  }

  // ── Session tokens ─────────────────────────────────────────────────────────
  if (!process.env['SYMFONY_MCP_SESSION_SECRET']) {
    findings.push({
      severity: 'HIGH',
      code: 'NO_SESSION_SECRET',
      message: 'Session token verification is disabled — any caller can connect',
      env: 'SYMFONY_MCP_SESSION_SECRET',
      suggestion: 'Set SYMFONY_MCP_SESSION_SECRET to a random 32+ character string',
    });
  }

  // ── Audit log ──────────────────────────────────────────────────────────────
  if (process.env['SYMFONY_MCP_AUDIT'] === 'false') {
    findings.push({
      severity: 'HIGH',
      code: 'AUDIT_DISABLED',
      message: 'Audit logging is explicitly disabled — no tool call record kept',
      env: 'SYMFONY_MCP_AUDIT',
      suggestion: 'Remove SYMFONY_MCP_AUDIT=false to re-enable audit logging',
    });
  }

  // ── Audit encryption ───────────────────────────────────────────────────────
  if (process.env['SYMFONY_MCP_AUDIT'] !== 'false' && !process.env['SYMFONY_MCP_AUDIT_KEY']) {
    findings.push({
      severity: 'MEDIUM',
      code: 'AUDIT_NOT_ENCRYPTED',
      message: 'Audit log is written in plaintext — entries are not encrypted at rest',
      env: 'SYMFONY_MCP_AUDIT_KEY',
      suggestion: 'Run: node -e "require(\'crypto\').randomBytes(32).toString(\'base64\')" and set as SYMFONY_MCP_AUDIT_KEY',
    });
  }

  // ── Audit key TTL (Y) ──────────────────────────────────────────────────────
  if (process.env['SYMFONY_MCP_AUDIT_KEY']) {
    const createdAtRaw = process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'];
    const ttlDays = parseInt(process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] ?? '90', 10) || 90;

    if (!createdAtRaw) {
      findings.push({
        severity: 'INFO',
        code: 'AUDIT_KEY_AGE_UNKNOWN',
        message: 'Audit key creation date is not tracked — key age and rotation schedule cannot be verified',
        env: 'SYMFONY_MCP_AUDIT_KEY_CREATED_AT',
        suggestion: `Set SYMFONY_MCP_AUDIT_KEY_CREATED_AT to the ISO timestamp when the key was created (e.g. ${new Date().toISOString()})`,
      });
    } else {
      const createdAt = new Date(createdAtRaw);
      if (isNaN(createdAt.getTime())) {
        findings.push({
          severity: 'INFO',
          code: 'AUDIT_KEY_CREATED_AT_INVALID',
          message: `SYMFONY_MCP_AUDIT_KEY_CREATED_AT is not a valid ISO timestamp: "${createdAtRaw}"`,
          env: 'SYMFONY_MCP_AUDIT_KEY_CREATED_AT',
          suggestion: `Set to a valid ISO timestamp, e.g. ${new Date().toISOString()}`,
        });
      } else {
        const ageDays = (Date.now() - createdAt.getTime()) / 86_400_000;
        const expiresInDays = ttlDays - ageDays;

        if (expiresInDays <= 0) {
          findings.push({
            severity: 'HIGH',
            code: 'AUDIT_KEY_EXPIRED',
            message: `Audit encryption key expired ${Math.floor(Math.abs(expiresInDays))} day(s) ago (TTL: ${ttlDays} days)`,
            env: 'SYMFONY_MCP_AUDIT_KEY',
            suggestion: 'Rotate immediately: generate a new key, set SYMFONY_MCP_AUDIT_KEY_PREV=<old key>, SYMFONY_MCP_AUDIT_KEY=<new key>, restart and optionally call reencryptAuditLog()',
          });
        } else if (expiresInDays <= 7) {
          findings.push({
            severity: 'MEDIUM',
            code: 'AUDIT_KEY_EXPIRING_SOON',
            message: `Audit encryption key expires in ${Math.floor(expiresInDays)} day(s) (TTL: ${ttlDays} days)`,
            env: 'SYMFONY_MCP_AUDIT_KEY',
            suggestion: 'Schedule key rotation before expiry to maintain uninterrupted audit trail encryption',
          });
        }
      }
    }
  }

  // ── Anomaly detection ──────────────────────────────────────────────────────
  if (process.env['SYMFONY_MCP_ANOMALY'] === 'false') {
    findings.push({
      severity: 'HIGH',
      code: 'ANOMALY_DISABLED',
      message: 'Anomaly detection is disabled — intrusion attempts will not be caught',
      env: 'SYMFONY_MCP_ANOMALY',
      suggestion: 'Remove SYMFONY_MCP_ANOMALY=false to re-enable anomaly detection',
    });
  } else if (!process.env['SYMFONY_MCP_ANOMALY_STRICT']) {
    findings.push({
      severity: 'MEDIUM',
      code: 'ANOMALY_NOT_STRICT',
      message: 'Anomaly detection is in log-only mode — HIGH severity events are not blocked',
      env: 'SYMFONY_MCP_ANOMALY_STRICT',
      suggestion: 'Set SYMFONY_MCP_ANOMALY_STRICT=true to block requests on HIGH/CRITICAL anomaly events',
    });
  }

  // ── Path restrictions ──────────────────────────────────────────────────────
  if (!process.env['SYMFONY_MCP_ALLOWED_PATHS']) {
    findings.push({
      severity: 'MEDIUM',
      code: 'NO_PATH_ALLOWLIST',
      message: 'No app path allowlist configured — any filesystem path can be targeted',
      env: 'SYMFONY_MCP_ALLOWED_PATHS',
      suggestion: 'Set SYMFONY_MCP_ALLOWED_PATHS=/path/to/app1,/path/to/app2 to restrict access',
    });
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────
  const rateLimit = process.env['SYMFONY_MCP_RATE_LIMIT'];
  if (rateLimit === '0' || rateLimit === 'false') {
    findings.push({
      severity: 'MEDIUM',
      code: 'RATE_LIMIT_DISABLED',
      message: 'Rate limiting is disabled — no protection against tool call flooding',
      env: 'SYMFONY_MCP_RATE_LIMIT',
      suggestion: 'Remove SYMFONY_MCP_RATE_LIMIT=0 to use the default 60 calls/minute limit',
    });
  }

  // ── DLP ────────────────────────────────────────────────────────────────────
  if (process.env['SYMFONY_MCP_DLP'] === 'false') {
    findings.push({
      severity: 'CRITICAL',
      code: 'DLP_DISABLED',
      message: 'DLP (Data Loss Prevention) is disabled — secrets, keys and PII can leak in tool output',
      env: 'SYMFONY_MCP_DLP',
      suggestion: 'Remove SYMFONY_MCP_DLP=false immediately — DLP is the primary secret protection layer',
    });
  }

  // ── Input validation ───────────────────────────────────────────────────────
  if (process.env['SYMFONY_MCP_INPUT_VALIDATION'] === 'false') {
    findings.push({
      severity: 'HIGH',
      code: 'INPUT_VALIDATION_DISABLED',
      message: 'Input validation is disabled — malformed or oversized parameters bypass schema checks',
      env: 'SYMFONY_MCP_INPUT_VALIDATION',
      suggestion: 'Remove SYMFONY_MCP_INPUT_VALIDATION=false (this flag is for testing only)',
    });
  }

  // ── HTTP transport without TLS ─────────────────────────────────────────────
  const httpPort = process.env['SYMFONY_MCP_HTTP_PORT'];
  if (httpPort && !process.env['SYMFONY_MCP_TLS_CERT']) {
    findings.push({
      severity: 'HIGH',
      code: 'HTTP_NO_TLS',
      message: `HTTP transport is running on port ${httpPort} without TLS — traffic is unencrypted`,
      env: 'SYMFONY_MCP_TLS_CERT',
      suggestion: 'Set SYMFONY_MCP_TLS_CERT and SYMFONY_MCP_TLS_KEY to enable TLS',
    });
  }

  // ── Production without encryption ─────────────────────────────────────────
  const nodeEnv = process.env['NODE_ENV'];
  if (nodeEnv === 'production' && !process.env['SYMFONY_MCP_AUDIT_KEY']) {
    findings.push({
      severity: 'HIGH',
      code: 'PRODUCTION_NO_ENCRYPTION',
      message: 'NODE_ENV=production but audit log encryption is not configured',
      env: 'SYMFONY_MCP_AUDIT_KEY',
      suggestion: 'Always encrypt audit logs in production environments',
    });
  }

  // ── Prompt injection detection (Q) ────────────────────────────────────────
  if (process.env['SYMFONY_MCP_PROMPT_INJECTION'] === 'false') {
    findings.push({
      severity: 'HIGH',
      code: 'PROMPT_INJECTION_DISABLED',
      message: 'Prompt injection detection is disabled — tool outputs may hijack the AI client',
      env: 'SYMFONY_MCP_PROMPT_INJECTION',
      suggestion: 'Remove SYMFONY_MCP_PROMPT_INJECTION=false to re-enable injection detection',
    });
  }

  // ── Per-IP rate limiting for HTTP transport (R) ───────────────────────────
  const httpRateLimit = process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'];
  if (httpPort && httpRateLimit === '0') {
    findings.push({
      severity: 'MEDIUM',
      code: 'HTTP_IP_RATE_LIMIT_DISABLED',
      message: 'Per-IP rate limiting is disabled for the HTTP transport — no protection against IP-level flooding',
      env: 'SYMFONY_MCP_HTTP_RATE_LIMIT',
      suggestion: 'Remove SYMFONY_MCP_HTTP_RATE_LIMIT=0 to use the default 120 requests/minute per IP',
    });
  }

  return findings;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<AuditFinding['severity'], string> = {
  CRITICAL: '🔴',
  HIGH:     '🟠',
  MEDIUM:   '🟡',
  INFO:     'ℹ️',
};

function formatFinding(f: AuditFinding): string {
  const icon = SEVERITY_ICON[f.severity];
  const lines = [
    `${icon} [symfony-mcp][startup-audit][${f.severity}] ${f.code}: ${f.message}`,
  ];
  if (f.env) lines.push(`   → Fix: set ${f.env}`);
  lines.push(`   → ${f.suggestion}`);
  return lines.join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Runs all security checks and emits warnings to stderr.
 * Returns the list of findings so callers can gate on CRITICAL severity.
 *
 * @param exitOnCritical - If true, process.exit(1) on CRITICAL findings (default false)
 */
export function runStartupAudit(exitOnCritical = false): AuditFinding[] {
  if (process.env['SYMFONY_MCP_STARTUP_AUDIT'] === 'false') return [];

  const findings = checks();
  if (findings.length === 0) {
    process.stderr.write('[symfony-mcp][startup-audit] ✅ All security checks passed\n');
    return [];
  }

  // Sort: CRITICAL first, then HIGH, MEDIUM, INFO
  const order: Record<AuditFinding['severity'], number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  process.stderr.write('\n[symfony-mcp][startup-audit] Security configuration warnings:\n');
  for (const f of findings) {
    process.stderr.write(formatFinding(f) + '\n');
  }

  const criticalCount = findings.filter(f => f.severity === 'CRITICAL').length;
  const highCount = findings.filter(f => f.severity === 'HIGH').length;
  process.stderr.write(
    `\n[symfony-mcp][startup-audit] ${findings.length} finding(s): ` +
    `${criticalCount} CRITICAL, ${highCount} HIGH — ` +
    `set SYMFONY_MCP_STARTUP_AUDIT=false to suppress after review\n\n`
  );

  if (exitOnCritical && criticalCount > 0) {
    process.stderr.write('[symfony-mcp][startup-audit] FATAL: CRITICAL findings present. Exiting.\n');
    process.exit(1);
  }

  return findings;
}

/**
 * Returns the count of findings by severity for health/metrics endpoints.
 */
export function getAuditSummary(): Record<AuditFinding['severity'], number> {
  if (process.env['SYMFONY_MCP_STARTUP_AUDIT'] === 'false') {
    return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, INFO: 0 };
  }
  const findings = checks();
  return {
    CRITICAL: findings.filter(f => f.severity === 'CRITICAL').length,
    HIGH:     findings.filter(f => f.severity === 'HIGH').length,
    MEDIUM:   findings.filter(f => f.severity === 'MEDIUM').length,
    INFO:     findings.filter(f => f.severity === 'INFO').length,
  };
}
