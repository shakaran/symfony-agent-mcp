// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Attributes and configuration carrying nested arrays.
 *
 * Seventeen analysers matched an option block with `[^\]]`, which cannot hold
 * a closing bracket, so nested arrays made them silent. With that fixed they
 * need something nested to read — and nested is the ordinary shape here:
 * route requirements, discriminator maps, cascade options, serializer groups,
 * importmap entries, group sequences.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** API Platform resources with nested operation and context arrays. */
function apiPlatformNested(root: string): void {
  put(root, 'src/ApiResource/Invoice.php', [
    '<?php',
    'namespace App\\ApiResource;',
    '',
    'use ApiPlatform\\Metadata\\ApiResource;',
    'use ApiPlatform\\Metadata\\Get;',
    'use ApiPlatform\\Metadata\\GetCollection;',
    'use ApiPlatform\\Metadata\\Patch;',
    'use Symfony\\Component\\Serializer\\Attribute\\Groups;',
    'use Symfony\\Component\\Validator\\Constraints as Assert;',
    '',
    '#[ApiResource(',
    '    operations: [',
    '        new Get(normalizationContext: ["groups" => ["invoice:read", "invoice:detail"]]),',
    '        new GetCollection(paginationItemsPerPage: 25),',
    '        new Patch(denormalizationContext: ["groups" => ["invoice:write"]]),',
    '    ],',
    '    normalizationContext: ["groups" => ["invoice:read"], "enable_max_depth" => true],',
    '    denormalizationContext: ["groups" => ["invoice:write"], "disable_type_enforcement" => false],',
    '    validationContext: ["groups" => ["Default", "invoice:create"]],',
    '    extraProperties: ["standard_put" => true],',
    ')]',
    'class Invoice',
    '{',
    '    #[Groups(["invoice:read", "invoice:detail"])]',
    '    #[Assert\\NotBlank(groups: ["invoice:create", "Default"])]',
    '    public string $reference = "";',
    '',
    '    #[Groups(["invoice:read"])]',
    '    #[Assert\\Collection(fields: ["street" => new Assert\\NotBlank(), "city" => new Assert\\NotBlank()])]',
    '    public array $address = [];',
    '}',
  ].join('\n') + '\n');
}

/** Doctrine cascade, discriminator maps and entity listeners, all nested. */
function doctrineNested(root: string): void {
  put(root, 'src/Entity/Payment.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[ORM\\Entity]',
    '#[ORM\\InheritanceType("SINGLE_TABLE")]',
    '#[ORM\\DiscriminatorColumn(name: "kind", type: "string")]',
    '#[ORM\\DiscriminatorMap(["card" => CardPayment::class, "transfer" => TransferPayment::class, "cash" => CashPayment::class])]',
    '#[ORM\\EntityListeners([\\App\\EventListener\\PaymentListener::class, \\App\\EventListener\\AuditListener::class])]',
    'abstract class Payment',
    '{',
    '    #[ORM\\Id]',
    '    #[ORM\\Column]',
    '    private ?int $id = null;',
    '',
    '    #[ORM\\OneToMany(',
    '        targetEntity: PaymentLine::class,',
    '        mappedBy: "payment",',
    '        cascade: ["persist", "remove", "detach"],',
    '        orphanRemoval: true,',
    '    )]',
    '    private $lines;',
    '',
    '    #[ORM\\ManyToMany(targetEntity: Tag::class, cascade: ["persist"])]',
    '    #[ORM\\JoinTable(name: "payment_tag", joinColumns: [], inverseJoinColumns: [])]',
    '    private $tags;',
    '}',
    '',
    '#[ORM\\Entity]',
    'class CardPayment extends Payment {}',
    '#[ORM\\Entity]',
    'class TransferPayment extends Payment {}',
    '#[ORM\\Entity]',
    'class CashPayment extends Payment {}',
  ].join('\n') + '\n');

  put(root, 'src/EventListener/PaymentListener.php', [
    '<?php',
    'namespace App\\EventListener;',
    '',
    'use Doctrine\\ORM\\Events;',
    'use Doctrine\\Bundle\\DoctrineBundle\\Attribute\\AsEntityListener;',
    '',
    '#[AsEntityListener(event: Events::prePersist, entity: \\App\\Entity\\Payment::class)]',
    '#[AsEntityListener(event: Events::postUpdate, entity: \\App\\Entity\\Payment::class)]',
    'class PaymentListener',
    '{',
    '    public function prePersist($payment, $args): void {}',
    '    public function postUpdate($payment, $args): void {}',
    '}',
  ].join('\n') + '\n');
}

