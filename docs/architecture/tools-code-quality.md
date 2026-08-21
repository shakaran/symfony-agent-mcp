# Category: code-quality

Code quality and analysis tools — profiler, dead code detection, dependency graph, accessibility, code metrics, PHPStan, Rector, complexity.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### dead-code

**Source:** `src/tools/dead-code.ts`
**Functions:** `detect_dead_code`, `detect_orphan_controllers`, `detect_unused_form_types`

Full scan: orphan controllers + uninjected services + unused forms + commands. All detections
are **heuristic** — cross-references constructor injection, `->get()` locator calls, `new FormType()`
calls in controllers, and route→controller mappings. Tag-based injection and dynamic service
locators may produce false positives; always verify before removing.

---

### code-quality

**Source:** `src/tools/code-quality.ts`
**Functions:** `get_code_quality_report`, `get_god_classes`, `get_code_quality_stats`

All classes with violations: long methods (>30 lines), high complexity (>10 branches), constructor
bloat (>8 deps), oversized classes (>300 lines). Parses method bodies via brace-depth tracking.
Cyclomatic complexity estimated by counting `if`, `for`, `foreach`, `while`, `case`, `catch`,
`&&`, `||`, and ternary operators. Does not require PHP execution.

---

### dependency-graph

**Source:** `src/tools/dependency-graph.ts`
**Functions:** `analyze_dependency_graph`, `detect_circular_dependencies`, `get_dependency_graph_stats`

Fan-in top 15 (most-injected services), fan-out top 10 (most dependencies), circular chains,
layer violations. Parses constructor type hints from all PHP files in `src/`. Assigns layer
(Controller, Command, Service, Repository, Entity, Form, EventListener, MessageHandler).
Detects anti-patterns: Entity→Service, Entity→Repository, Repository→Controller.

---

### accessibility-audit

**Source:** `src/tools/accessibility-audit.ts`
**Functions:** `list_accessibility_issues`, `get_accessibility_stats`

Static WCAG 2.1 AA accessibility audit of Twig templates: `<img>` without `alt` (1.1.1),
`<button>` without accessible name (4.1.2), icon-only buttons missing `aria-label`, `<input>`
without `id`/`aria-labelledby`, `<table>` without `<caption>` or `aria-label`, `<th>` without
`scope` (1.3.1), `aria-hidden="true"` on focusable elements (1.3.1), `<label>` without `for`,
skipped heading levels and multiple `<h1>` (2.4.6). Issues classified as WCAG failure / warning
/ review-needed.

---

### profiler

**Source:** `src/tools/profiler.ts`
**Functions:** (profiler inspection)

Profiler integration: requests, SQL queries, memory, exceptions. Deep Symfony Web Profiler data
analysis across all collected profiles.

---

### static-analysis

**Source:** `src/tools/static-analysis.ts`
**Functions:** `get_static_analysis_config`, `get_static_analysis_stats`

PHPStan level/paths/extensions/baseline error count, Psalm error level/plugins/strict mode,
PHP CS Fixer ruleset, Rector sets. Reads `phpstan.neon`, `phpstan-baseline.neon`, `psalm.xml`,
`.php-cs-fixer.php`, `rector.php`. Parses baseline error count and top offending files. Warns
when the baseline exceeds 100 suppressed errors.

---

### phpstan-config

**Source:** `src/tools/phpstan-config.ts`
**Functions:** `list_phpstan_config`, `get_phpstan_stats`

Reads `phpstan.neon` / `phpstan.dist.neon`: level (0–10, warns if < 5), paths, phpVersion,
includes/extensions (phpstan-symfony, phpstan-doctrine, phpstan-phpunit, phpstan-strict-rules,
phpstan-deprecation-rules), baseline file and size (warns if > 200 entries),
`reportUnmatchedIgnoredErrors`, `ignoreErrors` count, `excludePaths`. Detects missing Symfony
or Doctrine extensions via `composer.json`.

---

### psalm-config

**Source:** `src/tools/psalm-config.ts`
**Functions:** `list_psalm_config`, `get_psalm_stats`

Reads `psalm.xml` / `psalm.xml.dist`: analysis level (1–8), plugins (psalm/plugin-symfony,
Doctrine, Twig, PHPUnit), suppressed issue types from `<issueHandlers>`, error baseline file
and suppression count, excluded paths, `findUnusedCode` / `totallyTyped` flags. Warns on
permissive level (7–8), large baselines (>200), and Symfony project without the Symfony plugin.

---

### rector-config

**Source:** `src/tools/rector-config.ts`
**Functions:** `list_rector_rules`, `get_rector_stats`

Reads `rector.php`: PHP/Symfony/Doctrine/PHPUnit level sets applied (`LevelSetList`,
`SymfonySetList`, `DoctrineSetList`, `PHPUnitSetList`), individual rules added and skipped,
`withPaths()` scope, parallel runs flag, cache file presence. Upgrade gap analysis: warns when
the PHP set level is lower than `composer.json` requires (upgrade opportunity). Flags large
skip lists (>20 items).

---

### php-cs-fixer

**Source:** `src/tools/php-cs-fixer.ts`
**Functions:** `list_cs_fixer_config`, `get_cs_fixer_stats`

Reads `.php-cs-fixer.php` / `.php-cs-fixer.dist.php`: rulesets (`@Symfony`, `@PSR12`, `@PER`,
`@PhpCsFixer`, `@PHP80Migration`, etc.), extra enabled/disabled rules, risky rule detection,
Finder paths, cache file, `parallelConfig`. Warns on `@Symfony` + `@PSR12` redundancy, risky
rules without `--allow-risky=yes` note, missing vendor/var excludes.

