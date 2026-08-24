// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The live database connector with no drivers installed.
 *
 * db-real-connector.test.ts supplies mysql2, pg and better-sqlite3 as virtual
 * mocks so the query logic can be tested. This file deliberately does not:
 * it is the state a real installation is in until someone runs
 * `npm install mysql2`, and the error message it produces is the only
 * guidance that user gets.
 */

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
  cacheManager.clear();
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-nodrv-'));
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe('missing drivers', () => {
  test('detects that none of the optional drivers are installed', async () => {
    expect(await detectAvailableDrivers()).toEqual([]);
  });

  test('MySQL names the package to install', async () => {
    writeEnv('mysql://u:p@localhost/app');
    await expect(executeQuery(appDir, 'SELECT 1')).rejects.toThrow(/mysql2 driver not found/);
  });

  test('PostgreSQL names the package to install', async () => {
    writeEnv('postgresql://u:p@localhost/app');
    await expect(executeQuery(appDir, 'SELECT 1')).rejects.toThrow(/pg driver not found/);
  });

  test('SQLite names the package to install', async () => {
    writeEnv('sqlite:///%kernel.project_dir%/var/data.db');
    await expect(executeQuery(appDir, 'SELECT 1')).rejects.toThrow(/better-sqlite3 driver not found/);
  });

  test('a connection test reports the missing driver rather than throwing', async () => {
    writeEnv('mysql://u:p@localhost/app');
    const r = await testDatabaseConnection(appDir);

    expect(r.connected).toBe(false);
    expect(r.error).toMatch(/mysql2 driver not found/);
    expect(r.driversAvailable).toEqual([]);
  });
});

describe('unsupported database types', () => {
  beforeEach(() => writeEnv('oracle://u:p@localhost/app'));

  test('listing tables says which type it cannot handle', async () => {
    await expect(getLiveTables(appDir)).rejects.toThrow(/Cannot list tables.*unknown/i);
  });

  test('describing a table says which type it cannot handle', async () => {
    await expect(getLiveTableColumns(appDir, 'users'))
      .rejects.toThrow(/Cannot describe table.*unknown/i);
  });

  test('a query on an unsupported type lists what is supported', async () => {
    await expect(executeQuery(appDir, 'SELECT 1'))
      .rejects.toThrow(/mysql, postgresql, sqlite/);
  });
});
