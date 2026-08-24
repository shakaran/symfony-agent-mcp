// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseEnvFile,
  loadEnvironmentVariables,
  parseRoutes,
  parseServices,
  parseEntities,
  classToTableName,
  searchRoutes,
} from '../utils/symfony-parser';

// ─── Test fixture builder ────────────────────────────────────────────────────

function createTempApp(files: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-mcp-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }
  return tmpDir;
}

function cleanupTempApp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── parseEnvFile ────────────────────────────────────────────────────────────

describe('parseEnvFile', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('parses simple key=value pairs', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'APP_ENV=dev\nAPP_DEBUG=true\n');
    const env = parseEnvFile(path.join(tmpDir, '.env'));
    expect(env['APP_ENV']).toBe('dev');
    expect(env['APP_DEBUG']).toBe('true');
  });

  test('strips surrounding quotes', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'NAME="John Doe"\nNAME2=\'Jane\'\n');
    const env = parseEnvFile(path.join(tmpDir, '.env'));
    expect(env['NAME']).toBe('John Doe');
    expect(env['NAME2']).toBe('Jane');
  });

  test('ignores comment lines', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), '# This is a comment\nAPP_ENV=prod\n');
    const env = parseEnvFile(path.join(tmpDir, '.env'));
    expect(Object.keys(env)).toEqual(['APP_ENV']);
  });

  test('handles equals sign in value', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'DATABASE_URL=mysql://user:pa==ss@localhost/db\n');
    const env = parseEnvFile(path.join(tmpDir, '.env'));
    expect(env['DATABASE_URL']).toBe('mysql://user:pa==ss@localhost/db');
  });

  test('returns empty object for non-existent file', () => {
    const env = parseEnvFile('/nonexistent/.env');
    expect(env).toEqual({});
  });
});

// ─── loadEnvironmentVariables ────────────────────────────────────────────────

describe('loadEnvironmentVariables', () => {
  test('.env.local overrides .env', () => {
    const tmpDir = createTempApp({
      '.env': 'APP_ENV=dev\nSHARED=base\n',
      '.env.local': 'APP_ENV=prod\n',
    });
    const env = loadEnvironmentVariables(tmpDir);
    expect(env['APP_ENV']).toBe('prod');
    expect(env['SHARED']).toBe('base');
    cleanupTempApp(tmpDir);
  });
});

// ─── parseRoutes ─────────────────────────────────────────────────────────────

describe('parseRoutes', () => {
  test('parses routes from config/routes.yaml', () => {
    const tmpDir = createTempApp({
      'config/routes.yaml': `
app_home:
  path: /
  controller: App\\Controller\\HomeController::index
  methods: [GET]
app_about:
  path: /about
  controller: App\\Controller\\AboutController::index
  methods: [GET, HEAD]
`,
    });
    const routes = parseRoutes(tmpDir);
    expect(routes).toHaveLength(2);
    expect(routes[0].name).toBe('app_home');
    expect(routes[0].path).toBe('/');
    expect(routes[0].methods).toEqual(['GET']);
    expect(routes[1].methods).toEqual(['GET', 'HEAD']);
    cleanupTempApp(tmpDir);
  });

  test('parses routes from config/routes/ directory', () => {
    const tmpDir = createTempApp({
      'config/routes/api.yaml': `
api_users:
  path: /api/users
  controller: App\\Controller\\Api\\UserController::list
  methods: [GET]
`,
    });
    const routes = parseRoutes(tmpDir);
    expect(routes.some((r) => r.name === 'api_users')).toBe(true);
    cleanupTempApp(tmpDir);
  });

  test('returns empty array when no route files exist', () => {
    const tmpDir = createTempApp({});
    const routes = parseRoutes(tmpDir);
    expect(routes).toEqual([]);
    cleanupTempApp(tmpDir);
  });

  test('skips resource imports', () => {
    const tmpDir = createTempApp({
      'config/routes.yaml': `
controllers:
  resource:
    path: ../src/Controller/
    namespace: App\\Controller
  type: attribute
`,
    });
    const routes = parseRoutes(tmpDir);
    // Resource imports are skipped, no actual routes returned
    expect(routes.every((r) => !r.name.includes('controllers'))).toBe(true);
    cleanupTempApp(tmpDir);
  });
});

