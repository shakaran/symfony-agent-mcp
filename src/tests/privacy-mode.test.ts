// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import { applyPrivacyMode, getPrivacyLevel, getPrivacyStatus, isPrivacyApplicable } from '../utils/privacy-mode';

beforeEach(() => {
  delete process.env['SYMFONY_MCP_PRIVACY'];
  delete process.env['SYMFONY_MCP_PRIVACY_TOOLS'];
});

afterEach(() => {
  delete process.env['SYMFONY_MCP_PRIVACY'];
  delete process.env['SYMFONY_MCP_PRIVACY_TOOLS'];
});

// ── Standard mode (no-op) ──────────────────────────────────────────────────────

describe('standard mode (default)', () => {
  test('returns result unchanged', () => {
    const result = applyPrivacyMode(
      { content: [{ type: 'text', text: 'APP_SECRET=mysecret' }] },
      'list_environment_variables'
    );
    expect(result.content[0].text).toBe('APP_SECRET=mysecret');
  });

  test('isPrivacyApplicable returns false', () => {
    expect(isPrivacyApplicable('any_tool')).toBe(false);
  });
});

// ── Strict mode ──────────────────────────────────────────────────────────────

describe('strict mode', () => {
  beforeEach(() => {
    process.env['SYMFONY_MCP_PRIVACY'] = 'strict';
  });

  test('getPrivacyLevel returns strict', () => {
    expect(getPrivacyLevel()).toBe('strict');
  });

  test('strips env var values from list_environment_variables output', () => {
    const text = 'APP_ENV=prod\nAPP_SECRET=mysecretvalue\nDATABASE_URL=mysql://user:pass@host/db';
    const result = applyPrivacyMode(
      { content: [{ type: 'text', text }] },
      'list_environment_variables'
    );
    expect(result.content[0].text).not.toContain('mysecretvalue');
    expect(result.content[0].text).not.toContain('prod');
    expect(result.content[0].text).toContain('[PRIVACY:STRICT]');
  });

  test('masks IP addresses', () => {
    const result = applyPrivacyMode(
      { content: [{ type: 'text', text: 'Connection from 192.168.1.100 to 10.0.0.1' }] },
      'list_routes'
    );
    expect(result.content[0].text).not.toContain('192.168.1.100');
    expect(result.content[0].text).not.toContain('10.0.0.1');
    expect(result.content[0].text).toContain('[IP]');
  });

  test('does not strip env vars from other tools', () => {
    const text = 'APP_ENV=prod';
    const result = applyPrivacyMode(
      { content: [{ type: 'text', text }] },
      'list_routes' // not a env-var tool
    );
    // ENV_VAR stripping only applies to env-var-exposing tools
    expect(result.content[0].text).toBe('APP_ENV=prod');
  });

  test('preserves isError flag', () => {
    const result = applyPrivacyMode(
      { content: [{ type: 'text', text: 'error' }], isError: true },
      'list_routes'
    );
    expect(result.isError).toBe(true);
  });
});

// ── Paranoid mode ─────────────────────────────────────────────────────────────

describe('paranoid mode', () => {
  beforeEach(() => {
    process.env['SYMFONY_MCP_PRIVACY'] = 'paranoid';
  });

  test('getPrivacyLevel returns paranoid', () => {
    expect(getPrivacyLevel()).toBe('paranoid');
  });

  test('removes version numbers', () => {
    const result = applyPrivacyMode(
      { content: [{ type: 'text', text: 'Symfony 7.1.3 running on PHP 8.3.0' }] },
      'get_app_environment'
    );
    expect(result.content[0].text).not.toContain('7.1.3');
    expect(result.content[0].text).not.toContain('8.3.0');
    expect(result.content[0].text).toContain('[VERSION]');
  });

  test('removes timestamps', () => {
    const result = applyPrivacyMode(
      { content: [{ type: 'text', text: 'Last login: 2024-01-15T10:23:41Z' }] },
      'tail_log'
    );
    expect(result.content[0].text).not.toContain('2024-01-15');
    expect(result.content[0].text).toContain('[TIMESTAMP]');
  });

  test('masks ports', () => {
    const result = applyPrivacyMode(
      { content: [{ type: 'text', text: 'Listening on 127.0.0.1:8080' }] },
      'get_database_info'
    );
    expect(result.content[0].text).not.toContain(':8080');
    expect(result.content[0].text).toContain(':[PORT]');
  });
});

// ── SYMFONY_MCP_PRIVACY_TOOLS ─────────────────────────────────────────────────

describe('tool-specific privacy', () => {
  test('only applies to listed tools when SYMFONY_MCP_PRIVACY_TOOLS is set', () => {
    process.env['SYMFONY_MCP_PRIVACY'] = 'strict';
    process.env['SYMFONY_MCP_PRIVACY_TOOLS'] = 'list_environment_variables';

    expect(isPrivacyApplicable('list_environment_variables')).toBe(true);
    expect(isPrivacyApplicable('list_routes')).toBe(false);
  });

  test('applies to all tools when SYMFONY_MCP_PRIVACY_TOOLS is not set', () => {
    process.env['SYMFONY_MCP_PRIVACY'] = 'strict';

    expect(isPrivacyApplicable('list_routes')).toBe(true);
    expect(isPrivacyApplicable('get_entity_details')).toBe(true);
  });
});

// ── getPrivacyStatus ───────────────────────────────────────────────────────────

describe('getPrivacyStatus', () => {
  test('returns standard when no env var set', () => {
    const status = getPrivacyStatus();
    expect(status.level).toBe('standard');
    expect(status.applicableTools).toBe('all');
  });

  test('returns configured level and tools', () => {
    process.env['SYMFONY_MCP_PRIVACY'] = 'strict';
    process.env['SYMFONY_MCP_PRIVACY_TOOLS'] = 'list_routes,tail_log';
    const status = getPrivacyStatus();
    expect(status.level).toBe('strict');
    expect(status.applicableTools).toEqual(['list_routes', 'tail_log']);
  });
});
