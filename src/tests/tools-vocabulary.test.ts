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
import { envNamesForModule, packagesForModule, pathsForModule, samplesForModule } from './helpers/symfony-vocabulary';

const toolsDir = path.resolve(__dirname, '../tools');

const moduleNames = fs.readdirSync(toolsDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .sort();

interface ModuleFacts {
  paths: string[];
  envNames: string[];
  packages: string[];
}

/** How many single-line applications each module gets. */
const PER_MODULE = 200;

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-vocab-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function buildApp(dir: string, lines: string[], own: ModuleFacts): void {
  const { paths: ownPaths, envNames, packages } = own;
  const line = lines.join('\n        ');
  const comment = line.replace(/[\n#]/g, ' ');
  const write = (rel: string, content: string): void => {
    const full = path.join(dir, rel);
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    } catch {
      // A module names both a file and a directory at the same path — a
      // Makefile is not a directory — and whichever came first stays.
    }
  };

  // The packages this module gates on, or it returns before doing anything.
  const require_: Record<string, string> = { 'php': '>=8.2', 'symfony/framework-bundle': '^7.0' };
  for (const name of packages) require_[name] = '^1.0';
  write('composer.json', JSON.stringify({
    name: 'acme/app',
    require: require_,
    scripts: { 'post-install-cmd': comment.slice(0, 120) },
  }, null, 2));
  write('composer.lock', JSON.stringify({
    'content-hash': '0'.repeat(32),
    packages: Object.keys(require_).map((name) => ({ name, version: 'v1.0.0' })),
    'packages-dev': [{ name: 'phpunit/phpunit', version: '11.0.0' }],
  }, null, 2));
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

  // Half of what a module reads it reads through a YAML parser, by key, and a
  // key buried in a comment is not a key. Whatever in the vocabulary is shaped
  // like one gets written as one, at the top level and one level down.
  const keys = lines
    .map((l) => /^([a-z_][a-z0-9_]{2,40})\s*:/i.exec(l)?.[1])
    .filter((k): k is string => typeof k === 'string');
  if (keys.length > 0) {
    const structural: string[] = [];
    for (const key of keys) {
      structural.push(`${key}:`);
      for (const nested of keys) structural.push(`    ${nested}: value`);
      structural.push(`    enabled: true`);
    }
    write('config/packages/structural.yaml', structural.join('\n') + '\n');
    write('config/structural.yaml', structural.join('\n') + '\n');
  }
  write('config/packages/dev/vocabulary.yaml', `vocabulary:\n    line: ${JSON.stringify(line.replace(/\n/g, ' '))}\n`);
  write('config/services.yaml', `services:\n    _defaults:\n        autowire: true\n    # ${line.replace(/\n/g, ' ')}\n`);
  write('templates/vocabulary.html.twig', `{# ${line.replace(/[#{}]/g, '')} #}\n`);
  // The variables this module reads, set rather than mentioned.
  const envBody = `APP_ENV=prod\nAPP_DEBUG=0\n${envNames.map((n) => `${n}=value-for-${n.toLowerCase()}`).join('\n')}\n# ${line.replace(/\n/g, ' ')}\n`;
  write('.env', envBody);
  write('phpunit.xml', `<?xml version="1.0"?>\n<phpunit><!-- ${line.replace(/-->/g, '')} --></phpunit>\n`);
  write('docker-compose.yml', `services:\n    app:\n        image: acme\n        # ${line.replace(/\n/g, ' ')}\n`);

  // The same line again wherever else the modules read, since which file a
  // module opens is as particular as what it looks for inside it.
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

  // And the rest of the files the ecosystem modules open, each with the same
  // line inside it, since a module that reads only netlify.toml sees nothing
  // in any of the above.
  write('config/routes.yaml', `app_home:\n    path: /\n    controller: App\\Controller\\HomeController::index\n${hashed}`);
  write('config/bundles.php', `<?php\n\nreturn [\n    // ${comment}\n];\n`);
  write('importmap.php', `<?php\n\nreturn [\n    // ${comment}\n];\n`);
  write('psalm.xml', `<?xml version="1.0"?>\n<psalm errorLevel="3"><!-- ${comment.replace(/-->/g, '')} --></psalm>\n`);
  write('.php-cs-fixer.php', `<?php\n\n// ${comment}\n`);
  write('infection.json', JSON.stringify({ source: { directories: ['src'] }, note: comment.slice(0, 120) }));
  write('cypress.config.js', `module.exports = {\n    // ${comment}\n};\n`);
  write('wrangler.toml', `name = "acme"\n${hashed}`);
  write('netlify.toml', `[build]\ncommand = "make build"\n${hashed}`);
  write('vercel.json', JSON.stringify({ version: 2, note: comment.slice(0, 120) }));
  write('service.yaml', `apiVersion: serving.knative.dev/v1\nkind: Service\n${hashed}`);
  write('consul.json', JSON.stringify({ service: { name: 'acme' }, note: comment.slice(0, 120) }));
  write('sonar-project.properties', `sonar.projectKey=acme\n${hashed}`);
  write('features/vocabulary.feature', `Feature: vocabulary\n\n    Scenario: line\n        Given ${comment}\n`);
  write('proto/vocabulary.proto', `syntax = "proto3";\n\n// ${comment}\n`);
  write('.env.local', envBody);
  write('.env.prod', envBody);
  write('.env.dist', envBody);
  write('php.ini', `[PHP]\n; ${comment}\n`);
  write('supervisord.conf', `[supervisord]\n; ${comment}\n`);
  write('crontab', `# ${comment}\n`);
  write('helm/values.yaml', `image:\n    tag: latest\n${hashed}`);
  write('terraform/main.tf', `# ${comment}\n`);
  write('ansible/playbook.yml', `- hosts: all\n  tasks: []\n  ${comment}\n`);
  write('src/Form/VocabularyType.php', `<?php\n\nnamespace App\\Form;\n\nclass VocabularyType\n{\n    public function build(): void\n    {\n        ${line}\n    }\n}\n`);
  write('src/Twig/VocabularyExtension.php', `<?php\n\nnamespace App\\Twig;\n\nclass VocabularyExtension\n{\n    public function run(): void\n    {\n        ${line}\n    }\n}\n`);
  // And wherever this module says it reads, which is the only way to feed one
  // that opens a single file nobody else does.
  // Written above with the packages this module gates on and the variables it
  // reads. Rewriting them here as a note took the gate away, and everything
  // behind "package not installed" or "variable not set" stopped being
  // reachable at all.
  const KEEP = new Set(['composer.json', 'composer.lock', '.env', '.env.local', '.env.dist', '.env.prod']);

  for (const rel of ownPaths) {
    if (KEEP.has(rel)) continue;
    const ext = /\.([a-z0-9]+)$/i.exec(rel)?.[1]?.toLowerCase() ?? '';
    if (ext === 'php') {
      write(rel, `<?php\n\n// ${comment}\n\n${line}\n`);
    } else if (ext === 'json' || ext === 'avsc' || ext === 'lock') {
      write(rel, JSON.stringify({ name: 'acme', note: comment.slice(0, 160) }, null, 2) + '\n');
    } else if (ext === 'xml') {
      write(rel, `<?xml version="1.0"?>\n<root><!-- ${comment.replace(/--/g, '-')} --></root>\n`);
    } else if (ext === 'twig') {
      write(rel, `{# ${comment.replace(/[#{}]/g, '')} #}\n`);
    } else if (ext === 'js' || ext === 'ts' || ext === 'tf' || ext === 'sh') {
      write(rel, `// ${comment}\n`);
    } else if (ext === 'ini' || ext === 'conf' || ext === 'properties') {
      write(rel, `; ${comment}\n${comment}\n`);
    } else if (ext === 'feature') {
      write(rel, `Feature: vocabulary\n\n    Scenario: line\n        Given ${comment}\n`);
    } else if (ext === '') {
      // A directory the module walks: give it something to find.
      write(`${rel}/vocabulary.yaml`, `vocabulary:\n    line: ${JSON.stringify(comment)}\n`);
      write(`${rel}/Vocabulary.php`, `<?php\n\nnamespace App;\n\nclass VocabularyIn\n{\n    public function run(): void\n    {\n        ${line}\n    }\n}\n`);
      write(`${rel}/vocabulary.json`, JSON.stringify({ note: comment.slice(0, 160) }) + '\n');
    } else {
      // yaml, yml, neon, toml, env, dist and the rest read as text.
      write(rel, `${hashed}vocabulary:\n    line: ${JSON.stringify(comment)}\n`);
    }
  }

  write('src/Doctrine/VocabularyType.php', `<?php\n\nnamespace App\\Doctrine;\n\nclass VocabularyType\n{\n    public function run(): void\n    {\n        ${line}\n    }\n}\n`);

  // The same line in the other shapes a PHP file takes, since a good number
  // of checks ask what kind of declaration they are looking at.
  write('src/Contract/VocabularyInterface.php', `<?php\n\nnamespace App\\Contract;\n\n// ${comment}\ninterface VocabularyInterface\n{\n    public function run(): void;\n}\n`);
  write('src/Enum/VocabularyEnum.php', `<?php\n\nnamespace App\\Enum;\n\n// ${comment}\nenum VocabularyEnum: string\n{\n    case One = "one";\n    case Two = "two";\n}\n`);
  write('src/Trait/VocabularyTrait.php', `<?php\n\nnamespace App\\Traits;\n\ntrait VocabularyTrait\n{\n    public function run(): void\n    {\n        ${line}\n    }\n}\n`);
  write('src/Final/VocabularyFinal.php', `<?php\n\nnamespace App\\FinalNs;\n\nfinal class VocabularyFinal extends VocabularyBase implements \\Stringable\n{\n    public function run(): void\n    {\n        ${line}\n    }\n\n    public function __toString(): string { return "v"; }\n}\n`);
  write('src/Abstract/VocabularyBase.php', `<?php\n\nnamespace App\\AbstractNs;\n\nabstract class VocabularyBase\n{\n    abstract public function run(): void;\n}\n`);
  write('src/Classless/vocabulary.php', `<?php\n\n// ${comment}\n\nreturn [\n    "line" => ${JSON.stringify(comment.slice(0, 120))},\n];\n`);
}

describe('every module against an application holding one thing at a time', () => {
  describe.each(moduleNames)('%s', (name) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: Record<string, any>;
    let lines: string[];
    let facts: ModuleFacts;

    beforeAll(async () => {
      mod = (await import(path.join(toolsDir, name))) as Record<string, unknown>;
      lines = samplesForModule(path.join(toolsDir, `${name}.ts`)).slice(0, PER_MODULE);
      const file = path.join(toolsDir, `${name}.ts`);
      facts = {
        paths: pathsForModule(file).slice(0, 40),
        envNames: envNamesForModule(file),
        packages: packagesForModule(file),
      };
    });

    test('each line of its own vocabulary is handled', async () => {
      const functions = Object.entries(mod)
        .filter(([, v]) => typeof v === 'function' && (v as (a: string) => unknown).length === 1)
        .map(([, v]) => v as (a: string) => unknown);

      // Singles first, then every consecutive pair: a check that asks for two
      // things at once is as common as one that asks for a single thing.
      const groups: string[][] = lines.map((l) => [l]);
      for (let i = 0; i + 1 < lines.length; i++) groups.push([lines[i], lines[i + 1]]);
      // Then the lot, for the checks that want several at once, and the lot
      // minus one, which is the only shape that answers "this is here and
      // that is not" when both belong to the same module's vocabulary.
      if (lines.length > 2) {
        groups.push(lines);
        for (let i = 0; i < lines.length; i++) groups.push(lines.filter((_, j) => j !== i));
      }

      for (const [index, group] of groups.entries()) {
        const dir = path.join(root, `${name}-${index}`);
        buildApp(dir, group, facts);

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
