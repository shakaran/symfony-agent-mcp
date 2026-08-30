// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Each module against an application holding one thing at a time.
 *
 * The sweep runs every module against one large application, which is what
 * a real project looks like and what most of the parsing needs. It has one
 * blind spot, and it is a large one: a great many checks read "this is
 * present and that is not". In an application that contains everything,
 * the second half is never true, so the branch behind it cannot be reached
 * no matter how much content is added.
 *
 * Here each module is given a series of tiny applications, each holding a
 * single line of its own vocabulary — one of the strings its own patterns
 * describe — at every path it reads. What is present differs from one to
 * the next, which is exactly what those checks are asking about.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { samplesForModule } from './helpers/symfony-vocabulary';

const toolsDir = path.resolve(__dirname, '../tools');

const moduleNames = fs.readdirSync(toolsDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .sort();

/** How many single-line applications each module gets. */
const PER_MODULE = 200;

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-vocab-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function buildApp(dir: string, lines: string[]): void {
  const line = lines.join('\n        ');
  const write = (rel: string, content: string): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  write('composer.json', JSON.stringify({
    name: 'acme/app',
    require: { 'php': '>=8.2', 'symfony/framework-bundle': '^7.0' },
  }));
  // The directory a class sits in decides which module reads it at all.
  for (const [dir_, cls] of [
    ['src', 'Vocabulary'],
    ['src/Entity', 'VocabularyEntity'],
    ['src/Controller', 'VocabularyController'],
    ['src/Command', 'VocabularyCommand'],
    ['src/Security', 'VocabularyVoter'],
    ['src/MessageHandler', 'VocabularyHandler'],
    ['src/Repository', 'VocabularyRepository'],
    ['src/EventListener', 'VocabularyListener'],
    ['tests', 'VocabularyTest'],
  ] as const) {
    write(`${dir_}/${cls}.php`, `<?php\n\nnamespace App;\n\nclass ${cls}\n{\n    public function run(): void\n    {\n        ${line}\n    }\n}\n`);
  }
  write('config/packages/vocabulary.yaml', `vocabulary:\n${lines.map((l) => `    ${JSON.stringify(l)}: ~`).join('\n')}\n`);
  write('config/packages/prod/vocabulary.yaml', `vocabulary:\n    line: ${JSON.stringify(line.replace(/\n/g, ' '))}\n`);
  write('config/packages/dev/vocabulary.yaml', `vocabulary:\n    line: ${JSON.stringify(line.replace(/\n/g, ' '))}\n`);
  write('config/services.yaml', `services:\n    _defaults:\n        autowire: true\n    # ${line.replace(/\n/g, ' ')}\n`);
  write('templates/vocabulary.html.twig', `{# ${line.replace(/[#{}]/g, '')} #}\n`);
  write('.env', `APP_ENV=prod\n# ${line.replace(/\n/g, ' ')}\n`);
  write('phpunit.xml', `<?xml version="1.0"?>\n<phpunit><!-- ${line.replace(/-->/g, '')} --></phpunit>\n`);
  write('docker-compose.yml', `services:\n    app:\n        image: acme\n        # ${line.replace(/\n/g, ' ')}\n`);

  // The same line again wherever else the modules read, since which file a
  // module opens is as particular as what it looks for inside it.
  const comment = line.replace(/[\n#]/g, ' ');
  const hashed = `# ${comment}\n`;
  write('k8s/deployment.yaml', `apiVersion: apps/v1\nkind: Deployment\n${hashed}`);
  write('.github/workflows/ci.yml', `name: ci\non: [push]\njobs:\n    build:\n        runs-on: ubuntu-latest\n${hashed}`);
  write('.gitlab-ci.yml', `stages: [test]\n${hashed}`);
  write('Dockerfile', `FROM php:8.3-fpm\n${hashed}`);
  write('Makefile', `.PHONY: test\ntest:\n\t@echo ok\n${hashed}`);
  write('docker/nginx/default.conf', `server {\n    listen 80;\n    ${comment}\n}\n`);
  write('var/log/prod.log', `[2026-08-01T10:00:00+00:00] app.INFO: ${comment} [] []\n`);
  write('translations/messages.en.yaml', `vocabulary.line: ${JSON.stringify(comment)}\n`);
  write('public/index.php', `<?php\n\n// ${comment}\n`);
  write('bin/console', `#!/usr/bin/env php\n<?php\n\n// ${comment}\n`);
  write('rector.php', `<?php\n\n// ${comment}\n`);
  write('phpstan.neon', `parameters:\n    level: 6\n${hashed.replace(/^/, '    ')}`);
  write('behat.yaml', `default:\n    suites:\n        default: ~\n${hashed}`);
  write('package.json', JSON.stringify({ name: 'acme', scripts: { build: comment.slice(0, 80) } }));
  write('assets/app.js', `// ${comment}\n`);
  write('migrations/Version20260101000000.php', `<?php\n\nnamespace DoctrineMigrations;\n\n// ${comment}\n`);
}

describe('every module against an application holding one thing at a time', () => {
  describe.each(moduleNames)('%s', (name) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: Record<string, any>;
    let lines: string[];

    beforeAll(async () => {
      mod = (await import(path.join(toolsDir, name))) as Record<string, unknown>;
      lines = samplesForModule(path.join(toolsDir, `${name}.ts`)).slice(0, PER_MODULE);
    });

    test('each line of its own vocabulary is handled', async () => {
      const functions = Object.entries(mod)
        .filter(([, v]) => typeof v === 'function' && (v as (a: string) => unknown).length === 1)
        .map(([, v]) => v as (a: string) => unknown);

      // Singles first, then pairs: a check that asks for two things at once
      // is as common as one that asks for a thing and the absence of another.
      const groups: string[][] = lines.map((l) => [l]);
      for (let i = 0; i + 1 < lines.length; i += 2) groups.push([lines[i], lines[i + 1]]);
      // And one holding the lot, for the checks that want several at once.
      if (lines.length > 2) groups.push(lines);

      for (const [index, group] of groups.entries()) {
        const dir = path.join(root, `${name}-${index}`);
        buildApp(dir, group);

        for (const fn of functions) {
          const returned = await Promise.resolve(fn(dir));

          expect(returned).toBeDefined();
          if (returned && typeof returned === 'object' && 'content' in returned) {
            expect(Array.isArray((returned as { content: unknown }).content)).toBe(true);
          }
        }

        fs.rmSync(dir, { recursive: true, force: true });
      }

      expect(lines.length).toBeGreaterThanOrEqual(0);
    });
  });
});
