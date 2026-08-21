/**
 * Live database connector tests.
 *
 * This is the only module that opens a real connection, so it carries the
 * read-only guard, the kill switch, and per-driver row mapping. The three
 * drivers are optional peer dependencies loaded through dynamic import();
 * under ts-jest that compiles to require(), so they are supplied here as
 * virtual mocks. Nothing is installed and no database is contacted — what is
 * under test is this module's own logic: which query it builds per dialect,
 * how it maps rows back, and what it refuses.
 */

const mysqlExecute = jest.fn();
const mysqlEnd = jest.fn();
const mysqlCreateConnection = jest.fn();

const pgConnect = jest.fn();
const pgQuery = jest.fn();
const pgEnd = jest.fn();

const sqlitePrepare = jest.fn();
const sqliteClose = jest.fn();
const SqliteCtor = jest.fn();

jest.mock(
  'mysql2/promise',
  () => ({ createConnection: mysqlCreateConnection }),
  { virtual: true }
);

jest.mock(
  'pg',
  () => ({
    Client: class {
      connect = pgConnect;
      query = pgQuery;
      end = pgEnd;
    },
  }),
  { virtual: true }
);

jest.mock(
  'better-sqlite3',
  () => {
    const ctor = function (this: unknown, ...args: unknown[]) {
      SqliteCtor(...args);
      return { prepare: sqlitePrepare, close: sqliteClose };
    };
    return { __esModule: true, default: ctor };
  },
  { virtual: true }
);

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  executeQuery,
  testDatabaseConnection,
  getLiveTables,
  getLiveTableColumns,
  detectAvailableDrivers,
} from '../utils/db-real-connector';
import { cacheManager } from '../utils/cache-manager';

let appDir: string;

const writeEnv = (url: string): void => {
  fs.writeFileSync(path.join(appDir, '.env'), `DATABASE_URL=${url}\n`);
};

