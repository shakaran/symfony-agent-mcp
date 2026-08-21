# Category: integrations

Third-party integrations — Stripe, Slack, Sentry, Elasticsearch, Twilio, SendGrid, Mailgun, Datadog, OpenAI, OAuth.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### sentry-config

**Source:** `src/tools/sentry-config.ts`
**Functions:** `list_sentry_config`, `get_sentry_stats`

Detects `sentry/sentry-symfony` in `composer.json`, `config/packages/sentry.yaml` settings
(`dsn`, `environment`, `release`, `traces_sample_rate`); warns on DSN committed to `.env`
(use `SENTRY_DSN` env var), missing release tag, `traces_sample_rate=1.0` in production.

---

### datadog-integration

**Source:** `src/tools/datadog-integration.ts`
**Functions:** `list_datadog_integration`, `get_datadog_integration_stats`

Detects Datadog PHP tracer (`datadog/dd-trace`), APM config (`DD_SERVICE`, `DD_ENV`, `DD_VERSION`),
Monolog handler `DatadogHandler`, custom span creation. Warns on missing `DD_VERSION` (release
tracking), `DD_AGENT_HOST` not configured (no traces collected), tracing in CLI without
`DD_TRACE_CLI_ENABLED`.

---

### new-relic-integration

**Source:** `src/tools/new-relic-integration.ts`
**Functions:** `list_new_relic_integration`, `get_new_relic_integration_stats`

Detects New Relic PHP agent configuration: `newrelic.appname`, `NEW_RELIC_LICENSE_KEY`,
`ekino/newrelic-bundle` integration; warns on missing license key, `newrelic_start_transaction()`
in non-agent context.

---

### new-relic-php-agent

**Source:** `src/tools/new-relic-php-agent.ts`
**Functions:** `list_new_relic_php_agent`, `get_new_relic_php_agent_stats`

New Relic PHP agent configuration (from `newrelic.ini`): `newrelic.enabled`,
`newrelic.appname`, `newrelic.license`, `newrelic.transaction_tracer.record_sql` (obfuscated?),
cross-application tracing; warns on SQL recording not obfuscated, missing error handler.

---

### elastic-apm

**Source:** `src/tools/elastic-apm.ts`
**Functions:** `list_elastic_apm`, `get_elastic_apm_stats`

Elastic APM PHP agent: `elastic/apm-agent-php`, `ELASTIC_APM_*` env vars, `ElasticApmBundle`,
custom spans. Warns on missing service name/version, `SECRET_TOKEN` in plain `.env`, no error
capture.

---

### opentelemetry-config

**Source:** `src/tools/opentelemetry-config.ts`
**Functions:** `list_open_telemetry_config`, `get_open_telemetry_stats`

Detects OpenTelemetry bundle from `composer.json`, exporters, span processors, instrumentations,
sampler config.

---

### stripe-integration

**Source:** `src/tools/stripe-integration.ts`
**Functions:** `list_stripe_integration`, `get_stripe_integration_stats`

Detects `stripe/stripe-php` in `composer.json`, `STRIPE_SECRET_KEY`/`STRIPE_PUBLISHABLE_KEY`
env vars, `Stripe\Stripe::setApiKey()` calls, webhook handling with signature verification
(`\Stripe\Webhook::constructEvent()`); warns on API key not from env, missing webhook signature
verification, deprecated API version.

---

### stripe-billing

**Source:** `src/tools/stripe-billing.ts`
**Functions:** `list_stripe_billing`, `get_stripe_billing_stats`

Stripe Billing-specific: subscription lifecycle listeners, `customer.subscription.updated`
webhook handler, `Invoice`, `Subscription`, `PaymentIntent` event coverage. Warns on missing
`payment_intent.succeeded` handler, `invoice.payment_failed` not handled (churn risk).

---

### paypal-integration

**Source:** `src/tools/paypal-integration.ts`
**Functions:** `list_paypal_integration`, `get_paypal_integration_stats`

