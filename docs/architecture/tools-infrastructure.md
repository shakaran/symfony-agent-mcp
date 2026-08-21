# Category: infrastructure

Infrastructure tools — Docker, CI/CD, Kubernetes, Terraform, Helm, Nginx, serverless, cloud platforms.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### docker-inspector

**Source:** `src/tools/docker-inspector.ts`
**Functions:** `list_docker_config`, `get_docker_stats`

Parses `Dockerfile` (base image, PHP version, installed extensions via `docker-php-ext-install`
and `pecl install`, multi-stage build detection, `USER` instruction check, `APP_ENV` ARG/ENV,
`composer install` presence). Parses `docker-compose.yml` / `compose.yml` /
`docker-compose.override.yml`: service role classification (PHP, web server, database, cache,
message broker, search, mail), port mappings, volume mounts, healthcheck presence. Cross-checks
PHP version between Dockerfile and `composer.json`. Flags: running as root, `vendor/` mounted
as volume, missing healthchecks on critical services.

---

### cicd-config

**Source:** `src/tools/cicd-config.ts`
**Functions:** `list_cicd_config`, `get_cicd_stats`

Scans GitHub Actions workflows (`.github/workflows/*.yml`) and GitLab CI (`.gitlab-ci.yml`)
for PHP version matrix, Composer install, PHPUnit/Behat test steps, PHPStan/Psalm/CS-Fixer
static analysis, `bin/console` commands (migrate/cache:warmup), and deployment steps.
Flags deployments that run without a test gate. Also parses `Makefile` for Symfony-related
targets. Pure YAML/text parsing — no CI API calls.

---

### deployment-config

**Source:** `src/tools/deployment-config.ts`
**Functions:** `list_deployment_config`, `get_deployment_stats`

Distinct from `docker-inspector.ts` (local Docker). Covers production infrastructure:
Kubernetes Deployment (replicas, resource limits/requests, readiness/liveness probes) + HPA
(min/max replicas) + Ingress, Helm values, Fly.io `fly.toml` (vm size, min/max machines),
Heroku `Procfile` (web/worker/release processes), Render.com `render.yaml` (plan, services),
Google Cloud `app.yaml` (runtime, instance class). Issues: replicas < 2, missing resource
limits, no probes, Heroku missing release process.

---

### terraform-config

**Source:** `src/tools/terraform-config.ts`
**Functions:** `list_terraform_config`, `get_terraform_config_stats`

Terraform IaC configuration: `*.tf` files under `terraform/infra/infrastructure/`; resource
blocks, providers, variables; flags hardcoded secrets, no remote backend, missing
`required_version`.

---

### helm-charts-config

**Source:** `src/tools/helm-charts-config.ts`
**Functions:** `list_helm_charts_config`, `get_helm_charts_config_stats`

Helm chart and values analysis: `Chart.yaml`, `values.yaml`, `templates/` under
`helm/charts/k8s/`; flags `image.tag: latest`, missing resource limits, no
liveness/readiness probes.

---

### caddy-server-config

**Source:** `src/tools/caddy-server-config.ts`
**Functions:** `list_caddy_server_config`, `get_caddy_server_config_stats`

Caddy web server configuration: `Caddyfile` / `caddy.json` parsing; TLS settings,
`reverse_proxy`, `encode gzip/zstd`, `root` directive; flags missing TLS, no compression,
proxy without health checks.

---

### webserver-config

**Source:** `src/tools/webserver-config.ts`
**Functions:** `list_webserver_config`, `get_webserver_config_stats`

Detects nginx/apache vhost configuration files. Checks HTTPS, PHP-FPM, gzip, HSTS,
X-Frame-Options. Warns on missing HTTPS/HSTS/clickjacking headers.

---

### nginx-php-fpm

**Source:** `src/tools/nginx-php-fpm.ts`
**Functions:** `list_nginx_php_fpm_config`, `get_nginx_php_fpm_stats`

Analyzes `nginx.conf` and `php-fpm.conf` in `docker/`; warns on large `client_max_body_size`,
`server_tokens on`, missing `X-Frame-Options`/CSP/HSTS headers, bad `try_files`, `pm=static`,
excessive `max_children`, `request_terminate_timeout=0`.

---

### nginx-unit-config

**Source:** `src/tools/nginx-unit-config.ts`
**Functions:** `list_nginx_unit_config`, `get_nginx_unit_config_stats`

