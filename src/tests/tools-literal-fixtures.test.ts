// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Every analyser, against a file that says what it is looking for.
 *
 * Each module recognises an application by the strings it finds in its files:
 * `->flush(`, `PostConnectEventArgs`, `#[ORM\Cache`. A fixture written by hand
 * per module is the accurate way to exercise the findings, and
 * tools-findings.test.ts does that where the finding matters. This file takes
 * the other half of the problem — the branch that only opens when the string
 * *is* there — by reading each module's own literals and writing a file that
 * contains them all.
 *
 * It is deliberately crude: the fixture is not valid PHP and does not mean
 * anything. These analysers match text, so what it proves is that a module
 * survives an application where everything it looks for is present at once,
 * and that the halves of those conditions are taken.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const toolsDir = path.resolve(__dirname, '../tools');

const moduleNames = fs.readdirSync(toolsDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .sort();

/** The strings a module looks for in the text of a file. */
function literalsOf(moduleName: string): string[] {
  const src = fs.readFileSync(path.join(toolsDir, `${moduleName}.ts`), 'utf-8');
  const found = new Set<string>();

  for (const re of [
    /(?:content|line|trimmed|body|text|raw)\.includes\(\s*['"`]([^'"`]{2,90})['"`]\s*\)/g,
    /['"`]([\w./:-]{3,60})['"`]\s*(?:,|\])\s*\/\/ ?token/g,
  ]) {
    for (const m of src.matchAll(re)) found.add(m[1]);
  }

  // A file that declares a vendor namespace is skipped on purpose by many
  // modules; including those would hide everything else in the fixture.
  return [...found].filter((s) => !s.startsWith('namespace ') && !s.includes('vendor/'));
}

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'literal-fixtures-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function appFor(moduleName: string, literals: string[]): string {
  const dir = path.join(root, moduleName);
  const php = [
    '<?php',
    '',
    'namespace App\\Generated;',
    '',
    'class Everything',
    '{',
    ...literals.map((l, i) => `    // ${i}: ${l}`),
    '',
    '    public function run(): void',
    '    {',
    ...literals.map((l) => `        /* ${l} */`),
    '    }',
    '}',
    '',
  ].join('\n');

  const yaml = ['# generated', ...literals.map((l, i) => `key_${i}: '${l.replace(/'/g, '')}'`)].join('\n') + '\n';

  for (const rel of [
    'src/Generated/Everything.php',
    'src/Entity/Everything.php',
    'src/Command/EverythingCommand.php',
    'src/EventListener/EverythingListener.php',
    'tests/EverythingTest.php',
  ]) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, php);
  }

  for (const rel of [
    'config/packages/framework.yaml',
    'config/services.yaml',
    'translations/messages.en.yaml',
  ]) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, yaml);
  }

  fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({
    require: { 'symfony/framework-bundle': '^7.0' },
    autoload: { 'psr-4': { 'App\\': 'src/' } },
  }, null, 2));

  return dir;
}

async function runAll(moduleName: string, app: string): Promise<void> {
  const mod = await import(path.join(toolsDir, moduleName)) as Record<string, unknown>;

  for (const value of Object.values(mod)) {
    if (typeof value !== 'function') continue;
    const fn = value as (...args: unknown[]) => unknown;
    if (fn.length === 0) continue;

    const args = fn.length === 1 ? [app] : [app, 'Everything', 'Everything'];
    const returned = await Promise.resolve(fn(...args.slice(0, fn.length)));

    expect(returned).toBeDefined();
    if (returned && typeof returned === 'object' && 'content' in returned) {
      expect(Array.isArray((returned as { content: unknown[] }).content)).toBe(true);
    }
  }
}

describe('a file that contains every string a module looks for', () => {
  test.each(moduleNames)('%s', async (moduleName) => {
    const literals = literalsOf(moduleName);
    if (literals.length === 0) return;

    await runAll(moduleName, appFor(moduleName, literals));
  });
});

describe('and one that contains none of them', () => {
  // The same application shape with an ordinary class in it: what the module
  // does when the thing it looks for is simply not there.
  test.each(moduleNames)('%s', async (moduleName) => {
    await runAll(moduleName, appFor(`${moduleName}-none`, []));
  });
});