Detects PayPal PHP SDK, webhook IPN verification, `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET`
env. Warns on using IPN (deprecated — use Webhooks), sandbox credentials in production env.

---

### paypal-v2

**Source:** `src/tools/paypal-v2.ts`
**Functions:** `list_paypal_v2`, `get_paypal_v2_stats`

PayPal Orders v2 API: `paypal/paypal-checkout-sdk` / REST HTTP calls to `v2/checkout/orders`,
webhook verification via `PAYPAL-TRANSMISSION-SIG` header; warns on v1 Payments API usage
(deprecated), missing signature verification.

---

### braintree-integration

**Source:** `src/tools/braintree-integration.ts`
**Functions:** `list_braintree_integration`, `get_braintree_integration_stats`

Braintree payment gateway: `braintree/braintree_php`, `BraintreeGateway` instantiation, CSE/
client token generation, webhook notification parsing. Warns on missing signature
verification, hardcoded merchant ID.

---

### twilio-integration

**Source:** `src/tools/twilio-integration.ts`
**Functions:** `list_twilio_integration`, `get_twilio_integration_stats`

Detects `twilio/sdk` in `composer.json`, `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` env vars,
`Client::messages->create()` call sites; warns on credentials not from env, missing webhook
request validation.

---

### sendgrid-integration

**Source:** `src/tools/sendgrid-integration.ts`
**Functions:** `list_sendgrid_integration`, `get_sendgrid_integration_stats`

Detects `sendgrid/sendgrid` package, `SENDGRID_API_KEY` env var, Symfony Mailer
`sendgrid+smtp://` transport, webhook event handler; warns on API key in `.env` without env
var reference, missing event webhook signature check.

---

### mailgun-integration

**Source:** `src/tools/mailgun-integration.ts`
**Functions:** `list_mailgun_integration`, `get_mailgun_integration_stats`

Detects `mailgun/mailgun-php` or Symfony Mailer `mailgun+smtp://` / `mailgun+api://` transport;
`MAILGUN_KEY`/`MAILGUN_DOMAIN` env vars; webhook signature verification; warns on missing
domain config, wrong EU endpoint for EU accounts.

---

### algolia-integration

**Source:** `src/tools/algolia-integration.ts`
**Functions:** `list_algolia_integration`, `get_algolia_integration_stats`

Detects `algolia/algoliasearch-client-php` or `darvin/datagrid-algolia-bundle`;
`ALGOLIA_APP_ID`/`ALGOLIA_API_KEY`; index definition, `saveObject()` call sites. Warns on
write-protected Admin API key exposed in frontend env, missing `objectID` mapping.

---

### elasticsearch-mapping

**Source:** `src/tools/elasticsearch-mapping.ts`
**Functions:** `list_elasticsearch_mapping`, `get_elasticsearch_mapping_stats`

Scans FOS/Elastica mapping config (`fos_elastica.yaml`): indices, types, mappings, properties;
warns on `dynamic: true` (implicit mapping drift), missing `keyword` sub-field on analyzed
strings, `text` on ID fields, no `number_of_replicas` set.

---

### elasticsearch-percolate

**Source:** `src/tools/elasticsearch-percolate.ts`
**Functions:** `list_elasticsearch_percolate`, `get_elasticsearch_percolate_stats`

Detects Elasticsearch percolate query usage: `percolate` in mapping type, `PercolateQuery`,
`#[AsPercolation]` attributes; warns on percolation index without `query` field mapping,
queries not stored as documents.

---

### meilisearch-integration

**Source:** `src/tools/meilisearch-integration.ts`
**Functions:** `list_meilisearch_integration`, `get_meilisearch_integration_stats`

Meilisearch PHP client or Symfony bundle; index settings (`filterableAttributes`,
`sortableAttributes`, `searchableAttributes`); warns on missing API key, no index configured.

---

### mongodb-integration

**Source:** `src/tools/mongodb-integration.ts`
**Functions:** `list_mongodb_integration`, `get_mongodb_integration_stats`

