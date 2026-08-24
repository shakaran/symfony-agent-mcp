// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Database schema derived from Doctrine entities.
 *
 * db-connector.test.ts and db-connector-config.test.ts cover URL parsing and
 * the query guard. This file takes the other half of the module: turning
 * parsed entities into a table structure — columns, primary key, foreign keys
 * and indexes — plus the migration-file fallback used when an app has no
 * entities to read.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getTableStructure, listDatabaseTables, getDatabaseStats } from '../utils/db-connector';
import { cacheManager } from '../utils/cache-manager';

let appDir: string;

const write = (rel: string, body: string): void => {
  const full = path.join(appDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

const USER_ENTITY = `<?php
namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\Table(name: 'users')]
class User
{
    #[ORM\\Id]
    #[ORM\\Column(type: 'integer')]
    private int $id;

    #[ORM\\Column(type: 'string', length: 180)]
    private string $email;

    #[ORM\\Column(type: 'boolean')]
    private bool $isActive = true;

    #[ORM\\Column(type: 'datetime', nullable: true)]
    private ?\\DateTime $lastLogin = null;

    #[ORM\\ManyToOne(targetEntity: Team::class, inversedBy: 'members')]
    private Team $team;
}
`;

beforeEach(() => {
  cacheManager.clear();
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-schema-'));
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe('getTableStructure', () => {
  test('returns null for a table no entity maps to', async () => {
    write('src/Entity/User.php', USER_ENTITY);
    expect(await getTableStructure(appDir, 'no_such_table')).toBeNull();
  });

  test('returns null when the app has no entities at all', async () => {
    expect(await getTableStructure(appDir, 'users')).toBeNull();
  });

  test('finds the entity by its declared table name', async () => {
    write('src/Entity/User.php', USER_ENTITY);
    const t = await getTableStructure(appDir, 'users');

    expect(t).not.toBeNull();
    expect(t?.name).toBe('users');
  });

  test('finds an entity by its class-derived table name', async () => {
    write('src/Entity/ShoppingCart.php', `<?php
namespace App\\Entity;
use Doctrine\\ORM\\Mapping as ORM;
#[ORM\\Entity]
class ShoppingCart
{
    #[ORM\\Id]
    #[ORM\\Column(type: 'integer')]
    private int $id;
}
`);
    expect(await getTableStructure(appDir, 'shopping_cart')).not.toBeNull();
  });

  test('maps entity properties to columns with SQL types', async () => {
    write('src/Entity/User.php', USER_ENTITY);
    const cols = (await getTableStructure(appDir, 'users'))!.columns;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(byName['id'].type.toUpperCase()).toContain('INT');
    expect(byName['email'].type.toUpperCase()).toContain('VARCHAR');
    expect(byName['email'].maxLength).toBe(255);
  });

  test('carries nullability through from the entity', async () => {
    write('src/Entity/User.php', USER_ENTITY);
    const cols = (await getTableStructure(appDir, 'users'))!.columns;

    expect(cols.find((c) => c.name === 'last_login')?.nullable).toBe(true);
    expect(cols.find((c) => c.name === 'email')?.nullable).toBe(false);
  });

  test('declares a PRIMARY index for the identifier', async () => {
    write('src/Entity/User.php', USER_ENTITY);
    const idx = (await getTableStructure(appDir, 'users'))!.indexes;
    const pk = idx.find((i) => i.primary);

    expect(pk).toBeDefined();
    expect(pk?.name).toBe('PRIMARY');
    expect(pk?.unique).toBe(true);
    expect(pk?.columns).toEqual(['id']);
  });

  test('adds a foreign key column and index for a ManyToOne relation', async () => {
    write('src/Entity/User.php', USER_ENTITY);
    const t = (await getTableStructure(appDir, 'users'))!;

    expect(t.columns.map((c) => c.name)).toContain('team_id');

    const fk = t.foreignKeys.find((f) => f.column === 'team_id');
    expect(fk).toMatchObject({ referencedTable: 'team', referencedColumn: 'id' });

    const fkIndex = t.indexes.find((i) => i.columns.includes('team_id'));
    expect(fkIndex?.unique).toBe(false);
  });

  test('marks a OneToOne owning-side foreign key unique', async () => {
    write('src/Entity/Profile.php', `<?php
namespace App\\Entity;
use Doctrine\\ORM\\Mapping as ORM;
#[ORM\\Entity]
#[ORM\\Table(name: 'profiles')]
class Profile
{
    #[ORM\\Id]
    #[ORM\\Column(type: 'integer')]
    private int $id;

    #[ORM\\OneToOne(targetEntity: User::class, inversedBy: 'profile')]
    private User $user;
}
`);
    const t = (await getTableStructure(appDir, 'profiles'))!;
    const idx = t.indexes.find((i) => i.columns.includes('user_id'));

    expect(idx?.unique).toBe(true);
  });

  test('serves a repeated lookup from cache', async () => {
    write('src/Entity/User.php', USER_ENTITY);
    const first = await getTableStructure(appDir, 'users');

    // A new entity added afterwards must not appear until the cache clears.
    write('src/Entity/Post.php', `<?php
namespace App\\Entity;
use Doctrine\\ORM\\Mapping as ORM;
#[ORM\\Entity]
#[ORM\\Table(name: 'users')]
class Post {}
`);
    expect(await getTableStructure(appDir, 'users')).toEqual(first);
  });
});

describe('listDatabaseTables', () => {
  test('lists table names from entities, sorted', async () => {
    write('src/Entity/User.php', USER_ENTITY);
    write('src/Entity/Article.php', `<?php
namespace App\\Entity;
use Doctrine\\ORM\\Mapping as ORM;
#[ORM\\Entity]
#[ORM\\Table(name: 'articles')]
class Article
{
    #[ORM\\Id]
    #[ORM\\Column(type: 'integer')]
    private int $id;
}
`);
    expect(await listDatabaseTables(appDir)).toEqual(['articles', 'users']);
  });

  test('falls back to CREATE TABLE statements in migrations', async () => {
    write('migrations/Version20240101000000.php', `<?php
final class Version20240101000000 extends AbstractMigration
{
    public function up(Schema \\$schema): void
    {
        \\$this->addSql('CREATE TABLE users (id INT NOT NULL)');
        \\$this->addSql('CREATE TABLE "posts" (id INT NOT NULL)');
    }
}
`);
    expect((await listDatabaseTables(appDir)).sort()).toEqual(['posts', 'users']);
  });

  test('also scans src/Migrations', async () => {
    write('src/Migrations/Version1.php',
      `<?php \\$this->addSql('CREATE TABLE invoices (id INT)');`);

    expect(await listDatabaseTables(appDir)).toContain('invoices');
  });

  test('prefers entities over migrations when both exist', async () => {
    write('src/Entity/User.php', USER_ENTITY);
    write('migrations/Version1.php',
      `<?php \\$this->addSql('CREATE TABLE legacy_table (id INT)');`);

    expect(await listDatabaseTables(appDir)).toEqual(['users']);
  });

  test('returns nothing for an app with neither', async () => {
    expect(await listDatabaseTables(appDir)).toEqual([]);
  });

  test('survives an unreadable migrations directory', async () => {
    fs.mkdirSync(path.join(appDir, 'migrations'), { recursive: true });
    await expect(listDatabaseTables(appDir)).resolves.toEqual([]);
  });
});

describe('getDatabaseStats', () => {
  test('reports type, host and table count together', async () => {
    write('.env', 'DATABASE_URL=mysql://u:p@db.example.com/appdb\n');
    write('src/Entity/User.php', USER_ENTITY);

    const stats = await getDatabaseStats(appDir);

    expect(stats.type).toBe('mysql');
    expect(stats.host).toBe('db.example.com');
    expect(stats.database).toBe('appdb');
    expect(stats.tables).toBe(1);
  });

  test('reports zero tables for an empty app', async () => {
    expect((await getDatabaseStats(appDir)).tables).toBe(0);
  });
});
