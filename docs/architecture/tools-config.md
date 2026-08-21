# Category: config

Environment and framework configuration — env config, framework settings, Monolog, CORS, locale, feature flags.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### env-diff

**Source:** `src/tools/env-diff.ts`
**Functions:** `list_env_files`, `diff_env_files`, `find_sensitive_env_keys`, `get_env_stats`

Inventory of all `.env*` files with key counts; warns about `.env.local.php`. Compare all files
vs reference; report missing/undocumented keys per env. Audit `.env` for sensitive keys (tokens,
DSNs) with real values. Recognizes sensitive patterns: `SECRET`, `PASSWORD`, `TOKEN`, `API_KEY`,
`DSN`, `DATABASE_URL`, etc. Set `SYMFONY_MCP_SHOW_ENV_VALUES=true` to show non-sensitive values
in diffs.

---

### di-parameters

**Source:** `src/tools/di-parameters.ts`
**Functions:** `list_di_parameters`, `search_di_parameters`, `get_di_parameter_stats`

All `%parameters%` from `services.yaml` and `config/packages/*.yaml`, grouped by source
(sensitive values masked). Search by name or value; shows which services reference each matched
parameter. Flattens nested parameter objects into dot-notation keys. Masks values whose names
match `SECRET`, `PASSWORD`, `TOKEN`, `KEY`, `DSN`, `AUTH`, `PRIVATE`, `SALT` patterns.

---

### env-config-diff

**Source:** `src/tools/env-config-diff.ts`
**Functions:** `list_env_config_diff`, `get_env_config_diff_stats`

Packages with dev/prod/test overrides, overridden top-level keys per env, bundles registered
only for specific environments. Compares `config/packages/*.yaml` (base) against
`config/packages/{dev,prod,test}/*.yaml`. Lists which packages have no prod override (only dev).
Reads `config/bundles.php` to detect env-restricted bundle registration. Answers
"what changes between dev and prod?"

---

### cors

**Source:** `src/tools/cors.ts`
**Functions:** `list_cors_config`, `get_cors_stats`

NelmioCorsBundle path patterns with `allow_origin`, `allow_methods`, `allow_headers`,
`credentials`, `max_age`; flags dangerous combinations. Reads `config/packages/nelmio_cors.yaml`.
Detects critical misconfigurations: `allow_credentials=true` with wildcard origin, wildcard
`allow_headers`, all-methods patterns, missing `max_age`.

---

### monolog

**Source:** `src/tools/monolog.ts`
**Functions:** `list_monolog_config`, `get_monolog_stats`

All handlers (type, level, channels, path/URL masked), alert handlers (Slack/email/Sentry),
fingers-crossed buffers with `action_level`, custom channels and processors. Reads
`config/packages/monolog.yaml` plus `dev/` and `prod/` overrides, merging by handler name.
Labels all built-in handler types (stream, rotating_file, gelf, slack, sentry, etc.).

---

### feature-flags

**Source:** `src/tools/feature-flags.ts`
**Functions:** `list_feature_flags`, `get_feature_flag_stats`

Detects feature flag systems: Flagception bundle (YAML flags with on/off state), Unleash,
Flagsmith, OpenFeature. Scans `.env` files for `FEATURE_*`/`ENABLE_*`/`FLAG_*` env vars and
`services.yaml` for `feature.*` parameters. Reports classes calling `->isEnabled()` /
`->isActive()` and which flags they check.

---

### symfony-locale-config

**Source:** `src/tools/symfony-locale-config.ts`
**Functions:** `list_locale_config`, `get_locale_stats`

Reads `framework.yaml` `default_locale` and `enabled_locales`. Reads translator fallback chains
from `translation.yaml`/`framework.yaml`. Detects locales with translation files not in
`enabled_locales`. Warns when country-variant locales (e.g. `fr_CH`) have no base-language
fallback.

---

### symfony-config-extensions

**Source:** `src/tools/symfony-config-extensions.ts`
**Functions:** `list_config_extensions`, `get_config_extension_stats`

Finds bundle config extensions: classes implementing `ConfigurationInterface` or extending
`Extension`, `getAlias()`, `load()`, `getConfiguration()`. Warns: Extension without
`getAlias()`, alias mismatch with bundle name convention.

---

### symfony-config-environments

**Source:** `src/tools/symfony-config-environments.ts`
**Functions:** `list_env_config_overrides`, `get_env_config_override_stats`

Compares `config/packages/*.yaml` (base) against `dev/`, `prod/`, `test/` subdirectories.
Produces a presence table (base × env). Detects env-only packages, empty override files, and
top-level key mismatches between base and env override (possible typo).

---

### flex-recipes

**Source:** `src/tools/flex-recipes.ts`
**Functions:** `list_flex_recipes`, `get_flex_recipe_stats`

Reads `symfony.lock` to list all installed Flex recipes with their origin (official / contrib /
custom). Reports recipe version, packages that injected env vars (useful for 12-factor audits),
and warns on contrib recipes (community-maintained — should be reviewed).