// ─── searchRoutes ─────────────────────────────────────────────────────────────

describe('searchRoutes', () => {
  const routes = [
    { name: 'app_home', path: '/', methods: ['GET'], controller: 'HomeController::index' },
    { name: 'api_users', path: '/api/users', methods: ['GET'], controller: 'Api\\UserController::list' },
    { name: 'user_login', path: '/login', methods: ['POST'], controller: 'SecurityController::login' },
  ];

  test('searches by name', () => {
    const result = searchRoutes(routes, 'api', 'name');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('api_users');
  });

  test('searches by path', () => {
    const result = searchRoutes(routes, '/api', 'path');
    expect(result).toHaveLength(1);
  });

  test('searches by controller', () => {
    const result = searchRoutes(routes, 'security', 'controller');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('user_login');
  });

  test('searches all fields', () => {
    const result = searchRoutes(routes, 'user', 'all');
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── parseServices ───────────────────────────────────────────────────────────

describe('parseServices', () => {
  test('parses services.yaml', () => {
    const tmpDir = createTempApp({
      'config/services.yaml': `
services:
  App\\Service\\UserService:
    class: App\\Service\\UserService
    tags:
      - { name: 'app.user_service' }
  app.mailer:
    class: App\\Service\\Mailer
`,
    });
    const services = parseServices(tmpDir);
    expect(services.length).toBeGreaterThanOrEqual(2);
    const userService = services.find((s) => s.id.includes('UserService'));
    expect(userService).toBeDefined();
    expect(userService?.tags[0]).toBe('app.user_service');
    cleanupTempApp(tmpDir);
  });
});

// ─── parseEntities ───────────────────────────────────────────────────────────

describe('parseEntities', () => {
  test('parses entity with PHP 8 ORM attributes', () => {
    const tmpDir = createTempApp({
      'src/Entity/User.php': `<?php
namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity(repositoryClass: UserRepository::class)]
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

    #[ORM\\OneToMany(targetEntity: Post::class, mappedBy: 'author')]
    private Collection $posts;
}
`,
    });
    const entities = parseEntities(tmpDir);
    expect(entities).toHaveLength(1);
    const user = entities[0];
    expect(user.name).toBe('User');
    expect(user.tableName).toBe('users');
    expect(user.namespace).toBe('App\\Entity');
    expect(user.properties.some((p) => p.name === 'id' && p.isId)).toBe(true);
    expect(user.properties.some((p) => p.name === 'email')).toBe(true);
    expect(user.relationships.some((r) => r.type === 'OneToMany')).toBe(true);
    cleanupTempApp(tmpDir);
  });

  test('ignores non-entity PHP files', () => {
    const tmpDir = createTempApp({
      'src/Entity/UserRepository.php': `<?php
namespace App\\Repository;
class UserRepository extends ServiceEntityRepository {}
`,
    });
    const entities = parseEntities(tmpDir);
    expect(entities).toHaveLength(0);
    cleanupTempApp(tmpDir);
  });

  test('returns empty array when Entity dir does not exist', () => {
    const tmpDir = createTempApp({});
    const entities = parseEntities(tmpDir);
    expect(entities).toEqual([]);
    cleanupTempApp(tmpDir);
  });
});

// ─── classToTableName ─────────────────────────────────────────────────────────

describe('classToTableName', () => {
  test('converts PascalCase to snake_case', () => {
    expect(classToTableName('User')).toBe('user');
    expect(classToTableName('UserProfile')).toBe('user_profile');
    expect(classToTableName('BlogPost')).toBe('blog_post');
    expect(classToTableName('APIToken')).toBe('a_p_i_token');
  });
});
