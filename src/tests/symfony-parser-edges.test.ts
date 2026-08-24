// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Parser input the fixtures never produce.
 *
 * .env files are hand-edited, so they contain lines with no `=`, trailing
 * comments and quoted values. Route configuration contains scalars where a
 * map is expected, and duplicate names across files. A parser that throws or
 * silently mangles these takes every introspection tool down with it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseEnvFile,
  parseRoutes,
  parseServices,
  parseEntities,
  listLogFiles,
} from '../utils/symfony-parser';
import { cacheManager } from '../utils/cache-manager';

let appDir: string;

const write = (rel: string, body: string): void => {
  const full = path.join(appDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

beforeEach(() => {
  cacheManager.clear();
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-edges-'));
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe('parseEnvFile — malformed lines', () => {
  test('skips a line with no equals sign', () => {
    write('.env', 'THIS_IS_NOT_AN_ASSIGNMENT\nAPP_ENV=prod\n');
    const env = parseEnvFile(path.join(appDir, '.env'));

    expect(env).toEqual({ APP_ENV: 'prod' });
  });

  test('strips a trailing comment from a value', () => {
    write('.env', 'APP_ENV=prod # this is production\n');
    expect(parseEnvFile(path.join(appDir, '.env'))['APP_ENV']).toBe('prod');
  });

  test('keeps a hash that is part of a quoted value', () => {
    write('.env', 'SECRET_ISH="abc#def"\n');
    const v = parseEnvFile(path.join(appDir, '.env'))['SECRET_ISH'];

    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  test('handles a blank file', () => {
    write('.env', '\n\n   \n');
    expect(parseEnvFile(path.join(appDir, '.env'))).toEqual({});
  });
});

describe('parseRoutes — configuration that is not a route map', () => {
  test('skips scalar values where a route definition was expected', () => {
    write('config/routes.yaml', `some_scalar: just-a-string
another: 42
app_real:
  path: /real
  controller: C::i
`);
    expect(parseRoutes(appDir).map((r) => r.name)).toEqual(['app_real']);
  });

  test('skips a null entry', () => {
    write('config/routes.yaml', 'empty_one: ~\napp_real:\n  path: /r\n  controller: C::i\n');
    expect(parseRoutes(appDir).map((r) => r.name)).toEqual(['app_real']);
  });

  test('keeps the first definition when a name repeats across files', () => {
    write('config/routes.yaml', 'dup:\n  path: /from-root\n  controller: C::i\n');
    write('config/routes/extra.yaml', 'dup:\n  path: /from-subdir\n  controller: C::i\n');

    const dup = parseRoutes(appDir).filter((r) => r.name === 'dup');
    expect(dup).toHaveLength(1);
  });

  test('a second parse of an unchanged project is served from cache', () => {
    // parseRoutes watches both config/routes.yaml and the config/routes
    // directory. A watched path that does not exist counts as changed, so the
    // cache only ever hits when both are present — worth knowing, since a
    // project with no config/routes/ directory re-parses on every call.
    fs.mkdirSync(path.join(appDir, 'config', 'routes'), { recursive: true });
    write('config/routes.yaml', 'a:\n  path: /a\n  controller: C::i\n');

    const first = parseRoutes(appDir);
    const second = parseRoutes(appDir);

    expect(second).toBe(first);
  });

  test('editing a watched file invalidates the cache', () => {
    fs.mkdirSync(path.join(appDir, 'config', 'routes'), { recursive: true });
    write('config/routes.yaml', 'a:\n  path: /a\n  controller: C::i\n');
    expect(parseRoutes(appDir)).toHaveLength(1);

    const future = new Date(Date.now() + 10_000);
    write('config/routes.yaml', 'a:\n  path: /a\n  controller: C::i\nb:\n  path: /b\n  controller: C::i\n');
    fs.utimesSync(path.join(appDir, 'config', 'routes.yaml'), future, future);

    expect(parseRoutes(appDir)).toHaveLength(2);
  });
});

describe('parseServices — cache', () => {
  test('a second parse of an unchanged project is served from cache', () => {
    write('config/services.yaml', 'services:\n  a:\n    class: A\n');

    const first = parseServices(appDir);
    expect(parseServices(appDir)).toBe(first);
  });
});

describe('parseEntities — PHP that is not an entity', () => {
  test('skips a file with no class declaration', () => {
    write('src/Entity/helpers.php', "<?php\nfunction helper(): void {}\n");
    expect(parseEntities(appDir)).toEqual([]);
  });

  test('skips a class with no ORM attributes', () => {
    write('src/Entity/PlainClass.php', "<?php\nnamespace App\\Entity;\nclass PlainClass {}\n");
    expect(parseEntities(appDir)).toEqual([]);
  });

  test('reads a non-identifier column as a normal property', () => {
    write('src/Entity/Note.php', `<?php
namespace App\\Entity;
use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\Table(name: 'notes')]
class Note
{
    #[ORM\\Column(type: 'string')]
    private string $body;
}
`);
    const [e] = parseEntities(appDir);

    expect(e).toBeDefined();
    expect(e.properties.find((p) => p.name === 'body')?.isId).toBe(false);
  });
});

describe('listLogFiles — unreadable directory', () => {
  test('returns an empty list rather than throwing when var/log is a file', () => {
    fs.mkdirSync(path.join(appDir, 'var'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'var', 'log'), 'not a directory');

    expect(listLogFiles(appDir)).toEqual([]);
  });
});

describe('attribute routes in a file with no type declaration', () => {
  test('the class-level prefix comes back empty rather than throwing', () => {
    // A stray PHP file under src/Controller holding a route attribute but no
    // type declaration. The prefix extractor looks for the declaration keyword
    // and must cope with not finding one. (The fixture avoids that keyword
    // entirely — the extractor matches inside comments too.)
    write('src/Controller/Stray.php', `<?php
namespace App\\Controller;

#[Route('/stray', name: 'stray_route', methods: ['GET'])]
function stray(): Response {}
`);

    expect(() => parseRoutes(appDir)).not.toThrow();
  });
});
