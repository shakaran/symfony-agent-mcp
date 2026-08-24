// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import { sanitizeToolResult, sanitizeErrorMessage } from '../utils/output-sanitizer';

beforeEach(() => {
  delete process.env['SYMFONY_MCP_DLP'];
  delete process.env['SYMFONY_MCP_PRIVACY'];
  delete process.env['SYMFONY_MCP_PRIVACY_TOOLS'];
});

afterEach(() => {
  delete process.env['SYMFONY_MCP_DLP'];
  delete process.env['SYMFONY_MCP_PRIVACY'];
  delete process.env['SYMFONY_MCP_PRIVACY_TOOLS'];
});

// ── sanitizeToolResult ────────────────────────────────────────────────────────

describe('sanitizeToolResult — DLP gate', () => {
  test('redacts JWT in tool output', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = sanitizeToolResult(
      { content: [{ type: 'text', text: `Authorization token: ${jwt}` }] },
      'list_routes'
    );
    expect(result.content[0].text).not.toContain('eyJ');
    expect(result.content[0].text).toContain('[REDACTED:JWT_TOKEN]');
  });

  test('redacts AWS access key in output', () => {
    const result = sanitizeToolResult(
      { content: [{ type: 'text', text: 'key=AKIAIOSFODNN7EXAMPLE' }] },
      'get_app_environment'
    );
    expect(result.content[0].text).not.toContain('AKIA');
    expect(result.content[0].text).toContain('[REDACTED:AWS_ACCESS_KEY]');
  });

  test('redacts database URL credentials', () => {
    const result = sanitizeToolResult(
      { content: [{ type: 'text', text: 'DATABASE_URL=mysql://user:secret@localhost/app' }] },
      'get_database_config'
    );
    expect(result.content[0].text).not.toContain('secret');
  });

  test('passes through clean output unchanged', () => {
    const text = 'Route: GET /api/users [200 OK]';
    const result = sanitizeToolResult(
      { content: [{ type: 'text', text }] },
      'list_routes'
    );
    expect(result.content[0].text).toBe(text);
  });

  test('handles multiple content items', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = sanitizeToolResult(
      {
        content: [
          { type: 'text', text: 'Route list' },
          { type: 'text', text: `token=${jwt}` },
        ],
      },
      'list_routes'
    );
    expect(result.content[0].text).toBe('Route list');
    expect(result.content[1].text).not.toContain('eyJ');
  });

  test('preserves isError flag', () => {
    const result = sanitizeToolResult(
      { content: [{ type: 'text', text: 'Error occurred' }], isError: true },
      'list_routes'
    );
    expect(result.isError).toBe(true);
  });

  test('handles non-text content items', () => {
    const result = sanitizeToolResult(
      { content: [{ type: 'image', data: 'base64data' }] },
      'list_routes'
    );
    expect(result.content[0]).toEqual({ type: 'image', data: 'base64data' });
  });
});

describe('sanitizeToolResult — error sanitization', () => {
  test('strips stack trace from error result', () => {
    const stackTrace = `Error: ENOENT: no such file
    at Object.openSync (/usr/lib/node/fs.js:462:3)
    at Object.readFileSync (/usr/lib/node/fs.js:364:35)
    at listRoutes (/home/user/project/src/tools/routes.ts:42:12)`;

    const result = sanitizeToolResult(
      { content: [{ type: 'text', text: stackTrace }], isError: true },
      'list_routes'
    );
    expect(result.content[0].text).not.toContain('at Object.openSync');
    expect(result.content[0].text).not.toContain('/home/user/project');
  });

  test('preserves the first error line', () => {
    const error = `TypeError: Cannot read property 'foo' of undefined
    at something (/usr/local/lib/node.js:10:5)`;

    const result = sanitizeToolResult(
      { content: [{ type: 'text', text: error }], isError: true },
      'list_routes'
    );
    expect(result.content[0].text).toContain("TypeError: Cannot read property 'foo' of undefined");
  });
});

// ── sanitizeErrorMessage ───────────────────────────────────────────────────────

describe('sanitizeErrorMessage', () => {
  test('strips absolute /home paths', () => {
    const msg = 'Failed to read /home/alice/project/config/services.yaml';
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain('/home/alice');
    expect(result).toContain('[PATH]');
    expect(result).toContain('services.yaml'); // basename preserved
  });

  test('strips /var/ paths', () => {
    const result = sanitizeErrorMessage('Error reading /var/log/app/prod.log');
    expect(result).not.toContain('/var/log/app');
  });

  test('strips node_modules paths', () => {
    const result = sanitizeErrorMessage('at require (/app/node_modules/express/index.js:1:1)');
    expect(result).toContain('[node_modules/...]');
    expect(result).not.toContain('node_modules/express');
  });

  test('strips stack trace lines', () => {
    const msg = `Error: something failed
    at Object.<anonymous> (/app/src/server.ts:42:3)
    at Module._compile (node:internal/modules/cjs/loader:1364:14)`;
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain('at Object.<anonymous>');
    expect(result).not.toContain('at Module._compile');
    expect(result).toContain('Error: something failed');
  });

  test('applies DLP to error strings containing secrets', () => {
    const msg = 'Connection failed: mysql://root:supersecret@db.example.com/prod';
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain('supersecret');
  });

  test('leaves clean error messages unchanged', () => {
    const msg = 'Entity "User" not found in src/Entity/';
    const result = sanitizeErrorMessage(msg);
    expect(result).toBe(msg);
  });
});