---

### psr-compliance

**Source:** `src/tools/psr-compliance.ts`
**Functions:** `list_psr_compliance`, `get_psr_stats`

Checks PSR-3/6/7/11/14/16/18 interface usage vs Symfony concrete class type-hints in `src/`.
Counts PSR interface usages (portable) vs Symfony-specific classes (coupled) per standard.
Computes a portability score (% PSR-typed). Checks `composer.json` for PSR packages.

---

### php-cognitive-complexity

**Source:** `src/tools/php-cognitive-complexity.ts`
**Functions:** `list_php_cognitive_complexity`, `get_php_cognitive_complexity_stats`

Measures cyclomatic and cognitive complexity of PHP functions/methods; warns on functions
exceeding complexity threshold 10, deeply nested control flow (>3 levels), functions with too
many exit points.

---

### php-copy-paste-detector

**Source:** `src/tools/php-copy-paste-detector.ts`
**Functions:** `list_php_copy_paste_patterns`, `get_php_copy_paste_stats`

Detects duplicate code blocks and copy-paste patterns across PHP files; warns on identical long
method bodies, duplicated constant declarations, repeated switch-case patterns.

---

### php-metrics-config

**Source:** `src/tools/php-metrics-config.ts`
**Functions:** `list_php_metrics_config`, `get_php_metrics_stats`

Detects PhpMetrics configuration (`phpmetrics.xml`, `.phpmetrics.json`, Composer script
`phpmetrics`); warns on missing configuration, no CI integration, metrics not included in QA
pipeline.

---

### phpmd-config

**Source:** `src/tools/phpmd-config.ts`
**Functions:** `list_phpmd_config`, `get_phpmd_stats`

Parses PHPMD ruleset XML (`phpmd.xml`, `phpmd.xml.dist`); warns on missing ruleset, deprecated
rule references, too-permissive thresholds (cyclomatic complexity >20).

---

### phpbench-config

**Source:** `src/tools/phpbench-config.ts`
**Functions:** `list_phpbench_config`, `get_phpbench_stats`

Detects PHPBench configuration (`phpbench.json`, `.phpbench.json`); warns on missing
`runner.bootstrap`, benchmarks not tagged, no baseline stored.

---

### grumphp-config

**Source:** `src/tools/grumphp-config.ts`
**Functions:** `list_grumphp_config`, `get_grumphp_stats`

Parses `grumphp.yml`/`grumphp.dist.yml`; warns on hooks not configured, tasks list empty,
pre-commit but no pre-push hook, deprecated task names.

---

### phpstan-custom-rules

**Source:** `src/tools/phpstan-custom-rules.ts`
**Functions:** `list_php_stan_custom_rules`, `get_php_stan_custom_rule_stats`

Scans for `Rule` interface implementations. Reads `phpstan.neon` rules/stubs/ignoreErrors.
Warns on rule not registered, ignoreErrors without message, >20 ignores.

---

### rector-custom-rules

**Source:** `src/tools/rector-custom-rules.ts`
**Functions:** `list_rector_custom_rules`, `get_rector_custom_rule_stats`

Detects `AbstractRector` subclasses. Reads `rector.php` registrations. Warns on rule without
`getRuleDefinition()`, unregistered rule, no-op `refactor()`.

---

### php-architecture-rules

**Source:** `src/tools/php-architecture-rules.ts`
**Functions:** `list_php_architecture_rules`, `get_php_architecture_rules_stats`

Detects deptrac and Arkitect configuration. Reports layers, rule count, config file presence.
Warns on missing rules.

---

### deptrac-config

**Source:** `src/tools/deptrac-config.ts`
**Functions:** `list_deptrac_config`, `get_deptrac_config_stats`

Layer definitions, ruleset, baseline violations, architecture enforcement.

---

### php-complexity

**Source:** `src/tools/php-complexity.ts`
**Functions:** `list_php_complexity`, `get_php_complexity_stats`

Estimates cyclomatic complexity for PHP methods via regex-based decision-point counting.
Reports top-30 most complex methods with refactor/high-risk thresholds.

---

### sonarqube-config

**Source:** `src/tools/sonarqube-config.ts`
**Functions:** `list_sonarqube_config`, `get_sonarqube_config_stats`

Analyzes SonarQube project configuration; warns on missing `projectKey`, `sources`,
`coverage.reportPaths`, exclusions for vendor/migrations, `sourceEncoding`, `cpd.exclusions`,
CI without quality gate wait.

---

### composer-security-audit

**Source:** `src/tools/composer-security-audit.ts`
**Functions:** `list_composer_security_audit`, `get_composer_security_audit_stats`

Audits `composer.json` for security risks: dev-only packages in `require`, known abandoned
packages (sensio/framework-extra-bundle, doctrine/common), unbound PHP version constraint,
PHP 7 EOL, `minimum-stability: dev`, network calls in `post-install-cmd`.

---

### symfony-enlighten-analysis

**Source:** `src/tools/symfony-enlighten-analysis.ts`
**Functions:** `list_symfony_enlighten_analysis`, `get_symfony_enlighten_analysis_stats`

PHP Enlightn security/performance analysis configuration: `enlightn/enlightn` package detection,
`.enlightn.php` config; checks exposed `.env`, missing `APP_KEY`, `APP_DEBUG` in prod.
