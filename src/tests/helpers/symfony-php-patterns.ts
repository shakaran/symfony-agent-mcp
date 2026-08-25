// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP written in the shapes the remaining analysers look for.
 *
 * These modules read source rather than configuration, and the fixtures had
 * none of what they search for: Gedmo tree and slug mappings, PHPUnit
 * exception expectations and custom assertions, repeated password fields,
 * serializer context builders, chained cache adapters, Sonata admin classes.
 * Each block was written from the literals the module itself searches for.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Gedmo tree and sluggable, in both attribute and annotation form. */
function gedmoTreeAndSlug(root: string): void {
  put(root, 'src/Entity/Category.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    'use Gedmo\\Mapping\\Annotation as Gedmo;',
    '',
    '/**',
    ' * @Gedmo\\Tree(type="nested")',
    ' * @ORM\\Entity(repositoryClass="App\\Repository\\CategoryRepository")',
    ' */',
    '#[Gedmo\\Tree(type: "nested")]',
    '#[ORM\\Entity]',
    'class Category',
    '{',
    '    /**',
    '     * @Gedmo\\TreeLeft',
    '     * @ORM\\Column(type="integer")',
    '     */',
    '    #[Gedmo\\TreeLeft]',
    '    private $lft;',
    '',
    '    /**',
    '     * @Gedmo\\TreeRight',
    '     */',
    '    #[Gedmo\\TreeRight]',
    '    private $rgt;',
    '',
    '    /**',
    '     * @Gedmo\\TreeLevel',
    '     */',
    '    #[Gedmo\\TreeLevel]',
    '    private $lvl;',
    '',
    '    /**',
    '     * @Gedmo\\TreeRoot',
    '     */',
    '    #[Gedmo\\TreeRoot]',
    '    private $root;',
    '',
    '    /**',
    '     * @Gedmo\\TreeParent',
    '     * @ORM\\ManyToOne(targetEntity="Category", inversedBy="children")',
    '     */',
    '    #[Gedmo\\TreeParent]',
    '    private $parent;',
    '',
    '    /**',
    '     * @Gedmo\\Slug(fields={"title"}, unique=true)',
    '     * @ORM\\Column(length=128, unique=true)',
    '     */',
    '    #[Gedmo\\Slug(fields: ["title"], unique: true)]',
    '    private $slug;',
    '',
    '    /**',
    '     * @Gedmo\\Slug(fields={"title"}, handlers={',
    '     *     @Gedmo\\SlugHandler(class="Gedmo\\Sluggable\\Handler\\TreeSlugHandler")',
    '     * })',
    '     */',
    '    private $path;',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Entity/Article.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Gedmo\\Mapping\\Annotation as Gedmo;',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[ORM\\Entity]',
    'class Article',
    '{',
    '    /**',
    '     * @Gedmo\\Slug(fields={"title"}, handlers={',
    '     *     @Gedmo\\SlugHandler(class="Gedmo\\Sluggable\\Handler\\RelativeSlugHandler", options={',
    '     *         @Gedmo\\SlugHandlerOption(name="relationField", value="category")',
    '     *     })',
    '     * })',
    '     * @ORM\\Column(length=128)',
    '     */',
    '    private $slug;',
    '',
    '    #[ORM\\Column(length: 255)]',
    '    private $title;',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/stof_doctrine_extensions.yaml', [
    'stof_doctrine_extensions:',
    '    default_locale: en',
    '    orm:',
    '        default:',
    '            tree: true',
    '            sluggable: true',
    '            timestampable: true',
    '            blameable: true',
    '            loggable: true',
  ].join('\n') + '\n');
}