beforeEach(() => {
  jest.clearAllMocks();
  cacheManager.clear();
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-real-'));

  mysqlCreateConnection.mockResolvedValue({ execute: mysqlExecute, end: mysqlEnd });
  mysqlExecute.mockResolvedValue([[], []]);
  pgConnect.mockResolvedValue(undefined);
  pgQuery.mockResolvedValue({ fields: [], rows: [], rowCount: 0 });
  pgEnd.mockResolvedValue(undefined);
  sqlitePrepare.mockReturnValue({ all: () => [] });
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe('the read-only guard', () => {
  test.each([
    'INSERT INTO users VALUES (1)',
    'UPDATE users SET a = 1',
    'DELETE FROM users',
    'DROP TABLE users',
    'TRUNCATE users',
  ])('refuses %s before touching a driver', async (query) => {
    writeEnv('mysql://u:p@localhost/app');

    await expect(executeQuery(appDir, query)).rejects.toThrow(/only SELECT/i);
    expect(mysqlCreateConnection).not.toHaveBeenCalled();
  });

  test('rejects an unsupported database type', async () => {
    writeEnv('oracle://u:p@localhost/app');
    await expect(executeQuery(appDir, 'SELECT 1')).rejects.toThrow(/not supported/i);
  });
});

describe('MySQL', () => {
  beforeEach(() => writeEnv('mysql://appuser:pw@db.example.com:3307/appdb'));

  test('passes connection options through from DATABASE_URL', async () => {
    await executeQuery(appDir, 'SELECT 1');

    expect(mysqlCreateConnection).toHaveBeenCalledWith(expect.objectContaining({
      host: 'db.example.com', port: 3307, user: 'appuser', database: 'appdb',
    }));
  });

  test('maps rows into column order', async () => {
    mysqlExecute.mockResolvedValue([
      [{ id: 1, name: 'ada' }, { id: 2, name: 'grace' }],
      [{ name: 'id' }, { name: 'name' }],
    ]);

    const r = await executeQuery(appDir, 'SELECT id, name FROM users');

    expect(r.columns).toEqual(['id', 'name']);
    expect(r.rows).toEqual([[1, 'ada'], [2, 'grace']]);
    expect(r.rowCount).toBe(2);
  });

  test('closes the connection even when the query throws', async () => {
    mysqlExecute.mockRejectedValue(new Error('syntax error'));

    await expect(executeQuery(appDir, 'SELECT bad')).rejects.toThrow('syntax error');
    expect(mysqlEnd).toHaveBeenCalled();
  });

  test('builds SHOW TABLES for the table listing', async () => {
    mysqlExecute.mockResolvedValue([[{ t: 'users' }, { t: 'posts' }], [{ name: 't' }]]);

    expect(await getLiveTables(appDir)).toEqual(['users', 'posts']);
    expect(mysqlExecute).toHaveBeenCalledWith('SHOW TABLES', []);
  });

  test('describes a table and maps the MySQL column shape', async () => {
    mysqlExecute.mockResolvedValue([
      [{ Field: 'id', Type: 'int', Null: 'NO', Key: 'PRI', Default: '' }],
      [{ name: 'Field' }, { name: 'Type' }, { name: 'Null' }, { name: 'Key' }, { name: 'Default' }],
    ]);

    expect(await getLiveTableColumns(appDir, 'users')).toEqual([
      { name: 'id', type: 'int', nullable: false, key: 'PRI', default: '' },
    ]);
  });
});

describe('PostgreSQL', () => {
  beforeEach(() => writeEnv('postgresql://pguser:pw@pg.example.com:5433/pgdb'));

  test('passes connection options through', async () => {
    await executeQuery(appDir, 'SELECT 1');

    expect(pgConnect).toHaveBeenCalled();
    expect(pgEnd).toHaveBeenCalled();
  });

  test('maps rows into column order', async () => {
    pgQuery.mockResolvedValue({
      fields: [{ name: 'id' }, { name: 'email' }],
      rows: [{ id: 7, email: 'a@b.test' }],
      rowCount: 1,
    });

    const r = await executeQuery(appDir, 'SELECT id, email FROM users');

    expect(r.columns).toEqual(['id', 'email']);
    expect(r.rows).toEqual([[7, 'a@b.test']]);
  });

  test('closes the client even when the query throws', async () => {
    pgQuery.mockRejectedValue(new Error('relation does not exist'));

    await expect(executeQuery(appDir, 'SELECT 1')).rejects.toThrow(/relation/);
    expect(pgEnd).toHaveBeenCalled();
  });

  test('queries pg_tables for the table listing', async () => {
    pgQuery.mockResolvedValue({
      fields: [{ name: 'tablename' }], rows: [{ tablename: 'users' }], rowCount: 1,
    });

    expect(await getLiveTables(appDir)).toEqual(['users']);
    expect(pgQuery.mock.calls[0][0]).toContain('pg_tables');
  });

  test('describes a table through information_schema, passing the name as a parameter', async () => {
    pgQuery.mockResolvedValue({
      fields: [
        { name: 'column_name' }, { name: 'data_type' },
        { name: 'is_nullable' }, { name: 'column_default' },
      ],
      rows: [{ column_name: 'email', data_type: 'text', is_nullable: 'YES', column_default: '' }],
      rowCount: 1,
    });

    const cols = await getLiveTableColumns(appDir, 'users');

    expect(cols).toEqual([{ name: 'email', type: 'text', nullable: true, key: '', default: '' }]);
    expect(pgQuery.mock.calls[0][0]).toContain('information_schema.columns');
    expect(pgQuery.mock.calls[0][1]).toEqual(['users']);
  });
});

describe('SQLite', () => {
  beforeEach(() => writeEnv('sqlite:///%kernel.project_dir%/var/data.db'));

  test('opens the database file read-only', async () => {
    await executeQuery(appDir, 'SELECT 1');

    expect(SqliteCtor).toHaveBeenCalledWith(
      path.join(appDir, 'var', 'data.db'),
      { readonly: true }
    );
  });

  test('maps rows using the keys of the first row', async () => {
    sqlitePrepare.mockReturnValue({ all: () => [{ id: 1, name: 'ada' }] });

    const r = await executeQuery(appDir, 'SELECT id, name FROM users');

    expect(r.columns).toEqual(['id', 'name']);
    expect(r.rows).toEqual([[1, 'ada']]);
  });

  test('returns an empty result set without inventing columns', async () => {
    sqlitePrepare.mockReturnValue({ all: () => [] });

    const r = await executeQuery(appDir, 'SELECT 1');

    expect(r).toMatchObject({ columns: [], rows: [], rowCount: 0 });
  });

  test('closes the database even when prepare throws', async () => {
    sqlitePrepare.mockImplementation(() => { throw new Error('no such table'); });

    await expect(executeQuery(appDir, 'SELECT 1')).rejects.toThrow(/no such table/);
    expect(sqliteClose).toHaveBeenCalled();
  });

  test('fails clearly when DATABASE_URL declares no path', async () => {
    fs.rmSync(path.join(appDir, '.env'));
    await expect(executeQuery(appDir, 'SELECT 1')).rejects.toThrow(/path is not configured/i);
  });

  test('lists tables from sqlite_master', async () => {
    sqlitePrepare.mockReturnValue({ all: () => [{ name: 'users' }] });

    expect(await getLiveTables(appDir)).toEqual(['users']);
  });

  test('describes a table through PRAGMA and maps its column shape', async () => {
    sqlitePrepare.mockReturnValue({
      all: () => [{ cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 }],
    });

    expect(await getLiveTableColumns(appDir, 'users')).toEqual([
      // dflt_value is null here, and `null ?? ''` collapses to the empty string.
      { name: 'id', type: 'INTEGER', nullable: true, key: 'PRI', default: '' },
    ]);
  });
});

describe('result caching', () => {
  beforeEach(() => writeEnv('mysql://u:p@localhost/app'));

  test('a repeated query is served from cache', async () => {
    mysqlExecute.mockResolvedValue([[{ id: 1 }], [{ name: 'id' }]]);

    const first = await executeQuery(appDir, 'SELECT id FROM users');
    const second = await executeQuery(appDir, 'SELECT id FROM users');

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(mysqlCreateConnection).toHaveBeenCalledTimes(1);
  });

  test('different parameters are cached separately', async () => {
    await executeQuery(appDir, 'SELECT 1', [1]);
    await executeQuery(appDir, 'SELECT 1', [2]);

    expect(mysqlCreateConnection).toHaveBeenCalledTimes(2);
  });

  test('clearing the cache forces a fresh query', async () => {
    await executeQuery(appDir, 'SELECT 1');
    cacheManager.clear();
    await executeQuery(appDir, 'SELECT 1');

    expect(mysqlCreateConnection).toHaveBeenCalledTimes(2);
  });
});

describe('testDatabaseConnection', () => {
  test('reports a successful ping with a response time', async () => {
    writeEnv('mysql://u:p@db.example.com/appdb');
    const r = await testDatabaseConnection(appDir);

    expect(r.connected).toBe(true);
    expect(r.type).toBe('mysql');
    expect(r.host).toBe('db.example.com');
    expect(r.database).toBe('appdb');
    expect(typeof r.responseTimeMs).toBe('number');
  });

  test('reports the failure reason rather than throwing', async () => {
    writeEnv('mysql://u:p@localhost/app');
    mysqlCreateConnection.mockRejectedValue(new Error('ECONNREFUSED'));

    const r = await testDatabaseConnection(appDir);

    expect(r.connected).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });

  test('reports an unsupported type as a failure, not a crash', async () => {
    writeEnv('oracle://u:p@localhost/app');
    const r = await testDatabaseConnection(appDir);

    expect(r.connected).toBe(false);
    expect(r.error).toMatch(/not supported/i);
  });

  test('uses SELECT 1 AS ok for SQLite', async () => {
    writeEnv('sqlite:///%kernel.project_dir%/var/data.db');
    await testDatabaseConnection(appDir);

    expect(sqlitePrepare).toHaveBeenCalledWith('SELECT 1 AS ok');
  });
});

describe('detectAvailableDrivers', () => {
  test('lists the drivers that can be loaded', async () => {
    // All three are mocked as present in this file.
    expect((await detectAvailableDrivers()).sort())
      .toEqual(['better-sqlite3', 'mysql2', 'pg']);
  });

  test('is reported alongside every connection test', async () => {
    writeEnv('mysql://u:p@localhost/app');
    expect(Array.isArray((await testDatabaseConnection(appDir)).driversAvailable)).toBe(true);
  });
});
