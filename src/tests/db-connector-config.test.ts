/**
 * Database connection configuration and the read-only query guard.
 *
 * parseDatabaseUrl and readDoctrineConfig decide which database the
 * introspection tools describe, and isQuerySafe is what keeps this server
 * read-only: it is the single check standing between a caller-supplied query
 * and the database. Every statement type it is supposed to refuse gets an
 * explicit case here.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseDatabaseUrl,
  readDoctrineConfig,
  isQuerySafe,
  getDisplayDatabaseUrl,
} from '../utils/db-connector';

let appDir: string;

const write = (rel: string, body: string): void => {
  const full = path.join(appDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-connector-'));
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe('parseDatabaseUrl', () => {
  test('defaults to sqlite when DATABASE_URL is absent', () => {
    expect(parseDatabaseUrl(appDir)).toEqual({ type: 'sqlite' });
  });

  test('reads a MySQL URL in full', () => {
    write('.env', 'DATABASE_URL=mysql://appuser:s3cret@db.example.com:3307/appdb\n');
    const o = parseDatabaseUrl(appDir);

    expect(o.type).toBe('mysql');
    expect(o.host).toBe('db.example.com');
    expect(o.port).toBe(3307);
    expect(o.username).toBe('appuser');
    expect(o.database).toBe('appdb');
  });

  test('recognises both PostgreSQL schemes', () => {
    for (const scheme of ['postgresql', 'postgres']) {
      write('.env', `DATABASE_URL=${scheme}://u:p@localhost:5432/app\n`);
      expect(parseDatabaseUrl(appDir).type).toBe('postgresql');
    }
  });

  test('recognises the mysql2 and mssql schemes', () => {
    write('.env', 'DATABASE_URL=mysql2://u:p@localhost/app\n');
    expect(parseDatabaseUrl(appDir).type).toBe('mysql');

    write('.env', 'DATABASE_URL=sqlsrv://u:p@localhost/app\n');
    expect(parseDatabaseUrl(appDir).type).toBe('mssql');
  });

  test('expands %kernel.project_dir% in a sqlite path', () => {
    write('.env', 'DATABASE_URL=sqlite:///%kernel.project_dir%/var/data.db\n');
    const o = parseDatabaseUrl(appDir);

    expect(o.type).toBe('sqlite');
    expect(o.path).toBe(`${appDir}/var/data.db`);
  });

  test('decodes a percent-encoded username', () => {
    write('.env', 'DATABASE_URL=mysql://user%40host:p@localhost/app\n');
    expect(parseDatabaseUrl(appDir).username).toBe('user@host');
  });

  test('drops query parameters from the database name', () => {
    write('.env', 'DATABASE_URL=mysql://u:p@localhost/appdb?serverVersion=8.0\n');
    expect(parseDatabaseUrl(appDir).database).toBe('appdb');
  });

  test('reports an unrecognised scheme as unknown', () => {
    write('.env', 'DATABASE_URL=oracle://u:p@localhost/app\n');
    const o = parseDatabaseUrl(appDir);

    expect(o.type).toBe('unknown');
    expect(o.url).toBe('oracle://u:p@localhost/app');
  });

  test('omits the port when the URL declares none', () => {
    write('.env', 'DATABASE_URL=mysql://u:p@localhost/app\n');
    expect(parseDatabaseUrl(appDir).port).toBeUndefined();
  });

  test('.env.local wins over .env', () => {
    write('.env', 'DATABASE_URL=mysql://u:p@base-host/app\n');
    write('.env.local', 'DATABASE_URL=mysql://u:p@local-host/app\n');

    expect(parseDatabaseUrl(appDir).host).toBe('local-host');
  });
});

describe('readDoctrineConfig', () => {
  test('falls back to DATABASE_URL when doctrine.yaml is absent', () => {
    write('.env', 'DATABASE_URL=mysql://u:p@from-env/app\n');
    expect(readDoctrineConfig(appDir).host).toBe('from-env');
  });

  test('falls back when the file has no dbal section', () => {
    write('.env', 'DATABASE_URL=mysql://u:p@from-env/app\n');
    write('config/packages/doctrine.yaml', 'doctrine:\n  orm:\n    auto_mapping: true\n');

    expect(readDoctrineConfig(appDir).host).toBe('from-env');
  });

  test('reads an explicit dbal block', () => {
    write('config/packages/doctrine.yaml', `doctrine:
  dbal:
    driver: pdo_pgsql
    host: pg.example.com
    port: 5433
    user: pguser
    password: pgpass
    dbname: pgdb
`);
    const o = readDoctrineConfig(appDir);

    expect(o).toMatchObject({
      type: 'postgresql', host: 'pg.example.com', port: 5433,
      username: 'pguser', database: 'pgdb',
    });
  });

  test('maps each pdo driver to its database type', () => {
    const cases: Array<[string, string]> = [
      ['pdo_mysql', 'mysql'],
      ['pdo_pgsql', 'postgresql'],
      ['pdo_sqlite', 'sqlite'],
      ['pdo_sqlsrv', 'mssql'],
    ];
    for (const [driver, type] of cases) {
      write('config/packages/doctrine.yaml', `doctrine:\n  dbal:\n    driver: ${driver}\n`);
      expect(readDoctrineConfig(appDir).type).toBe(type);
    }
  });

  test('defaults an unrecognised driver to mysql', () => {
    write('config/packages/doctrine.yaml', 'doctrine:\n  dbal:\n    driver: pdo_oci\n');
    expect(readDoctrineConfig(appDir).type).toBe('mysql');
  });

  test('reads a sqlite path from dbal', () => {
    write('config/packages/doctrine.yaml',
      'doctrine:\n  dbal:\n    driver: pdo_sqlite\n    path: var/data.db\n');

    expect(readDoctrineConfig(appDir).path).toBe('var/data.db');
  });
});

describe('isQuerySafe', () => {
  test('accepts read-only statements', () => {
    for (const q of [
      'SELECT * FROM users',
      'select id from users',
      '  SELECT 1  ',
      'DESCRIBE users',
      'DESC users',
      'EXPLAIN SELECT * FROM users',
      'SHOW TABLES',
      'PRAGMA table_info(users)',
    ]) {
      expect(isQuerySafe(q)).toBe(true);
    }
  });

  test('refuses every write statement', () => {
    for (const q of [
      'INSERT INTO users VALUES (1)',
      'UPDATE users SET name = "x"',
      'DELETE FROM users',
      'DROP TABLE users',
      'CREATE TABLE t (id INT)',
      'ALTER TABLE users ADD c INT',
      'TRUNCATE users',
      'REPLACE INTO users VALUES (1)',
      'GRANT ALL ON db.* TO u',
      'REVOKE ALL ON db.* FROM u',
    ]) {
      expect(isQuerySafe(q)).toBe(false);
    }
  });

  test('refuses regardless of case or leading whitespace', () => {
    expect(isQuerySafe('  drop table users')).toBe(false);
    expect(isQuerySafe('\n\tDeLeTe FROM users')).toBe(false);
  });

  test('refuses anything that is not a recognised read statement', () => {
    expect(isQuerySafe('')).toBe(false);
    expect(isQuerySafe('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(false);
    expect(isQuerySafe('CALL some_procedure()')).toBe(false);
  });
});

describe('getDisplayDatabaseUrl', () => {
  test('redacts the password from a real URL', () => {
    const shown = getDisplayDatabaseUrl({
      type: 'mysql', url: 'mysql://user:hunter2@db.example.com/app',
    });

    expect(shown).not.toContain('hunter2');
  });

  test('builds a MySQL URL from parts when none was configured', () => {
    expect(getDisplayDatabaseUrl({ type: 'mysql', host: 'h', port: 3307, database: 'd' }))
      .toBe('mysql://h:3307/d');
  });

  test('falls back to conventional defaults per type', () => {
    expect(getDisplayDatabaseUrl({ type: 'mysql' })).toBe('mysql://localhost:3306/app');
    expect(getDisplayDatabaseUrl({ type: 'postgresql' })).toBe('postgresql://localhost:5432/app');
    expect(getDisplayDatabaseUrl({ type: 'sqlite' })).toBe('sqlite://var/app.db');
  });

  test('reports an unknown type plainly', () => {
    expect(getDisplayDatabaseUrl({ type: 'unknown' })).toBe('Unknown database');
  });
});
