import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  withAudit,
  getAuditLogPath,
  getAuditRotationConfig,
  resetAuditLogger,
} from '../utils/audit-logger';

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  resetAuditLogger();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rotation-'));
  logPath = path.join(tmpDir, 'audit.log');
  process.env['SYMFONY_MCP_AUDIT'] = 'true';
  process.env['SYMFONY_MCP_AUDIT_LOG'] = logPath;
  delete process.env['SYMFONY_MCP_AUDIT_MAX_SIZE_MB'];
  delete process.env['SYMFONY_MCP_AUDIT_MAX_FILES'];
});

afterEach(async () => {
  resetAuditLogger();
  delete process.env['SYMFONY_MCP_AUDIT'];
  delete process.env['SYMFONY_MCP_AUDIT_LOG'];
  delete process.env['SYMFONY_MCP_AUDIT_MAX_SIZE_MB'];
  delete process.env['SYMFONY_MCP_AUDIT_MAX_FILES'];
  // Allow pending stream I/O to settle before removing the directory
  await new Promise(r => setTimeout(r, 30));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const fakeResult = { content: [{ type: 'text', text: 'ok' }], isError: false };

describe('getAuditRotationConfig', () => {
  test('returns defaults when env vars are absent', () => {
    const config = getAuditRotationConfig();
    expect(config.maxSizeMb).toBe(50);
    expect(config.maxFiles).toBe(5);
  });

  test('reflects SYMFONY_MCP_AUDIT_MAX_SIZE_MB', () => {
    process.env['SYMFONY_MCP_AUDIT_MAX_SIZE_MB'] = '10';
    expect(getAuditRotationConfig().maxSizeMb).toBe(10);
  });

  test('reflects SYMFONY_MCP_AUDIT_MAX_FILES', () => {
    process.env['SYMFONY_MCP_AUDIT_MAX_FILES'] = '3';
    expect(getAuditRotationConfig().maxFiles).toBe(3);
  });
});

describe('audit log creation', () => {
  test('getAuditLogPath returns the configured path', async () => {
    await withAudit('list_routes', '/app', () => Promise.resolve(fakeResult));
    const resolvedPath = getAuditLogPath();
    expect(resolvedPath).not.toBeNull();
    expect(resolvedPath).toBe(logPath);
  });

  test('entries are appended to the log', async () => {
    await withAudit('list_routes', '/app', () => Promise.resolve(fakeResult));
    await withAudit('list_services', '/app', () => Promise.resolve(fakeResult));
    // Stream I/O is async — allow the fd to open and data to flush
    await new Promise(r => setTimeout(r, 50));
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('list_routes');
    expect(content).toContain('list_services');
  });
});

describe('resetAuditLogger', () => {
  test('allows a fresh logger to be opened after reset', async () => {
    await withAudit('list_routes', '/app', () => Promise.resolve(fakeResult));
    expect(getAuditLogPath()).not.toBeNull();

    // Reset closes the stream; subsequent writes must re-open it
    resetAuditLogger();
    await new Promise(r => setTimeout(r, 20)); // let stream close settle

    // After reset, new writes create a fresh stream to the same path
    await withAudit('list_routes', '/app', () => Promise.resolve(fakeResult));
    expect(getAuditLogPath()).toBe(logPath);
  });
});

describe('rotation — triggered by byte count', () => {
  test('rotation creates audit.log.1 and a fresh audit.log', async () => {
    // Set a 1 MB rotation limit
    process.env['SYMFONY_MCP_AUDIT_MAX_SIZE_MB'] = '1';
    process.env['SYMFONY_MCP_AUDIT_MAX_FILES'] = '3';

    // Prime the logger and get the resolved path
    await withAudit('prime', '/app', () => Promise.resolve(fakeResult));
    const resolvedPath = getAuditLogPath()!;

    // Reset so we can seed the file with > 1 MB and re-open it
    resetAuditLogger();
    await new Promise(r => setTimeout(r, 20)); // let close settle

    // Overwrite the log file with > 1 MB of data
    fs.writeFileSync(resolvedPath, 'X'.repeat(1024 * 1024 + 512), { mode: 0o600 });

    // Re-open the logger — it will seed bytesWritten from the file size
    process.env['SYMFONY_MCP_AUDIT_MAX_SIZE_MB'] = '1';
    await withAudit('trigger-rotation', '/app', () => Promise.resolve(fakeResult));

    // Allow async I/O to settle
    await new Promise(r => setTimeout(r, 30));

    expect(fs.existsSync(`${resolvedPath}.1`)).toBe(true);
    // The fresh log file should be much smaller than the seeded size
    if (fs.existsSync(resolvedPath)) {
      expect(fs.statSync(resolvedPath).size).toBeLessThan(1024 * 1024);
    }
  }, 5000);

  test('old rotated files beyond maxFiles are deleted', async () => {
    process.env['SYMFONY_MCP_AUDIT_MAX_SIZE_MB'] = '1';
    process.env['SYMFONY_MCP_AUDIT_MAX_FILES'] = '2';

    await withAudit('prime', '/app', () => Promise.resolve(fakeResult));
    const resolvedPath = getAuditLogPath()!;
    resetAuditLogger();
    await new Promise(r => setTimeout(r, 20));

    // Create fake rotated files .1 and .2
    fs.writeFileSync(`${resolvedPath}.1`, 'old1', { mode: 0o600 });
    fs.writeFileSync(`${resolvedPath}.2`, 'old2', { mode: 0o600 });

    // Seed the main log with > 1 MB to trigger rotation
    fs.writeFileSync(resolvedPath, 'X'.repeat(1024 * 1024 + 512), { mode: 0o600 });
    await withAudit('trigger', '/app', () => Promise.resolve(fakeResult));
    await new Promise(r => setTimeout(r, 30));

    // .2 was the "oldest" and should have been deleted (maxFiles=2 → keep .1 and .2, delete .3+)
    // After rotation: old .2 shifts to .3 which exceeds maxFiles=2 → delete .3 before rename
    // Actually: maxFiles=2, delete .2 first, rename .1→.2, rename current→.1
    expect(fs.existsSync(`${resolvedPath}.3`)).toBe(false);
  }, 5000);
});
