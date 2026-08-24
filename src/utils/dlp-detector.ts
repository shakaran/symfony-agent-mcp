// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Advanced DLP (Data Loss Prevention) Detector
 *
 * Detects structural patterns that keyword matching misses:
 *  - Credit/debit card numbers (Luhn-validated)
 *  - JWT tokens
 *  - PEM private/certificate blocks
 *  - Cloud provider API keys (AWS, GCP, Azure)
 *  - Service tokens (Stripe, GitHub, Slack, SendGrid…)
 *  - US SSNs and phone numbers
 *  - Database connection strings with credentials
 *  - Basic Auth / token-as-username credentials embedded in URLs
 *  - Query-string credentials (?password=, ?auth=, ?token=…)
 *  - Azure SAS signatures (&sig=…)
 *  - HashiCorp Vault tokens (hvs.xxx)
 *
 * Integrates with sanitizeConfig() and sanitizeLogOutput() via scanText() / redactText().
 *
 * Configuration:
 *   SYMFONY_MCP_DLP=false  — disable DLP scanning entirely (not recommended)
 *   SYMFONY_MCP_DLP_HASH   — "true" to replace matches with SHA-256 fingerprints
 *                            instead of [REDACTED:<type>] (for forensic correlation)
 */

export interface DlpMatch {
  type: string;
  start: number;
  end: number;
  redactedWith: string;
}

// ─── Pattern definitions ───────────────────────────────────────────────────

interface DlpPattern {
  type: string;
  regex: RegExp;
  validate?: (match: string) => boolean;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
}