Detects NGINX Unit server configuration: PHP application missing `processes` limits (unbounded
worker spawn), `user`/`group` set to `root`, missing `access_log` routing, HTTP listener
without TLS termination in production, `pass` routing to non-existent PHP application name.

---

### cron-jobs

**Source:** `src/tools/cron-jobs.ts`
**Functions:** `list_cron_jobs`, `get_cron_job_stats`

Scans external cron jobs outside SchedulerBundle: Dockerfile `crontab` / cron expressions,
docker-compose cron service, `supervisord.conf` programs, Kubernetes `kind: CronJob` manifests,
Platform.sh `.symfony.cloud.yaml` crons section, Procfile clock entries. Also identifies
console commands whose names suggest cron usage (contain "cron", "daily", "hourly", etc.).

---

### symfony-kubernetes

**Source:** `src/tools/symfony-kubernetes.ts`
**Functions:** `list_kubernetes_config`, `get_kubernetes_config_stats`

Scans Kubernetes manifests (`*.yaml`/`*.yml`) in `k8s`/`kubernetes`/`deploy`/`.kube` dirs;
warns on containers without `readinessProbe`/`livenessProbe`, missing `resources.limits`,
`latest` image tag in production, `hostNetwork: true`, secrets stored as env vars instead of
Secrets.

---

### kubernetes-manifests

**Source:** `src/tools/kubernetes-manifests.ts`
**Functions:** `list_kubernetes_manifests`, `get_kubernetes_manifests_stats`

Scans Kubernetes manifests (`.yaml`/`.yml` in `k8s/`, `kubernetes/`, `deploy/`): Deployments
without resource `requests`/`limits`, missing `livenessProbe`/`readinessProbe`, containers
running as root (`runAsUser: 0`), missing `securityContext.readOnlyRootFilesystem`, Services
with `type: LoadBalancer` in development, Ingress without TLS.

---

### docker-compose-health

**Source:** `src/tools/docker-compose-health.ts`
**Functions:** `list_docker_compose_health`, `get_docker_compose_health_stats`

Analyzes Docker Compose service health; warns on db/cache services without healthcheck, no
restart policy, `depends_on` without `condition: service_healthy`, missing resource limits on
web/app containers.

---

### docker-swarm-config

**Source:** `src/tools/docker-swarm-config.ts`
**Functions:** `list_docker_swarm_config`, `get_docker_swarm_config_stats`

Scans `docker-compose.yml`/`docker-compose.prod.yml`/`docker-compose.swarm.yml` for Swarm
deploy sections. Detects missing resource limits (OOM kill risk), missing `healthcheck` with
multiple replicas, `update_config` without `failure_action: rollback`, `stop-first` update
order (downtime), missing `restart_policy`, `rollback_config` without `parallelism`.

---

### circleci-config

**Source:** `src/tools/circleci-config.ts`
**Functions:** `list_circleci_config`, `get_circleci_config_stats`

CircleCI CI/CD pipeline configuration: `.circleci/config.yml`; jobs, workflows, orbs, caching;
flags no vendor/ cache, plain-text secrets, missing test parallelism.

---

### jenkins-config

**Source:** `src/tools/jenkins-config.ts`
**Functions:** `list_jenkins_config`, `get_jenkins_config_stats`

Jenkins pipeline configuration: `Jenkinsfile` (declarative/scripted); stages, agent, environment
block; flags plain-text credentials, no timeout, missing `post{failure{}}` block.

---

### github-actions-config

**Source:** `src/tools/github-actions-config.ts`
**Functions:** `list_github_actions_config`, `get_github_actions_config_stats`

Analyzes GitHub Actions workflows; warns on mutable refs, write permissions, `pull_request_target`
security, self-hosted runners without isolation.

---

### gitlab-ci-config

**Source:** `src/tools/gitlab-ci-config.ts`
**Functions:** `list_gitlab_ci_config`, `get_gitlab_ci_config_stats`

Analyzes GitLab CI configuration: hardcoded variables, sensitive artifacts, missing SAST,
`:latest` images.

---

### github-dependabot-config

**Source:** `src/tools/github-dependabot-config.ts`
**Functions:** `list_github_dependabot_config`, `get_github_dependabot_config_stats`

Scans `.github/dependabot.yml` for: missing `composer`/`npm`/`docker`/`github-actions`
ecosystems; no `open-pull-requests-limit`; missing `reviewers`/`assignees`; `interval: daily`
(suggest weekly); missing `groups:` for bundling minor/patch updates.

