// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * What was left: benchmarks marked as subjects, a mailer with a fallback
 * in both spellings, a repository whose queries are middling, and Twig
 * templates printing raw user content.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-tail-'));
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

describe('what was left', () => {
  test('benchmarks marked as subjects', async () => {
    const app = appWith('phpbench-subjects', {
      'benchmarks/CatalogueBench.php': [
        '<?php',
        'namespace App\\Benchmarks;',
        '',
        'class CatalogueBench',
        '{',
        '    /**',
        '     * @Subject',
        '     * @Revs(1000)',
        '     * @Iterations(5)',
        '     */',
        '    public function benchSearch(): void { }',
        '',
        '    /**',
        '     * @Bench',
        '     */',
        '    public function benchIndex(): void { }',
        '}',
      ].join('\n') + '\n',
      'benchmarks/ImportBenchmark.php': [
        '<?php',
        'namespace App\\Benchmarks;',
        '',
        'class ImportBenchmark',
        '{',
        '    #[Subject]',
        '    public function benchImport(): void { }',
        '}',
      ].join('\n') + '\n',
      'benchmarks/NotABenchmark.php': '<?php\n\nclass Helper {}\n',
      'phpbench.json': JSON.stringify({
        'runner.bootstrap': 'vendor/autoload.php',
        'runner.path': 'benchmarks',
        'runner.iterations': 10,
        'runner.revs': 5000,
      }, null, 2) + '\n',
    }, { 'phpbench/phpbench': '^1.2' });

    const text = await runModule('phpbench-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a mailer fallback written both the old way and the new', async () => {
    const modern = appWith('fallback-new', {
      '.env': 'MAILER_DSN=failover(smtp://acme:hunter2@primary.example.com:587 smtp://backup.example.com:587 sendmail://default)\n',
      'config/packages/mailer.yaml': 'framework:\n    mailer:\n        dsn: "%env(MAILER_DSN)%"\n',
    });

    const legacy = appWith('fallback-old', {
      '.env': 'MAILER_DSN=failover+smtp://primary.example.com:587 smtp://backup.example.com:587\n',
      '.env.prod': 'MAILER_DSN=roundrobin(ses+api://ACCESS:SECRET@default mailgun+api://KEY:example.com@default)\n',
    });

    const single = appWith('fallback-single', {
      '.env': 'MAILER_DSN=smtp://acme:hunter2@smtp.example.com:25\n',
      '.env.local': 'MAILER_DSN=null://null\n',
    });

    const results = await Promise.all([
      runModule('symfony-mailer-smtp-fallback.js', modern),
      runModule('symfony-mailer-smtp-fallback.js', legacy),
      runModule('symfony-mailer-smtp-fallback.js', single),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('a repository whose queries sit in the middle', async () => {
    const app = appWith('middling-repository', {
      'src/Repository/MiddlingRepository.php': [
        '<?php',
        'namespace App\\Repository;',
        '',
        'use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;',
        '',
        'class MiddlingRepository extends ServiceEntityRepository',
        '{',
        '    public function recent(): array',
        '    {',
        '        return $this->createQueryBuilder("m")',
        '            ->where("m.createdAt > :from")',
        '            ->andWhere("m.status = :status")',
        '            ->orderBy("m.createdAt", "DESC")',
        '            ->getQuery()',
        '            ->getResult();',
        '    }',
        '',
        '    public function withRelations(): array',
        '    {',
        '        $rows = $this->createQueryBuilder("m")->getQuery()->getResult();',
        '        foreach ($rows as $row) {',
        '            $row->getCustomer()->getName();',
        '            $row->getLines()->count();',
        '        }',
        '',
        '        return $rows;',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Middling.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity(repositoryClass: \\App\\Repository\\MiddlingRepository::class)]',
        'class Middling',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('repository-analyzer.js', app, ['MiddlingRepository']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('templates printing raw content, one name at a time', async () => {
    const app = appWith('twig-raw', {
      'templates/comment/show.html.twig': [
        '<article>',
        '    {{ comment.body|raw }}',
        '    {{ user_input|raw }}',
        '    {{ description|raw }}',
        '    {{ page.title|raw }}',
        '    {{ safe_constant|raw }}',
        '</article>',
      ].join('\n') + '\n',
      'templates/page/render.html.twig': [
        '{{ include(template_from_string(unsafe_source)) }}',
        '{{ raw_html|raw }}',
      ].join('\n') + '\n',
      'src/Controller/CommentController.php': [
        '<?php',
        'namespace App\\Controller;',
        '',
        'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
        'use Symfony\\Component\\HttpFoundation\\Response;',
        '',
        'class CommentController extends AbstractController',
        '{',
        '    public function show(): Response',
        '    {',
        '        return $this->render("comment/show.html.twig", ["comment" => null]);',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('php-template-injection.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
