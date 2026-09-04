// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Applications for the modules that read the parts around the application:
 * charts, playbooks, PHP settings, two-factor authentication, template
 * namespaces, and the request-shaped risks in PHP code.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-infra-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function appWith(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (!files['composer.json']) {
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({
      require: {
        'symfony/framework-bundle': '^7.0',
        'scheb/2fa-bundle': '^7.0',
        'scheb/2fa-totp': '^7.0',
        'symfony/process': '^7.0',
        'google/apiclient': '^2.15',
        'async-aws/ses': '^1.0',
      },
    }));
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

describe('the parts around the application', () => {
  test('a Helm chart with probes on one deployment and none on the other', async () => {
    const app = appWith('helm', {
      'Chart.yaml': [
        'apiVersion: v2',
        'name: acme',
        'description: The Acme storefront',
        'type: application',
        'version: 1.4.0',
        'appVersion: "1.4.0"',
        'dependencies:',
        '    - name: postgresql',
        '      version: 15.5.0',
        '      repository: https://charts.bitnami.com/bitnami',
      ].join('\n') + '\n',
      'values.yaml': [
        'replicaCount: 1',
        'image:',
        '    repository: acme/app',
        '    tag: latest',
        '    pullPolicy: Always',
        'resources: {}',
        'autoscaling:',
        '    enabled: false',
        'securityContext:',
        '    runAsUser: 0',
        'env:',
        '    APP_ENV: prod',
        '    APP_SECRET: 0123456789abcdef0123456789abcdef',
      ].join('\n') + '\n',
      'templates/deployment.yaml': [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '    name: {{ include "acme.fullname" . }}',
        'spec:',
        '    replicas: {{ .Values.replicaCount }}',
        '    template:',
        '        spec:',
        '            containers:',
        '                - name: app',
        '                  image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"',
        '                  livenessProbe:',
        '                      httpGet:',
        '                          path: /health',
        '                          port: http',
        '                  readinessProbe:',
        '                      httpGet:',
        '                          path: /ready',
        '                          port: http',
      ].join('\n') + '\n',
      'templates/worker.yaml': [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '    name: {{ include "acme.fullname" . }}-worker',
        'spec:',
        '    template:',
        '        spec:',
        '            containers:',
        '                - name: worker',
        '                  image: "{{ .Values.image.repository }}:latest"',
      ].join('\n') + '\n',
      'templates/_helpers.tpl': '{{- define "acme.fullname" -}}\nacme\n{{- end -}}\n',
    });

    const text = await runModule('helm-charts-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('an Ansible playbook that becomes root and one that does not', async () => {
    const app = appWith('ansible', {
      'ansible/playbook.yml': [
        '- hosts: web',
        '  become: true',
        '  gather_facts: true',
        '  vars:',
        '      app_env: prod',
        '      db_password: hunter2',
        '  tasks:',
        '      - name: Install packages',
        '        apt:',
        '            name: ["php8.3-fpm", "nginx"]',
        '            state: present',
        '',
        '      - name: Copy the environment file',
        '        template:',
        '            src: env.j2',
        '            dest: /var/www/html/.env',
        '            mode: "0644"',
        '        no_log: false',
        '',
        '      - name: Restart php-fpm',
        '        service:',
        '            name: php8.3-fpm',
        '            state: restarted',
        '        become_user: root',
      ].join('\n') + '\n',
      'ansible/deploy.yml': [
        '- hosts: web',
        '  gather_facts: false',
        '  tasks:',
        '      - name: Pull the release',
        '        git:',
        '            repo: git@example.com:acme/app.git',
        '            dest: /var/www/html',
        '            version: main',
        '',
        '      - name: Warm the cache',
        '        command: php bin/console cache:warmup',
      ].join('\n') + '\n',
      'ansible/inventory.ini': '[web]\nweb-1.example.com\nweb-2.example.com\n',
    });

    const text = await runModule('ansible-playbook-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a php.ini with the JIT on, and preloading', async () => {
    const app = appWith('php-ini', {
      'php.ini': [
        '[PHP]',
        'memory_limit = 512M',
        'max_execution_time = 30',
        'realpath_cache_size = 4096K',
        '',
        '[opcache]',
        'opcache.enable = 1',
        'opcache.enable_cli = 1',
        'opcache.memory_consumption = 256',
        'opcache.max_accelerated_files = 20000',
        'opcache.validate_timestamps = 0',
        'opcache.preload = /var/www/html/config/preload.php',
        'opcache.preload_user = www-data',
        'opcache.jit = tracing',
        'opcache.jit_buffer_size = 128M',
        'opcache.jit_hot_loop = 64',
        'opcache.jit_hot_func = 127',
      ].join('\n') + '\n',
      'config/preload.php': [
        '<?php',
        '',
        'if (file_exists(dirname(__DIR__).\'/var/cache/prod/App_KernelProdContainer.preload.php\')) {',
        '    require dirname(__DIR__).\'/var/cache/prod/App_KernelProdContainer.preload.php\';',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('php-jit-config.js', app);
    const second = await runModule('php-opcache-preload.js', app).catch(() => '');
    expect((text + second).length).toBeGreaterThan(0);
  });

  test('two-factor authentication, configured and half configured', async () => {
    const app = appWith('two-factor', {
      'config/packages/scheb_two_factor.yaml': [
        'scheb_two_factor:',
        '    security_tokens:',
        '        - Symfony\\Component\\Security\\Http\\Authenticator\\Token\\PostAuthenticationToken',
        '    trusted_device:',
        '        enabled: true',
        '        lifetime: 5184000',
        '        extend_lifetime: false',
        '    backup_codes:',
        '        enabled: true',
        '        manager: App\\Security\\BackupCodeManager',
        '    totp:',
        '        enabled: true',
        '        server_name: Acme',
        '        issuer: Acme',
        '        digits: 6',
        '        window: 1',
        '    email:',
        '        enabled: false',
        '        sender_email: no-reply@example.com',
        '        digits: 4',
      ].join('\n') + '\n',
      'config/packages/security.yaml': [
        'security:',
        '    firewalls:',
        '        main:',
        '            two_factor:',
        '                auth_form_path: 2fa_login',
        '                check_path: 2fa_login_check',
        '                enable_csrf: true',
        '    access_control:',
        '        - { path: ^/2fa, role: IS_AUTHENTICATED_2FA_IN_PROGRESS }',
      ].join('\n') + '\n',
      'src/Entity/User.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Scheb\\TwoFactorBundle\\Model\\Totp\\TwoFactorInterface;',
        'use Scheb\\TwoFactorBundle\\Model\\Totp\\TotpConfigurationInterface;',
        'use Scheb\\TwoFactorBundle\\Model\\Totp\\TotpConfiguration;',
        '',
        'class User implements TwoFactorInterface',
        '{',
        '    private ?string $totpSecret = null;',
        '',
        '    public function isTotpAuthenticationEnabled(): bool',
        '    {',
        '        return $this->totpSecret !== null;',
        '    }',
        '',
        '    public function getTotpAuthenticationUsername(): string { return "user"; }',
        '',
        '    public function getTotpAuthenticationConfiguration(): ?TotpConfigurationInterface',
        '    {',
        '        return new TotpConfiguration($this->totpSecret, TotpConfiguration::ALGORITHM_SHA1, 30, 6);',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-security-two-factor.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('Twig namespaces, one of them pointing at a directory that is not there', async () => {
    const app = appWith('twig-namespaces', {
      'config/packages/twig.yaml': [
        'twig:',
        '    default_path: "%kernel.project_dir%/templates"',
        '    paths:',
        '        "%kernel.project_dir%/templates/email": email',
        '        "%kernel.project_dir%/templates/admin": admin',
        '        "%kernel.project_dir%/vendor/acme/bundle/templates": AcmeBundle',
        '        "%kernel.project_dir%/templates/missing": missing',
        '        "%kernel.project_dir%/assets/templates": ~',
      ].join('\n') + '\n',
      'templates/email/welcome.html.twig': '{% extends "@email/layout.html.twig" %}\n',
      'templates/email/layout.html.twig': '<html>{% block body %}{% endblock %}</html>\n',
      'templates/admin/dashboard.html.twig': [
        '{% extends "@admin/layout.html.twig" %}',
        '{% include "@AcmeBundle/widget.html.twig" %}',
        '{% include "@nowhere/thing.html.twig" %}',
      ].join('\n') + '\n',
      'templates/admin/layout.html.twig': '<html>{% block body %}{% endblock %}</html>\n',
      'assets/templates/component.html.twig': '<div>{{ value }}</div>\n',
    });

    const text = await runModule('twig-namespace-paths.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('requests built from user input, and templates rendered from it', async () => {
    const app = appWith('ssrf-and-templates', {
      'src/Service/Fetcher.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use GuzzleHttp\\Client;',
        'use Symfony\\Contracts\\HttpClient\\HttpClientInterface;',
        '',
        'class Fetcher',
        '{',
        '    public function __construct(private HttpClientInterface $http) {}',
        '',
        '    public function fetch(): string',
        '    {',
        '        $url = $_GET["url"];',
        '        $body = file_get_contents($url);',
        '',
        '        $ch = curl_init($url);',
        '        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);',
        '        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);',
        '        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);',
        '        $curl = curl_exec($ch);',
        '        curl_close($ch);',
        '',
        '        $client = new Client();',
        '        $guzzle = $client->get($_POST["endpoint"])->getBody()->getContents();',
        '',
        '        $symfony = $this->http->request("GET", $_REQUEST["target"])->getContent();',
        '',
        '        return $body . $curl . $guzzle . $symfony;',
        '    }',
        '',
        '    public function safe(): string',
        '    {',
        '        return $this->http->request("GET", "https://api.example.com/status")->getContent();',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Service/Renderer.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Twig\\Environment;',
        'use Twig\\Loader\\ArrayLoader;',
        '',
        'class Renderer',
        '{',
        '    public function __construct(private Environment $twig) {}',
        '',
        '    public function render(): string',
        '    {',
        '        $template = $_GET["template"];',
        '        $twig = new Environment(new ArrayLoader(["page" => $template]));',
        '',
        '        return $twig->render("page", ["name" => $_GET["name"]])',
        '            . $this->twig->createTemplate($_POST["body"])->render([])',
        '            . eval("return \\"" . $_GET["expr"] . "\\";");',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const results = await Promise.all([
      runModule('php-ssrf-patterns.js', app),
      runModule('php-template-injection.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('processes started from PHP, one of them from request data', async () => {
    const app = appWith('process', {
      'src/Service/Exporter.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Symfony\\Component\\Process\\Process;',
        'use Symfony\\Component\\Process\\Exception\\ProcessFailedException;',
        '',
        'class Exporter',
        '{',
        '    public function export(string $table): string',
        '    {',
        '        $process = new Process(["pg_dump", "--table", $table]);',
        '        $process->setTimeout(300);',
        '        $process->run();',
        '',
        '        if (!$process->isSuccessful()) {',
        '            throw new ProcessFailedException($process);',
        '        }',
        '',
        '        return $process->getOutput();',
        '    }',
        '',
        '    public function risky(): string',
        '    {',
        '        $process = Process::fromShellCommandline("convert " . $_GET["file"] . " out.png");',
        '        $process->setTimeout(null);',
        '        $process->start();',
        '        $process->wait();',
        '',
        '        exec("ls " . $_POST["dir"], $output);',
        '        shell_exec("rm -rf " . $_REQUEST["path"]);',
        '',
        '        return implode("\\n", $output);',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-process.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a voter that denies by default and one that grants by default', async () => {
    const app = appWith('custom-voter', {
      'src/Security/Voter/PostVoter.php': [
        '<?php',
        'namespace App\\Security\\Voter;',
        '',
        'use Symfony\\Component\\Security\\Core\\Authentication\\Token\\TokenInterface;',
        'use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;',
        '',
        'final class PostVoter extends Voter',
        '{',
        '    public const EDIT = "POST_EDIT";',
        '',
        '    protected function supports(string $attribute, mixed $subject): bool',
        '    {',
        '        return $attribute === self::EDIT && $subject instanceof \\App\\Entity\\Post;',
        '    }',
        '',
        '    protected function voteOnAttribute(string $attribute, mixed $subject, TokenInterface $token): bool',
        '    {',
        '        $user = $token->getUser();',
        '        if (!$user instanceof \\App\\Entity\\User) {',
        '            return false;',
        '        }',
        '',
        '        return $subject->getAuthor() === $user;',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Security/Voter/PermissiveVoter.php': [
        '<?php',
        'namespace App\\Security\\Voter;',
        '',
        'use Symfony\\Component\\Security\\Core\\Authentication\\Token\\TokenInterface;',
        'use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\VoterInterface;',
        '',
        'class PermissiveVoter implements VoterInterface',
        '{',
        '    public function vote(TokenInterface $token, mixed $subject, array $attributes): int',
        '    {',
        '        return VoterInterface::ACCESS_GRANTED;',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Security/Voter/AbstainingVoter.php': [
        '<?php',
        'namespace App\\Security\\Voter;',
        '',
        'use Symfony\\Component\\Security\\Core\\Authentication\\Token\\TokenInterface;',
        'use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;',
        '',
        'class AbstainingVoter extends Voter',
        '{',
        '    protected function supports(string $attribute, mixed $subject): bool',
        '    {',
        '        return true;',
        '    }',
        '',
        '    protected function voteOnAttribute(string $attribute, mixed $subject, TokenInterface $token): bool',
        '    {',
        '        return true;',
        '    }',
        '}',
      ].join('\n') + '\n',
      'config/packages/security.yaml': [
        'security:',
        '    access_decision_manager:',
        '        strategy: affirmative',
        '        allow_if_all_abstain: true',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-security-custom-voter.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('validation mapped automatically, and templates that query in a loop', async () => {
    const app = appWith('validator-and-twig', {
      'config/packages/validator.yaml': [
        'framework:',
        '    validation:',
        '        email_validation_mode: html5',
        '        auto_mapping:',
        '            App\\Entity\\: ["strict"]',
        '            App\\Dto\\: []',
        '        not_compromised_password:',
        '            enabled: false',
        '        mapping:',
        '            paths:',
        '                - "%kernel.project_dir%/config/validator"',
      ].join('\n') + '\n',
      'config/packages/dev/validator.yaml': [
        'framework:',
        '    validation:',
        '        not_compromised_password:',
        '            enabled: false',
      ].join('\n') + '\n',
      'src/Entity/Customer.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        'use Symfony\\Component\\Validator\\Constraints as Assert;',
        '',
        '#[ORM\\Entity]',
        'class Customer',
        '{',
        '    #[ORM\\Column(length: 255)]',
        '    #[Assert\\NotBlank]',
        '    private string $name = "";',
        '',
        '    #[ORM\\Column(length: 180, unique: true)]',
        '    private string $email = "";',
        '}',
      ].join('\n') + '\n',
      'templates/orders/list.html.twig': [
        '{% extends "base.html.twig" %}',
        '',
        '{% block body %}',
        '    {% for order in orders %}',
        '        <h2>{{ order.customer.name }}</h2>',
        '        {% for line in order.lines %}',
        '            <p>{{ line.product.name }} — {{ line.product.category.name }}</p>',
        '        {% endfor %}',
        '        {{ repository.findRelated(order.id)|length }}',
        '    {% endfor %}',
        '',
        '    {% for row in data.getAll() %}',
        '        {{ row.value }}',
        '    {% endfor %}',
        '{% endblock %}',
      ].join('\n') + '\n',
      'templates/base.html.twig': '<html>{% block body %}{% endblock %}</html>\n',
    });

    const results = await Promise.all([
      runModule('symfony-validator-auto-mapping.js', app),
      runModule('symfony-twig-profiling.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('a Redis Sentinel cache, and one pointing at a single node', async () => {
    const app = appWith('sentinel', {
      'config/packages/cache.yaml': [
        'framework:',
        '    cache:',
        '        app: cache.adapter.redis',
        '        default_redis_provider: "redis+sentinel://sentinel-1:26379,sentinel-2:26379,sentinel-3:26379/mymaster"',
        '        pools:',
        '            app.cache.sessions:',
        '                adapter: cache.adapter.redis',
        '                provider: "redis://single-node:6379"',
      ].join('\n') + '\n',
      'config/services.yaml': [
        'services:',
        '    app.redis.sentinel:',
        '        class: Redis',
        '        factory: ["Symfony\\\\Component\\\\Cache\\\\Adapter\\\\RedisAdapter", createConnection]',
        '        arguments:',
        '            - "redis+sentinel://sentinel-1:26379/mymaster"',
        '            -',
        '                redis_sentinel: mymaster',
        '                timeout: 5',
        '                retry_interval: 100',
        '                password: hunter2',
      ].join('\n') + '\n',
      '.env': 'REDIS_URL=redis+sentinel://sentinel-1:26379/mymaster\n',
    });

    const text = await runModule('symfony-cache-redis-sentinel.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