Detects `doctrine/mongodb-odm`, `mongodb/mongodb` PHP library, `doctrine_mongodb.yaml`
connections; warns on `MONGOCLIENT_PERSIST` without pool management, missing `readPreference`
for replicated setup, ODM without indexes configured.

---

### oauth2-server

**Source:** `src/tools/oauth2-server.ts`
**Functions:** `list_oauth2_server`, `get_oauth2_server_stats`

Detects `league/oauth2-server` or `trikoder/oauth2-bundle`; reads grant types, scopes,
token TTL config; warns on implicit grant enabled, refresh token without rotation.

---

### google-oauth-integration

**Source:** `src/tools/google-oauth-integration.ts`
**Functions:** `list_google_oauth_integration`, `get_google_oauth_integration_stats`

Google OAuth/SSO via `KnpU/OAuth2-Client-Bundle` or `hwi/oauth-bundle`; `GOOGLE_CLIENT_ID`/
`GOOGLE_CLIENT_SECRET` env vars; scope declaration; warns on `email`+`profile` only scope
(add `openid`), missing state parameter.

---

### microsoft-graph-integration

**Source:** `src/tools/microsoft-graph-integration.ts`
**Functions:** `list_microsoft_graph_integration`, `get_microsoft_graph_integration_stats`

Microsoft Graph API (`microsoft/microsoft-graph`, `league/oauth2-client`);
`MICROSOFT_CLIENT_ID`/`TENANT_ID` env vars; Graph endpoint calls; warns on delegated permission
without user consent flow, missing token refresh.

---

### saml-integration

**Source:** `src/tools/saml-integration.ts`
**Functions:** `list_saml_integration`, `get_saml_integration_stats`

SAML2 setup via `lightsaml/sp-bundle` or `hslavich/onelogin-saml-bundle`; IDP metadata URL,
assertion decryption, attribute mapping; warns on missing signature verification, unsigned
AuthnRequest.

---

### league-oauth2

**Source:** `src/tools/league-oauth2.ts`
**Functions:** `list_league_oauth2`, `get_league_oauth2_stats`

League OAuth2 client integrations: providers registered, custom provider classes, scope
definitions; warns on `state` parameter disabled, insecure `redirect_uri`.

---

### grpc-integration

**Source:** `src/tools/grpc-integration.ts`
**Functions:** `list_grpc_integration`, `get_grpc_integration_stats`

gRPC PHP stubs (`google/protobuf`, `grpc/grpc`), proto file locations, generated client
stubs; warns on missing TLS channel credentials, no retry/timeout policy.

---

### openai-integration

**Source:** `src/tools/openai-integration.ts`
**Functions:** `list_openai_integration`, `get_openai_integration_stats`

Detects OpenAI PHP SDK (`openai-php/client`), `OPENAI_API_KEY` env var, `OpenAI::client()`
call sites, model names used (`gpt-4`, `gpt-3.5-turbo`); warns on API key hardcoded, streaming
without timeout, no error handling for rate limits.

---

### bugsnag-integration

**Source:** `src/tools/bugsnag-integration.ts`
**Functions:** `list_bugsnag_integration`, `get_bugsnag_integration_stats`

Detects `bugsnag/bugsnag-laravel` / `bugsnag/bugsnag-php`, `BUGSNAG_API_KEY` env var, Monolog
handler; warns on missing `releaseStage` config, breadcrumbs not enabled.

---

### slack-webhook-integration

**Source:** `src/tools/slack-webhook-integration.ts`
**Functions:** `list_slack_webhook_integration`, `get_slack_webhook_integration_stats`

Detects Slack webhook URLs in `.env`, Monolog `SlackHandler`/`SlackWebhookHandler`, Symfony
Notifier `slack://` transport; warns on webhook URL committed without env var, no rate limit
on Slack notifications, bare URL without signing.

---

### github-api-integration

**Source:** `src/tools/github-api-integration.ts`
**Functions:** `list_github_api_integration`, `get_github_api_integration_stats`

Detects `knplabs/github-api` or direct GitHub REST API calls; `GITHUB_TOKEN` env var;
webhook signature verification (`X-Hub-Signature-256`); warns on token committed to `.env`,
missing webhook signature check, rate limit handling absent.

