/**
 * Per-check coverage for the startup security audit.
 *
 * The audit is what tells an operator their deployment is missing request
 * signing, running without an encrypted audit log, or serving HTTP without
 * TLS. Each check is a small env-var branch, and a check that never fires is
 * worse than no check at all, so each one gets its own trigger here.
 */

import { runStartupAudit, getAuditSummary } from '../utils/startup-audit';

const TOUCHED = [
  'SYMFONY_MCP_STARTUP_AUDIT',
  'SYMFONY_MCP_SIGNING_SECRET',
  'SYMFONY_MCP_SESSION_SECRET',
  'SYMFONY_MCP_AUDIT',
  'SYMFONY_MCP_AUDIT_KEY',
  'SYMFONY_MCP_AUDIT_KEY_CREATED_AT',
  'SYMFONY_MCP_AUDIT_KEY_TTL_DAYS',
  'SYMFONY_MCP_ANOMALY',
  'SYMFONY_MCP_ANOMALY_STRICT',
  'SYMFONY_MCP_ALLOWED_PATHS',
  'SYMFONY_MCP_RATE_LIMIT',
  'SYMFONY_MCP_DLP',
  'SYMFONY_MCP_INPUT_VALIDATION',
  'SYMFONY_MCP_HTTP_PORT',
  'SYMFONY_MCP_TLS_CERT',
  'SYMFONY_MCP_PROMPT_INJECTION',
  'SYMFONY_MCP_HTTP_RATE_LIMIT',
  'NODE_ENV',
];

let saved: Record<string, string | undefined>;
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  // The audit writes its report to stderr; keep the test output readable.
  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Codes reported for the current environment. */
function codes(): string[] {
  return runStartupAudit(false).map((f) => f.code);
}

describe('secrets', () => {
  test('flags a missing signing secret', () => {
    expect(codes()).toContain('NO_REQUEST_SIGNING');
  });

  test('stops flagging once the signing secret is set', () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 'x'.repeat(32);
    expect(codes()).not.toContain('NO_REQUEST_SIGNING');
  });

  test('flags a missing session secret', () => {
    expect(codes()).toContain('NO_SESSION_SECRET');
  });

  test('stops flagging once the session secret is set', () => {
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 'y'.repeat(32);
    expect(codes()).not.toContain('NO_SESSION_SECRET');
  });
});

describe('audit log', () => {
  test('flags an explicitly disabled audit log as HIGH', () => {
    process.env['SYMFONY_MCP_AUDIT'] = 'false';
    const f = runStartupAudit(false).find((x) => x.code === 'AUDIT_DISABLED');
    expect(f?.severity).toBe('HIGH');
  });

  test('flags an unencrypted audit log when no key is set', () => {
    expect(codes()).toContain('AUDIT_NOT_ENCRYPTED');
  });

  test('does not flag encryption once a key is present', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = 'k'.repeat(64);
    expect(codes()).not.toContain('AUDIT_NOT_ENCRYPTED');
  });

  test('a disabled audit log is not also reported as unencrypted', () => {
    process.env['SYMFONY_MCP_AUDIT'] = 'false';
    const c = codes();
    expect(c).toContain('AUDIT_DISABLED');
    expect(c).not.toContain('AUDIT_NOT_ENCRYPTED');
  });
});

describe('audit key rotation', () => {
  beforeEach(() => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = 'k'.repeat(64);
  });

  test('flags an unknown key age', () => {
    expect(codes()).toContain('AUDIT_KEY_AGE_UNKNOWN');
  });

  test('flags an unparseable creation timestamp', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = 'last tuesday';
    expect(codes()).toContain('AUDIT_KEY_CREATED_AT_INVALID');
  });

  test('flags a key past its TTL', () => {
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = old;
    const f = runStartupAudit(false).find((x) => x.code === 'AUDIT_KEY_EXPIRED');
    expect(f?.severity).toBe('HIGH');
  });

  test('warns while a key is nearing its TTL', () => {
    const nearly = new Date(Date.now() - 85 * 86_400_000).toISOString();
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = nearly;
    expect(codes()).toContain('AUDIT_KEY_EXPIRING_SOON');
  });

  test('says nothing about a freshly created key', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] = new Date().toISOString();
    const c = codes();
    expect(c).not.toContain('AUDIT_KEY_EXPIRED');
    expect(c).not.toContain('AUDIT_KEY_EXPIRING_SOON');
    expect(c).not.toContain('AUDIT_KEY_AGE_UNKNOWN');
  });

  test('honours a custom TTL', () => {
    process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = '10';
    process.env['SYMFONY_MCP_AUDIT_KEY_CREATED_AT'] =
      new Date(Date.now() - 20 * 86_400_000).toISOString();
    expect(codes()).toContain('AUDIT_KEY_EXPIRED');
  });
});

