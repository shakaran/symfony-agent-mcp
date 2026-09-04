// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Applications for the bundles and integrations: single sign-on, mail
 * through SES, Google APIs, webhooks, sessions, error pages, tenants and
 * the search stack.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-bundles-'));
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

describe('the bundles an application leans on', () => {
  test('single sign-on through two different client bundles', async () => {
    const app = appWith('oauth-sso', {
      'config/packages/knpu_oauth2_client.yaml': [
        'knpu_oauth2_client:',
        '    clients:',
        '        google:',
        '            type: google',
        '            client_id: "%env(GOOGLE_CLIENT_ID)%"',
        '            client_secret: "%env(GOOGLE_CLIENT_SECRET)%"',
        '            redirect_route: connect_google_check',
        '            redirect_params: {}',
        '        github:',
        '            type: github',
        '            client_id: "1234567890abcdef"',
        '            client_secret: "abcdef1234567890abcdef1234567890"',
        '            redirect_route: connect_github_check',
      ].join('\n') + '\n',
      'config/packages/hwi_oauth.yaml': [
        'hwi_oauth:',
        '    firewall_names: [main]',
        '    resource_owners:',
        '        azure:',
        '            type: azure',
        '            client_id: "%env(AZURE_CLIENT_ID)%"',
        '            client_secret: "%env(AZURE_CLIENT_SECRET)%"',
        '            scope: "openid profile email"',
      ].join('\n') + '\n',
      'src/Controller/ConnectController.php': [
        '<?php',
        'namespace App\\Controller;',
        '',
        'use KnpU\\OAuth2ClientBundle\\Client\\ClientRegistry;',
        'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
        'use Symfony\\Component\\HttpFoundation\\Response;',
        'use Symfony\\Component\\Routing\\Attribute\\Route;',
        '',
        'class ConnectController extends AbstractController',
        '{',
        '    #[Route("/connect/google", name: "connect_google")]',
        '    public function connect(ClientRegistry $registry): Response',
        '    {',
        '        return $registry->getClient("google")->redirect(["profile", "email"], []);',
        '    }',
        '',
        '    #[Route("/connect/google/check", name: "connect_google_check")]',
        '    public function check(ClientRegistry $registry): Response',
        '    {',
        '        $user = $registry->getClient("google")->fetchUser();',
        '',
        '        return $this->redirectToRoute("app_home");',
        '    }',
        '}',
      ].join('\n') + '\n',
      '.env': 'GOOGLE_CLIENT_ID=1234\nGOOGLE_CLIENT_SECRET=secret-value-here\nAZURE_CLIENT_ID=abcd\n',
    }, { 'knpuniversity/oauth2-client-bundle': '^2.18', 'league/oauth2-client': '^2.7' });

    const text = await runModule('oauth-sso.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('Google APIs, with a key file and a refresh token', async () => {
    const app = appWith('google', {
      'config/packages/google.yaml': [
        'parameters:',
        '    google.credentials: "%kernel.project_dir%/config/google-key.json"',
        '    google.scopes: ["https://www.googleapis.com/auth/drive.readonly"]',
      ].join('\n') + '\n',
      'src/Service/Drive.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'class Drive',
        '{',
        '    public function client(): \\Google\\Client',
        '    {',
        '        $client = new \\Google\\Client();',
        '        $client->setAuthConfig("%kernel.project_dir%/config/google-key.json");',
        '        $client->setScopes(["https://www.googleapis.com/auth/drive.readonly"]);',
        '        $client->setAccessType("offline");',
        '        $client->setPrompt("consent");',
        '        $url = $client->createAuthUrl();',
        '        $token = $client->getRefreshToken();',
        '        $client->fetchAccessTokenWithRefreshToken($token);',
        '',
        '        return $client;',
        '    }',
        '}',
      ].join('\n') + '\n',
      '.env': 'GOOGLE_APPLICATION_CREDENTIALS=/var/www/html/config/google-key.json\nGOOGLE_CLIENT_ID=1234.apps.googleusercontent.com\n',
    }, { 'google/apiclient': '^2.15' });

    const text = await runModule('google-oauth-integration.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('mail through SES, in configuration and through the client', async () => {
    const app = appWith('ses', {
      'config/packages/mailer.yaml': [
        'framework:',
        '    mailer:',
        '        dsn: "ses+api://ACCESSKEY:SECRETKEY@default?region=eu-west-1"',
        '        envelope:',
        '            sender: no-reply@example.com',
      ].join('\n') + '\n',
      '.env': 'MAILER_DSN=ses+smtp://ACCESSKEY:SECRETKEY@default?region=eu-west-1\nAWS_REGION=eu-west-1\n',
      'src/Service/Bulk.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Aws\\Ses\\SesClient;',
        'use Aws\\SesV2\\SesV2Client;',
        '',
        'class Bulk',
        '{',
        '    public function send(array $addresses): void',
        '    {',
        '        $client = new SesClient(["region" => "eu-west-1", "version" => "2010-12-01"]);',
        '        $client->sendEmail(["Destination" => ["ToAddresses" => $addresses]]);',
        '',
        '        $v2 = new SesV2Client(["region" => "eu-west-1", "version" => "latest"]);',
        '        $v2->sendBulkEmail(["BulkEmailEntries" => []]);',
        '    }',
        '}',
      ].join('\n') + '\n',
    }, { 'aws/aws-sdk-php': '^3.300', 'symfony/amazon-mailer': '^7.0' });

    const text = await runModule('aws-ses-integration.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('webhooks, with a consumer and a request parser', async () => {
    const app = appWith('webhooks', {
      'config/packages/webhook.yaml': [
        'framework:',
        '    webhook:',
        '        routing:',
        '            stripe:',
        '                service: App\\Webhook\\StripeRequestParser',
        '                secret: "%env(STRIPE_WEBHOOK_SECRET)%"',
        '            github:',
        '                service: App\\Webhook\\GithubRequestParser',
        '                secret: ""',
      ].join('\n') + '\n',
      'src/Webhook/StripeRequestParser.php': [
        '<?php',
        'namespace App\\Webhook;',
        '',
        'use Symfony\\Component\\HttpFoundation\\ChainRequestMatcher;',
        'use Symfony\\Component\\HttpFoundation\\Request;',
        'use Symfony\\Component\\RemoteEvent\\RemoteEvent;',
        'use Symfony\\Component\\Webhook\\Client\\AbstractRequestParser;',
        'use Symfony\\Component\\Webhook\\Exception\\RejectWebhookException;',
        '',
        'final class StripeRequestParser extends AbstractRequestParser',
        '{',
        '    protected function getRequestMatcher(): ChainRequestMatcher',
        '    {',
        '        return new ChainRequestMatcher([]);',
        '    }',
        '',
        '    protected function doParse(Request $request, string $secret): ?RemoteEvent',
        '    {',
        '        if (!$request->headers->has("stripe-signature")) {',
        '            throw new RejectWebhookException(406, "Missing signature");',
        '        }',
        '',
        '        return new RemoteEvent("payment", "evt_1", $request->toArray());',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Webhook/GithubRequestParser.php': [
        '<?php',
        'namespace App\\Webhook;',
        '',
        'use Symfony\\Component\\HttpFoundation\\Request;',
        'use Symfony\\Component\\RemoteEvent\\RemoteEvent;',
        '',
        'final class GithubRequestParser',
        '{',
        '    public function parse(Request $request, string $secret): ?RemoteEvent',
        '    {',
        '        return new RemoteEvent("push", "evt_2", $request->toArray());',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/RemoteEvent/PaymentConsumer.php': [
        '<?php',
        'namespace App\\RemoteEvent;',
        '',
        'use Symfony\\Component\\RemoteEvent\\Attribute\\AsRemoteEventConsumer;',
        'use Symfony\\Component\\RemoteEvent\\Consumer\\ConsumerInterface;',
        'use Symfony\\Component\\RemoteEvent\\RemoteEvent;',
        '',
        '#[AsRemoteEventConsumer("stripe")]',
        'final class PaymentConsumer implements ConsumerInterface',
        '{',
        '    public function consume(RemoteEvent $event): void',
        '    {',
        '    }',
        '}',
      ].join('\n') + '\n',
    }, { 'symfony/webhook': '^7.0', 'symfony/remote-event': '^7.0' });

    const text = await runModule('webhooks.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('sessions on Redis, and the cookie settings around them', async () => {
    const app = appWith('session', {
      'config/packages/framework.yaml': [
        'framework:',
        '    session:',
        '        handler_id: "%env(REDIS_URL)%"',
        '        cookie_secure: auto',
        '        cookie_samesite: lax',
        '        cookie_httponly: true',
        '        cookie_lifetime: 0',
        '        gc_maxlifetime: 1440',
        '        gc_probability: 1',
        '        save_path: null',
        '        storage_factory_id: session.storage.factory.native',
        '        metadata_update_threshold: 120',
      ].join('\n') + '\n',
      'config/packages/dev/framework.yaml': [
        'framework:',
        '    session:',
        '        handler_id: null',
        '        cookie_secure: false',
        '        cookie_samesite: none',
      ].join('\n') + '\n',
      'config/services.yaml': [
        'services:',
        '    Symfony\\Component\\HttpFoundation\\Session\\Storage\\Handler\\RedisSessionHandler:',
        '        arguments:',
        '            - "@Redis"',
        '            - { prefix: "acme_session_", ttl: 3600 }',
      ].join('\n') + '\n',
      '.env': 'REDIS_URL=redis://localhost:6379\n',
    });

    const text = await runModule('session-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('error pages, as templates and as a subscriber', async () => {
    const app = appWith('error-pages', {
      'templates/bundles/TwigBundle/Exception/error404.html.twig': '{% extends "base.html.twig" %}\n{% block body %}Not found{% endblock %}\n',
      'templates/bundles/TwigBundle/Exception/error500.html.twig': '{% extends "base.html.twig" %}\n{% block body %}Server error{% endblock %}\n',
      'templates/bundles/TwigBundle/Exception/error.html.twig': '{% extends "base.html.twig" %}\n{% block body %}Something went wrong{% endblock %}\n',
      'templates/base.html.twig': '<html>{% block body %}{% endblock %}</html>\n',
      'src/EventSubscriber/ExceptionSubscriber.php': [
        '<?php',
        'namespace App\\EventSubscriber;',
        '',
        'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
        'use Symfony\\Component\\HttpFoundation\\JsonResponse;',
        'use Symfony\\Component\\HttpKernel\\Event\\ExceptionEvent;',
        'use Symfony\\Component\\HttpKernel\\Exception\\HttpExceptionInterface;',
        'use Symfony\\Component\\HttpKernel\\KernelEvents;',
        '',
        'class ExceptionSubscriber implements EventSubscriberInterface',
        '{',
        '    public static function getSubscribedEvents(): array',
        '    {',
        '        return [KernelEvents::EXCEPTION => ["onException", 10]];',
        '    }',
        '',
        '    public function onException(ExceptionEvent $event): void',
        '    {',
        '        $exception = $event->getThrowable();',
        '        $status = $exception instanceof HttpExceptionInterface ? $exception->getStatusCode() : 500;',
        '',
        '        if (str_starts_with($event->getRequest()->getPathInfo(), "/api")) {',
        '            $event->setResponse(new JsonResponse(["error" => $exception->getMessage()], $status));',
        '        }',
        '    }',
        '}',
      ].join('\n') + '\n',
      'config/packages/twig.yaml': 'twig:\n    exception_controller: null\n',
    });

    const text = await runModule('error-pages.js', app, ['404', '500']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('one application serving several tenants', async () => {
    const app = appWith('multi-tenancy', {
      'src/Entity/Tenant.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        'class Tenant',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[ORM\\Column(length: 64, unique: true)]',
        '    private string $subdomain = "";',
        '}',
      ].join('\n') + '\n',
      'src/Doctrine/TenantFilter.php': [
        '<?php',
        'namespace App\\Doctrine;',
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
        '',
        '        return sprintf("%s.tenant_id = %s", $targetTableAlias, $this->getParameter("tenant_id"));',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/EventSubscriber/TenantSubscriber.php': [
        '<?php',
        'namespace App\\EventSubscriber;',
        '',
        'use Doctrine\\ORM\\EntityManagerInterface;',
        'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
        'use Symfony\\Component\\HttpKernel\\Event\\RequestEvent;',
        'use Symfony\\Component\\HttpKernel\\KernelEvents;',
        '',
        'class TenantSubscriber implements EventSubscriberInterface',
        '{',
        '    public function __construct(private EntityManagerInterface $entityManager) {}',
        '',
        '    public static function getSubscribedEvents(): array',
        '    {',
        '        return [KernelEvents::REQUEST => ["onKernelRequest", 30]];',
        '    }',
        '',
        '    public function onKernelRequest(RequestEvent $event): void',
        '    {',
        '        if (!$event->isMainRequest()) { return; }',
        '',
        '        $subdomain = explode(".", $event->getRequest()->getHost())[0];',
        '        $filter = $this->entityManager->getFilters()->enable("tenant");',
        '        $filter->setParameter("tenant_id", $subdomain);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'config/packages/doctrine.yaml': [
        'doctrine:',
        '    orm:',
        '        filters:',
        '            tenant:',
        '                class: App\\Doctrine\\TenantFilter',
        '                enabled: false',
      ].join('\n') + '\n',
    });

    const text = await runModule('multi-tenancy.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('named native queries and a repository full of DQL', async () => {
    const app = appWith('named-queries', {
      'src/Entity/Report.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity(repositoryClass: \\App\\Repository\\ReportRepository::class)]',
        '#[ORM\\NamedNativeQuery(',
        '    name: "monthly_totals",',
        '    resultSetMapping: "totals",',
        '    query: "SELECT * FROM report WHERE created_at > :from"',
        ')]',
        '#[ORM\\SqlResultSetMapping(',
        '    name: "totals",',
        '    entities: [],',
        ')]',
        'class Report',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '}',
      ].join('\n') + '\n',
      'src/Repository/ReportRepository.php': [
        '<?php',
        'namespace App\\Repository;',
        '',
        'use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;',
        '',
        'class ReportRepository extends ServiceEntityRepository',
        '{',
        '    public function monthly(): array',
        '    {',
        '        return $this->getEntityManager()',
        '            ->createNativeQuery("SELECT * FROM report", $this->rsm)',
        '            ->getResult();',
        '    }',
        '',
        '    public function totals(): array',
        '    {',
        '        return $this->getEntityManager()',
        '            ->createNamedNativeQuery("monthly_totals")',
        '            ->getResult();',
        '    }',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('doctrine-named-queries.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('doctrine subscribers, one of them asking the platform what it is', async () => {
    const app = appWith('doctrine-subscribers', {
      'src/EventSubscriber/TimestampSubscriber.php': [
        '<?php',
        'namespace App\\EventSubscriber;',
        '',
        'use Doctrine\\Bundle\\DoctrineBundle\\EventSubscriber\\EventSubscriberInterface;',
        'use Doctrine\\ORM\\Event\\LifecycleEventArgs;',
        'use Doctrine\\ORM\\Events;',
        '',
        'class TimestampSubscriber implements EventSubscriberInterface',
        '{',
        '    public function getSubscribedEvents(): array',
        '    {',
        '        return [Events::prePersist, Events::preUpdate, Events::postLoad];',
        '    }',
        '',
        '    public function prePersist(LifecycleEventArgs $args): void',
        '    {',
        '        $platform = $args->getObjectManager()->getConnection()->getDatabasePlatform();',
        '        if ($platform->getName() === "postgresql") { return; }',
        '    }',
        '',
        '    public function preUpdate(LifecycleEventArgs $args): void { }',
        '    public function postLoad(LifecycleEventArgs $args): void { }',
        '}',
      ].join('\n') + '\n',
      'src/EventSubscriber/SlugSubscriber.php': [
        '<?php',
        'namespace App\\EventSubscriber;',
        '',
        'use Doctrine\\Common\\EventSubscriber;',
        'use Doctrine\\ORM\\Events;',
        '',
        'class SlugSubscriber implements EventSubscriber',
        '{',
        '    public function getSubscribedEvents(): array',
        '    {',
        '        return [Events::onFlush];',
        '    }',
        '',
        '    public function onFlush($args): void',
        '    {',
        '        $args->getObjectManager()->getConnection()->getPlatform();',
        '    }',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('doctrine-event-subscribers.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('the search stack, from the bundle to the finder', async () => {
    const app = appWith('search', {
      'config/packages/fos_elastica.yaml': [
        'fos_elastica:',
        '    clients:',
        '        default:',
        '            url: "%env(ELASTICSEARCH_URL)%"',
        '            retryOnConflict: 5',
        '    indexes:',
        '        product:',
        '            settings:',
        '                number_of_shards: 1',
        '                number_of_replicas: 0',
        '            properties:',
        '                name: { type: text }',
        '                sku: { type: keyword }',
        '            persistence:',
        '                driver: orm',
        '                model: App\\Entity\\Product',
        '                listener: { insert: true, update: true, delete: true }',
        '                provider: ~',
        '                finder: ~',
      ].join('\n') + '\n',
      'src/Service/ProductSearch.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Elastica\\Query;',
        'use FOS\\ElasticaBundle\\Finder\\TransformedFinder;',
        '',
        'class ProductSearch',
        '{',
        '    public function __construct(private TransformedFinder $productFinder) {}',
        '',
        '    public function search(string $term): array',
        '    {',
        '        $query = new Query\\MultiMatch();',
        '        $query->setQuery($term);',
        '        $query->setFields(["name", "sku"]);',
        '',
        '        return $this->productFinder->find($query, 50);',
        '    }',
        '}',
      ].join('\n') + '\n',
      '.env': 'ELASTICSEARCH_URL=http://elasticsearch:9200\n',
    }, { 'friendsofsymfony/elastica-bundle': '^6.4', 'ruflin/elastica': '^7.3' });

    const text = await runModule('search-integration.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
