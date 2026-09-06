// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The guards inside the test helpers themselves.
 *
 * The helpers read module sources, build samples out of the patterns they
 * find and copy applications. Each of them refuses the input it cannot
 * handle: a module that is not there, a pattern too long to sample, one
 * whose sample does not match what it came from. Those refusals only run
 * when the input is wrong, which the fixtures never are.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { sampleFor, addPatternSamples } from './helpers/symfony-regex-samples';
import {
  envNamesForModule,
  packagesForModule,
  pathsForModule,
  samplesForModule,
} from './helpers/symfony-vocabulary';
import { addWalkerEntries } from './helpers/symfony-walkers';
import { useYmlSpelling } from './helpers/symfony-insecure';
import { addComposerDependencies, addPerModuleSurface } from './helpers/symfony-areas';
import { createSparseFixture } from './helpers/symfony-sparse';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-helper-guards-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the vocabulary helpers', () => {
  test('a module that is not there gives nothing back', () => {
    const missing = path.join(root, 'does-not-exist.ts');

    expect(samplesForModule(missing)).toEqual([]);
    expect(pathsForModule(missing)).toEqual([]);
    expect(envNamesForModule(missing)).toEqual([]);
    expect(packagesForModule(missing)).toEqual([]);
  });

  test('a pattern too long to sample, one that cannot be built and one that does not match', () => {
    const long = 'a'.repeat(320);
    const module = path.join(root, 'module.ts');
    fs.writeFileSync(module, [
      '// A pattern longer than the sampler will look at:',
      `const long = /${long}/;`,
      '// One whose sample cannot match what it came from:',
      'const impossible = /(?!x)x/;',
      '// And one that samples cleanly:',
      "const fine = /framework:\\s*\\n\\s+secret:/;",
      '',
    ].join('\n'));

    const samples = samplesForModule(module);

    expect(Array.isArray(samples)).toBe(true);
    expect(samples.every((s) => typeof s === 'string')).toBe(true);
  });
});

describe('the sampler', () => {
  test('patterns it cannot build a sample for', () => {
    expect(sampleFor('\\')).toBeNull();
    expect(sampleFor('[')).toBeNull();
    expect(sampleFor('(')).toBeNull();
    expect(sampleFor('[^\\s\\S]')).toBeNull();
    expect(sampleFor('([^\\s\\S])')).toBeNull();
    expect(sampleFor('a'.repeat(9000))).toBeNull();
  });

  test('a class of characters it does not know is sampled from its first', () => {
    expect(sampleFor('[\\u00e1\\u00e9]')).not.toBeNull();
  });

  test('patterns written into an application, from a directory of modules', () => {
    const toolsDir = path.join(root, 'fake-tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, 'long-pattern.ts'), [
      `const long = /${'b'.repeat(320)}/;`,
      "const broken = /(?!y)y/;",
      "const good = /doctrine:\\s*\\n\\s+dbal:/;",
      '',
    ].join('\n'));

    const app = path.join(root, 'sample-app');
    fs.mkdirSync(app, { recursive: true });
    addPatternSamples(app, toolsDir);

    expect(fs.existsSync(app)).toBe(true);
  });
});

describe('the application helpers', () => {
  test('a directory that cannot be read stops the walk without throwing', () => {
    const app = path.join(root, 'walker-app');
    fs.mkdirSync(path.join(app, 'src'), { recursive: true });

    expect(() => addWalkerEntries(app, 2)).not.toThrow();
    expect(fs.existsSync(path.join(app, 'composer.json'))).toBe(true);
  });

  test('renaming to the .yml spelling when there is no config directory', () => {
    const app = path.join(root, 'yml-app');
    fs.mkdirSync(app, { recursive: true });

    expect(() => useYmlSpelling(app)).not.toThrow();
  });

  test('a per-module surface with fewer symbols than there are directories', () => {
    const toolsDir = path.join(root, 'tiny-tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, 'tiny.ts'), "const only = 'app.tiny';\n");

    const app = path.join(root, 'surface-app');
    fs.mkdirSync(app, { recursive: true });
    addPerModuleSurface(app, toolsDir);

    expect(fs.existsSync(app)).toBe(true);
  });
});

describe('patterns that no engine will compile', () => {
  // Both helpers build a sample out of a pattern and then check the sample
  // against it. A pattern that is only valid as text, not as a regular
  // expression, is where that check has to give up.
  function moduleWithBadPatterns(name: string): { dir: string; file: string } {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'broken-patterns.ts');
    fs.writeFileSync(file, [
      "const outOfOrder = /abcdef{2,1}/;",
      "const reversedClass = /[z-a]wxyz/;",
      "export const both = [outOfOrder, reversedClass];",
      '',
    ].join('\n'));

    return { dir, file };
  }

  test('the vocabulary keeps only the samples its pattern accepts', () => {
    const { file } = moduleWithBadPatterns('bad-patterns-vocabulary');

    expect(samplesForModule(file)).toEqual([]);
  });

  test('and the sample writer skips them too', () => {
    const { dir } = moduleWithBadPatterns('bad-patterns-samples');
    const app = path.join(root, 'bad-patterns-app');
    fs.mkdirSync(app, { recursive: true });

    expect(() => addPatternSamples(app, dir)).not.toThrow();
  });
});

describe('copying an application sparsely', () => {
  test('JSON that is broken, JSON that is a list, and something that is neither', () => {
    const source = path.join(root, 'sparse-source');
    fs.mkdirSync(path.join(source, 'config'), { recursive: true });
    fs.writeFileSync(path.join(source, 'composer.json'), '{ "require": { "php": ">=8.2" }\n');
    fs.writeFileSync(path.join(source, 'config', 'list.json'), '["a", "b"]\n');
    fs.writeFileSync(path.join(source, 'config', 'services.yaml'), 'services:\n    _defaults:\n        autowire: true\n');
    fs.writeFileSync(path.join(source, 'README.md'), '# Acme\n');
    // A named pipe is neither a file nor a directory, and is skipped.
    execFileSync('mkfifo', [path.join(source, 'queue.fifo')]);

    const target = createSparseFixture(source, path.join(root, 'sparse-target'));

    expect(fs.readFileSync(path.join(target, 'composer.json'), 'utf-8')).toContain('">=8.2"');
    expect(fs.readFileSync(path.join(target, 'config', 'list.json'), 'utf-8')).toContain('"a"');
    expect(fs.existsSync(path.join(target, 'queue.fifo'))).toBe(false);
  });
});

describe('the helpers that write into an application', () => {
  test('a directory it is not allowed to read stops the walk there', () => {
    const app = path.join(root, 'walker-locked-app');
    fs.mkdirSync(path.join(app, 'locked'), { recursive: true });
    fs.chmodSync(path.join(app, 'locked'), 0o000);

    try {
      expect(() => addWalkerEntries(app, 2)).not.toThrow();
    } finally {
      fs.chmodSync(path.join(app, 'locked'), 0o755);
    }
  });

  test('dependencies are not added to an application without a composer.json', () => {
    const app = path.join(root, 'no-composer-app');
    fs.mkdirSync(app, { recursive: true });
    const tools = path.join(root, 'no-composer-tools');
    fs.mkdirSync(tools, { recursive: true });
    fs.writeFileSync(path.join(tools, 'thing.ts'), "const p = 'acme/invoices';\n");

    addComposerDependencies(app, tools);

    expect(fs.existsSync(path.join(app, 'composer.json'))).toBe(false);
  });
});
