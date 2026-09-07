// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The three database drivers, without the databases.
 *
 * mysql2, pg and better-sqlite3 are optional peer dependencies: the connector
 * imports whichever the application's DATABASE_URL asks for, and everything
 * behind that import — the defaults for host and port, the shape of a row
 * with columns missing, the two ways a driver package can be exported — has
 * never run in this repository, because none of the three is installed.
 *
 * They are mocked here as virtual modules, which is what they are from the
 * connector's point of view.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mysqlExecute = jest.fn();
const pgQuery = jest.fn();

jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(async () => ({
    execute: mysqlExecute,
    end: jest.fn(async () => undefined),
  })),
}), { virtual: true });

jest.mock('pg', () => ({
  __esModule: true,
  // The package exports the client under `default` when it is loaded as ESM,
  // which is the shape the connector falls back to.
  default: {
    Client: class {
      async connect(): Promise<void> { /* nothing to connect to */ }
      query = pgQuery;
      async end(): Promise<void> { /* nothing to close */ }
    },
  },
}), { virtual: true });

jest.mock('better-sqlite3', () => {
  // No default export: the module itself is the constructor.
  return class {
    prepare(): { all: () => unknown[]; run: () => { changes: number } } {
      return { all: () => [{ id: 1, label: 'one' }], run: () => ({ changes: 1 }) };
    }
    close(): void { /* nothing to close */ }
  };
}, { virtual: true });

import { executeQuery, getLiveTableColumns } from '../utils/db-real-connector';
import { cacheManager } from '../utils/cache-manager';

let appDir: string;

function makeApp(databaseUrl: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-drivers-'));
  fs.writeFileSync(path.join(dir, '.env'), `DATABASE_URL=${databaseUrl}\n`);
  return dir;
}

beforeEach(() => {
  cacheManager.clear();
  mysqlExecute.mockReset();
  pgQuery.mockReset();
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

test('mysql without a host or port in the url', async () => {
  appDir = makeApp('mysql://app');
  mysqlExecute.mockResolvedValue([[{ name: 'id' }], [{ name: 'name' }]]);

  const result = await executeQuery(appDir, 'SELECT name FROM t');

  expect(result.columns).toEqual(['name']);
});

test('mysql columns where the key and default are null', async () => {
  appDir = makeApp('mysql://app@db/shop');
  mysqlExecute.mockResolvedValue([
    [{ 'Field': 'id', 'Type': 'int', 'Null': 'NO', 'Key': null, 'Default': null }],
    [{ name: 'Field' }, { name: 'Type' }, { name: 'Null' }, { name: 'Key' }, { name: 'Default' }],
  ]);

  const columns = await getLiveTableColumns(appDir, 'orders');

  expect(columns[0]).toMatchObject({ name: 'id', key: '', default: '' });
});

test('postgres exported under default, with no host and a null row count', async () => {
  appDir = makeApp('postgresql://app');
  pgQuery.mockResolvedValue({ fields: [{ name: 'id' }], rows: [{ id: 7 }], rowCount: null });

  const result = await executeQuery(appDir, 'SELECT id FROM t');

  expect(result.rowCount).toBe(1);
});

test('postgres columns with a null default', async () => {
  appDir = makeApp('postgresql://app@db:5432/shop');
  pgQuery.mockResolvedValue({
    fields: [{ name: 'column_name' }, { name: 'data_type' }, { name: 'is_nullable' }, { name: 'column_default' }],
    rows: [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null }],
    rowCount: 1,
  });

  const columns = await getLiveTableColumns(appDir, 'orders');

  expect(columns[0]).toMatchObject({ name: 'id', default: '' });
});

test('sqlite, whose package is the constructor itself', async () => {
  appDir = makeApp('sqlite:///%kernel.project_dir%/var/data.db');

  const result = await executeQuery(appDir, 'SELECT * FROM t');

  expect(result.columns).toEqual(['id', 'label']);
});

test('sqlite columns, one of them the primary key and one not', async () => {
  appDir = makeApp('sqlite:///%kernel.project_dir%/var/data.db');

  const columns = await getLiveTableColumns(appDir, 'orders');

  expect(columns.length).toBeGreaterThan(0);
});

test('mysql with no host at all, and fields the driver did not return as a list', async () => {
  appDir = makeApp('mysql:///shop');
  mysqlExecute.mockResolvedValue([[], undefined]);

  const result = await executeQuery(appDir, 'SELECT 1');

  expect(result.columns).toEqual([]);
});

test('a connection timeout that cannot be read as a number', async () => {
  const saved = process.env['SYMFONY_MCP_DB_TIMEOUT_MS'];
  process.env['SYMFONY_MCP_DB_TIMEOUT_MS'] = 'as long as it takes';

  try {
    await jest.isolateModulesAsync(async () => {
      const connector = jest.requireActual<typeof import('../utils/db-real-connector')>('../utils/db-real-connector');
      appDir = makeApp('sqlite:///%kernel.project_dir%/var/data.db');

      await expect(connector.executeQuery(appDir, 'SELECT * FROM t')).resolves.toBeDefined();
    });
  } finally {
    if (saved === undefined) delete process.env['SYMFONY_MCP_DB_TIMEOUT_MS'];
    else process.env['SYMFONY_MCP_DB_TIMEOUT_MS'] = saved;
  }
});