---

### shopify-integration

**Source:** `src/tools/shopify-integration.ts`
**Functions:** `list_shopify_integration`, `get_shopify_integration_stats`

Shopify Partner API / Shopify Admin REST API; `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET_KEY`;
webhook HMAC validation; warns on webhook handler without HMAC verification, using deprecated
Shopify API version.

---

### zendesk-integration

**Source:** `src/tools/zendesk-integration.ts`
**Functions:** `list_zendesk_integration`, `get_zendesk_integration_stats`

Zendesk REST API client integration: `zendesk/zendesk_api_client_php`, `ZENDESK_*` env vars,
webhook handler; warns on API token in plain env file, missing subdomain configuration.

---

### intercom-integration

**Source:** `src/tools/intercom-integration.ts`
**Functions:** `list_intercom_integration`, `get_intercom_integration_stats`

Intercom API: `intercom/intercom-php`, `INTERCOM_ACCESS_TOKEN` env var, webhook verification;
warns on access token not from env, missing `X-Hub-Signature` verification.

---

### segment-analytics

**Source:** `src/tools/segment-analytics.ts`
**Functions:** `list_segment_analytics`, `get_segment_analytics_stats`

Segment analytics integration: `segmentio/analytics-php`, `SEGMENT_WRITE_KEY` env var, `track()`/
`identify()`/`page()` call sites; warns on API key committed, PII in event properties,
`identify()` without userId, missing event naming convention.

---

### hubspot-integration

**Source:** `src/tools/hubspot-integration.ts`
**Functions:** `list_hubspot_integration`, `get_hubspot_integration_stats`

HubSpot CRM API: `hubspot/hubspot-php-client`, `HUBSPOT_API_KEY`/`HUBSPOT_PRIVATE_APP_TOKEN`
env vars, form submission handler; warns on deprecated API key auth (use private app token),
missing error handling.

---

### firebase-integration

**Source:** `src/tools/firebase-integration.ts`
**Functions:** `list_firebase_integration`, `get_firebase_integration_stats`

Firebase PHP SDK (`kreait/firebase-php`), FCM push notifications, service account credentials;
warns on service account JSON committed (use env var), FCM without topic routing.

---

### owasp-dependency-check

**Source:** `src/tools/owasp-dependency-check.ts`
**Functions:** `list_owasp_dependency_check`, `get_owasp_dependency_check_stats`

OWASP Dependency Check: `dependencycheck.properties` or CI step; `suppressionFile` presence;
warns on no OWASP scan in CI, suppression file with no comments on suppressed CVEs.

---

### composer-security-audit

**Source:** `src/tools/composer-security-audit.ts`
**Functions:** `list_composer_audit_config`, `get_composer_audit_stats`

Detects `composer audit` / `local-php-security-checker` / `roave/security-advisories` in CI;
warns on missing security audit step, `ignore:` list in `composer.json` without comment,
security advisories package not pinned.

---

### symfony-secrets-vault

**Source:** `src/tools/symfony-secrets-vault.ts`
**Functions:** `list_secrets`, `get_secrets_stats`

All secret names from `config/secrets/{env}/` directories (any environment). Returns secret
names only (values never read). Reports vault backends detected: Sodium local vault, AWS
Secrets Manager vault, custom vault. Warns when `SYMFONY_DECRYPTION_SECRET` is present in
`.env` files (should be env variable, not committed).

---

### symfony-secrets-rotation

**Source:** `src/tools/symfony-secrets-rotation.ts`
**Functions:** `list_symfony_secrets_rotation`, `get_symfony_secrets_rotation_stats`

Detects secrets rotation procedures: `bin/console secrets:generate-keys --rotate`, rotation
scripts in `Makefile`/CI, rotation schedule comments in vault YAML; warns on no rotation
procedure documented, decryption key in `.env` (rotation impossible), missing backup key.

---

### symfony-gdpr-compliance

