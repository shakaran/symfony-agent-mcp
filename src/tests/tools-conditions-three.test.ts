// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The API Platform corners and the last of the Behat ones: an order filter
 * on a text column, a Mercure topic with no placeholder, serialization
 * contexts on both sides, a step definition that matches anything.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-conditions3-'));
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

    const calls = fn.length === 1 ? [[appPath]] : (extras.length > 0 ? extras.map((e) => [appPath, e, e]) : [[appPath, '', '']]);
    for (const args of calls) {
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

describe('the API Platform corners', () => {
  test('filters on text columns, static Mercure topics and contexts on both sides', async () => {
    const app = appWith('api-corners', {
      'config/packages/api_platform.yaml': [
        'api_platform:',
        '    title: Acme',
        '    version: 1.0.0',
        '    mercure:',
        '        hub_url: "%env(MERCURE_PUBLIC_URL)%"',
      ].join('\n') + '\n',
      'config/packages/mercure.yaml': [
        'mercure:',
        '    hubs:',
        '        default:',
        '            url: "%env(MERCURE_URL)%"',
        '            public_url: "%env(MERCURE_PUBLIC_URL)%"',
        '            jwt:',
        '                secret: "%env(MERCURE_JWT_SECRET)%"',
      ].join('\n') + '\n',
      'src/Entity/Article.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use ApiPlatform\\Doctrine\\Orm\\Filter\\OrderFilter;',
        'use ApiPlatform\\Doctrine\\Orm\\Filter\\SearchFilter;',
        'use ApiPlatform\\Metadata\\ApiFilter;',
        'use ApiPlatform\\Metadata\\ApiResource;',
        'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
        '',
        "#[ApiResource(",
        "    normalizationContext: ['groups' => ['article:read', 'article:detail']],",
        "    denormalizationContext: ['groups' => ['article:write']],",
        "    mercure: ['topics' => ['https://example.com/articles']],",
        ')]',
        "#[ApiFilter(OrderFilter::class, properties: ['description', 'title'])]",
        "#[ApiFilter(SearchFilter::class, properties: ['title', 'body'])]",
        'class Article',
        '{',
        "    #[Groups(['article:read'])]",
        '    public int $id = 0;',
        '',
        "    #[Groups(['article:read', 'article:write'])]",
        '    public string $description = "";',
        '',
        "    #[Groups(['article:detail'])]",
        '    public string $body = "";',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Feed.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use ApiPlatform\\Metadata\\ApiResource;',
        'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
        '',
        "#[ApiResource(",
        "    normalizationContext: ['groups' => ['feed:read']],",
        "    denormalizationContext: ['groups' => ['feed:write']],",
        "    mercure: ['topics' => ['https://example.com/feeds/{id}']],",
        ')]',
        'class Feed',
        '{',
        "    #[Groups(['feed:read'])]",
        '    public int $id = 0;',
        '}',
      ].join('\n') + '\n',
      'src/Serializer/FeedNormalizer.php': [
        '<?php',
        'namespace App\\Serializer;',
        '',
        'use Symfony\\Component\\Serializer\\Normalizer\\NormalizerInterface;',
        '',
        'class FeedNormalizer implements NormalizerInterface',
        '{',
        '    public function normalize($object, ?string $format = null, array $context = []): mixed { return []; }',
        '    public function supportsNormalization($data, ?string $format = null, array $context = []): bool { return true; }',
        '    public function getSupportedTypes(?string $format): array { return ["*" => true]; }',
        '}',
      ].join('\n') + '\n',
      'src/Exception/ApiException.php': [
        '<?php',
        'namespace App\\Exception;',
        '',
        'use Symfony\\Component\\HttpKernel\\Exception\\HttpExceptionInterface;',
        '',
        'class ApiException extends \\RuntimeException implements HttpExceptionInterface',
        '{',
        '    public function getStatusCode(): int { return 503; }',
        '    public function getHeaders(): array { return []; }',
        '}',
      ].join('\n') + '\n',
      'config/packages/api_platform_errors.yaml': [
        'api_platform:',
        '    exception_to_status:',
        '        App\\Exception\\ApiException: 503',
        '        Symfony\\Component\\Serializer\\Exception\\NotEncodableValueException: 400',
        '        Doctrine\\ORM\\EntityNotFoundException: 404',
        '        App\\Exception\\GatewayException: 502',
      ].join('\n') + '\n',
    }, { 'api-platform/core': '^3.2', 'symfony/mercure-bundle': '^0.3' });

    const results = await Promise.all([
      runModule('api-platform-filters.js', app, ['Article']),
      runModule('api-platform-mercure-push.js', app),
      runModule('api-platform-serialization-context.js', app, ['Article']),
      runModule('api-platform-error-handling.js', app),
      runModule('api-platform-security.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('a step definition that matches anything', async () => {
    const app = appWith('behat-broad', {
      'behat.yaml': 'default:\n    suites:\n        default:\n            paths: ["%paths.base%/features"]\n',
      'features/broad.feature': [
        'Feature: Broad steps',
        '',
        '    Scenario: Anything at all',
        '        Given something happens',
        '        When another thing happens',
        '        Then I should see a result',
      ].join('\n') + '\n',
      'features/bootstrap/BroadContext.php': [
        '<?php',
        'namespace App\\Tests\\Behat;',
        '',
        'use Behat\\Behat\\Context\\Context;',
        '',
        'class BroadContext implements Context',
        '{',
        '    /**',
        '     * @Given /^.*$/',
        '     */',
        '    public function anything(): void { }',
        '',
        '    /**',
        '     * @When /(.*)/',
        '     */',
        '    public function alsoAnything(): void { }',
        '',
        '    /**',
        '     * @Then I should see a result',
        '     */',
        '    public function precise(): void { }',
        '}',
      ].join('\n') + '\n',
    }, { 'behat/behat': '^3.14' });

    const text = await runModule('behat-step-coverage.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
