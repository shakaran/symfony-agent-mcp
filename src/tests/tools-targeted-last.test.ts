// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The remaining corners: the server's own cache, bundles written with
 * single quotes, intervals spelled several ways, recipes from the contrib
 * repository, GrumPHP installed without a configuration, Smarty templates
 * and a file holding two classes with a property of the same name.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearMcpCache, inspectMcpCache } from '../tools/cache-inspector.js';
import { cacheManager } from '../utils/cache-manager.js';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-last-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function appWith(name: string, files: Record<string, string>, require_: Record<string, string> = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (!files['composer.json']) {
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({
      require: { 'symfony/framework-bundle': '^7.0', ...require_ },
    }, null, 2));
  }

  return dir;
}

async function runModule(name: string, appPath: string, extras: string[] = []): Promise<string> {
  const mod = await import(path.resolve(__dirname, '../tools', name.replace(/\.js$/, ''))) as Record<string, unknown>;
  const texts: string[] = [];

  for (const [, value] of Object.entries(mod)) {
    if (typeof value !== 'function') continue;
    const fn = value as (...args: unknown[]) => unknown;
    if (fn.length === 0) continue;

    const argsets = fn.length === 1 ? [[appPath]] : extras.map((e) => [appPath, e, e]);
    for (const args of argsets) {
      const returned = await Promise.resolve(fn(...args.slice(0, fn.length)));
      expect(returned).toBeDefined();
      if (returned && typeof returned === 'object' && 'content' in returned) {
        const content = (returned as { content: Array<{ text?: string }> }).content;
        expect(Array.isArray(content)).toBe(true);
        texts.push(content.map((c) => c.text ?? '').join('\n'));
      }
    }
  }

  return texts.join('\n');
}