/** Routes with requirements and defaults, both nested arrays. */
function routingNested(root: string): void {
  put(root, 'src/Controller/CatalogController.php', [
    '<?php',
    'namespace App\\Controller;',
    '',
    'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
    'use Symfony\\Component\\HttpFoundation\\Response;',
    'use Symfony\\Component\\Routing\\Attribute\\Route;',
    '',
    '#[Route("/catalog", requirements: ["_locale" => "en|es|fr"], defaults: ["_locale" => "en"])]',
    'class CatalogController extends AbstractController',
    '{',
    '    #[Route(',
    '        "/{id}/{slug}",',
    '        name: "catalog_show",',
    '        requirements: ["id" => "\\d+", "slug" => "[a-z0-9-]+"],',
    '        defaults: ["slug" => "", "_format" => "html"],',
    '        methods: ["GET", "HEAD"],',
    '        options: ["expose" => true],',
    '    )]',
    '    public function show(int $id): Response { return new Response((string) $id); }',
    '',
    '    #[Route("/search", name: "catalog_search", condition: "request.headers.get(\'Accept\') matches \'/json/\'")]',
    '    public function search(): Response { return new Response("[]"); }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/routes/catalog.yaml', [
    'catalog_legacy:',
    '    path: /legacy/{id}',
    '    controller: App\\Controller\\CatalogController::show',
    '    requirements:',
    '        id: "\\d+"',
    '    defaults:',
    '        _format: json',
    '    methods: [GET, POST]',
  ].join('\n') + '\n');
}

/** Access tokens, group sequences, unique entities, serializer discriminators. */
function securityAndValidationNested(root: string): void {
  put(root, 'config/packages/security_access_token.yaml', [
    'security:',
    '    firewalls:',
    '        api:',
    '            pattern: ^/api',
    '            stateless: true',
    '            access_token:',
    '                token_handler:',
    '                    oidc:',
    '                        claim: sub',
    '                        audience: acme',
    '                        issuers: ["https://idp.example.com"]',
    '                        algorithms: ["RS256", "ES256"]',
    '                token_extractors:',
    '                    - header',
    '                    - query_string',
    '                realm: api',
  ].join('\n') + '\n');

  put(root, 'src/Entity/Subscription.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    'use Symfony\\Bridge\\Doctrine\\Validator\\Constraints\\UniqueEntity;',
    'use Symfony\\Component\\Validator\\Constraints as Assert;',
    'use Symfony\\Component\\Validator\\GroupSequenceProviderInterface;',
    '',
    '#[ORM\\Entity]',
    '#[UniqueEntity(fields: ["customer", "plan"], errorPath: "plan", message: "Already subscribed")]',
    '#[UniqueEntity(fields: ["externalId"], repositoryMethod: "findByExternal")]',
    '#[Assert\\GroupSequence(["Subscription", "Strict"])]',
    'class Subscription implements GroupSequenceProviderInterface',
    '{',
    '    #[Assert\\NotBlank(groups: ["Strict"])]',
    '    public string $externalId = "";',
    '',
    '    public function getGroupSequence(): array',
    '    {',
    '        return [["Subscription"], ["Strict", "Payment"]];',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Dto/Shape.php', [
    '<?php',
    'namespace App\\Dto;',
    '',
    'use Symfony\\Component\\Serializer\\Attribute\\DiscriminatorMap;',
    '',
    '#[DiscriminatorMap(typeProperty: "type", mapping: ["circle" => Circle::class, "square" => Square::class])]',
    'abstract class Shape {}',
    '',
    'class Circle extends Shape { public float $radius = 0; }',
    'class Square extends Shape { public float $side = 0; }',
  ].join('\n') + '\n');
}

/** Importmap, Vite, Rector rules and array unpacking. */
function assetAndToolingNested(root: string): void {
  put(root, 'importmap.php', [
    '<?php',
    '',
    'return [',
    '    "app" => ["path" => "./assets/app.js", "entrypoint" => true],',
    '    "@hotwired/stimulus" => ["version" => "3.2.2"],',
    '    "@symfony/stimulus-bundle" => ["path" => "./vendor/symfony/stimulus-bundle/assets/dist/loader.js"],',
    '    "bootstrap/dist/css/bootstrap.min.css" => ["version" => "5.3.3", "type" => "css"],',
    '    "chart.js" => ["version" => "4.4.0", "preload" => true],',
    '];',
  ].join('\n') + '\n');

  put(root, 'vite.config.js', [
    "import { defineConfig } from 'vite';",
    "import symfonyPlugin from 'vite-plugin-symfony';",
    '',
    'export default defineConfig({',
    '    plugins: [symfonyPlugin({ refresh: ["templates/**/*.twig"] })],',
    '    build: {',
    '        rollupOptions: {',
    "            input: { app: './assets/app.js', admin: './assets/admin.js' },",
    '            output: { manualChunks: { vendor: ["chart.js"] } },',
    '        },',
    '        outDir: "public/build",',
    '    },',
    '    server: { host: "0.0.0.0", port: 5173, watch: { usePolling: true } },',
    '});',
  ].join('\n') + '\n');

  put(root, 'src/Rector/CustomRule.php', [
    '<?php',
    'namespace App\\Rector;',
    '',
    'use PhpParser\\Node;',
    'use Rector\\Rector\\AbstractRector;',
    'use Symplify\\RuleDocGenerator\\ValueObject\\CodeSample\\CodeSample;',
    'use Symplify\\RuleDocGenerator\\ValueObject\\RuleDefinition;',
    '',
    'final class CustomRule extends AbstractRector',
    '{',
    '    public function getNodeTypes(): array',
    '    {',
    '        return [Node\\Expr\\MethodCall::class, Node\\Expr\\StaticCall::class];',
    '    }',
    '',
    '    public function refactor(Node $node): ?Node { return null; }',
    '',
    '    public function getRuleDefinition(): RuleDefinition',
    '    {',
    '        return new RuleDefinition("Replace deprecated call", [new CodeSample("old();", "new();")]);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Service/Unpacking.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class Unpacking',
    '{',
    '    public function build(array $base, array $extra): array',
    '    {',
    '        return [...$base, ...$extra, "flags" => [...($base["flags"] ?? []), "new"]];',
    '    }',
    '',
    '    public function nested(): array',
    '    {',
    '        return ["a" => ["b" => ["c" => [1, 2, 3]]], "d" => [...[4, 5], 6]];',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Everything in this file. */
export function addNestedArrays(root: string): void {
  apiPlatformNested(root);
  doctrineNested(root);
  routingNested(root);
  securityAndValidationNested(root);
  assetAndToolingNested(root);
}
