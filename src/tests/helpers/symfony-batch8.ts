// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * An eighth batch, for the parsers whose second form was never fed: console
 * commands configured in configure(), promoted properties with serializer
 * groups, PHP translation catalogues, Twig inheritance, workflow metadata,
 * custom Monolog handlers, cache pool directories and dynamic regular
 * expressions.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function phpForms(root: string): void {
  put(root, 'src/Command/LegacyImportCommand.php', [
    '<?php',
    'namespace App\\Command;',
    '',
    'use Symfony\\Component\\Console\\Command\\Command;',
    'use Symfony\\Component\\Console\\Input\\InputArgument;',
    'use Symfony\\Component\\Console\\Input\\InputInterface;',
    'use Symfony\\Component\\Console\\Input\\InputOption;',
    'use Symfony\\Component\\Console\\Output\\OutputInterface;',
    '',
    'class LegacyImportCommand extends Command',
    '{',
    '    protected function configure(): void',
    '    {',
    '        $this->setName("app:legacy-import")',
    '            ->setDescription("Imports the legacy catalogue")',
    '            ->setHelp("Reads a CSV export and writes products")',
    '            ->setAliases(["app:import-legacy", "legacy:import"])',
    '            ->addArgument("file", InputArgument::REQUIRED, "Path to the CSV export")',
    '            ->addArgument("locales", InputArgument::IS_ARRAY, "Locales to import")',
    '            ->addOption("dry-run", "d", InputOption::VALUE_NONE, "Do not write anything")',
    '            ->addOption("batch", "b", InputOption::VALUE_OPTIONAL, "Rows per batch", 500)',
    '            ->addOption("channel", null, InputOption::VALUE_REQUIRED, "Sales channel")',
    '            ->addOption("tag", "t", InputOption::VALUE_IS_ARRAY | InputOption::VALUE_OPTIONAL, "Tags");',
    '    }',
    '',
    '    protected function execute(InputInterface $input, OutputInterface $output): int',
    '    {',
    '        return Command::SUCCESS;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Dto/CustomerInput.php', [
    '<?php',
    'namespace App\\Dto;',
    '',
    'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
    'use Symfony\\Component\\Serializer\\Annotation\\SerializedName;',
    'use Symfony\\Component\\Validator\\Constraints as Assert;',
    '',
    'final class CustomerInput',
    '{',
    '    public function __construct(',
    '        #[Groups(["customer:write"])]',
    '        #[Assert\\NotBlank]',
    '        public readonly string $name,',
    '',
    '        #[Groups(["customer:write", "customer:read"])]',
    '        #[SerializedName("email_address")]',
    '        public readonly string $email,',
    '',
    '        #[Groups(["customer:write"])]',
    '        public readonly ?string $vatNumber = null,',
    '    ) {}',
    '}',
  ].join('\n') + '\n');

  put(root, 'translations/messages.en.php', [
    '<?php',
    '',
    'return [',
    '    "cart.title" => "Your cart",',
    '    "cart.empty" => "Nothing in here yet",',
    '    "order.placed" => "Order placed",',
    '    "order.cancelled" => "Order cancelled",',
    '];',
  ].join('\n') + '\n');

  put(root, 'translations/messages.fr.php', [
    '<?php',
    '',
    'return [',
    '    "cart.title" => "Votre panier",',
    '    "cart.empty" => "Rien pour l\'instant",',
    '];',
  ].join('\n') + '\n');

  put(root, 'translations/messages.en.json', JSON.stringify({
    'cart.title': 'Your cart',
    'cart.checkout': 'Checkout',
    'nested': { 'deep': { 'key': 'A deep value' } },
  }, null, 2) + '\n');

  put(root, 'src/Logger/DatabaseHandler.php', [
    '<?php',
    'namespace App\\Logger;',
    '',
    'use Monolog\\Handler\\AbstractProcessingHandler;',
    'use Monolog\\Level;',
    'use Monolog\\LogRecord;',
    '',
    'class DatabaseHandler extends AbstractProcessingHandler',
    '{',
    '    public function __construct(private \\PDO $pdo, $level = Level::Warning, bool $bubble = true)',
    '    {',
    '        parent::__construct($level, $bubble);',
    '    }',
    '',
    '    protected function write(LogRecord $record): void',
    '    {',
    '        $this->pdo->prepare("INSERT INTO log (message, level) VALUES (?, ?)")',
    '            ->execute([$record->message, $record->level->getName()]);',
    '    }',
    '',
    '    public function isHandling(LogRecord $record): bool',
    '    {',
    '        return $record->level->value >= Level::Warning->value;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Logger/NullishHandler.php', [
    '<?php',
    'namespace App\\Logger;',
    '',
    'use Monolog\\Handler\\HandlerInterface;',
    '',
    'class NullishHandler implements HandlerInterface',
    '{',
    '    public function isHandling($record): bool { return false; }',
    '    public function handle($record): bool { return true; }',
    '    public function handleBatch(array $records): void { }',
    '    public function close(): void { }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Service/PatternMatcher.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class PatternMatcher',
    '{',
    '    public function match(array $rows): array',
    '    {',
    '        $pattern = $_GET["pattern"];',
    '        $out = [];',
    '        foreach ($rows as $row) {',
    '            if (preg_match($pattern, $row)) { $out[] = $row; }',
    '        }',
    '',
    '        $needle = $_POST["needle"];',
    '        $rewritten = preg_replace("/" . $needle . "/", "***", implode(",", $rows));',
    '        $parts = preg_split($pattern, $rewritten);',
    '        $legacy = preg_replace("/(\\\\d+)/e", "strtoupper(\'$1\')", $rewritten);',
    '',
    '        return [$out, $parts, $legacy];',
    '    }',
    '',
    '    public function safe(string $value): bool',
    '    {',
    '        return (bool) preg_match("/^[a-z0-9-]+$/", $value);',
    '    }',
    '}',
  ].join('\n') + '\n');
}

function templatesAndConfig(root: string): void {
  put(root, 'templates/product/show.html.twig', [
    '{% extends "base.html.twig" %}',
    '',
    '{% use "components/rating.html.twig" with stars as rating_stars %}',
    '',
    '{% block title %}{{ product.name }}{% endblock %}',
    '',
    '{% block body %}',
    '    {% include "product/_gallery.html.twig" with {images: product.images} %}',
    '    {% include "product/_price.html.twig" only %}',
    '',
    '    {% embed "components/card.html.twig" with {title: product.name} %}',
    '        {% block content %}{{ product.description }}{% endblock %}',
    '    {% endembed %}',
    '',
    '    {% block reviews %}',
    '        {% for review in product.reviews %}',
    '            {{ include("product/_review.html.twig", {review: review}) }}',
    '        {% endfor %}',
    '    {% endblock %}',
    '{% endblock %}',
  ].join('\n') + '\n');

  put(root, 'templates/product/_gallery.html.twig', '{% for image in images %}<img src="{{ image }}">{% endfor %}\n');
  put(root, 'templates/product/_price.html.twig', '<span class="price">{{ price|format_currency("EUR") }}</span>\n');
  put(root, 'templates/product/_review.html.twig', '<article>{{ review.body }}</article>\n');
  put(root, 'templates/components/card.html.twig', '<div class="card"><h2>{{ title }}</h2>{% block content %}{% endblock %}</div>\n');
  put(root, 'templates/components/rating.html.twig', '{% block stars %}{{ "*"|repeat(rating) }}{% endblock %}\n');

  put(root, 'config/packages/workflow_metadata.yaml', [
    'framework:',
    '    workflows:',
    '        refund:',
    '            type: state_machine',
    '            metadata:',
    '                title: Refund handling',
    '                owner: finance',
    '            marking_store:',
    '                type: method',
    '                property: state',
    '            supports: [App\\Entity\\Refund]',
    '            initial_marking: requested',
    '            places:',
    '                requested:',
    '                    metadata:',
    '                        label: Requested',
    '                approved:',
    '                    metadata:',
    '                        label: Approved',
    '                paid: ~',
    '                rejected: ~',
    '            transitions:',
    '                approve:',
    '                    from: requested',
    '                    to: approved',
    '                    metadata:',
    '                        label: Approve the refund',
    '                        priority: 10',
    '                pay:',
    '                    from: approved',
    '                    to: paid',
    '                reject:',
    '                    from: requested',
    '                    to: rejected',
  ].join('\n') + '\n');

  put(root, 'config/packages/messenger_routing.yaml', [
    'framework:',
    '    messenger:',
    '        routing:',
    '            "App\\Message\\SendInvoice": async',
    '            "App\\Message\\RebuildIndex": [async, async_priority_high]',
    '            "App\\Message\\AuditTrail":',
    '                - async',
    '                - sync',
    '            "App\\Message\\Unrouted": nowhere',
    '            "*": async',
  ].join('\n') + '\n');

  put(root, 'src/Message/SendInvoice.php', [
    '<?php',
    'namespace App\\Message;',
    '',
    'final class SendInvoice',
    '{',
    '    public function __construct(public readonly int $invoiceId) {}',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Message/NeverRouted.php', [
    '<?php',
    'namespace App\\Message;',
    '',
    'final class NeverRouted',
    '{',
    '    public function __construct(public readonly string $reason) {}',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Service/Dispatcher.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use App\\Message\\NeverRouted;',
    'use App\\Message\\SendInvoice;',
    'use Symfony\\Component\\Messenger\\MessageBusInterface;',
    '',
    'class Dispatcher',
    '{',
    '    public function __construct(private MessageBusInterface $bus) {}',
    '',
    '    public function run(): void',
    '    {',
    '        $this->bus->dispatch(new SendInvoice(42));',
    '        $this->bus->dispatch(new NeverRouted("no transport"));',
    '    }',
    '}',
  ].join('\n') + '\n');

  // The cache inspector reads the built cache rather than configuration.
  for (const env of ['dev', 'prod']) {
    for (const pool of ['app', 'system', 'validator', 'doctrine']) {
      put(root, `var/cache/${env}/pools/${pool}/entry-1.php`, '<?php\n\nreturn ["value", 1756000000];\n');
      put(root, `var/cache/${env}/pools/${pool}/entry-2.php`, '<?php\n\nreturn ["another", 1756000100];\n');
    }
    put(root, `var/cache/${env}/App_Kernel${env}DebugContainer.php`, '<?php\n\nclass App_Kernel {}\n');
    put(root, `var/cache/${env}/url_matching_routes.php`, '<?php\n\nreturn [];\n');
    put(root, `var/cache/${env}/twig/ab/cdef0123456789.php`, '<?php\n\nclass __TwigTemplate_abc {}\n');
  }
}

/** Everything in this file. */
export function addBatchEight(root: string): void {
  phpForms(root);
  templatesAndConfig(root);
}