describe('the remaining corners', () => {
  test('the cache the server keeps for itself', () => {
    const before = inspectMcpCache();
    expect(before.content[0]?.text).toContain('MCP Server Cache Statistics');

    const cleared = clearMcpCache();
    expect(cleared.content[0]?.text?.length).toBeGreaterThan(0);

    const after = inspectMcpCache();
    expect(after.content[0]?.text).toContain('Status:');
  });

  test('a cache that fails with something that is not an Error', () => {
    const stats = jest.spyOn(cacheManager, 'getStats').mockImplementation(() => {
      throw 'the cache is gone';
    });

    try {
      const inspected = inspectMcpCache();
      expect(inspected.isError).toBe(true);
      expect(inspected.content[0]?.text).toContain('the cache is gone');

      const cleared = clearMcpCache();
      expect(cleared.isError).toBe(true);
      expect(cleared.content[0]?.text).toContain('the cache is gone');
    } finally {
      stats.mockRestore();
    }
  });

  test('bundles written with single quotes, as the recipe writes them', async () => {
    const app = appWith('bundles-quotes', {
      'config/bundles.php': [
        '<?php',
        '',
        'return [',
        "    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],",
        "    Symfony\\Bundle\\WebProfilerBundle\\WebProfilerBundle::class => ['dev' => true, 'test' => true],",
        "    Symfony\\Bundle\\MakerBundle\\MakerBundle::class => ['dev' => true],",
        "    Sentry\\SentryBundle\\SentryBundle::class => ['prod' => true],",
        "    Doctrine\\Bundle\\DoctrineBundle\\DoctrineBundle::class => ['all' => true],",
        '];',
      ].join('\n') + '\n',
      'src/Kernel.php': [
        '<?php',
        'namespace App;',
        '',
        'use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;',
        'use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;',
        '',
        'class Kernel extends BaseKernel',
        '{',
        '    use MicroKernelTrait;',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('kernel-analysis.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('limiter intervals spelled in hours, minutes and ISO durations', async () => {
    const app = appWith('limiter-intervals', {
      'config/packages/rate_limiter.yaml': [
        'framework:',
        '    rate_limiter:',
        '        hourly:',
        '            policy: sliding_window',
        '            limit: 100',
        '            interval: "2 hours"',
        '        minutely:',
        '            policy: fixed_window',
        '            limit: 10',
        '            interval: "30 minutes"',
        '        daily:',
        '            policy: sliding_window',
        '            limit: 1000',
        '            interval: "1 day"',
        '        iso:',
        '            policy: token_bucket',
        '            limit: 5',
        '            rate: { interval: "PT30S", amount: 1 }',
        '        seconds:',
        '            policy: fixed_window',
        '            limit: 3',
        '            interval: "15 seconds"',
        '        nonsense:',
        '            policy: fixed_window',
        '            limit: 3',
        '            interval: "whenever"',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-rate-limiter-policy.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('recipes from the contrib repository, and a lock that will not parse', async () => {
    const contrib = appWith('flex-contrib', {
      'symfony.lock': JSON.stringify({
        'nelmio/cors-bundle': {
          version: '2.4',
          recipe: { repo: 'github.com/symfony/recipes-contrib', branch: 'main', version: '1.5', ref: 'bbb' },
          files: ['config/packages/nelmio_cors.yaml'],
        },
        'symfony/console': {
          version: '7.0',
          recipe: { repo: 'github.com/symfony/recipes', branch: 'main', version: '5.3', ref: 'ccc' },
        },
        'acme/no-recipe': { version: '1.0' },
      }, null, 2) + '\n',
      'config/packages/nelmio_cors.yaml': 'nelmio_cors:\n    defaults:\n        allow_origin: ["*"]\n',
    });

    const broken = appWith('flex-broken', {
      'symfony.lock': '{ this is not json at all\n',
    });

    const first = await runModule('flex-recipes.js', contrib, ['nelmio/cors-bundle']);
    const second = await runModule('flex-recipes.js', broken, ['anything']);
    expect((first + second).length).toBeGreaterThan(0);
  });

  test('GrumPHP required with no configuration, and a pre-push hook', async () => {
    const app = appWith('grumphp-nofile', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpro/grumphp': '^2.5' },
        extra: { grumphp: { 'git-hook-variables': { 'exec-grumphp-command': 'php' } } },
      }, null, 2) + '\n',
      '.git/hooks/pre-push': '#!/bin/sh\nvendor/bin/grumphp run\n',
      '.git/hooks/pre-commit': '#!/bin/sh\nvendor/bin/grumphp git:pre-commit\n',
    });

    const text = await runModule('grumphp-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a Smarty template chosen by the request', async () => {
    const app = appWith('smarty', {
      'src/Legacy/SmartyRenderer.php': [
        '<?php',
        'namespace App\\Legacy;',
        '',
        'class SmartyRenderer',
        '{',
        '    public function render(): void',
        '    {',
        '        $smarty = new \\Smarty();',
        '        $template = $_GET["page"];',
        '        $smarty->assign("name", $_GET["name"]);',
        '        $smarty->display($template);',
        '',
        '        $code = "return " . $_POST["expr"] . ";";',
        '        eval($code);',
        '',
        '        $interpolated = "Hello ${name}";',
        '        eval("echo \\"" . $interpolated . "\\";");',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('php-template-injection.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('two classes in one file, each with a hook on the same property', async () => {
    const app = appWith('hooks-twice', {
      'src/Domain/Pair.php': [
        '<?php',
        'namespace App\\Domain;',
        '',
        'class First',
        '{',
        '    private float $raw = 0.0;',
        '',
        '    public float $amount {',
        '        get => $this->raw;',
        '    }',
        '}',
        '',
        'class Second',
        '{',
        '    private float $raw = 0.0;',
        '',
        '    public float $amount {',
        '        get {',
        '            return $this->raw * 2;',
        '        }',
        '        set {',
        '            $this->raw = $value / 2;',
        '        }',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('php-property-hooks.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
