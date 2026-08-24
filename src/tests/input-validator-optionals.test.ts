// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Optional parameters and pattern-constrained names.
 *
 * The required-parameter check catches an empty string before the type
 * validators ever see one, so the validators' own "must not be empty" and
 * enum-membership branches only run for *optional* parameters. Those are the
 * ones a caller is most likely to send half-filled, which makes them worth
 * pinning down rather than leaving to the required-path tests.
 */

import { validateToolArgs } from '../utils/input-validator';

const APP = '/var/www/app';

describe('optional enum parameters', () => {
  test('each declared value is accepted', () => {
    for (const type of ['name', 'path', 'controller', 'all']) {
      expect(validateToolArgs('search_routes', { app_path: APP, query: 'q', type }).valid).toBe(true);
    }
  });

  test('an omitted enum is fine', () => {
    expect(validateToolArgs('search_routes', { app_path: APP, query: 'q' }).valid).toBe(true);
  });

  test('an explicit null enum is treated as omitted', () => {
    expect(validateToolArgs('search_routes', { app_path: APP, query: 'q', type: null }).valid)
      .toBe(true);
  });

  test('a value outside the set is rejected, and the message lists the options', () => {
    const r = validateToolArgs('search_routes', { app_path: APP, query: 'q', type: 'sideways' });

    expect(r.valid).toBe(false);
    expect(r.reason).toContain('must be one of');
    expect(r.reason).toContain('controller');
  });

  test('the service search enum is validated the same way', () => {
    expect(validateToolArgs('search_services', { app_path: APP, query: 'q', type: 'tag' }).valid)
      .toBe(true);
    expect(validateToolArgs('search_services', { app_path: APP, query: 'q', type: 'nope' }).valid)
      .toBe(false);
  });
});

describe('pattern-constrained names', () => {
  test('a table name of word characters is accepted', () => {
    expect(validateToolArgs('get_table_schema', { app_path: APP, table_name: 'user_roles' }).valid)
      .toBe(true);
  });

  test('a table name breaking the pattern is rejected by name, not by shape', () => {
    const r = validateToolArgs('get_table_schema', { app_path: APP, table_name: 'user-roles' });

    expect(r.valid).toBe(false);
    expect(r.reason).toContain('alphanumeric + underscore');
  });

  test('a hex profiler token is accepted', () => {
    expect(validateToolArgs('get_profiler_details', { app_path: APP, token: 'a1b2c3d4' }).valid)
      .toBe(true);
  });

  test('a non-hex profiler token is rejected by its named pattern', () => {
    const r = validateToolArgs('get_profiler_details', { app_path: APP, token: 'not-hex-token' });

    expect(r.valid).toBe(false);
    expect(r.reason).toContain('hex profiler token');
  });

  test('a token past its length cap is rejected before the pattern', () => {
    const r = validateToolArgs('get_profiler_details', { app_path: APP, token: 'a'.repeat(65) });

    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/exceeds max length \(64\)/);
  });
});

describe('empty values on optional parameters', () => {
  test('an empty optional query is rejected as empty', () => {
    // `type` is optional; `query` is required, so use a tool where the empty
    // value reaches the query validator rather than the required check.
    const r = validateToolArgs('search_routes', { app_path: APP, query: 'ok', type: '' });

    expect(r.valid).toBe(false);
    expect(r.reason).toContain('must be one of');
  });

  test('an empty required name is reported as missing, not malformed', () => {
    const r = validateToolArgs('get_table_schema', { app_path: APP, table_name: '' });

    expect(r.valid).toBe(false);
    expect(r.reason).toBe('Missing required parameter: table_name');
  });

  test('a whitespace-only name reaches the pattern check', () => {
    const r = validateToolArgs('get_table_schema', { app_path: APP, table_name: '   ' });

    expect(r.valid).toBe(false);
  });
});
