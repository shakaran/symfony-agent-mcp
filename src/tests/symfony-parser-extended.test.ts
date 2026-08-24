// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony parser — coverage beyond symfony-parser.test.ts.
 *
 * The existing suite covers the happy paths of parseEnvFile, parseRoutes over
 * YAML, searchRoutes, parseServices and parseEntities. This one takes the
 * ground it leaves: PHP 8 attribute routes on controllers (including class
 * prefixes and precedence against YAML), the service definition shapes that
 * are not a plain class map, searchServices, log file listing and traversal
 * refusal, and getAppConfig's fallbacks.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseRoutes,
  parseServices,
  searchServices,
  classToTableName,
  readLogFile,
  listLogFiles,
  getAppConfig,
} from '../utils/symfony-parser';
import { cacheManager } from '../utils/cache-manager';

let appDir: string;

function makeApp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-parser-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'Controller'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'var', 'log'), { recursive: true });
  return dir;
}

const write = (rel: string, body: string): void => {
  const full = path.join(appDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

beforeEach(() => {
  cacheManager.clear();
  appDir = makeApp();
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe('parseRoutes — YAML configuration', () => {
  test('reads name, path, controller and methods', () => {
    write('config/routes.yaml', `app_home:
  path: /
  controller: App\\Controller\\HomeController::index
  methods: [GET, HEAD]
`);
    const [r] = parseRoutes(appDir);

    expect(r.name).toBe('app_home');
    expect(r.path).toBe('/');
    expect(r.controller).toBe('App\\Controller\\HomeController::index');
    expect(r.methods).toEqual(['GET', 'HEAD']);
  });

  test('defaults to GET when no methods are declared', () => {
    write('config/routes.yaml', 'app_x:\n  path: /x\n  controller: C::i\n');
    expect(parseRoutes(appDir)[0].methods).toEqual(['GET']);
  });

  test('accepts a single method given as a scalar', () => {
    write('config/routes.yaml', 'app_x:\n  path: /x\n  controller: C::i\n  methods: POST\n');
    expect(parseRoutes(appDir)[0].methods).toEqual(['POST']);
  });

  test('carries requirements, defaults and options through', () => {
    write('config/routes.yaml', `app_show:
  path: /item/{id}
  controller: C::show
  requirements:
    id: '\\d+'
  defaults:
    _format: json
  options:
    utf8: true
`);
    const [r] = parseRoutes(appDir);

    expect(r.requirements).toEqual({ id: '\\d+' });
    expect(r.defaults).toEqual({ _format: 'json' });
    expect(r.options).toEqual({ utf8: true });
  });

  test('skips resource imports, which are not routes themselves', () => {
    write('config/routes.yaml', `controllers:
  resource: ../src/Controller/
  type: attribute
app_real:
  path: /real
  controller: C::real
`);
    expect(parseRoutes(appDir).map((r) => r.name)).toEqual(['app_real']);
  });

  test('returns nothing for an app with no route configuration', () => {
    expect(parseRoutes(appDir)).toEqual([]);
  });

  test('does not throw on a path that does not exist', () => {
    expect(() => parseRoutes('/nonexistent/app')).not.toThrow();
  });

  test('survives malformed YAML', () => {
    write('config/routes.yaml', 'app_x:\n  - [unclosed\n');
    expect(() => parseRoutes(appDir)).not.toThrow();
  });
});

describe('parseRoutes — PHP 8 attribute routes', () => {
  test('reads a route declared on a controller method', () => {
    write('src/Controller/BlogController.php', `<?php
namespace App\\Controller;

use Symfony\\Component\\Routing\\Attribute\\Route;

class BlogController
{
    #[Route('/blog', name: 'blog_index', methods: ['GET'])]
    public function index(): Response {}
}
`);
    const routes = parseRoutes(appDir);
    const r = routes.find((x) => x.name === 'blog_index');

    expect(r).toBeDefined();
    expect(r?.path).toBe('/blog');
    expect(r?.methods).toEqual(['GET']);
    expect(r?.controller).toContain('BlogController');
  });

  test('applies a class-level route prefix', () => {
    write('src/Controller/AdminController.php', `<?php
namespace App\\Controller;

#[Route('/admin')]
class AdminController
{
    #[Route('/users', name: 'admin_users', methods: ['GET'])]
    public function users(): Response {}
}
`);
    const r = parseRoutes(appDir).find((x) => x.name === 'admin_users');
    expect(r?.path).toBe('/admin/users');
  });

  test('reads several methods on one route', () => {
    write('src/Controller/ApiController.php', `<?php
namespace App\\Controller;

class ApiController
{
    #[Route('/api/item', name: 'api_item', methods: ['GET', 'POST', 'DELETE'])]
    public function item(): Response {}
}
`);
    expect(parseRoutes(appDir).find((x) => x.name === 'api_item')?.methods)
      .toEqual(['GET', 'POST', 'DELETE']);
  });

  test('finds controllers in nested directories', () => {
    write('src/Controller/Api/V2/ThingController.php', `<?php
namespace App\\Controller\\Api\\V2;

class ThingController
{
    #[Route('/v2/thing', name: 'v2_thing')]
    public function thing(): Response {}
}
`);
    expect(parseRoutes(appDir).map((r) => r.name)).toContain('v2_thing');
  });

  test('a YAML route wins over an attribute route of the same name', () => {
    write('config/routes.yaml', 'dup:\n  path: /from-yaml\n  controller: C::i\n');
    write('src/Controller/DupController.php', `<?php
namespace App\\Controller;
class DupController
{
    #[Route('/from-attribute', name: 'dup')]
    public function i(): Response {}
}
`);
    const dup = parseRoutes(appDir).filter((r) => r.name === 'dup');

    expect(dup).toHaveLength(1);
    expect(dup[0].path).toBe('/from-yaml');
  });

  test('ignores a controller directory that does not exist', () => {
    fs.rmSync(path.join(appDir, 'src', 'Controller'), { recursive: true, force: true });
    expect(() => parseRoutes(appDir)).not.toThrow();
  });
});

describe('parseServices', () => {
  test('reads id, class and tags', () => {
    write('config/services.yaml', `services:
  App\\Service\\Mailer:
    class: App\\Service\\Mailer
    tags:
      - { name: 'app.mailer' }
      - 'kernel.event_listener'
`);
    const [s] = parseServices(appDir);

    expect(s.id).toBe('App\\Service\\Mailer');
    expect(s.class).toBe('App\\Service\\Mailer');
    expect(s.tags).toEqual(['app.mailer', 'kernel.event_listener']);
  });

  test('reads arguments, factory and alias', () => {
    write('config/services.yaml', `services:
  app.thing:
    class: App\\Thing
    arguments: ['@logger', '%kernel.debug%']
    factory: 'App\\Factory::create'
  app.alias:
    alias: app.thing
`);
    const services = parseServices(appDir);
    const thing = services.find((s) => s.id === 'app.thing');

    expect(thing?.arguments).toEqual(['@logger', '%kernel.debug%']);
    expect(thing?.factory).toBe('App\\Factory::create');
    expect(services.find((s) => s.id === 'app.alias')?.alias).toBe('app.thing');
  });

  test('treats a bare string value as the class', () => {
    write('config/services.yaml', 'services:\n  app.simple: App\\Simple\n');
    expect(parseServices(appDir)[0].class).toBe('App\\Simple');
  });

  test('skips null service definitions', () => {
    write('config/services.yaml', 'services:\n  app.null: ~\n  app.real:\n    class: App\\Real\n');
    expect(parseServices(appDir).map((s) => s.id)).toEqual(['app.real']);
  });

  test('an untagged service reports an empty tag list', () => {
    write('config/services.yaml', 'services:\n  app.x:\n    class: App\\X\n');
    expect(parseServices(appDir)[0].tags).toEqual([]);
  });

  test('returns nothing when services.yaml is absent', () => {
    expect(parseServices(appDir)).toEqual([]);
  });

  test('returns nothing when the file has no services key', () => {
    write('config/services.yaml', 'parameters:\n  locale: en\n');
    expect(parseServices(appDir)).toEqual([]);
  });
});

describe('searchServices', () => {
  const services = [
    { id: 'app.mailer', class: 'App\\Service\\Mailer', tags: ['app.mailer'] },
    { id: 'app.logger', class: 'App\\Service\\Logger', tags: ['monolog.logger'] },
  ];

  test('matches by id', () => {
    expect(searchServices(services, 'mailer', 'id').map((s) => s.id)).toEqual(['app.mailer']);
  });

  test('matches by class', () => {
    expect(searchServices(services, 'Logger', 'class').map((s) => s.id)).toEqual(['app.logger']);
  });

  test('matches by tag', () => {
    expect(searchServices(services, 'monolog', 'tag').map((s) => s.id)).toEqual(['app.logger']);
  });

  test('searches every field by default', () => {
    expect(searchServices(services, 'monolog').map((s) => s.id)).toEqual(['app.logger']);
  });
});

describe('classToTableName', () => {
  test('converts PascalCase to snake_case', () => {
    expect(classToTableName('ShoppingCart')).toBe('shopping_cart');
    expect(classToTableName('User')).toBe('user');
  });

  test('handles consecutive capitals', () => {
    expect(classToTableName('APIToken')).toBe('a_p_i_token');
  });

  test('leaves an already-lowercase name alone', () => {
    expect(classToTableName('user')).toBe('user');
  });
});

describe('log files', () => {
  test('lists .log files only', () => {
    write('var/log/dev.log', 'x');
    write('var/log/prod.log', 'y');
    write('var/log/notes.txt', 'z');

    expect(listLogFiles(appDir).sort()).toEqual(['dev.log', 'prod.log']);
  });

  test('filters by environment', () => {
    write('var/log/dev.log', 'x');
    write('var/log/prod.log', 'y');

    expect(listLogFiles(appDir, 'prod')).toEqual(['prod.log']);
  });

  test('returns nothing when var/log is missing', () => {
    fs.rmSync(path.join(appDir, 'var'), { recursive: true, force: true });
    expect(listLogFiles(appDir)).toEqual([]);
  });

  test('reads the last N lines and drops blank ones', () => {
    write('var/log/dev.log', 'l1\nl2\n\nl3\nl4\n');
    expect(readLogFile(appDir, 'dev.log', 2)).toEqual(['l3', 'l4']);
  });

  test('returns everything when fewer lines exist than requested', () => {
    write('var/log/dev.log', 'only\n');
    expect(readLogFile(appDir, 'dev.log', 50)).toEqual(['only']);
  });

  test('returns nothing for a file that is not there', () => {
    expect(readLogFile(appDir, 'missing.log')).toEqual([]);
  });

  test('refuses to traverse out of var/log', () => {
    expect(readLogFile(appDir, '../../../etc/passwd')).toEqual([]);
  });
});

describe('getAppConfig', () => {
  test('reads the environment', () => {
    write('.env', 'APP_ENV=dev\nAPP_DEBUG=true\nAPP_VERSION=2.1.0\n');
    const cfg = getAppConfig(appDir);

    expect(cfg.app_env).toBe('dev');
    expect(cfg.app_debug).toBe(true);
    expect(cfg.app_version).toBe('2.1.0');
  });

  test('falls back to safe defaults when .env is absent', () => {
    const cfg = getAppConfig(appDir);

    expect(cfg.app_env).toBe('prod');
    expect(cfg.app_debug).toBe(false);
    expect(cfg.app_version).toBe('unknown');
  });
});
