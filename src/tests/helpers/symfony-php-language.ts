// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP language features and library use, for the analysers that find nothing.
 *
 * 453 of the never-called functions are `.filter()` callbacks, 177 `.map()`
 * and 113 `.sort()`. None of them is dead code: they run over the collection a
 * module builds, and the collection is empty because the source contains
 * nothing the module recognises. Filling the source is what calls them.
 *
 * Each block covers one module's vocabulary, taken from the module itself.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Splat, named arguments, first-class callables, variadics. */
function splatAndVariadics(root: string): void {
  put(root, 'src/Service/Spread.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class Spread',
    '{',
    '    public function sum(int ...$numbers): int',
    '    {',
    '        return array_sum($numbers);',
    '    }',
    '',
    '    public function forward(array $args): int',
    '    {',
    '        return $this->sum(...$args);',
    '    }',
    '',
    '    public function merge(array $a, array $b): array',
    '    {',
    '        return [...$a, ...$b, "extra" => 1];',
    '    }',
    '',
    '    public function named(): object',
    '    {',
    '        return new \\DateTimeImmutable(datetime: "now", timezone: new \\DateTimeZone("UTC"));',
    '    }',
    '',
    '    public function unpackString(array $rows): array',
    '    {',
    '        // String keys in a spread require PHP 8.1',
    '        return [...$rows, ...["k" => "v"]];',
    '    }',
    '',
    '    public function callable(): array',
    '    {',
    '        return array_map($this->sum(...), [[1, 2], [3, 4]]);',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Covariant returns and contravariant parameters. */
function covariance(root: string): void {
  put(root, 'src/Model/Shapes.php', [
    '<?php',
    'namespace App\\Model;',
    '',
    'abstract class AnimalShelter',
    '{',
    '    abstract public function adopt(): Animal;',
    '    abstract public function feed(AnimalFood $food): void;',
    '}',
    '',
    'class Animal {}',
    'class Cat extends Animal {}',
    'class AnimalFood {}',
    'class CatFood extends AnimalFood {}',
    '',
    'class CatShelter extends AnimalShelter',
    '{',
    '    // Covariant return: narrower than the parent declares',
    '    public function adopt(): Cat',
    '    {',
    '        return new Cat();',
    '    }',
    '',
    '    // Contravariant parameter: wider than the parent declares',
    '    public function feed(AnimalFood $food): void {}',
    '}',
    '',
    'interface Repository',
    '{',
    '    public function find(int $id): ?object;',
    '}',
    '',
    'class CatRepository implements Repository',
    '{',
    '    public function find(int $id): ?Cat { return null; }',
    '}',
  ].join('\n') + '\n');
}

/** CSV reading and writing, with and without escaping. */
function csvParsing(root: string): void {
  put(root, 'src/Service/CsvExporter.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class CsvExporter',
    '{',
    '    public function read(string $file): array',
    '    {',
    '        $rows = [];',
    '        if (($handle = fopen($file, "r")) !== false) {',
    '            while (($data = fgetcsv($handle, 1000, ",", "\\"", "\\\\")) !== false) {',
    '                $rows[] = $data;',
    '            }',
    '            fclose($handle);',
    '        }',
    '        return $rows;',
    '    }',
    '',
    '    public function write(string $file, array $rows): void',
    '    {',
    '        $handle = fopen($file, "w");',
    '        fputcsv($handle, ["id", "name", "total"]);',
    '        foreach ($rows as $row) {',
    '            // Values starting with = are read as formulas by spreadsheets',
    '            fputcsv($handle, $row);',
    '        }',
    '        fclose($handle);',
    '    }',
    '',
    '    public function parseString(string $line): array',
    '    {',
    '        return str_getcsv($line, ",", "\\"");',
    '    }',
    '',
    '    public function withSymfony(string $file): array',
    '    {',
    '        $reader = new \\League\\Csv\\Reader($file);',
    '        return iterator_to_array($reader->getRecords());',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** FTP and SFTP, in the shapes the analyser inspects. */
function ftpPatterns(root: string): void {
  put(root, 'src/Service/FileTransfer.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class FileTransfer',
    '{',
    '    public function plainFtp(string $host, string $user, string $pass): void',
    '    {',
    '        // Unencrypted, and the credentials travel in clear',
    '        $conn = ftp_connect($host, 21, 30);',
    '        ftp_login($conn, $user, $pass);',
    '        ftp_pasv($conn, true);',
    '        ftp_put($conn, "/remote/file.txt", "/local/file.txt", FTP_BINARY);',
    '        ftp_get($conn, "/local/out.txt", "/remote/out.txt", FTP_ASCII);',
    '        ftp_close($conn);',
    '    }',
    '',
    '    public function secureFtp(string $host): void',
    '    {',
    '        $conn = ftp_ssl_connect($host, 21, 30);',
    '        ftp_login($conn, "user", "pass");',
    '        ftp_close($conn);',
    '    }',
    '',
    '    public function sftp(string $host): void',
    '    {',
    '        $ssh = ssh2_connect($host, 22);',
    '        ssh2_auth_pubkey_file($ssh, "user", "/keys/id_rsa.pub", "/keys/id_rsa");',
    '        $sftp = ssh2_sftp($ssh);',
    '        file_put_contents("ssh2.sftp://" . intval($sftp) . "/remote/file.txt", "data");',
    '    }',
    '',
    '    public function flysystem(): void',
    '    {',
    '        $adapter = new \\League\\Flysystem\\Ftp\\FtpAdapter(',
    '            \\League\\Flysystem\\Ftp\\FtpConnectionOptions::fromArray([',
    '                "host" => "ftp.example.com",',
    '                "root" => "/",',
    '                "username" => "user",',
    '                "ssl" => false,',
    '            ])',
    '        );',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Doctrine SQL filters and their registration. */
function doctrineFilters(root: string): void {
  put(root, 'src/Doctrine/Filter/TenantFilter.php', [
    '<?php',
    'namespace App\\Doctrine\\Filter;',
    '',
    'use Doctrine\\ORM\\Mapping\\ClassMetadata;',
    'use Doctrine\\ORM\\Query\\Filter\\SQLFilter;',
    '',
    'class TenantFilter extends SQLFilter',
    '{',
    '    public function addFilterConstraint(ClassMetadata $targetEntity, $targetTableAlias): string',
    '    {',
    '        if (!$targetEntity->hasField("tenantId")) {',
    '            return "";',
    '        }',
    '        return sprintf("%s.tenant_id = %s", $targetTableAlias, $this->getParameter("tenantId"));',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Doctrine/Filter/SoftDeleteFilter.php', [
    '<?php',
    'namespace App\\Doctrine\\Filter;',
    '',
    'use Doctrine\\ORM\\Mapping\\ClassMetadata;',
    'use Doctrine\\ORM\\Query\\Filter\\SQLFilter;',
    '',
    'class SoftDeleteFilter extends SQLFilter',
    '{',
    '    public function addFilterConstraint(ClassMetadata $targetEntity, $targetTableAlias): string',
    '    {',
    '        return $targetTableAlias . ".deleted_at IS NULL";',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/doctrine_filters.yaml', [
    'doctrine:',
    '    orm:',
    '        filters:',
    '            tenant:',
    '                class: App\\Doctrine\\Filter\\TenantFilter',
    '                enabled: true',
    '            soft_delete:',
    '                class: App\\Doctrine\\Filter\\SoftDeleteFilter',
    '                enabled: false',
  ].join('\n') + '\n');

  put(root, 'src/EventSubscriber/FilterConfigurator.php', [
    '<?php',
    'namespace App\\EventSubscriber;',
    '',
    'class FilterConfigurator',
    '{',
    '    public function onKernelRequest($event): void',
    '    {',
    '        $filter = $this->em->getFilters()->enable("tenant");',
    '        $filter->setParameter("tenantId", 1);',
    '        $this->em->getFilters()->disable("soft_delete");',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Functional tests driving the kernel, and custom events. */
function kernelTestsAndEvents(root: string): void {
  put(root, 'tests/Functional/KernelDrivenTest.php', [
    '<?php',
    'namespace App\\Tests\\Functional;',
    '',
    'use Symfony\\Bundle\\FrameworkBundle\\KernelBrowser;',
    'use Symfony\\Bundle\\FrameworkBundle\\Test\\KernelTestCase;',
    'use Symfony\\Bundle\\FrameworkBundle\\Test\\WebTestCase;',
    'use Symfony\\Component\\HttpFoundation\\Request;',
    '',
    'class KernelDrivenTest extends WebTestCase',
    '{',
    '    public function testHandlesRequest(): void',
    '    {',
    '        $client = static::createClient(["environment" => "test"], ["HTTP_HOST" => "localhost"]);',
    '        $client->disableReboot();',
    '        $client->followRedirects();',
    '        $crawler = $client->request("GET", "/", [], [], ["HTTP_ACCEPT" => "text/html"]);',
    '',
    '        $this->assertResponseIsSuccessful();',
    '        $this->assertResponseStatusCodeSame(200);',
    '        $this->assertSelectorTextContains("h1", "Demo");',
    '    }',
    '',
    '    public function testKernelDirectly(): void',
    '    {',
    '        $kernel = static::bootKernel();',
    '        $container = static::getContainer();',
    '        $response = $kernel->handle(Request::create("/health"));',
    '        $this->assertSame(200, $response->getStatusCode());',
    '        static::ensureKernelShutdown();',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Event/OrderPlacedEvent.php', [
    '<?php',
    'namespace App\\Event;',
    '',
    'use Symfony\\Contracts\\EventDispatcher\\Event;',
    '',
    'class OrderPlacedEvent extends Event',
    '{',
    '    public const NAME = "order.placed";',
    '',
    '    public function __construct(private readonly int $orderId) {}',
    '',
    '    public function getOrderId(): int { return $this->orderId; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Event/OrderCancelledEvent.php', [
    '<?php',
    'namespace App\\Event;',
    '',
    'use Symfony\\Contracts\\EventDispatcher\\Event;',
    '',
    'final class OrderCancelledEvent extends Event',
    '{',
    '    public const NAME = "order.cancelled";',
    '    public function __construct(public readonly int $orderId, public readonly string $reason) {}',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/EventListener/OrderEventListener.php', [
    '<?php',
    'namespace App\\EventListener;',
    '',
    'use App\\Event\\OrderCancelledEvent;',
    'use App\\Event\\OrderPlacedEvent;',
    'use Symfony\\Component\\EventDispatcher\\Attribute\\AsEventListener;',
    'use Symfony\\Component\\EventDispatcher\\EventDispatcherInterface;',
    '',
    '#[AsEventListener(event: OrderPlacedEvent::class, priority: 10)]',
    'class OrderEventListener',
    '{',
    '    public function __construct(private EventDispatcherInterface $dispatcher) {}',
    '',
    '    public function __invoke(OrderPlacedEvent $event): void',
    '    {',
    '        $this->dispatcher->dispatch(new OrderCancelledEvent($event->getOrderId(), "duplicate"));',
    '        $this->dispatcher->dispatch($event, OrderPlacedEvent::NAME);',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Doctrine custom types, and workflow marking read every way. */
function typesAndWorkflow(root: string): void {
  put(root, 'src/Doctrine/Type/MoneyType.php', [
    '<?php',
    'namespace App\\Doctrine\\Type;',
    '',
    'use Doctrine\\DBAL\\Platforms\\AbstractPlatform;',
    'use Doctrine\\DBAL\\Types\\Type;',
    '',
    'class MoneyType extends Type',
    '{',
    '    public const NAME = "money";',
    '',
    '    public function getName(): string { return self::NAME; }',
    '',
    '    public function getSQLDeclaration(array $column, AbstractPlatform $platform): string',
    '    {',
    '        return "BIGINT";',
    '    }',
    '',
    '    public function convertToPHPValue($value, AbstractPlatform $platform): ?int',
    '    {',
    '        return $value === null ? null : (int) $value;',
    '    }',
    '',
    '    public function convertToDatabaseValue($value, AbstractPlatform $platform): ?int',
    '    {',
    '        return $value === null ? null : (int) $value;',
    '    }',
    '',
    '    public function requiresSQLCommentHint(AbstractPlatform $platform): bool { return true; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/doctrine_types.yaml', [
    'doctrine:',
    '    dbal:',
    '        types:',
    '            money: App\\Doctrine\\Type\\MoneyType',
    '            uuid: Symfony\\Bridge\\Doctrine\\Types\\UuidType',
    '        mapping_types:',
    '            enum: string',
    '            jsonb: json',
  ].join('\n') + '\n');

  put(root, 'src/Service/WorkflowInspector.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Symfony\\Component\\Workflow\\Marking;',
    'use Symfony\\Component\\Workflow\\Registry;',
    'use Symfony\\Component\\Workflow\\WorkflowInterface;',
    '',
    'class WorkflowInspector',
    '{',
    '    public function __construct(private Registry $registry, private WorkflowInterface $fulfilment) {}',
    '',
    '    public function inspect($subject): array',
    '    {',
    '        $workflow = $this->registry->get($subject, "fulfilment");',
    '        $marking = $workflow->getMarking($subject);',
    '        $places = $marking->getPlaces();',
    '',
    '        $enabled = $workflow->getEnabledTransitions($subject);',
    '        $can = $workflow->can($subject, "prepare");',
    '        $blockers = $workflow->buildTransitionBlockerList($subject, "dispatch");',
    '',
    '        if ($marking->has("picked") && $marking->has("invoiced")) {',
    '            $workflow->apply($subject, "dispatch");',
    '        }',
    '',
    '        $definition = $workflow->getDefinition();',
    '        return [$places, $enabled, $can, $blockers, $definition->getTransitions()];',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Everything in this file. */
export function addPhpLanguageFeatures(root: string): void {
  splatAndVariadics(root);
  covariance(root);
  csvParsing(root);
  ftpPatterns(root);
  doctrineFilters(root);
  kernelTestsAndEvents(root);
  typesAndWorkflow(root);
}
