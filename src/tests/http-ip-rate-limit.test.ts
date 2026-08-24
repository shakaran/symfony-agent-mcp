// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import {
  checkIpRateLimit,
  resetIpRateLimits,
} from '../utils/http-rate-limiter';

beforeEach(() => {
  resetIpRateLimits();
  delete process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'];
});

afterEach(() => {
  resetIpRateLimits();
  delete process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'];
});

describe('checkIpRateLimit — basic behaviour', () => {
  test('allows requests within limit', () => {
    process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '5';
    for (let i = 0; i < 5; i++) {
      expect(checkIpRateLimit('1.2.3.4')).toBe(true);
    }
  });

  test('blocks requests that exceed limit', () => {
    process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '3';
    expect(checkIpRateLimit('1.2.3.4')).toBe(true);
    expect(checkIpRateLimit('1.2.3.4')).toBe(true);
    expect(checkIpRateLimit('1.2.3.4')).toBe(true);
    expect(checkIpRateLimit('1.2.3.4')).toBe(false);
  });

  test('different IPs have independent counters', () => {
    process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '2';
    expect(checkIpRateLimit('10.0.0.1')).toBe(true);
    expect(checkIpRateLimit('10.0.0.1')).toBe(true);
    expect(checkIpRateLimit('10.0.0.1')).toBe(false); // exceeded

    // Different IP should still be allowed
    expect(checkIpRateLimit('10.0.0.2')).toBe(true);
    expect(checkIpRateLimit('10.0.0.2')).toBe(true);
  });

  test('SYMFONY_MCP_HTTP_RATE_LIMIT=0 disables limiting', () => {
    process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '0';
    for (let i = 0; i < 500; i++) {
      expect(checkIpRateLimit('1.2.3.4')).toBe(true);
    }
  });

  test('default limit is 120 requests', () => {
    // Default 120: requests 1–120 allowed
    for (let i = 0; i < 120; i++) {
      expect(checkIpRateLimit('5.5.5.5')).toBe(true);
    }
    expect(checkIpRateLimit('5.5.5.5')).toBe(false);
  });

  test('IPv4-mapped IPv6 is normalised to IPv4', () => {
    process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '2';
    // Both forms should share the same counter
    expect(checkIpRateLimit('::ffff:192.168.1.1')).toBe(true);
    expect(checkIpRateLimit('192.168.1.1')).toBe(true);
    expect(checkIpRateLimit('192.168.1.1')).toBe(false);
  });
});

describe('resetIpRateLimits', () => {
  test('clears all counters', () => {
    process.env['SYMFONY_MCP_HTTP_RATE_LIMIT'] = '1';
    expect(checkIpRateLimit('9.9.9.9')).toBe(true);
    expect(checkIpRateLimit('9.9.9.9')).toBe(false);

    resetIpRateLimits();

    expect(checkIpRateLimit('9.9.9.9')).toBe(true);
  });
});