**Source:** `src/tools/symfony-gdpr-compliance.ts`
**Functions:** `list_symfony_gdpr_compliance`, `get_symfony_gdpr_compliance_stats`

GDPR data subject implementation patterns: user data export (`UserDataExportInterface`),
right-to-erasure (`UserDataAnonymizationInterface`), consent logging; warns on email/name
fields without anonymization, missing erasure handler, no consent audit log.

---

### symfony-webauthn

**Source:** `src/tools/symfony-webauthn.ts`
**Functions:** `list_symfony_webauthn`, `get_symfony_webauthn_stats`

WebAuthn/FIDO2 (`web-auth/webauthn-symfony-bundle`): authenticator registration, assertion
verification, credential storage; warns on missing RP ID validation, user verification not
required for high-security actions.

---

### symfony-two-factor

**Source:** `src/tools/symfony-two-factor.ts`
**Functions:** `list_two_factor_config`, `get_two_factor_stats`

Reads `scheb/2fa-bundle` configuration: `google`, `email`, `totp` authenticator enablement,
`trusted_device` TTL, `backup_codes` provider, `ip_whitelist`. Scans `src/Security/` for
`TwoFactorInterface`/`BackupCodeInterface` implementations and `TwoFactorProviderInterface`.
Flags missing backup codes provider and trusted IP bypass.

---

### symfony-oauth-sso

**Source:** `src/tools/symfony-oauth-sso.ts`
**Functions:** `list_oauth_sso_config`, `get_oauth_sso_stats`

Reads `knpu_oauth2_client.yaml` provider list (type, credentials presence), or `hwi_oauth.yaml`
resource owners. Scans `src/Security/` for classes implementing `OAuthAwareUserProviderInterface`
or extending `AbstractSocialAuthenticator`. Flags missing `state` parameter, missing user
creation on first login.

---

### symfony-ldap-auth

**Source:** `src/tools/symfony-ldap-auth.ts`
**Functions:** `list_symfony_ldap_auth`, `get_symfony_ldap_auth_stats`

Symfony LDAP security configuration: `security.yaml` LDAP provider, `ldap.yaml` connection
options; warns on missing `encryption: tls`, bind password in plain config, no `dn_string`
configured.

---

### sonata-admin

**Source:** `src/tools/sonata-admin.ts`
**Functions:** `list_sonata_admin`, `get_sonata_admin_stats`

Detects `sonata-project/admin-bundle` in `composer.json` and `SonataAdminBundle` in
`bundles.php`. Reads `sonata_admin.yaml` config. Scans `src/Admin/` for classes extending
`AbstractAdmin`: associated entity, configured `configureListFields()`/`configureFormFields()`/
`configureDatagridFilters()`. Flags admin classes without access control and default
`dashboard_groups` with no items.

---

### symfony-search-integration

**Source:** `src/tools/symfony-search-integration.ts`
**Functions:** `list_search_integration`, `get_search_integration_stats`

Detects FOS Elastica, Doctrine Search, Meilisearch, Algolia bundles; reads index mappings and
entity subscriptions; warns on no search bundle installed, entity updated but not re-indexed.

---

### symfony-pdf-generation

**Source:** `src/tools/symfony-pdf-generation.ts`
**Functions:** `list_symfony_pdf_generation`, `get_symfony_pdf_generation_stats`

PDF generation patterns (`dompdf/dompdf`, `knplabs/knp-snappy-bundle`, `gotenberg`);
warns on synchronous PDF generation in request cycle (use queue), missing Twig template caching.

---

### symfony-image-processing

**Source:** `src/tools/symfony-image-processing.ts`
**Functions:** `list_symfony_image_processing`, `get_symfony_image_processing_stats`

Image manipulation libs (`liip/imagine-bundle`, `intervention/image`); image resizing
controllers, filter sets, cache strategies; warns on original image served without resize.

---

### symfony-excel-generation

**Source:** `src/tools/symfony-excel-generation.ts`
**Functions:** `list_symfony_excel_generation`, `get_symfony_excel_generation_stats`