const PATTERNS: DlpPattern[] = [
  // ── PEM blocks (must come before base64 patterns) ──────────────────────
  {
    type: 'PRIVATE_KEY_PEM',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
    severity: 'CRITICAL',
  },
  {
    type: 'CERTIFICATE_PEM',
    regex: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    severity: 'HIGH',
  },

  // ── JWT tokens ─────────────────────────────────────────────────────────
  {
    type: 'JWT_TOKEN',
    regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    severity: 'CRITICAL',
  },

  // ── AWS ────────────────────────────────────────────────────────────────
  {
    type: 'AWS_ACCESS_KEY',
    regex: /\b(AKIA|ASIA|AROA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    severity: 'CRITICAL',
  },
  {
    type: 'AWS_SECRET_KEY',
    // 40-char base64url string preceded by a context keyword
    regex: /(?:aws[_\s-]?secret[_\s-]?(?:access[_\s-]?)?key|AWS_SECRET_ACCESS_KEY)["\s:=]+([A-Za-z0-9/+]{40})\b/gi,
    severity: 'CRITICAL',
  },

  // ── Google ─────────────────────────────────────────────────────────────
  {
    type: 'GCP_API_KEY',
    regex: /\bAIza[0-9A-Za-z\-_]{35,}\b/g,
    severity: 'CRITICAL',
  },
  {
    type: 'GOOGLE_OAUTH',
    regex: /\b[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com\b/g,
    severity: 'HIGH',
  },

  // ── GitHub ─────────────────────────────────────────────────────────────
  {
    type: 'GITHUB_TOKEN',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{32,}\b/g,
    severity: 'CRITICAL',
  },
  {
    type: 'GITHUB_PAT',
    regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
    severity: 'CRITICAL',
  },

  // ── Stripe ─────────────────────────────────────────────────────────────
  {
    type: 'STRIPE_KEY',
    regex: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    severity: 'CRITICAL',
  },

  // ── Slack ──────────────────────────────────────────────────────────────
  {
    type: 'SLACK_TOKEN',
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    severity: 'CRITICAL',
  },
  {
    type: 'SLACK_WEBHOOK',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
    severity: 'HIGH',
  },

  // ── SendGrid / Twilio / Other SaaS ─────────────────────────────────────
  {
    type: 'SENDGRID_KEY',
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
    severity: 'CRITICAL',
  },
  {
    type: 'TWILIO_ACCOUNT_SID',
    regex: /\bAC[a-z0-9]{32}\b/g,
    severity: 'HIGH',
  },

  // ── URLs with credentials ──────────────────────────────────────────────
  {
    type: 'CREDENTIALS_IN_URL',
    // Matches scheme://[user]:password@host (user may be empty: redis://:pass@host)
    regex: /[a-z][a-z0-9+\-.]*:\/\/[^\s/@]*:[^@\s]{1,256}@[^\s"'`>]+/gi,
    severity: 'CRITICAL',
  },
  {
    type: 'TOKEN_AS_USERNAME_IN_URL',
    // Matches scheme://token@host where token has no colon (redis://mytoken@host:6379)
    regex: /[a-z][a-z0-9+\-.]*:\/\/([^\s:@/"'`]{8,})@[^\s"'`>]/gi,
    severity: 'CRITICAL',
  },
  {
    type: 'QUERY_STRING_CREDENTIALS',
    // Matches ?password=val, &auth=val, ?token=val, etc. in URLs or DSN strings
    regex: /[?&](password|auth|token|secret|api_key|apikey|pass|credential)=[^&\s"'`]{1,200}/gi,
    severity: 'HIGH',
  },
  {
    type: 'AZURE_SAS_SIGNATURE',
    // Matches Azure SAS token sig= parameter (URL-encoded or raw base64)
    regex: /[?&]sig=[A-Za-z0-9%+/=]{20,}/gi,
    severity: 'HIGH',
  },
  {
    type: 'VAULT_TOKEN',
    // Matches HashiCorp Vault service token formats: hvs.xxx (current) and hv.xxx
    regex: /\bhvs?\.[A-Za-z0-9]{6,}\b/g,
    severity: 'CRITICAL',
  },

  // ── Credit/debit card numbers ──────────────────────────────────────────
  {
    type: 'CREDIT_CARD',
    regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|2[2-7][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    validate: luhnCheck,
    severity: 'CRITICAL',
  },
  // Formatted card numbers (with spaces or dashes)
  {
    type: 'CREDIT_CARD_FORMATTED',
    regex: /\b(?:\d{4}[\s-]){3}\d{4}\b/g,
    validate: (s) => luhnCheck(s.replace(/[\s-]/g, '')),
    severity: 'CRITICAL',
  },

  // ── US Social Security Numbers ─────────────────────────────────────────
  {
    type: 'SSN_US',
    regex: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    severity: 'HIGH',
  },

  // ── US Phone numbers ───────────────────────────────────────────────────
  {
    type: 'PHONE_US',
    regex: /\b(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
    severity: 'MEDIUM',
  },

  // ── Email addresses ───────────────────────────────────────────────────
  {
    type: 'EMAIL',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    severity: 'MEDIUM',
  },
];

// ─── Luhn algorithm ───────────────────────────────────────────────────────

function luhnCheck(num: string): boolean {
  const digits = num.replace(/\D/g, '');
  /* istanbul ignore next -- the CARD regexes only match 13-16 digit runs,
     and the formatted one strips to exactly 16, so this never fires today.
     Kept because luhnCheck is a general-purpose helper. */
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let isEven = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (isEven) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

// ─── ReDoS timeout (T) ────────────────────────────────────────────────────

function getDlpTimeoutMs(): number {
  const raw = parseInt(process.env['SYMFONY_MCP_DLP_TIMEOUT_MS'] ?? '500', 10);
  return isNaN(raw) || raw <= 0 ? 500 : raw;
}

// ─── Public API ───────────────────────────────────────────────────────────

function isDlpEnabled(): boolean {
  return process.env['SYMFONY_MCP_DLP'] !== 'false';
}

function useHashMode(): boolean {
  return process.env['SYMFONY_MCP_DLP_HASH'] === 'true';
}

import * as crypto from 'crypto';

function makeRedactLabel(type: string, value: string): string {
  if (useHashMode()) {
    const fingerprint = crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
    return `[REDACTED:${type}:${fingerprint}]`;
  }
  return `[REDACTED:${type}]`;
}

/**
 * Scans text for DLP pattern matches without redacting.
 * Returns all matches found, ordered by position.
 *
 * Includes a wall-clock timeout (SYMFONY_MCP_DLP_TIMEOUT_MS, default 500 ms)
 * checked between regex executions. A single catastrophic backtrack within one
 * exec() call cannot be interrupted this way, but the size cap
 * (SYMFONY_MCP_MAX_OUTPUT_BYTES) bounds the worst-case input before DLP runs.
 */
export function scanText(text: string): DlpMatch[] {
  if (!isDlpEnabled() || !text) return [];

  const matches: DlpMatch[] = [];
  const deadline = Date.now() + getDlpTimeoutMs();
  let timedOut = false;

  outer: for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = pattern.regex.exec(text)) !== null) {
      if (Date.now() > deadline) {
        timedOut = true;
        break outer;
      }

      const rawMatch = m[0];
      if (pattern.validate && !pattern.validate(rawMatch)) continue;

      matches.push({
        type: pattern.type,
        start: m.index,
        end: m.index + rawMatch.length,
        redactedWith: makeRedactLabel(pattern.type, rawMatch),
      });
    }
  }

  if (timedOut) {
    process.stderr.write(
      `[symfony-mcp][dlp][warn] Scan exceeded timeout of ${getDlpTimeoutMs()}ms ` +
      `— results may be incomplete. Set SYMFONY_MCP_DLP_TIMEOUT_MS to adjust.\n`
    );
  }

  // Sort by start position; longer matches win on overlap
  return matches
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
}

/**
 * Returns the configured DLP scan timeout in milliseconds.
 */
export function getDlpScanTimeoutMs(): number {
  return getDlpTimeoutMs();
}

/**
 * Replaces all DLP pattern matches in text with redaction labels.
 * Handles overlapping patterns — the first/longest match wins.
 */
export function redactText(text: string): string {
  if (!isDlpEnabled() || !text) return text;

  const matches = scanText(text);
  if (matches.length === 0) return text;

  let result = '';
  let cursor = 0;

  for (const match of matches) {
    if (match.start < cursor) continue; // skip overlapping
    result += text.slice(cursor, match.start);
    result += match.redactedWith;
    cursor = match.end;
  }

  result += text.slice(cursor);
  return result;
}

/**
 * Scans an arbitrary value (string, object, array) recursively.
 * Returns whether any DLP violations were found.
 */
export function containsDlpViolation(value: unknown): boolean {
  if (typeof value === 'string') return scanText(value).length > 0;
  if (Array.isArray(value)) return value.some(containsDlpViolation);
  if (value && typeof value === 'object') {
    return Object.values(value).some(containsDlpViolation);
  }
  return false;
}

/**
 * Applies DLP redaction to an arbitrary value recursively.
 */
export function dlpSanitize(value: unknown, depth = 0): unknown {
  if (!isDlpEnabled()) return value;
  if (depth > 10) return value;

  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => dlpSanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, dlpSanitize(v, depth + 1)])
    );
  }
  return value;
}

/**
 * Returns a list of DLP pattern names and their severity for diagnostics.
 */
export function getDlpPatternInfo(): Array<{ type: string; severity: string }> {
  return PATTERNS.map((p) => ({ type: p.type, severity: p.severity }));
}
