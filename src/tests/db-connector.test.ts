import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseDatabaseUrl, listDatabaseTables, getTableStructure, isQuerySafe, getDisplayDatabaseUrl } from '../utils/db-connector';

function createTempApp(files: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-connector-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }
  return tmpDir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── parseDatabaseUrl ─────────────────────────────────────────────────────────

describe('parseDatabaseUrl', () => {
  test('parses MySQL URL from .env', () => {
    const tmpDir = createTempApp({ '.env': 'DATABASE_URL=mysql://app:pass@localhost:3306/myapp\n' });
    const opts = parseDatabaseUrl(tmpDir);
    expect(opts.type).toBe('mysql');
    expect(opts.host).toBe('localhost');
    expect(opts.port).toBe(3306);
    expect(opts.database).toBe('myapp');
    cleanup(tmpDir);
  });

  test('parses PostgreSQL URL', () => {
    const tmpDir = createTempApp({ '.env': 'DATABASE_URL=postgresql://user:pass@db.host/appdb\n' });
    const opts = parseDatabaseUrl(tmpDir);
    expect(opts.type).toBe('postgresql');
    expect(opts.database).toBe('appdb');
    cleanup(tmpDir);
  });

  test('parses postgres:// alias', () => {
    const tmpDir = createTempApp({ '.env': 'DATABASE_URL=postgres://user:pass@localhost/db\n' });
    const opts = parseDatabaseUrl(tmpDir);
    expect(opts.type).toBe('postgresql');
    cleanup(tmpDir);
  });

  test('returns sqlite default when no DATABASE_URL', () => {
    const tmpDir = createTempApp({});
    const opts = parseDatabaseUrl(tmpDir);
    expect(opts.type).toBe('sqlite');
    cleanup(tmpDir);
  });
});

// ─── listDatabaseTables ───────────────────────────────────────────────────────

describe('listDatabaseTables', () => {
  test('derives tables from entity files', async () => {
    const tmpDir = createTempApp({
      'src/Entity/User.php': `<?php
namespace App\\Entity;
use Doctrine\\ORM\\Mapping as ORM;
#[ORM\\Entity]
class User {
  #[ORM\\Id]
  #[ORM\\Column]
  private int $id;
}`,
      'src/Entity/BlogPost.php': `<?php
namespace App\\Entity;
use Doctrine\\ORM\\Mapping as ORM;
#[ORM\\Entity]
class BlogPost {
  #[ORM\\Id]
  #[ORM\\Column]
  private int $id;
}`,
    });

    const tables = await listDatabaseTables(tmpDir);
    expect(tables).toContain('user');
    expect(tables).toContain('blog_post');
    cleanup(tmpDir);
  });

  test('returns empty array when no entities exist', async () => {
    const tmpDir = createTempApp({});
    const tables = await listDatabaseTables(tmpDir);
    expect(tables).toEqual([]);
    cleanup(tmpDir);
  });
});

// ─── getTableStructure ────────────────────────────────────────────────────────

describe('getTableStructure', () => {
  test('builds table structure from entity', async () => {
    const tmpDir = createTempApp({
      'src/Entity/User.php': `<?php
namespace App\\Entity;
use Doctrine\\ORM\\Mapping as ORM;
#[ORM\\Entity]
#[ORM\\Table(name: 'users')]
class User {
  #[ORM\\Id]
  #[ORM\\Column(type: 'integer')]
  private int $id;

  #[ORM\\Column(type: 'string')]
  private string $email;
}`,
    });

    const table = await getTableStructure(tmpDir, 'users');
    expect(table).not.toBeNull();
    expect(table?.name).toBe('users');
    expect(table?.entityClass).toBe('User');
    expect(table?.columns.some((c) => c.name === 'id')).toBe(true);
    expect(table?.columns.some((c) => c.name === 'email')).toBe(true);
    const idIdx = table?.indexes.find((i) => i.primary);
    expect(idIdx).toBeDefined();
    cleanup(tmpDir);
  });

  test('returns null for unknown table', async () => {
    const tmpDir = createTempApp({});
    const table = await getTableStructure(tmpDir, 'nonexistent');
    expect(table).toBeNull();
    cleanup(tmpDir);
  });
});

// ─── isQuerySafe ──────────────────────────────────────────────────────────────

describe('isQuerySafe', () => {
  test('allows SELECT queries', () => {
    expect(isQuerySafe('SELECT * FROM users')).toBe(true);
    expect(isQuerySafe('select id, name from users where id = 1')).toBe(true);
  });

  test('allows DESCRIBE and SHOW', () => {
    expect(isQuerySafe('DESCRIBE users')).toBe(true);
    expect(isQuerySafe('SHOW TABLES')).toBe(true);
    expect(isQuerySafe('EXPLAIN SELECT * FROM users')).toBe(true);
  });

  test('blocks INSERT', () => {
    expect(isQuerySafe('INSERT INTO users VALUES (1, "test")')).toBe(false);
  });

  test('blocks UPDATE', () => {
    expect(isQuerySafe('UPDATE users SET name = "hack" WHERE 1=1')).toBe(false);
  });

  test('blocks DELETE', () => {
    expect(isQuerySafe('DELETE FROM users')).toBe(false);
  });

  test('blocks DROP', () => {
    expect(isQuerySafe('DROP TABLE users')).toBe(false);
  });

  test('blocks CREATE', () => {
    expect(isQuerySafe('CREATE TABLE evil (id INT)')).toBe(false);
  });

  test('blocks TRUNCATE', () => {
    expect(isQuerySafe('TRUNCATE TABLE users')).toBe(false);
  });
});

// ─── getDisplayDatabaseUrl ────────────────────────────────────────────────────

describe('getDisplayDatabaseUrl', () => {
  test('redacts password from stored URL', () => {
    const opts = { type: 'mysql' as const, url: 'mysql://user:secret@localhost/db' };
    const display = getDisplayDatabaseUrl(opts);
    expect(display).not.toContain('secret');
    expect(display).toContain('[REDACTED]');
  });

  test('constructs URL from options when no URL stored', () => {
    const opts = { type: 'mysql' as const, host: 'db.example.com', port: 3306, database: 'app' };
    const display = getDisplayDatabaseUrl(opts);
    expect(display).toContain('db.example.com');
    expect(display).toContain('app');
  });
});