---

### symfony-runtime

**Source:** `src/tools/symfony-runtime.ts`
**Functions:** `list_runtime_config`, `get_runtime_stats`

Reads `composer.json` `extra.runtime` configuration: class, env_var_name, dotenv_path,
prod_envs, test_envs, disable_dotenv. Checks `vendor/autoload_runtime.php` existence and
`public/index.php` runtime pattern. Scans for custom `RuntimeInterface`/`RunnerInterface`/
`ResolverInterface`.

---

### symfony-bundle-config-tree

**Source:** `src/tools/symfony-bundle-config-tree.ts`
**Functions:** `list_bundle_config_tree`, `get_bundle_config_tree_stats`

Detects `ConfigurationInterface`/`TreeBuilder` classes and `Extension::load()`. Reads root node
alias, config nodes. Warns on missing root node, missing `processConfiguration()`.

---

### symfony-intl-config

**Source:** `src/tools/symfony-intl-config.ts`
**Functions:** `list_symfony_intl_config`, `get_symfony_intl_stats`

Analyzes Symfony Intl component configuration; warns on missing `symfony/intl`, ICU data not
installed, locale not validated against `Intl::getLocales()`.

---

### monolog-channel-mapping

**Source:** `src/tools/monolog-channel-mapping.ts`
**Functions:** `list_monolog_channel_mapping`, `get_monolog_channel_stats`

Reads `monolog.yaml` channel definitions and handler routing. Warns on channels with no explicit
routing, >3 handlers per channel.

---

### blackfire-config

**Source:** `src/tools/blackfire-config.ts`
**Functions:** `list_blackfire_config`, `get_blackfire_stats`

Detects `blackfire/php-sdk` in `composer.json`, `ext-blackfire`, Docker Compose `blackfire`
service, Blackfire Player `.bkf` scenario files in project/tests directories, PHP usage sites
(`BlackfireProbe`, `BlackfireClient`), and `BLACKFIRE_*` credentials in `.env` files.

---

### symfony-maker-config

**Source:** `src/tools/symfony-maker-config.ts`
**Functions:** `list_maker_config`, `get_maker_stats`

Reads `config/packages/maker.yaml` (`root_namespace`, `generate_final_classes`). Counts
generated classes by directory type: Entity, Controller, Form, Repository, Command,
EventSubscriber, EventListener, MessageHandler, DataFixtures, Security/Voter, Serializer.

---

### opentelemetry-config

**Source:** `src/tools/opentelemetry-config.ts`
**Functions:** `list_open_telemetry_config`, `get_open_telemetry_stats`

Detects OpenTelemetry bundle from `composer.json`, exporters, span processors, instrumentations,
sampler config.

---

### php-ini-analysis

**Source:** `src/tools/php-ini-analysis.ts`
**Functions:** `list_php_ini_settings`, `get_php_ini_stats`

Scans `php.ini`/`.user.ini` in the project; warns on `display_errors=On` in production,
`expose_php=On`, `memory_limit` below 256M, `max_execution_time=0`, missing `date.timezone`,
`log_errors=Off`, `error_reporting=0`.

---

### php-fpm-config

**Source:** `src/tools/php-fpm-config.ts`
**Functions:** `list_php_fpm_config`, `get_php_fpm_stats`

Parses `php-fpm.conf`/`www.conf` in the project tree; warns on `pm=static`,
`pm.max_children` above 200, `request_terminate_timeout=0`, missing `pm.max_requests`.

---

### opcache-apcu-config

**Source:** `src/tools/opcache-apcu-config.ts`
**Functions:** `list_opcache_apcu_config`, `get_opcache_apcu_stats`

Reads `php.ini`/`opcache.ini` from docker directories: `enabled`, `memory_consumption`,
`preload`, `validate_timestamps`, APCu `shm_size`.

---

### php-xdebug-config

**Source:** `src/tools/php-xdebug-config.ts`
**Functions:** `list_php_xdebug_config`, `get_php_xdebug_config_stats`

Xdebug configuration analysis: detects `xdebug.mode`, `start_with_request`, `client_host`
settings in `php.ini` / `conf.d` files; flags development modes active in production context.

---

### symfony-kernel-boot

**Source:** `src/tools/symfony-kernel-boot.ts`
**Functions:** `list_symfony_kernel_boot`, `get_symfony_kernel_boot_stats`

Detects custom Kernel boot customizations (`configureContainer`, `configureRoutes`,
boot/shutdown hooks); warns on expensive operations in `boot()`, missing environment-specific
bundle registration.

---

### symfony-multi-language-routing

**Source:** `src/tools/symfony-multi-language-routing.ts`
**Functions:** `list_symfony_multi_language_routing`, `get_symfony_multi_language_routing_stats`

Detects multi-language routing patterns; warns on `{_locale}` without requirements constraint,
missing default locale, static HTML `lang=` attribute, missing `hreflang` alternate links.