---

### symfony-health-probe

**Source:** `src/tools/symfony-health-probe.ts`
**Functions:** `list_health_probes`, `get_health_probe_stats`

Scans health/readiness endpoints and `HealthIndicatorInterface`; reads Docker/K8s manifests;
warns on combined liveness+readiness endpoint, DB check without timeout, unauthenticated probes.

---

### health-checks

**Source:** `src/tools/health-checks.ts`
**Functions:** `list_health_checks`, `get_health_check_stats`

Detects health/readiness/liveness endpoints through three independent mechanisms: YAML route
files (scans `config/routes/` for paths matching `/health`, `/healthz`, `/ready`, `/readyz`,
`/live`, `/livez`, `/ping`, `/status`); controller scanning for `#[Route]` attributes on
health-named controllers/methods; and implementation scanning for classes implementing
`HealthCheck`, `CheckInterface`, `HealthIndicator`, or similar interfaces.

---

### varnish-config

**Source:** `src/tools/varnish-config.ts`
**Functions:** `list_varnish_config`, `get_varnish_config_stats`

Analyzes Varnish VCL configuration; warns on missing grace period, no backend health probe, no
PURGE/BAN handler, cookie passthrough bypassing cache, missing `X-Forwarded-For`, Symfony
`trusted_proxies` not configured.

---

### cdn-config

**Source:** `src/tools/cdn-config.ts`
**Functions:** `list_cdn_config`, `get_cdn_config_stats`

Analyzes CDN configuration in Symfony; warns on HTTP CDN `base_url`, missing SRI integrity
attributes, CDN domains not in CSP, CORS wildcard origin, AssetMapper `server` not configured
for CDN delivery.

---

### prometheus-metrics

**Source:** `src/tools/prometheus-metrics.ts`
**Functions:** `list_prometheus_metrics`, `get_prometheus_metrics_stats`

Detects Prometheus metric instrumentation via `promphp/prometheus_client_php`; warns on dead
metrics (registered but never updated), counter `set()` usage, histogram without explicit
buckets, unauthenticated `/metrics` endpoint.

---

### prometheus-alerting-rules

**Source:** `src/tools/prometheus-alerting-rules.ts`
**Functions:** `list_prometheus_alerting_rules`, `get_prometheus_alerting_rules_stats`

Scans `*.rules.yml`, `prometheus/`, `monitoring/` for: alert rules without `for:` duration
(flapping); missing `severity` label; deprecated functions; non-PascalCase alert names;
missing `summary`/`description` annotations; recording rules without `labels:`.

---

### loki-log-config

**Source:** `src/tools/loki-log-config.ts`
**Functions:** `list_loki_log_config`, `get_loki_log_config_stats`

Detects Grafana Loki log shipping configuration: `promtail`/`alloy`/`fluentbit` config files
missing `labels` for service identification, scrape configs targeting non-existent log paths,
missing `pipeline_stages` for log parsing, Loki retention not configured. Flags `level` label
missing from log lines making alert routing impossible.

---

### grafana-dashboard

**Source:** `src/tools/grafana-dashboard.ts`
**Functions:** `list_grafana_dashboard`, `get_grafana_dashboard_stats`

Dashboard provisioning, datasource secrets, admin password, alert rules.

---

### ansible-playbook-config

**Source:** `src/tools/ansible-playbook-config.ts`
**Functions:** `list_ansible_playbook_config`, `get_ansible_playbook_config_stats`

Scans `*.yml`, `playbooks/`, `ansible/` for: `shell:`/`command:` with unquoted Jinja2 variables
(injection risk); `become: true` without `become_user`; plaintext secrets in `vars:` (masked);
missing `no_log: true`; unnecessary `gather_facts`; `ignore_errors: true` on critical tasks.

---

### symfony-roadrunner-config

**Source:** `src/tools/symfony-roadrunner-config.ts`
**Functions:** `list_symfony_roadrunner_config`, `get_symfony_roadrunner_stats`

Analyzes `.rr.yaml` RoadRunner configuration; warns on `num_workers=1`, excessive workers
(>256), `max_jobs=0` (no worker recycling), root user, debug log level, SSL without cert,
unconfigured pool.

---

### symfony-runtime-env

**Source:** `src/tools/symfony-runtime-env.ts`
**Functions:** `list_runtime_env`, `get_runtime_env_stats`