/** PHPUnit: exception expectations, custom assertions, the old annotations. */
function phpunitPatterns(root: string): void {
  put(root, 'tests/Unit/ExceptionTest.php', [
    '<?php',
    'namespace App\\Tests\\Unit;',
    '',
    'use PHPUnit\\Framework\\TestCase;',
    'use PHPUnit\\Framework\\Assert;',
    '',
    'class ExceptionTest extends TestCase',
    '{',
    '    public function testModernExpectation(): void',
    '    {',
    '        $this->expectException(\\InvalidArgumentException::class);',
    '        $this->expectExceptionMessage("bad input");',
    '        $this->expectExceptionCode(400);',
    '        throw new \\InvalidArgumentException("bad input", 400);',
    '    }',
    '',
    '    /**',
    '     * @expectedException \\RuntimeException',
    '     * @expectedExceptionMessage boom',
    '     */',
    '    public function testLegacyAnnotation(): void',
    '    {',
    '        throw new \\RuntimeException("boom");',
    '    }',
    '',
    '    public function testTryCatchInsteadOfExpectation(): void',
    '    {',
    '        try {',
    '            throw new \\LogicException("x");',
    '            $this->fail("should not reach here");',
    '        } catch (\\LogicException $e) {',
    '            $this->assertSame("x", $e->getMessage());',
    '            Assert::assertEquals("x", $e->getMessage());',
    '        }',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'tests/Support/CustomAssertions.php', [
    '<?php',
    'namespace App\\Tests\\Support;',
    '',
    'use PHPUnit\\Framework\\Assert;',
    'use PHPUnit\\Framework\\Constraint\\Constraint;',
    '',
    '/**',
    ' * Assertions shared across the suite.',
    ' */',
    'trait CustomAssertions',
    '{',
    '    public function assertIsMoney($value, string $message = ""): void',
    '    {',
    '        $this->assertMatchesRegularExpression("/^\\\\d+\\\\.\\\\d{2}$/", (string) $value, $message);',
    '    }',
    '',
    '    public function assertThatOrderIsPaid($order): void',
    '    {',
    '        $this->assertThat($order->status, new IsPaidConstraint());',
    '    }',
    '',
    '    public function assertNever(): void',
    '    {',
    '        Assert::fail("this should not happen");',
    '    }',
    '}',
    '',
    'class IsPaidConstraint extends Constraint',
    '{',
    '    public function toString(): string { return "is paid"; }',
    '    protected function matches($other): bool { return $other === "paid"; }',
    '}',
  ].join('\n') + '\n');
}

/** Repeated password fields, and the comparison that should be constant time. */
function repeatedFields(root: string): void {
  put(root, 'src/Form/RegistrationType.php', [
    '<?php',
    'namespace App\\Form;',
    '',
    'use Symfony\\Component\\Form\\AbstractType;',
    'use Symfony\\Component\\Form\\Extension\\Core\\Type\\PasswordType;',
    'use Symfony\\Component\\Form\\Extension\\Core\\Type\\RepeatedType;',
    'use Symfony\\Component\\Form\\FormBuilderInterface;',
    '',
    'class RegistrationType extends AbstractType',
    '{',
    '    public function buildForm(FormBuilderInterface $builder, array $options): void',
    '    {',
    '        $builder->add("plainPassword", RepeatedType::class, [',
    '            "type" => PasswordType::class,',
    '            "invalid_message" => "The password fields must match.",',
    '            "first_options" => ["label" => "Password"],',
    '            "second_options" => ["label" => "Confirm password"],',
    '            "mapped" => false,',
    '        ]);',
    '',
    '        $builder->add("email", RepeatedType::class, [',
    '            "first_options" => ["label" => "Email"],',
    '            "second_options" => ["label" => "Confirm email"],',
    '        ]);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Service/TokenComparer.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class TokenComparer',
    '{',
    '    public function unsafe(string $a, string $b): bool',
    '    {',
    '        // Timing-sensitive comparison written with ===',
    '        return $a === $b;',
    '    }',
    '',
    '    public function safe(string $a, string $b): bool',
    '    {',
    '        return hash_equals($a, $b);',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Serializer context builders, chained caches, Sonata admin. */
function serializerCacheAdmin(root: string): void {
  put(root, 'src/Serializer/OrderContextBuilder.php', [
    '<?php',
    'namespace App\\Serializer;',
    '',
    'use ApiPlatform\\Serializer\\SerializerContextBuilderInterface;',
    'use Symfony\\Component\\HttpFoundation\\Request;',
    '',
    'class OrderContextBuilder implements SerializerContextBuilderInterface',
    '{',
    '    public function __construct(private SerializerContextBuilderInterface $decorated) {}',
    '',
    '    public function createFromRequest(Request $request, bool $normalization, ?array $extractedAttributes = null): array',
    '    {',
    '        $context = $this->decorated->createFromRequest($request, $normalization, $extractedAttributes);',
    '        $context["groups"][] = "order:admin";',
    '        return $context;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Serializer/ContextFactory.php', [
    '<?php',
    'namespace App\\Serializer;',
    '',
    'use Symfony\\Component\\Serializer\\Context\\Normalizer\\DateTimeNormalizerContextBuilder;',
    'use Symfony\\Component\\Serializer\\Context\\Normalizer\\ObjectNormalizerContextBuilder;',
    '',
    'class ContextFactory',
    '{',
    '    public function build(): array',
    '    {',
    '        $context = (new ObjectNormalizerContextBuilder())',
    '            ->withGroups(["order:read"])',
    '            ->withSkipNullValues(true)',
    '            ->toArray();',
    '',
    '        return (new DateTimeNormalizerContextBuilder())',
    '            ->withContext($context)',
    '            ->withFormat("Y-m-d")',
    '            ->toArray();',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Cache/ChainedCache.php', [
    '<?php',
    'namespace App\\Cache;',
    '',
    'use Symfony\\Component\\Cache\\Adapter\\ArrayAdapter;',
    'use Symfony\\Component\\Cache\\Adapter\\ChainAdapter;',
    'use Symfony\\Component\\Cache\\Adapter\\RedisAdapter;',
    'use Symfony\\Component\\Cache\\Adapter\\TagAwareAdapter;',
    '',
    'class ChainedCache',
    '{',
    '    public function build(): ChainAdapter',
    '    {',
    '        $chain = new ChainAdapter([new ArrayAdapter(), new RedisAdapter($this->redis)], 30);',
    '        $tagAware = new TagAwareAdapter($chain);',
    '        $tagAware->invalidateTags(["orders"]);',
    '        return $chain;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/cache_chain.yaml', [
    'framework:',
    '    cache:',
    '        pools:',
    '            app.cache.chained:',
    '                adapters: [cache.adapter.array, cache.adapter.redis]',
    '                tags: true',
    '            app.cache.tagged:',
    '                adapter: cache.app',
    '                tags: app.cache.tag_store',
  ].join('\n') + '\n');

  put(root, 'src/Admin/OrderAdmin.php', [
    '<?php',
    'namespace App\\Admin;',
    '',
    'use Sonata\\AdminBundle\\Admin\\AbstractAdmin;',
    'use Sonata\\AdminBundle\\Datagrid\\DatagridMapper;',
    'use Sonata\\AdminBundle\\Datagrid\\ListMapper;',
    'use Sonata\\AdminBundle\\Form\\FormMapper;',
    '',
    'class OrderAdmin extends AbstractAdmin',
    '{',
    '    protected function configureDatagridFilters(DatagridMapper $filter): void',
    '    {',
    '        $filter->add("reference")->add("status");',
    '    }',
    '',
    '    protected function configureListFields(ListMapper $list): void',
    '    {',
    '        $list->addIdentifier("reference")->add("status")->add("total");',
    '    }',
    '',
    '    protected function configureFormFields(FormMapper $form): void',
    '    {',
    '        $form->add("reference")->add("status");',
    '    }',
    '',
    '    protected function configureBatchActions(array $actions): array',
    '    {',
    '        $actions["export"] = ["ask_confirmation" => true];',
    '        return $actions;',
    '    }',
    '',
    '    protected function configureExportFields(): array { return ["reference", "total"]; }',
    '    protected function configureDefaultSortValues(array &$sortValues): void',
    '    {',
    '        $sortValues["_sort_by"] = "createdAt";',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Null-coalescing and the older shapes it replaces. */
function nullCoalescing(root: string): void {
  put(root, 'src/Service/Defaults.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class Defaults',
    '{',
    '    public function modern(array $options): array',
    '    {',
    '        $timeout = $options["timeout"] ?? 30;',
    '        $retries = $options["retries"] ?? null;',
    '        $options["locale"] ??= "en";',
    '        $name = $this->config?->getName() ?? "unnamed";',
    '        return [$timeout, $retries, $name, $options];',
    '    }',
    '',
    '    public function legacy(array $options): array',
    '    {',
    '        // The shapes ?? replaces, still common in older code',
    '        $timeout = isset($options["timeout"]) ? $options["timeout"] : 30;',
    '        $retries = array_key_exists("retries", $options) ? $options["retries"] : null;',
    '        $locale = empty($options["locale"]) ? "en" : $options["locale"];',
    '        $name = isset($this->config) && $this->config->getName() ? $this->config->getName() : "unnamed";',
    '        return [$timeout, $retries, $locale, $name];',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** nelmio/security-bundle and pgbouncer. */
function securityBundleAndPgbouncer(root: string): void {
  put(root, 'config/packages/nelmio_security.yaml', [
    'nelmio_security:',
    '    signed_cookie:',
    '        names: ["*"]',
    '    clickjacking:',
    '        paths:',
    '            "^/.*": DENY',
    '    content_type:',
    '        nosniff: true',
    '    xss_protection:',
    '        enabled: true',
    '        mode_block: true',
    '    forced_ssl:',
    '        enabled: false',
    '        hsts_max_age: 31536000',
    '        hsts_subdomains: true',
    '    csp:',
    '        enabled: true',
    '        report_logger_service: logger',
    '        enforce:',
    '            default-src: ["\'self\'"]',
    '            script-src: ["\'self\'", "\'unsafe-inline\'"]',
    '            img-src: ["\'self\'", "data:"]',
  ].join('\n') + '\n');

  put(root, 'docker/pgbouncer/pgbouncer.ini', [
    '[databases]',
    'app = host=postgres port=5432 dbname=app',
    '',
    '[pgbouncer]',
    'listen_addr = 0.0.0.0',
    'listen_port = 6432',
    'auth_type = scram-sha-256',
    'pool_mode = transaction',
    'max_client_conn = 200',
    'default_pool_size = 20',
    'server_reset_query = DISCARD ALL',
  ].join('\n') + '\n');

  put(root, '.env.pgbouncer', 'DATABASE_URL="postgresql://app@pgbouncer:6432/app?serverVersion=16"\n');
}

/** Everything in this file. */
export function addPhpPatterns(root: string): void {
  gedmoTreeAndSlug(root);
  phpunitPatterns(root);
  repeatedFields(root);
  serializerCacheAdmin(root);
  nullCoalescing(root);
  securityBundleAndPgbouncer(root);
}
