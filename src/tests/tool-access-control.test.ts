// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import {
  checkToolAccess,
  filterAllowedTools,
  isAccessControlConfigured,
  getAccessControlStatus,
} from '../utils/tool-access-control';

beforeEach(() => {
  delete process.env['SYMFONY_MCP_ALLOWED_TOOLS'];
  delete process.env['SYMFONY_MCP_BLOCKED_TOOLS'];
});

afterEach(() => {
  delete process.env['SYMFONY_MCP_ALLOWED_TOOLS'];
  delete process.env['SYMFONY_MCP_BLOCKED_TOOLS'];
});

describe('checkToolAccess — no restrictions', () => {
  test('allows any tool when neither env var is set', () => {
    expect(checkToolAccess('list_routes').allowed).toBe(true);
    expect(checkToolAccess('get_security_config').allowed).toBe(true);
    expect(checkToolAccess('get_database_config').allowed).toBe(true);
  });

  test('isAccessControlConfigured returns false', () => {
    expect(isAccessControlConfigured()).toBe(false);
  });
});

describe('checkToolAccess — allowlist', () => {
  beforeEach(() => {
    process.env['SYMFONY_MCP_ALLOWED_TOOLS'] = 'list_routes,list_services,list_entities';
  });

  test('allows tools in the list', () => {
    expect(checkToolAccess('list_routes').allowed).toBe(true);
    expect(checkToolAccess('list_services').allowed).toBe(true);
    expect(checkToolAccess('list_entities').allowed).toBe(true);
  });

  test('blocks tools not in the list', () => {
    const result = checkToolAccess('get_database_config');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('get_database_config');
    expect(result.reason).toContain('SYMFONY_MCP_ALLOWED_TOOLS');
  });

  test('isAccessControlConfigured returns true', () => {
    expect(isAccessControlConfigured()).toBe(true);
  });

  test('getAccessControlStatus shows allowlist mode', () => {
    const status = getAccessControlStatus();
    expect(status.mode).toBe('allowlist');
    expect(status.allowedTools).toContain('list_routes');
    expect(status.blockedTools).toBeNull();
  });
});

describe('checkToolAccess — denylist', () => {
  beforeEach(() => {
    process.env['SYMFONY_MCP_BLOCKED_TOOLS'] = 'get_security_config,get_database_config,list_environment_variables';
  });

  test('allows tools not in the blocked list', () => {
    expect(checkToolAccess('list_routes').allowed).toBe(true);
    expect(checkToolAccess('list_entities').allowed).toBe(true);
  });

  test('blocks tools in the denied list', () => {
    const result = checkToolAccess('get_security_config');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('SYMFONY_MCP_BLOCKED_TOOLS');
  });

  test('getAccessControlStatus shows denylist mode', () => {
    const status = getAccessControlStatus();
    expect(status.mode).toBe('denylist');
    expect(status.blockedTools).toContain('get_security_config');
    expect(status.allowedTools).toBeNull();
  });
});

describe('checkToolAccess — denylist takes precedence over allowlist', () => {
  beforeEach(() => {
    process.env['SYMFONY_MCP_ALLOWED_TOOLS'] = 'list_routes,get_security_config';
    process.env['SYMFONY_MCP_BLOCKED_TOOLS'] = 'get_security_config';
  });

  test('blocked tool is denied even when in the allowlist', () => {
    expect(checkToolAccess('get_security_config').allowed).toBe(false);
  });

  test('non-blocked tool in allowlist is allowed', () => {
    expect(checkToolAccess('list_routes').allowed).toBe(true);
  });
});

describe('filterAllowedTools', () => {
  test('returns all tools when no restrictions set', () => {
    const tools = [
      { name: 'list_routes' },
      { name: 'get_database_config' },
      { name: 'get_security_config' },
    ];
    expect(filterAllowedTools(tools)).toHaveLength(3);
  });

  test('filters to allowlist', () => {
    process.env['SYMFONY_MCP_ALLOWED_TOOLS'] = 'list_routes';
    const tools = [
      { name: 'list_routes' },
      { name: 'get_database_config' },
    ];
    const filtered = filterAllowedTools(tools);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('list_routes');
  });

  test('removes blocked tools', () => {
    process.env['SYMFONY_MCP_BLOCKED_TOOLS'] = 'get_security_config,get_database_config';
    const tools = [
      { name: 'list_routes' },
      { name: 'get_database_config' },
      { name: 'get_security_config' },
    ];
    const filtered = filterAllowedTools(tools);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('list_routes');
  });

  test('preserves additional tool properties', () => {
    process.env['SYMFONY_MCP_ALLOWED_TOOLS'] = 'list_routes';
    const tools = [{ name: 'list_routes', description: 'Lists all routes', inputSchema: {} }];
    const filtered = filterAllowedTools(tools);
    expect(filtered[0].description).toBe('Lists all routes');
  });
});
