// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * A fifth batch: DQL functions, login links, LDAP, FOSRestBundle, web
 * server vhosts, RFC 7807 responses and an exception hierarchy.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function doctrineAndSecurity(root: string): void {
  // Appended to the doctrine.yaml written by the fourth batch.
  const doctrine = path.join(root, 'config', 'packages', 'doctrine.yaml');
  let existing = '';
  try { existing = fs.readFileSync(doctrine, 'utf-8'); } catch { /* first write */ }
  const dql = [
    '        dql:',
    '            string_functions:',
    '                unaccent: App\\Doctrine\\Dql\\Unaccent',
    '                group_concat: DoctrineExtensions\\Query\\Mysql\\GroupConcat',
    '            numeric_functions:',
    '                distance: App\\Doctrine\\Dql\\Distance',
    '                rand: DoctrineExtensions\\Query\\Mysql\\Rand',
    '            datetime_functions:',
    '                date_format: DoctrineExtensions\\Query\\Mysql\\DateFormat',
    '                year: App\\Doctrine\\Dql\\Year',
  ].join('\n') + '\n';
  fs.writeFileSync(doctrine, existing.trimEnd() + '\n' + dql);

  put(root, 'src/Doctrine/Dql/Unaccent.php', [
    '<?php',
    'namespace App\\Doctrine\\Dql;',
    '',
    'use Doctrine\\ORM\\Query\\AST\\Functions\\FunctionNode;',
    'use Doctrine\\ORM\\Query\\Lexer;',
    'use Doctrine\\ORM\\Query\\Parser;',
    'use Doctrine\\ORM\\Query\\SqlWalker;',
    '',
    'class Unaccent extends FunctionNode',
    '{',
    '    private $expression;',
    '',
    '    public function parse(Parser $parser): void',
    '    {',
    '        $parser->match(Lexer::T_IDENTIFIER);',
    '        $parser->match(Lexer::T_OPEN_PARENTHESIS);',
    '        $this->expression = $parser->StringPrimary();',
    '        $parser->match(Lexer::T_CLOSE_PARENTHESIS);',
    '    }',
    '',
    '    public function getSql(SqlWalker $sqlWalker): string',
    '    {',
    '        return "unaccent(" . $this->expression->dispatch($sqlWalker) . ")";',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Doctrine/Dql/Distance.php', [
    '<?php',
    'namespace App\\Doctrine\\Dql;',
    '',
    'use Doctrine\\ORM\\Query\\AST\\Functions\\FunctionNode;',
    'use Doctrine\\ORM\\Query\\Parser;',
    'use Doctrine\\ORM\\Query\\SqlWalker;',
    '',
    'class Distance extends FunctionNode',
    '{',
    '    public function parse(Parser $parser): void { }',
    '    public function getSql(SqlWalker $sqlWalker): string { return "st_distance()"; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/ldap.yaml', [
    'ldap:',
    '    default:',
    '        host: "%env(LDAP_HOST)%"',
    '        port: 389',
    '        encryption: none',
    '        version: 3',
    '    secure:',
    '        host: ldaps.example.com',
    '        port: 636',
    '        encryption: ssl',
    '',
    'services:',
    '    Symfony\\Component\\Ldap\\Ldap:',
    '        arguments: ["@Symfony\\\\Component\\\\Ldap\\\\Adapter\\\\ExtLdap\\\\Adapter"]',
    '        tags: [ldap]',
    '',
    '    Symfony\\Component\\Ldap\\Adapter\\ExtLdap\\Adapter:',
    '        arguments:',
    '            -',
    '                host: "%env(LDAP_HOST)%"',
    '                port: 389',
    '                encryption: none',
    '                options:',
    '                    protocol_version: 3',
    '                    referrals: false',
  ].join('\n') + '\n');

  put(root, 'config/packages/security_ldap.yaml', [
    'security:',
    '    providers:',
    '        ldap_users:',
    '            ldap:',
    '                service: Symfony\\Component\\Ldap\\Ldap',
    '                base_dn: "dc=example,dc=com"',
    '                search_dn: "cn=reader,dc=example,dc=com"',
    '                search_password: "%env(LDAP_PASSWORD)%"',
    '                default_roles: [ROLE_USER]',
    '                uid_key: uid',
    '    firewalls:',
    '        ldap:',
    '            pattern: ^/intranet',
    '            provider: ldap_users',
    '            form_login_ldap:',
    '                service: Symfony\\Component\\Ldap\\Ldap',
    '                dn_string: "uid={user_identifier},dc=example,dc=com"',
    '                check_path: intranet_login',
    '                login_path: intranet_login',
    '        magic:',
    '            pattern: ^/magic',
    '            login_link:',
    '                check_route: magic_login_check',
    '                signature_properties: [id, email]',
    '                lifetime: 600',
    '                max_uses: 1',
    '                success_handler: App\\Security\\MagicLinkSuccessHandler',
  ].join('\n') + '\n');

  put(root, 'src/Security/MagicLinkSuccessHandler.php', [
    '<?php',
    'namespace App\\Security;',
    '',
    'use Symfony\\Component\\HttpFoundation\\RedirectResponse;',
    'use Symfony\\Component\\HttpFoundation\\Request;',
    'use Symfony\\Component\\Security\\Http\\Authentication\\AuthenticationSuccessHandlerInterface;',
    '',
    'class MagicLinkSuccessHandler implements AuthenticationSuccessHandlerInterface',
    '{',
    '    public function onAuthenticationSuccess(Request $request, $token): RedirectResponse',
    '    {',
    '        return new RedirectResponse("/");',
    '    }',
    '}',
  ].join('\n') + '\n');
}

function apiAndExceptions(root: string): void {
  put(root, 'config/packages/fos_rest.yaml', [
    'fos_rest:',
    '    routing_loader: false',
    '    param_fetcher_listener: true',
    '    body_listener: true',
    '    view:',
    '        view_response_listener: force',
    '        formats:',
    '            json: true',
    '            xml: false',
    '    format_listener:',
    '        rules:',
    '            - { path: "^/api", priorities: [json], fallback_format: json, prefer_extension: false }',
    '            - { path: "^/", stop: true }',
    '    exception:',
    '        enabled: true',
    '        exception_controller: "fos_rest.exception.controller:showAction"',
  ].join('\n') + '\n');

  put(root, 'src/Controller/Api/LegacyRestController.php', [
    '<?php',
    'namespace App\\Controller\\Api;',
    '',
    'use FOS\\RestBundle\\Controller\\AbstractFOSRestController;',
    'use FOS\\RestBundle\\Controller\\Annotations as Rest;',
    'use FOS\\RestBundle\\View\\View;',
    '',
    'class LegacyRestController extends AbstractFOSRestController',
    '{',
    '    #[Rest\\Get("/api/legacy/items")]',
    '    #[Rest\\QueryParam(name: "page", requirements: "\\\\d+", default: "1")]',
    '    public function index(): View',
    '    {',
    '        return $this->view([], 200);',
    '    }',
    '',
    '    #[Rest\\Post("/api/legacy/items")]',
    '    #[Rest\\View(serializerGroups: ["item:read"], statusCode: 201)]',
    '    public function create(): View',
    '    {',
    '        return View::create([], 201);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Exception/AppException.php', [
    '<?php',
    'namespace App\\Exception;',
    '',
    'abstract class AppException extends \\RuntimeException',
    '{',
    '    abstract public function getErrorCode(): string;',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Exception/OrderNotFoundException.php', [
    '<?php',
    'namespace App\\Exception;',
    '',
    'use Symfony\\Component\\HttpKernel\\Exception\\HttpExceptionInterface;',
    '',
    'class OrderNotFoundException extends AppException implements HttpExceptionInterface',
    '{',
    '    public function __construct(private string $reference)',
    '    {',
    '        parent::__construct(sprintf("Order %s not found", $reference), 404);',
    '    }',
    '',
    '    public function getErrorCode(): string { return "ORDER_NOT_FOUND"; }',
    '    public function getStatusCode(): int { return 404; }',
    '    public function getHeaders(): array { return []; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Exception/PaymentDeclinedException.php', [
    '<?php',
    'namespace App\\Exception;',
    '',
    'class PaymentDeclinedException extends AppException',
    '{',
    '    public function getErrorCode(): string { return "PAYMENT_DECLINED"; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Exception/InvalidStateException.php', [
    '<?php',
    'namespace App\\Exception;',
    '',
    'class InvalidStateException extends \\LogicException',
    '{',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/EventListener/ProblemDetailsListener.php', [
    '<?php',
    'namespace App\\EventListener;',
    '',
    'use App\\Exception\\AppException;',
    'use Symfony\\Component\\EventDispatcher\\Attribute\\AsEventListener;',
    'use Symfony\\Component\\HttpFoundation\\JsonResponse;',
    'use Symfony\\Component\\HttpKernel\\Event\\ExceptionEvent;',
    'use Symfony\\Component\\HttpKernel\\KernelEvents;',
    '',
    '#[AsEventListener(event: KernelEvents::EXCEPTION, priority: 10)]',
    'class ProblemDetailsListener',
    '{',
    '    public function __invoke(ExceptionEvent $event): void',
    '    {',
    '        $e = $event->getThrowable();',
    '        if (!$e instanceof AppException) { return; }',
    '',
    '        $response = new JsonResponse([',
    '            "type" => "https://example.com/probs/" . strtolower($e->getErrorCode()),',
    '            "title" => $e->getMessage(),',
    '            "status" => 400,',
    '            "detail" => $e->getMessage(),',
    '            "instance" => $event->getRequest()->getPathInfo(),',
    '        ], 400);',
    '        $response->headers->set("Content-Type", "application/problem+json");',
    '',
    '        $event->setResponse($response);',
    '    }',
    '}',
  ].join('\n') + '\n');
}

function webserver(root: string): void {
  put(root, 'docker/nginx/default.conf', [
    'server {',
    '    listen 80;',
    '    server_name acme.example.com;',
    '    root /var/www/html/public;',
    '',
    '    location / {',
    '        try_files $uri /index.php$is_args$args;',
    '    }',
    '',
    '    location ~ ^/index\\.php(/|$) {',
    '        fastcgi_pass php:9000;',
    '        fastcgi_split_path_info ^(.+\\.php)(/.*)$;',
    '        include fastcgi_params;',
    '        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;',
    '        fastcgi_param DOCUMENT_ROOT $realpath_root;',
    '        internal;',
    '    }',
    '',
    '    location ~ \\.php$ {',
    '        return 404;',
    '    }',
    '',
    '    client_max_body_size 20m;',
    '    error_log /var/log/nginx/error.log;',
    '    access_log /var/log/nginx/access.log;',
    '}',
  ].join('\n') + '\n');

  put(root, 'docker/apache/vhost.conf', [
    '<VirtualHost *:80>',
    '    ServerName acme.example.com',
    '    DocumentRoot /var/www/html/public',
    '',
    '    <Directory /var/www/html/public>',
    '        AllowOverride None',
    '        Require all granted',
    '        FallbackResource /index.php',
    '    </Directory>',
    '',
    '    <Directory /var/www/html>',
    '        Options FollowSymlinks',
    '    </Directory>',
    '',
    '    ErrorLog /var/log/apache2/error.log',
    '    CustomLog /var/log/apache2/access.log combined',
    '</VirtualHost>',
  ].join('\n') + '\n');

  put(root, 'deploy/nginx-ssl.conf', [
    'server {',
    '    listen 443 ssl http2;',
    '    server_name acme.example.com;',
    '    root /var/www/html/public;',
    '',
    '    ssl_certificate     /etc/letsencrypt/live/acme/fullchain.pem;',
    '    ssl_certificate_key /etc/letsencrypt/live/acme/privkey.pem;',
    '    ssl_protocols TLSv1.2 TLSv1.3;',
    '',
    '    add_header Strict-Transport-Security "max-age=31536000" always;',
    '    add_header X-Frame-Options DENY;',
    '',
    '    location / {',
    '        try_files $uri /index.php$is_args$args;',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Everything in this file. */
export function addBatchFive(root: string): void {
  doctrineAndSecurity(root);
  apiAndExceptions(root);
  webserver(root);
}