describe('runtime protections', () => {
  test('flags disabled anomaly detection', () => {
    process.env['SYMFONY_MCP_ANOMALY'] = 'false';
    expect(codes()).toContain('ANOMALY_DISABLED');
  });

  test('flags anomaly detection left in non-strict mode', () => {
    expect(codes()).toContain('ANOMALY_NOT_STRICT');
  });

  test('flags a missing path allowlist', () => {
    expect(codes()).toContain('NO_PATH_ALLOWLIST');
  });

  test('stops flagging once an allowlist is configured', () => {
    process.env['SYMFONY_MCP_ALLOWED_PATHS'] = '/var/www/app';
    expect(codes()).not.toContain('NO_PATH_ALLOWLIST');
  });

  test('flags rate limiting disabled by 0 or false', () => {
    for (const v of ['0', 'false']) {
      process.env['SYMFONY_MCP_RATE_LIMIT'] = v;
      expect(codes()).toContain('RATE_LIMIT_DISABLED');
    }
  });

  test('flags disabled DLP as CRITICAL', () => {
    process.env['SYMFONY_MCP_DLP'] = 'false';
    const f = runStartupAudit(false).find((x) => x.code === 'DLP_DISABLED');
    expect(f?.severity).toBe('CRITICAL');
  });

  test('flags disabled input validation', () => {
    process.env['SYMFONY_MCP_INPUT_VALIDATION'] = 'false';
    expect(codes()).toContain('INPUT_VALIDATION_DISABLED');
  });

  test('flags disabled prompt-injection filtering', () => {
    process.env['SYMFONY_MCP_PROMPT_INJECTION'] = 'false';
    expect(codes()).toContain('PROMPT_INJECTION_DISABLED');
  });
});

describe('HTTP transport', () => {
  test('flags HTTP served without TLS', () => {
    process.env['SYMFONY_MCP_HTTP_PORT'] = '8080';
    expect(codes()).toContain('HTTP_NO_TLS');
  });

  test('says nothing about TLS when the HTTP transport is off', () => {
    expect(codes()).not.toContain('HTTP_NO_TLS');
  });

  test('stops flagging once a certificate is configured', () => {
    process.env['SYMFONY_MCP_HTTP_PORT'] = '8080';
    process.env['SYMFONY_MCP_TLS_CERT'] = '/etc/ssl/cert.pem';
    expect(codes()).not.toContain('HTTP_NO_TLS');
  });

  test('flags per-IP rate limiting disabled on the HTTP transport', () => {
    process.env['SYMFONY_MCP_HTTP_PORT'] = '8080';
    process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '0';
    expect(codes()).toContain('HTTP_IP_RATE_LIMIT_DISABLED');
  });
});

describe('production posture', () => {
  test('flags an unencrypted audit log in production', () => {
    process.env['NODE_ENV'] = 'production';
    expect(codes()).toContain('PRODUCTION_NO_ENCRYPTION');
  });

  test('does not apply outside production', () => {
    process.env['NODE_ENV'] = 'development';
    expect(codes()).not.toContain('PRODUCTION_NO_ENCRYPTION');
  });
});

describe('report shape', () => {
  test('findings are sorted CRITICAL first', () => {
    process.env['SYMFONY_MCP_DLP'] = 'false';
    const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };
    const sev = runStartupAudit(false).map((f) => order[f.severity]);
    expect([...sev].sort((a, b) => a - b)).toEqual(sev);
  });

  test('every finding carries a code, message and suggestion', () => {
    for (const f of runStartupAudit(false)) {
      expect(f.code).toBeTruthy();
      expect(f.message).toBeTruthy();
      expect(f.suggestion).toBeTruthy();
    }
  });

  test('writes its report to stderr', () => {
    runStartupAudit(false);
    expect(stderrSpy).toHaveBeenCalled();
  });

  test('returns nothing when the audit is switched off', () => {
    process.env['SYMFONY_MCP_STARTUP_AUDIT'] = 'false';
    expect(runStartupAudit(false)).toEqual([]);
  });
});

describe('getAuditSummary', () => {
  test('counts by severity and agrees with the findings list', () => {
    process.env['SYMFONY_MCP_DLP'] = 'false';
    const findings = runStartupAudit(false);
    const summary = getAuditSummary();

    for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'INFO'] as const) {
      expect(summary[sev]).toBe(findings.filter((f) => f.severity === sev).length);
    }
  });

  test('is all zeroes when the audit is switched off', () => {
    process.env['SYMFONY_MCP_STARTUP_AUDIT'] = 'false';
    expect(getAuditSummary()).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, INFO: 0 });
  });
});