Spreadsheet generation (`phpoffice/phpspreadsheet`, `fastexcel/fastexcel`);
`StreamedResponse` usage; warns on large dataset without streaming, memory limit not raised.

---

### symfony-file-archive

**Source:** `src/tools/symfony-file-archive.ts`
**Functions:** `list_symfony_file_archive`, `get_symfony_file_archive_stats`

Archive generation (`ZipArchive`, `PharData`); temp file cleanup; warns on `addFromString()`
without sanitized filename (path traversal), missing `close()` call.

---

### symfony-gedmo

**Source:** `src/tools/symfony-gedmo.ts`
**Functions:** `list_gedmo_config`, `get_gedmo_stats`

Reads `stof_doctrine_extensions.yaml` for enabled extensions (Timestampable, Blameable,
Sluggable, Translatable, Sortable, Loggable, SoftDeleteable, Tree). Scans entities for
`#[Timestampable]`, `#[Blameable]`, `#[Slug]`, `#[Translatable]`, `#[TreeLeft]`, etc.
Flags Blameable without `TokenStorageInterface` service registered, Slug without source field.

---

### gedmo-tree

**Source:** `src/tools/gedmo-tree.ts`
**Functions:** `list_gedmo_tree`, `get_gedmo_tree_stats`

Gedmo Tree extension: `#[Tree]` strategy (`nested`/`closure`/`materialized_path`/`adjacency`),
`#[TreeLeft]`/`#[TreeRight]`/`#[TreeLevel]`/`#[TreeRoot]`/`#[TreeParent]` fields. Warns on
missing index on `lft`/`rgt`, nested set without `root` field (multi-root problem).

---

### gedmo-translatable

**Source:** `src/tools/gedmo-translatable.ts`
**Functions:** `list_gedmo_translatable`, `get_gedmo_translatable_stats`

Gedmo Translatable: `#[Translatable]` fields, `TranslatableListener` registration,
`Translation` entity; warns on `$locale` not persisted separately, `stof_doctrine_extensions`
not configured with locale, entity without primary translation.

---

### gedmo-sluggable

**Source:** `src/tools/gedmo-sluggable.ts`
**Functions:** `list_gedmo_sluggable`, `get_gedmo_sluggable_stats`

Gedmo Sluggable: `#[Slug]` with `fields:`, `updatable`, `unique` options; warns on slug not
indexed (`unique: true` without DB unique index), multi-field slug without separator.

---

### gedmo-blameable

**Source:** `src/tools/gedmo-blameable.ts`
**Functions:** `list_gedmo_blameable`, `get_gedmo_blameable_stats`

Gedmo Blameable: `#[Blameable(on: 'create')]`, `#[Blameable(on: 'update')]` fields;
warns on Blameable used in CLI context without user provider, `blame` set to string instead
of entity relation.

---

### symfony-htmx

**Source:** `src/tools/symfony-htmx.ts`
**Functions:** `list_symfony_htmx`, `get_symfony_htmx_stats`

HTMX integration: `HX-Request`/`HX-Trigger`/`HX-Target`/`HX-Swap` header detection in
controllers, `HX-Location` response headers, Twig partial templates returning fragments;
warns on CSRF absent on HTMX POST endpoints.

---

### symfony-alpine-js

**Source:** `src/tools/symfony-alpine-js.ts`
**Functions:** `list_symfony_alpine_js`, `get_symfony_alpine_js_stats`

Alpine.js (`alpinejs` npm package or CDN), `x-data`/`x-bind`/`x-on`/`x-model` usage in
Twig templates; warns on `x-model` on element without form context, Alpine version loaded
from CDN without SRI hash.

---

### symfony-kubernetes-config

**Source:** `src/tools/symfony-kubernetes-config.ts`
**Functions:** `list_kubernetes_config`, `get_kubernetes_config_stats`

Scans Kubernetes manifests; warns on `APP_ENV=prod` not from `ConfigMap`/`Secret`,
`DATABASE_URL` in manifest plain text, no resource limits, no pod disruption budget.
