// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * A twelfth batch: the classes the configuration already named.
 *
 * Several modules read a service or routing entry and then go looking for
 * the class behind it — a lazy service, a routed message, a decorated
 * inner service. The configuration was there and the classes were not, so
 * the second half of each of those modules never ran.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function lazyServices(root: string): void {
  put(root, 'src/Service/HeavyReportBuilder.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Doctrine\\ORM\\EntityManagerInterface;',
    'use Psr\\Log\\LoggerInterface;',
    'use Symfony\\Component\\HttpClient\\HttpClient;',
    'use Symfony\\Contracts\\Cache\\CacheInterface;',
    'use Symfony\\Contracts\\HttpClient\\HttpClientInterface;',
    '',
    'class HeavyReportBuilder implements ReportBuilderInterface',
    '{',
    '    public function __construct(',
    '        private EntityManagerInterface $entityManager,',
    '        private CacheInterface $cache,',
    '        private LoggerInterface $logger,',
    '        private HttpClientInterface $httpClient,',
    '        private string $reportDir,',
    '        private int $retention = 90,',
    '    ) {',
    '        $this->warmUp();',
    '    }',
    '',
    '    public function build(string $kind): string',
    '    {',
    '        return $this->reportDir . "/" . $kind . ".csv";',
    '    }',
    '',
    '    private function warmUp(): void',
    '    {',
    '        $this->cache->get("report.warm", static fn (): bool => true);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Service/ReportBuilderInterface.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'interface ReportBuilderInterface',
    '{',
    '    public function build(string $kind): string;',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Service/LazyGhostCandidate.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'final class LazyGhostCandidate implements ReportBuilderInterface',
    '{',
    '    public function __construct(private string $reportDir) {}',
    '',
    '    public function build(string $kind): string',
    '    {',
    '        return $this->reportDir . "/" . $kind . ".pdf";',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Service/EagerButHeavy.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Doctrine\\ORM\\EntityManagerInterface;',
    '',
    'class EagerButHeavy',
    '{',
    '    private array $preloaded = [];',
    '',
    '    public function __construct(private EntityManagerInterface $entityManager)',
    '    {',
    '        $this->preloaded = $entityManager->getRepository(\\App\\Entity\\Product::class)->findAll();',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Service/ProxiedService.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class ProxiedService implements ReportBuilderInterface',
    '{',
    '    public function build(string $kind): string { return $kind; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Service/ApiClient.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Symfony\\Contracts\\HttpClient\\HttpClientInterface;',
    '',
    'class ApiClient',
    '{',
    '    public function __construct(',
    '        private HttpClientInterface $client,',
    '        private string $baseUrl,',
    '        private string $token,',
    '        private int $timeout = 10,',
    '    ) {}',
    '',
    '    public function get(string $path): array',
    '    {',
    '        return $this->client->request("GET", $this->baseUrl . $path, [',
    '            "auth_bearer" => $this->token,',
    '            "timeout" => $this->timeout,',
    '        ])->toArray();',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Cache/MetricsCacheDecorator.php', [
    '<?php',
    'namespace App\\Cache;',
    '',
    'use Psr\\Cache\\CacheItemPoolInterface;',
    '',
    'class MetricsCacheDecorator implements CacheItemPoolInterface',
    '{',
    '    public function __construct(private CacheItemPoolInterface $inner) {}',
    '',
    '    public function getItem($key): mixed { return $this->inner->getItem($key); }',
    '    public function getItems(array $keys = []): iterable { return $this->inner->getItems($keys); }',
    '    public function hasItem($key): bool { return $this->inner->hasItem($key); }',
    '    public function clear(): bool { return $this->inner->clear(); }',
    '    public function deleteItem($key): bool { return $this->inner->deleteItem($key); }',
    '    public function deleteItems(array $keys): bool { return $this->inner->deleteItems($keys); }',
    '    public function save($item): bool { return $this->inner->save($item); }',
    '    public function saveDeferred($item): bool { return $this->inner->saveDeferred($item); }',
    '    public function commit(): bool { return $this->inner->commit(); }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Mailer/ThrottlingMailerDecorator.php', [
    '<?php',
    'namespace App\\Mailer;',
    '',
    'use Symfony\\Component\\Mailer\\MailerInterface;',
    'use Symfony\\Component\\Mime\\RawMessage;',
    'use Symfony\\Component\\Mailer\\Envelope;',
    'use Symfony\\Component\\RateLimiter\\LimiterInterface;',
    '',
    'class ThrottlingMailerDecorator implements MailerInterface',
    '{',
    '    public function __construct(private MailerInterface $inner, private LimiterInterface $limiter) {}',
    '',
    '    public function send(RawMessage $message, ?Envelope $envelope = null): void',
    '    {',
    '        $this->limiter->consume()->ensureAccepted();',
    '        $this->inner->send($message, $envelope);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Serializer/TracingNormalizerDecorator.php', [
    '<?php',
    'namespace App\\Serializer;',
    '',
    'use Symfony\\Component\\Serializer\\Normalizer\\NormalizerInterface;',
    '',
    'class TracingNormalizerDecorator implements NormalizerInterface',
    '{',
    '    public function __construct(private NormalizerInterface $inner) {}',
    '',
    '    public function normalize($object, ?string $format = null, array $context = []): mixed',
    '    {',
    '        return $this->inner->normalize($object, $format, $context);',
    '    }',
    '',
    '    public function supportsNormalization($data, ?string $format = null, array $context = []): bool',
    '    {',
    '        return $this->inner->supportsNormalization($data, $format, $context);',
    '    }',
    '',
    '    public function getSupportedTypes(?string $format): array { return ["*" => true]; }',
    '}',
  ].join('\n') + '\n');
}

function routedMessages(root: string): void {
  for (const [name, handled] of [['RebuildIndex', true], ['AuditTrail', true], ['Unrouted', false]] as const) {
    put(root, `src/Message/${name}.php`, [
      '<?php',
      'namespace App\\Message;',
      '',
      `final class ${name}`,
      '{',
      '    public function __construct(public readonly string $reference = "") {}',
      '}',
    ].join('\n') + '\n');

    if (!handled) continue;
    put(root, `src/MessageHandler/${name}Handler.php`, [
      '<?php',
      'namespace App\\MessageHandler;',
      '',
      `use App\\Message\\${name};`,
      'use Symfony\\Component\\Messenger\\Attribute\\AsMessageHandler;',
      '',
      '#[AsMessageHandler]',
      `final class ${name}Handler`,
      '{',
      `    public function __invoke(${name} $message): void`,
      '    {',
      '    }',
      '}',
    ].join('\n') + '\n');
  }

  put(root, 'src/Entity/Product.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[ORM\\Entity]',
    '#[ORM\\Table(name: "product")]',
    '#[ORM\\Index(name: "idx_product_sku", columns: ["sku"])]',
    'class Product',
    '{',
    '    #[ORM\\Id]',
    '    #[ORM\\GeneratedValue]',
    '    #[ORM\\Column]',
    '    private ?int $id = null;',
    '',
    '    #[ORM\\Column(length: 64, unique: true)]',
    '    private string $sku = "";',
    '',
    '    #[ORM\\Column(type: "decimal", precision: 10, scale: 2)]',
    '    private string $price = "0.00";',
    '',
    '    #[ORM\\ManyToOne(targetEntity: Customer::class)]',
    '    #[ORM\\JoinColumn(nullable: true, onDelete: "SET NULL")]',
    '    private ?Customer $owner = null;',
    '}',
  ].join('\n') + '\n');
}

/** Everything in this file. */
export function addBatchTwelve(root: string): void {
  lazyServices(root);
  routedMessages(root);
}
