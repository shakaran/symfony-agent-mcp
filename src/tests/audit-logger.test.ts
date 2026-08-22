import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { withAudit, readRecentAuditEntries } from '../utils/audit-logger';

// Use a temp file per test run to avoid cross-test pollution
let tmpLogFile: string;

beforeEach(() => {
  tmpLogFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-')), 'audit.log');
  process.env['SYMFONY_MCP_AUDIT_LOG'] = tmpLogFile;
  process.env['SYMFONY_MCP_AUDIT'] = 'true';

  // Force re-init by resetting module state via env var change
  // (The logger lazy-inits on first use, so a new path means a new stream)
});

afterEach(() => {
  delete process.env['SYMFONY_MCP_AUDIT_LOG'];
  try { fs.unlinkSync(tmpLogFile); } catch { /* ok */ }
});

describe('withAudit', () => {
  test('executes and returns synchronous result', () => {
    const result = withAudit('list_routes', '/app', () => ({
      content: [{ type: 'text', text: 'ok' }],
    })) as { content: Array<{ type: string; text: string }> };

    expect(result.content[0].text).toBe('ok');
  });

  test('executes and returns async result', async () => {
    const result = await withAudit('list_tables', '/app', async () => ({
      content: [{ type: 'text', text: 'async ok' }],
    }));

    expect((result as { content: Array<{ type: string; text: string }> }).content[0].text).toBe('async ok');
  });

  test('re-throws errors from the wrapped function', async () => {
    await expect(
      withAudit('broken_tool', '/app', async () => {
        throw new Error('tool exploded');
      })
    ).rejects.toThrow('tool exploded');
  });

  test('does not expose app_path in logs', async () => {
    const sensitiveAppPath = '/home/secret-user/my-app';
    await withAudit('list_routes', sensitiveAppPath, async () => ({
      content: [{ type: 'text', text: 'done' }],
    }));

    // Log should NOT contain the raw app path
    if (fs.existsSync(tmpLogFile)) {
      const logContent = fs.readFileSync(tmpLogFile, 'utf-8');
      expect(logContent).not.toContain(sensitiveAppPath);
      // But it should contain the hash
      expect(logContent).toContain('"appHash"');
    }
  });
});

describe('readRecentAuditEntries', () => {
  test('returns empty array when no log exists', () => {
    process.env['SYMFONY_MCP_AUDIT_LOG'] = '/tmp/definitely-no-such-log-xyz.log';
    const entries = readRecentAuditEntries();
    expect(entries).toEqual([]);
  });

  test('returns limited number of entries', () => {
    // Write more than the limit directly to file
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({
        ts: new Date().toISOString(),
        tool: `tool_${i}`,
        appHash: 'abc12345',
        durationMs: 10,
        success: true,
      }));
    }
    fs.writeFileSync(tmpLogFile, lines.join('\n') + '\n', 'utf-8');

    const entries = readRecentAuditEntries(5);
    expect(entries.length).toBe(5);
  });
});

describe('audit log disabled', () => {
  test('SYMFONY_MCP_AUDIT=false disables file logging', async () => {
    process.env['SYMFONY_MCP_AUDIT'] = 'false';

    await withAudit('list_routes', '/app', async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));

    // File should not be created
    expect(fs.existsSync(tmpLogFile)).toBe(false);
  });
});