Detects FrankenPHP/RoadRunner/ReactPHP runtime packages and `APP_RUNTIME`; warns on missing
runtime config, `APP_RUNTIME` committed to `.env`.

---

### frankenphp-config

**Source:** `src/tools/frankenphp-config.ts`
**Functions:** `list_frankenphp_config`, `get_frankenphp_config_stats`

Caddyfile worker/TLS/compression/HTTP3/Mercure, docker-compose env.

---

### apache-config

**Source:** `src/tools/apache-config.ts`
**Functions:** `list_apache_config`, `get_apache_config_stats`

Rewrite rules, security headers, `ServerSignature`, directory listing, `AllowOverride`.

---

### traefik-config

**Source:** `src/tools/traefik-config.ts`
**Functions:** `list_traefik_config`, `get_traefik_config_stats`

Scans `traefik.yml/yaml`, `docker-compose.yml`, `.traefik/` for: missing HTTPS redirect
middleware; `insecureSkipVerify: true` (MITM risk); missing rate-limit middleware;
`api.insecure: true` (dashboard exposed); missing access logs; entrypoint without TLS;
`exposedByDefault: true` in Docker provider.

---

### vault-integration

**Source:** `src/tools/vault-integration.ts`
**Functions:** `list_vault_integration`, `get_vault_integration_stats`

HashiCorp Vault secrets management integration: `vault-php/vault` package, `VAULT_ADDR/TOKEN`
env, KV/transit/PKI paths; flags `VAULT_TOKEN` in `.env` (use AppRole/k8s auth), no TLS
verification.

---

### vault-dynamic-secrets

**Source:** `src/tools/vault-dynamic-secrets.ts`
**Functions:** `list_vault_dynamic_secrets`, `get_vault_dynamic_secrets_stats`

Scans `src/**/*.php`, `config/**/*.yaml`, `.env*` for: static DB credentials instead of Vault
dynamic secrets; missing lease renewal; `VAULT_TOKEN` in plaintext `.env` (masked); hardcoded
Vault address; `vault/` package used without TTL-aware credential refresh.

---

### docker-security-config

**Source:** `src/tools/docker-security-config.ts`
**Functions:** `list_docker_security_config`, `get_docker_security_config_stats`

Root user, privileged mode, ENV secrets, `:latest` tags, `cap_drop`.

---

### cloudwatch-integration

**Source:** `src/tools/cloudwatch-integration.ts`
**Functions:** `list_cloudwatch_integration`, `get_cloudwatch_integration_stats`

Monolog handlers, static credentials, alarms, log retention, X-Ray.

---

### symfony-cli

**Source:** `src/tools/symfony-cli.ts`
**Functions:** `list_symfony_cli_config`, `get_symfony_cli_stats`

Reads SymfonyCloud / Platform.sh config: `.symfony.cloud.yaml` (app name, PHP version, build
flavor, relationships, workers, crons, mounts, disk, env variables), `.platform/routes.yaml`
(routes with upstream/redirect types), `.platform/services.yaml` (services: type, disk).
Cross-checks PHP version against `composer.json` requirement.

---

### pwa-manifest-config

**Source:** `src/tools/pwa-manifest-config.ts`
**Functions:** `list_pwa_manifest_config`, `get_pwa_manifest_stats`

Analyzes PWA `manifest.json`/`site.webmanifest`; warns on missing 512×512 icon, `short_name`
exceeding 12 chars, invalid display value, missing service worker, no `offline.html`,
non-root-relative `start_url`.

---

### swoole-openswoole

**Source:** `src/tools/swoole-openswoole.ts`
**Functions:** `list_swoole_openswoole`, `get_swoole_openswoole_stats`

Server config, shared static state, coroutine-unsafe PDO, Symfony Runtime.

---

### file-storage

**Source:** `src/tools/file-storage.ts`
**Functions:** `list_file_storage`, `get_file_storage_stats`

Reads VichUploaderBundle config (`vich_uploader.yaml`: mappings — URI prefix, upload
destination, delete-on-update/remove flags). Reads Flysystem storages (`flysystem.yaml` or
`oneup_flysystem.yaml`: adapter type — local/S3/GCS/Azure/SFTP — with DSN/key masked). Scans
entities for `#[Vich\UploadableField]` with mapping name extraction. Warns on local adapter
(not suitable for multi-server) and files stored in `public/` without auth.
