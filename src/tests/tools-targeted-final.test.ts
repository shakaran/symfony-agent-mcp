// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The last of the applications written for one module: workflows at the
 * indentation their recipe uses, form themes of each family, voters whose
 * attributes are written four different ways, subscribers whose methods
 * have bodies, and the server's own cache.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-final-'));
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

describe('the last of them', () => {
  test('a parallel workflow written at the indentation the recipe uses', async () => {
    const app = appWith('workflow-recipe-indent', {
      'config/packages/workflow.yaml': [
        'framework:',
        '  workflows:',
        '    publication:',
        '      type: workflow',
        '      audit_trail:',
        '        enabled: true',
        '      marking_store:',
        '        type: method',
        '        property: marking',
        '      supports:',
        '        - App\\Entity\\Post',
        '      initial_marking: draft',
        '      places:',
        '        - draft',
        '        - legal_review',
        '        - copy_review',
        '        - approved',
        '        - published',
        '      transitions:',
        '        submit:',
        '          from: draft',
        '          to: [legal_review, copy_review]',
        '        approve_legal:',
        '          from: legal_review',
        '          to: approved_legal',
        '        approve_copy:',
        '          from: copy_review',
        '          to: approved_copy',
        '        publish:',
        '          from: [approved_legal, approved_copy]',
        '          to: published',
        '          guard: "is_granted(\'ROLE_EDITOR\')"',
      ].join('\n') + '\n',
      'src/Entity/Post.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'class Post',
        '{',
        '    private array $marking = [];',
        '',
        '    public function getMarking(): array { return $this->marking; }',
        '    public function setMarking(array $marking, array $context = []): void { $this->marking = $marking; }',
        '}',
      ].join('\n') + '\n',
      'src/Service/Reviewer.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Symfony\\Component\\Workflow\\WorkflowInterface;',
        '',
        'class Reviewer',
        '{',
        '    public function __construct(private WorkflowInterface $publicationWorkflow) {}',
        '',
        '    public function review(object $post): void',
        '    {',
        '        $marking = $this->publicationWorkflow->getMarking($post);',
        '        foreach ($marking->getPlaces() as $place => $count) { }',
        '        if ($marking->has("legal_review")) { }',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-workflow-parallel-transitions.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('form themes of each family, and a custom one on its own', async () => {
    const app = appWith('form-themes', {
      'config/packages/twig.yaml': [
        'twig:',
        '    form_themes:',
        '        - "tailwind_2_layout.html.twig"',
        '        - "form/custom_theme.html.twig"',
        '        - "form/orphan_theme.html.twig"',
      ].join('\n') + '\n',
      'config/packages/framework.yaml': [
        'framework:',
        '    form:',
        '        legacy_error_messages: false',
        '',
        'twig:',
        '    form_themes: ["foundation_6_layout.html.twig"]',
      ].join('\n') + '\n',
      'templates/form/custom_theme.html.twig': [
        '{% use "bootstrap_5_layout.html.twig" %}',
        '',
        '{% block form_row %}',
        '    <div class="row">{{ form_label(form) }}{{ form_widget(form) }}</div>',
        '{% endblock %}',
      ].join('\n') + '\n',
      'templates/form/orphan_theme.html.twig': [
        '{% block form_row %}',
        '    <div>{{ form_widget(form) }}</div>',
        '{% endblock %}',
      ].join('\n') + '\n',
      'templates/order/new.html.twig': [
        '{% form_theme form "form/custom_theme.html.twig" %}',
        '{% form_theme form.lines "tailwind_2_layout.html.twig" %}',
        '',
        '{{ form_start(form) }}{{ form_end(form) }}',
      ].join('\n') + '\n',
      'templates/order/edit.html.twig': [
        '{% form_theme form "form/custom_theme.html.twig" %}',
        '',
        '{{ form(form) }}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-form-themes.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('voters whose attributes are written four different ways', async () => {
    const app = appWith('voter-attributes', {
      'src/Security/Voter/ArrayVoter.php': [
        '<?php',
        'namespace App\\Security\\Voter;',
        '',
        'use Symfony\\Component\\Security\\Core\\Authentication\\Token\\TokenInterface;',
        'use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;',
        '',
        'class ArrayVoter extends Voter',
        '{',
        '    protected function supports(string $attribute, mixed $subject): bool',
        '    {',
        '        return in_array($attribute, ["POST_VIEW", "POST_EDIT", "POST_DELETE"], true);',
        '    }',
        '',
        '    protected function voteOnAttribute(string $attribute, mixed $subject, TokenInterface $token): bool',
        '    {',
        '        return false;',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Security/Voter/SingleVoter.php': [
        '<?php',
        'namespace App\\Security\\Voter;',
        '',
        'use Symfony\\Component\\Security\\Core\\Authentication\\Token\\TokenInterface;',
        'use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;',
        '',
        'class SingleVoter extends Voter',
        '{',
        '    protected function supports(string $attribute, mixed $subject): bool',
        '    {',
        '        return $attribute === "INVOICE_DOWNLOAD";',
        '    }',
        '',
        '    protected function voteOnAttribute(string $attribute, mixed $subject, TokenInterface $token): bool',
        '    {',
        '        return true;',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Security/Voter/ConstantVoter.php': [
        '<?php',
        'namespace App\\Security\\Voter;',
        '',
        'use Symfony\\Component\\Security\\Core\\Authentication\\Token\\TokenInterface;',
        'use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;',
        '',
        'class ConstantVoter extends Voter',
        '{',
        '    public const VIEW = "ORDER_VIEW";',
        '    public const EDIT = "ORDER_EDIT";',
        '    private const ATTRIBUTES = [self::VIEW, self::EDIT];',
        '',
        '    protected function supports(string $attribute, mixed $subject): bool',
        '    {',
        '        return in_array($attribute, self::ATTRIBUTES, true);',
        '    }',
        '',
        '    protected function voteOnAttribute(string $attribute, mixed $subject, TokenInterface $token): bool',
        '    {',
        '        return match ($attribute) {',
        '            self::VIEW => true,',
        '            self::EDIT => false,',
        '            default => false,',
        '        };',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Security/Voter/MatchVoter.php': [
        '<?php',
        'namespace App\\Security\\Voter;',
        '',
        'use Symfony\\Component\\Security\\Core\\Authentication\\Token\\TokenInterface;',
        'use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;',
        '',
        'class MatchVoter extends Voter',
        '{',
        '    protected function supports(string $attribute, mixed $subject): bool',
        '    {',
        '        return match ($attribute) {',
        '            "COMMENT_EDIT", "COMMENT_DELETE" => true,',
        '            default => false,',
        '        };',
        '    }',
        '',
        '    protected function voteOnAttribute(string $attribute, mixed $subject, TokenInterface $token): bool',
        '    {',
        '        return $token->getUser() !== null;',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-security-custom-voter.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('subscribers whose listener methods have bodies to read', async () => {
    const app = appWith('subscriber-bodies', {
      'src/EventSubscriber/AuditSubscriber.php': [
        '<?php',
        'namespace App\\EventSubscriber;',
        '',
        'use Doctrine\\Bundle\\DoctrineBundle\\EventSubscriber\\EventSubscriberInterface;',
        'use Doctrine\\ORM\\Event\\OnFlushEventArgs;',
        'use Doctrine\\ORM\\Event\\PostPersistEventArgs;',
        'use Doctrine\\ORM\\Events;',
        '',
        'class AuditSubscriber implements EventSubscriberInterface',
        '{',
        '    public function getSubscribedEvents(): array',
        '    {',
        '        return [',
        '            Events::onFlush,',
        '            Events::postPersist,',
        '            Events::postUpdate,',
        '            "preRemove",',
        '        ];',
        '    }',
        '',
        '    public function onFlush(OnFlushEventArgs $args): void',
        '    {',
        '        $manager = $args->getObjectManager();',
        '        $unitOfWork = $manager->getUnitOfWork();',
        '        foreach ($unitOfWork->getScheduledEntityInsertions() as $entity) {',
        '            $manager->persist($entity);',
        '        }',
        '        $manager->flush();',
        '    }',
        '',
        '    public function postPersist(PostPersistEventArgs $args): void',
        '    {',
        '        $args->getObjectManager()->getRepository(\\App\\Entity\\Order::class)->findAll();',
        '    }',
        '',
        '    public function postUpdate($args): void',
        '    {',
        '    }',
        '',
        '    public function preRemove($args): void',
        '    {',
        '        $args->getObjectManager()->getConnection()->getDatabasePlatform();',
        '    }',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('doctrine-event-subscribers.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('the server cache, and a pool measured in gigabytes', async () => {
    const dir = path.join(root, 'huge-cache');
    fs.mkdirSync(path.join(dir, 'var', 'cache', 'prod', 'pools', 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } }));
    fs.writeFileSync(path.join(dir, 'config', 'packages', 'cache.yaml').replace(/config.*/, 'placeholder'), '');
    fs.mkdirSync(path.join(dir, 'config', 'packages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'packages', 'cache.yaml'), 'framework:\n    cache:\n        app: cache.adapter.filesystem\n');

    // A sparse file: a gigabyte of length, none of it written.
    const entry = path.join(dir, 'var', 'cache', 'prod', 'pools', 'app', 'huge.php');
    const handle = fs.openSync(entry, 'w');
    fs.ftruncateSync(handle, 2 * 1024 * 1024 * 1024);
    fs.closeSync(handle);

    const text = await runModule('cache-inspector.js', dir, ['prod']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('bundles enabled per environment, and a kernel with two compiler passes', async () => {
    const app = appWith('kernel-envs', {
      'config/bundles.php': [
        '<?php',
        '',
        'return [',
        '    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ["all" => true],',
        '    Symfony\\Bundle\\WebProfilerBundle\\WebProfilerBundle::class => ["dev" => true, "test" => true],',
        '    Symfony\\Bundle\\MakerBundle\\MakerBundle::class => ["dev" => true],',
        '    Symfony\\Bundle\\DebugBundle\\DebugBundle::class => ["dev" => true],',
        '    Doctrine\\Bundle\\FixturesBundle\\DoctrineFixturesBundle::class => ["dev" => true, "test" => true],',
        '    Sentry\\SentryBundle\\SentryBundle::class => ["prod" => true],',
        '];',
      ].join('\n') + '\n',
      'src/Kernel.php': [
        '<?php',
        'namespace App;',
        '',
        'use App\\DependencyInjection\\Compiler\\FirstPass;',
        'use App\\DependencyInjection\\Compiler\\SecondPass;',
        'use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;',
        'use Symfony\\Component\\DependencyInjection\\ContainerBuilder;',
        'use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;',
        '',
        'class Kernel extends BaseKernel',
        '{',
        '    use MicroKernelTrait;',
        '',
        '    protected function build(ContainerBuilder $container): void',
        '    {',
        '        $container->addCompilerPass(new FirstPass());',
        '        $container->addCompilerPass(new SecondPass());',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/DependencyInjection/Compiler/FirstPass.php': [
        '<?php',
        'namespace App\\DependencyInjection\\Compiler;',
        '',
        'use Symfony\\Component\\DependencyInjection\\Compiler\\CompilerPassInterface;',
        'use Symfony\\Component\\DependencyInjection\\ContainerBuilder;',
        '',
        'class FirstPass implements CompilerPassInterface',
        '{',
        '    public function process(ContainerBuilder $container): void { }',
        '}',
      ].join('\n') + '\n',
      'src/DependencyInjection/Compiler/SecondPass.php': [
        '<?php',
        'namespace App\\DependencyInjection\\Compiler;',
        '',
        'use Symfony\\Component\\DependencyInjection\\Compiler\\CompilerPassInterface;',
        'use Symfony\\Component\\DependencyInjection\\ContainerBuilder;',
        '',
        'class SecondPass implements CompilerPassInterface',
        '{',
        '    public function process(ContainerBuilder $container): void { }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('kernel-analysis.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a template built from a request three lines above the render', async () => {
    const app = appWith('template-context', {
      'src/Controller/PreviewController.php': [
        '<?php',
        'namespace App\\Controller;',
        '',
        'use Symfony\\Component\\HttpFoundation\\Request;',
        'use Symfony\\Component\\HttpFoundation\\Response;',
        'use Twig\\Environment;',
        '',
        'class PreviewController',
        '{',
        '    public function __construct(private Environment $twig) {}',
        '',
        '    public function preview(Request $request): Response',
        '    {',
        '        $source = $request->query->get("source");',
        '        $trimmed = trim($source);',
        '        $prepared = $trimmed;',
        '',
        '        return new Response($this->twig->createTemplate($prepared)->render([]));',
        '    }',
        '',
        '    public function fromPost(Request $request): Response',
        '    {',
        '        $body = $request->request->get("body");',
        '',
        '        return new Response($this->twig->createTemplate($body)->render([]));',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('php-template-injection.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('property hooks with a block after an expression', async () => {
    const app = appWith('hooks-block', {
      'src/Domain/Account.php': [
        '<?php',
        'namespace App\\Domain;',
        '',
        'class Account',
        '{',
        '    private float $balanceValue = 0.0;',
        '',
        '    public float $balance {',
        '        get {',
        '            return $this->balanceValue;',
        '        }',
        '        set {',
        '            $this->balanceValue = $value;',
        '        }',
        '    }',
        '',
        '    public string $iban {',
        '        set (string $value) {',
        '            if (strlen($value) < 15) {',
        '                throw new \\InvalidArgumentException("too short");',
        '            }',
        '            $this->ibanValue = $value;',
        '        }',
        '        get {',
        '            $a = 1;',
        '            $b = 2;',
        '            $c = 3;',
        '            $d = 4;',
        '            $e = 5;',
        '            $f = 6;',
        '            $g = 7;',
        '            return $this->ibanValue;',
        '        }',
        '    }',
        '',
        '    private string $ibanValue = "";',
        '',
        '    public readonly string $reference {',
        '        get => $this->ibanValue;',
        '    }',
        '',
        '    public int $recursive {',
        '        get {',
        '            return $this->recursive;',
        '        }',
        '    }',
        '',
        '    public int $noReturn {',
        '        get {',
        '            $x = 1;',
        '        }',
        '    }',
        '',
        '    public int $noField {',
        '        set {',
        '            $this->somethingElse = $value;',
        '        }',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('php-property-hooks.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
