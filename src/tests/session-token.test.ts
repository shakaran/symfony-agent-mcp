// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import { generateSessionToken, verifySessionToken, getTokenStatus } from '../utils/session-token';

beforeEach(() => {
  delete process.env['SYMFONY_MCP_SESSION_SECRET'];
  delete process.env['SYMFONY_MCP_SESSION_WINDOW'];
  delete process.env['SYMFONY_MCP_SESSION_STRICT'];
});

afterEach(() => {
  delete process.env['SYMFONY_MCP_SESSION_SECRET'];
  delete process.env['SYMFONY_MCP_SESSION_WINDOW'];
  delete process.env['SYMFONY_MCP_SESSION_STRICT'];
});

describe('generateSessionToken', () => {
  test('returns null when no secret is configured', () => {
    expect(generateSessionToken()).toBeNull();
  });

  test('returns a 32-char hex string when secret is set', () => {
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 'my-test-secret';
    const token = generateSessionToken();
    expect(token).not.toBeNull();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  test('returns a deterministic token within the same time window', () => {
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 'my-test-secret';
    const t1 = generateSessionToken();
    const t2 = generateSessionToken();
    expect(t1).toBe(t2);
  });

  test('different secrets produce different tokens', () => {
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 'secret-one';
    const t1 = generateSessionToken();
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 'secret-two';
    const t2 = generateSessionToken();
    expect(t1).not.toBe(t2);
  });
});

describe('verifySessionToken', () => {
  test('always valid when no secret is configured', () => {
    const result = verifySessionToken(undefined);
    expect(result.valid).toBe(true);

    const result2 = verifySessionToken('any-random-string');
    expect(result2.valid).toBe(true);
  });

  test('valid when correct token is provided', () => {
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 'my-test-secret';
    const token = generateSessionToken()!;
    const result = verifySessionToken(token);
    expect(result.valid).toBe(true);
    expect(result.expiresInSeconds).toBeGreaterThan(0);
  });

  test('invalid when wrong token is provided', () => {
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 'my-test-secret';
    process.env['SYMFONY_MCP_SESSION_STRICT'] = 'true';
    const result = verifySessionToken('wrongtoken12345678901234567890ab');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('invalid or expired');
  });

  test('warns but allows missing token in non-strict mode', () => {
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 'my-test-secret';
    // no SYMFONY_MCP_SESSION_STRICT
    const result = verifySessionToken(undefined);
    expect(result.valid).toBe(true);
  });

  test('rejects missing token in strict mode', () => {
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 'my-test-secret';
    process.env['SYMFONY_MCP_SESSION_STRICT'] = 'true';
    const result = verifySessionToken(undefined);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('No session token provided');
  });

  test('rejects wrong-length token without timing leak', () => {
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 'my-test-secret';
    process.env['SYMFONY_MCP_SESSION_STRICT'] = 'true';
    // token padded to 64 chars for timingSafeEqual — any mismatch should fail
    const result = verifySessionToken('short');
    expect(result.valid).toBe(false);
  });
});

describe('getTokenStatus', () => {
  test('returns enabled=false when no secret configured', () => {
    const status = getTokenStatus();
    expect(status.enabled).toBe(false);
    expect(status.currentToken).toBeNull();
    expect(status.windowSeconds).toBe(300);
  });

  test('returns enabled=true with current token when configured', () => {
    process.env['SYMFONY_MCP_SESSION_SECRET'] = 'my-test-secret';
    process.env['SYMFONY_MCP_SESSION_WINDOW'] = '60';

    const status = getTokenStatus();
    expect(status.enabled).toBe(true);
    expect(status.windowSeconds).toBe(60);
    expect(status.currentToken).toMatch(/^[0-9a-f]{32}$/);
    expect(status.expiresInSeconds).toBeGreaterThan(0);
    expect(status.expiresInSeconds).toBeLessThanOrEqual(60);
  });
});
