// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Per-type validator coverage for input-validator.ts.
 *
 * The existing suites exercise validateToolArgs through a handful of tools;
 * these reach each type validator's own rejection branches — the length caps,
 * the character allowlists, the numeric bounds and the enum membership test —
 * since this is layer one of the security pipeline and a gap here is a gap
 * everywhere downstream.
 */

import {
  validateToolArgs,
  isInputValidationEnabled,
  getValidatedTools,
} from '../utils/input-validator';

const APP = '/var/www/app';

describe('path parameters', () => {
  test('accepts an ordinary absolute path', () => {
    expect(validateToolArgs('list_routes', { app_path: APP }).valid).toBe(true);
  });

  test('rejects a non-string', () => {
    const r = validateToolArgs('list_routes', { app_path: 42 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/must be a string/);
  });

  test('rejects an empty path as missing, since app_path is required', () => {
    const r = validateToolArgs('list_routes', { app_path: '' });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/Missing required parameter|must not be empty/);
  });

  test('rejects a path beyond the 4096-character cap', () => {
    const r = validateToolArgs('list_routes', { app_path: '/a'.repeat(2100) });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/exceeds max length \(4096\)/);
  });

  test('rejects each shell metacharacter', () => {
    for (const meta of ['|', '&', ';', '`', '$', '(', ')', '<', '>']) {
      const r = validateToolArgs('list_routes', { app_path: `${APP}${meta}x` });
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/unsafe characters/);
    }
  });

  test('rejects carriage return and newline', () => {
    for (const ws of ['\n', '\r']) {
      expect(validateToolArgs('list_routes', { app_path: `${APP}${ws}x` }).valid).toBe(false);
    }
  });

  test('rejects a NUL byte', () => {
    expect(validateToolArgs('list_routes', { app_path: `${APP}\0` }).valid).toBe(false);
  });
});

describe('name parameters', () => {
  test('accepts a normal name', () => {
    expect(validateToolArgs('get_route_details', { app_path: APP, route_name: 'app_home' }).valid)
      .toBe(true);
  });

  test('reports the missing required name', () => {
    const r = validateToolArgs('get_route_details', { app_path: APP });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('Missing required parameter: route_name');
  });

  test('rejects a non-string name', () => {
    const r = validateToolArgs('get_route_details', { app_path: APP, route_name: { a: 1 } });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/must be a string/);
  });

  test('rejects a name past its declared maxLength', () => {
    const r = validateToolArgs('get_environment_logs', {
      app_path: APP,
      environment: 'e'.repeat(65), // schema caps this one at 64
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/exceeds max length \(64\)/);
  });

  test('rejects unsafe characters in a name', () => {
    const r = validateToolArgs('get_route_details', { app_path: APP, route_name: 'app;rm -rf /' });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/unsafe characters/);
  });
});

describe('query parameters', () => {
  test('accepts a normal query', () => {
    expect(validateToolArgs('search_routes', { app_path: APP, query: 'admin' }).valid).toBe(true);
  });

  test('reports the missing required query', () => {
    const r = validateToolArgs('search_routes', { app_path: APP });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('Missing required parameter: query');
  });

  test('rejects a non-string query', () => {
    const r = validateToolArgs('search_routes', { app_path: APP, query: ['a'] });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/must be a string/);
  });

  test('rejects an oversized query', () => {
    const r = validateToolArgs('search_routes', { app_path: APP, query: 'q'.repeat(5000) });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/exceeds max length/);
  });

  test('rejects a NUL byte in a query', () => {
    const r = validateToolArgs('search_routes', { app_path: APP, query: 'admin\0' });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/null byte/);
  });

  test('a query may contain spaces and punctuation', () => {
    expect(validateToolArgs('search_routes', { app_path: APP, query: 'admin user (v2)' }).valid)
      .toBe(true);
  });
});

describe('integer parameters', () => {
  const base = { app_path: APP, file_name: 'dev.log' };

  test('accepts a value inside the range', () => {
    expect(validateToolArgs('tail_log', { ...base, lines: 100 }).valid).toBe(true);
  });

  test('accepts a numeric string', () => {
    expect(validateToolArgs('tail_log', { ...base, lines: '100' }).valid).toBe(true);
  });

  test('rejects a non-numeric value', () => {
    const r = validateToolArgs('tail_log', { ...base, lines: 'many' });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/must be a number/);
  });

  test('rejects below the minimum', () => {
    const r = validateToolArgs('tail_log', { ...base, lines: 0 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/minimum is 1/);
  });

  test('rejects above the maximum', () => {
    const r = validateToolArgs('tail_log', { ...base, lines: 10_001 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/maximum is 10000/);
  });

  test('accepts the exact bounds', () => {
    expect(validateToolArgs('tail_log', { ...base, lines: 1 }).valid).toBe(true);
    expect(validateToolArgs('tail_log', { ...base, lines: 10_000 }).valid).toBe(true);
  });

  test('rejects Infinity and NaN', () => {
    expect(validateToolArgs('tail_log', { ...base, lines: Infinity }).valid).toBe(false);
    expect(validateToolArgs('tail_log', { ...base, lines: NaN }).valid).toBe(false);
  });

  test('an omitted optional integer is fine', () => {
    expect(validateToolArgs('tail_log', base).valid).toBe(true);
  });
});

describe('tools without a registered schema', () => {
  test('still validate app_path, as defence in depth', () => {
    const r = validateToolArgs('some_unregistered_tool', { app_path: `${APP};id` });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/unsafe characters/);
  });

  test('pass when no app_path is supplied at all', () => {
    expect(validateToolArgs('some_unregistered_tool', { anything: 'goes' }).valid).toBe(true);
  });

  test('accept a well-formed app_path', () => {
    expect(validateToolArgs('some_unregistered_tool', { app_path: APP }).valid).toBe(true);
  });
});

describe('configuration surface', () => {
  afterEach(() => {
    delete process.env['SYMFONY_MCP_INPUT_VALIDATION'];
  });

  test('validation is on by default', () => {
    expect(isInputValidationEnabled()).toBe(true);
  });

  test('only the exact string "false" disables it', () => {
    process.env['SYMFONY_MCP_INPUT_VALIDATION'] = 'false';
    expect(isInputValidationEnabled()).toBe(false);

    process.env['SYMFONY_MCP_INPUT_VALIDATION'] = 'no';
    expect(isInputValidationEnabled()).toBe(true);
  });

  test('getValidatedTools lists the schema-backed tools', () => {
    const tools = getValidatedTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).toContain('list_routes');
    expect(new Set(tools).size).toBe(tools.length);
  });
});
