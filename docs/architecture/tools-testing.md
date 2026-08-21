# Category: testing

Testing tools — PHPUnit, Behat, Cypress, Playwright, Pest, static analysis, mutation testing.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### test-suite

**Source:** `src/tools/test-suite.ts`
**Functions:** `list_tests`, `get_test_stats`

All test classes and methods (including data providers), coverage directory detection, test
suite metadata. Recursively scans `tests/` for `Test.php` files: class name, method count,
`#[DataProvider]`/`@dataProvider` detection. Also reads `phpunit.xml`/`phpunit.xml.dist` for
suite definitions, coverage config, and bootstrap path. Reports untested directories (source
dirs with no matching test namespace).

---

### phpunit-config

**Source:** `src/tools/phpunit-config.ts`
**Functions:** `list_phpunit_config`, `get_phpunit_config_stats`

Reads `phpunit.xml`/`phpunit.xml.dist` suites, source includes/excludes, coverage driver,
required extensions; flags missing `stopOnFailure`/`stopOnError`, no coverage whitelist,
`processIsolation` disabled.

---

### behat-config

**Source:** `src/tools/behat-config.ts`
**Functions:** `list_behat_suites`, `get_behat_stats`

Reads `behat.yml`/`.behat.yml`: suites (contexts, paths, tags, profile), extension registrations.
Detects all `Context` classes in `tests/Behat/Context/`, their step definition count. Reports
suites vs detected context classes, warns on suites with no `paths:`, contexts registered in
multiple suites.

---

### behat-step-coverage

**Source:** `src/tools/behat-step-coverage.ts`
**Functions:** `list_behat_steps`, `get_behat_step_coverage_stats`

Scans `*.feature` files for all `Given`/`When`/`Then` step strings and `@tag`s. Collects
step definition `#[Given]`/`#[When]`/`#[Then]` regex patterns from all Context classes.
Reports: undefined steps (feature steps with no matching regex), unused definitions, tag
coverage, suite-level step counts. Length-guarded pattern matcher to prevent ReDoS.

---

### behat-contexts

**Source:** `src/tools/behat-contexts.ts`
**Functions:** `list_behat_contexts`, `get_behat_context_stats`

Scans `tests/Behat/` for Context classes implementing `Context`; reads `behat.yml` for suite
context assignments; warns on context not in any suite, context with no step definitions,
context importing `MinkContext` without Mink configured.

---

### behat-tags

**Source:** `src/tools/behat-tags.ts`
**Functions:** `list_behat_tags`, `get_behat_tag_stats`

Reads all `@tags` from `.feature` files; groups scenarios by tag; warns on scenarios with no
tags (no filtering possible), tags used for only one scenario, `@wip` scenarios.

---

### symfony-phpunit-performance

**Source:** `src/tools/symfony-phpunit-performance.ts`
**Functions:** `list_phpunit_performance`, `get_phpunit_performance_stats`

Reads `phpunit.xml` config; detects `processIsolation=true`, large test suites per file,
missing `cacheResult="true"`, verbose logging; warns on `@large` annotations without time limit.

---

### symfony-phpunit-database

**Source:** `src/tools/symfony-phpunit-database.ts`
**Functions:** `list_phpunit_database`, `get_phpunit_database_stats`

Reads `phpunit.xml` for database test configuration; detects `@group database`, `KernelTestCase`
without `setUp()`, missing transaction rollback, fixtures without reset strategy.

---

### symfony-phpunit-parallel

**Source:** `src/tools/symfony-phpunit-parallel.ts`
**Functions:** `list_phpunit_parallel`, `get_phpunit_parallel_stats`

Detects PHPUnit 11 parallel test runner configuration: `numberOfTestSuiteRunners`, `phpunit`
`runTestsInSeparateProcesses`, Paratest config; warns on stateful shared resources without
process isolation.

---

### phpunit-data-providers

**Source:** `src/tools/phpunit-data-providers.ts`
**Functions:** `list_data_providers`, `get_data_provider_stats`

All `#[DataProvider]`/`@dataProvider` usages across test files. Detects orphaned providers
(provider method not referenced by any test), tests referencing non-existent providers,
providers returning fewer than 2 cases (use inline instead), and generators vs arrays.

---

### phpunit-mocks

**Source:** `src/tools/phpunit-mocks.ts`
**Functions:** `list_mock_usages`, `get_mock_stats`

Scans `createMock()`/`getMockBuilder()` calls; warns on mocking concrete classes, mocking
the class under test, `$this->exactly(0)` (use `never()`), `$this->at()` (deprecated).

---

### symfony-phpunit-clock

**Source:** `src/tools/symfony-phpunit-clock.ts`
**Functions:** `list_phpunit_clock`, `get_phpunit_clock_stats`

Detects `ClockInterface` / `MockClock` / `ClockSensitiveTestTrait` usage; warns on
`new \DateTime()` or `time()` in tests, `ClockSensitiveTestTrait` without `ClockInterface`
injection in the SUT.

---

### phpunit-self-shunting

**Source:** `src/tools/phpunit-self-shunting.ts`
**Functions:** `list_phpunit_self_shunting`, `get_phpunit_self_shunting_stats`

Detects self-shunting test pattern (test class implements interface under test); warns on
self-shunting on large interfaces (incomplete implementation risk), pattern used for final
classes (impossible).

---

### phpunit-snapshots

**Source:** `src/tools/phpunit-snapshots.ts`
**Functions:** `list_phpunit_snapshots`, `get_phpunit_snapshot_stats`

Detects `Spatie\Snapshots` / `spatie/phpunit-snapshot-assertions` usage; warns on snapshot
tests without `--update-snapshots` CI step, missing snapshot files, snapshots on HTML output
(fragile).

---

### phpunit-expect-exception

**Source:** `src/tools/phpunit-expect-exception.ts`
**Functions:** `list_phpunit_expect_exceptions`, `get_phpunit_expect_exception_stats`

Detects `$this->expectException()` usage; warns on `expectException()` without
`expectExceptionMessage()` or `expectExceptionCode()` (too broad), `@expectedException`
annotation (deprecated), `try/catch` with `$this->fail()` (use `expectException()` instead).

---

### phpunit-isolation

**Source:** `src/tools/phpunit-isolation.ts`
**Functions:** `list_phpunit_isolation`, `get_phpunit_isolation_stats`

Detects tests using `@runInSeparateProcess`, `@preserveGlobalState`, static state mutation
(`static $counter`, global variables in test body); warns on cross-test state leaks.

---

### phpunit-naming

**Source:** `src/tools/phpunit-naming.ts`
**Functions:** `list_phpunit_naming`, `get_phpunit_naming_stats`

Audits PHPUnit test method naming; warns on non-descriptive names (e.g. `test1`, `testFoo`),
missing `test` prefix without `#[Test]` attribute, test class not matching file name.

---

### phpunit-coverage

**Source:** `src/tools/phpunit-coverage.ts`
**Functions:** `list_phpunit_coverage`, `get_phpunit_coverage_stats`

Reads `phpunit.xml` coverage config; scans `src/` for classes with no test equivalent;
warns on coverage thresholds below 80%, coverage driver not configured.

---

### phpunit-custom-assertions

**Source:** `src/tools/phpunit-custom-assertions.ts`
**Functions:** `list_custom_assertions`, `get_custom_assertion_stats`

Reads `TestCase` subclasses with custom `assert*` methods; warns on custom assertion without
failure message, custom assertion duplicating built-in assertion.

---

### phpunit-test-doubles

**Source:** `src/tools/phpunit-test-doubles.ts`
**Functions:** `list_test_doubles`, `get_test_double_stats`

Detects stubs, mocks, spies, and fakes; warns on too many mocks per test (> 5 suggests
design smell), mocking value objects, spy pattern in strict unit tests.

---

### phpunit-attributes

**Source:** `src/tools/phpunit-attributes.ts`
**Functions:** `list_phpunit_attributes`, `get_phpunit_attribute_stats`

Detects PHPUnit 10+ attribute usage: `#[Test]`, `#[DataProvider]`, `#[Before]`, `#[After]`,
`#[CoversClass]`, `#[UsesClass]`, `#[Group]`; warns on mixing attribute + annotation style
in same file.

---

### phpunit-extensions

**Source:** `src/tools/phpunit-extensions.ts`
**Functions:** `list_phpunit_extensions`, `get_phpunit_extension_stats`

Detects PHPUnit 10+ `ExtensionInterface` implementations registered in `phpunit.xml`; warns on
`beforeTest`/`afterTest` hooks performing I/O in extensions.

---

### phpunit-groups

**Source:** `src/tools/phpunit-groups.ts`
**Functions:** `list_phpunit_groups`, `get_phpunit_group_stats`

Reads `#[Group]` / `@group` annotations across all tests; warns on groups defined but not
referenced in `phpunit.xml` `<group>` include/exclude filters.

---

### symfony-controller-tests

**Source:** `src/tools/symfony-controller-tests.ts`
**Functions:** `list_controller_tests`, `get_controller_test_stats`

Scans `tests/` for `WebTestCase`/`KernelTestCase`; detects `$client->request()` routes and HTTP
verbs; checks if each source controller has a matching test file; warns on missing assertions.

---

### symfony-clock-tests

**Source:** `src/tools/symfony-clock-tests.ts`
**Functions:** `list_clock_tests`, `get_clock_test_stats`

Reads `ClockSensitiveTestTrait`, `ClockInterface`, `MockClock` usage in tests; warns on test
using `time()`, `new \DateTime()`, or `date()` directly.

---

### symfony-constraint-validator-tests

**Source:** `src/tools/symfony-constraint-validator-tests.ts`
**Functions:** `list_constraint_validator_tests`, `get_constraint_validator_test_stats`

Reads `ConstraintValidatorTestCase` subclasses; warns on validators without test coverage,
tests that mock the validator instead of using the test case.

---

### symfony-test-http-kernel

**Source:** `src/tools/symfony-test-http-kernel.ts`
**Functions:** (test HTTP kernel analysis)

Detects `HttpKernelBrowser`/`WebTestCase` client usage patterns; warns on tests creating
multiple client instances (share via `setUp()`), `$client->request()` without asserting
response code, `KernelTestCase` when `WebTestCase` is needed.

---

### pest-php

**Source:** `src/tools/pest-php.ts`
**Functions:** `list_pest_tests`, `get_pest_test_stats`

Scans `tests/` for Pest PHP test files (`it()`, `test()`, `describe()`, `uses()`, `arch()`);
counts and groups by test type. Detects `uses(RefreshDatabase::class)` and
`uses(TestCase::class)` trait imports. Warns on `it()` descriptions under 10 chars, missing
assertion, Pest arch test without baseline.

---

### symfony-phpunit-test-groups

**Source:** `src/tools/symfony-phpunit-test-groups.ts`
**Functions:** `list_test_groups`, `get_test_group_stats`

Reads `#[Group]`/`@group` annotations from all test classes; reports which groups are defined
and how many tests belong to each; warns on tests with no group, deprecated `@group slow`.

---

### infection-mutants

**Source:** `src/tools/infection-mutants.ts`
**Functions:** `list_infection_mutants`, `get_infection_mutant_stats`

Reads `infection.json`/`infection.json5` config; detects `mutators`, `source`, `testFramework`,
`minMsi`, `minCoveredMsi`; warns on missing `minMsi` threshold, no `testFramework` configured,
mutators not scoped to changed files in CI.

---

### panther-config

**Source:** `src/tools/panther-config.ts`
**Functions:** `list_panther_config`, `get_panther_config_stats`

Symfony Panther end-to-end browser test: `PantherTestCase`, `Client::createChromeClient()`,
JS execution, screenshot on failure.

---

### cypress-config

**Source:** `src/tools/cypress-config.ts`
**Functions:** `list_cypress_config`, `get_cypress_config_stats`

Detects Cypress E2E configuration (`cypress.config.js`/`.ts`, `cypress/e2e/**/*.cy.ts`);
warns on missing `baseUrl`, deprecated `support.file`, `cy.wait()` with hardcoded ms, missing
video/screenshot config in CI, flaky `cy.intercept()` without `wait()`.

---

### playwright-config

**Source:** `src/tools/playwright-config.ts`
**Functions:** `list_playwright_config`, `get_playwright_config_stats`

Detects Playwright config (`playwright.config.ts`): projects, base URL, retries, workers,
reporter; warns on missing `fullyParallel`, no retry in CI, `page.waitForTimeout()` (fragile),
missing `expect.timeout` override.

---

### zenstruck-foundry

**Source:** `src/tools/zenstruck-foundry.ts`
**Functions:** `list_zenstruck_foundry`, `get_zenstruck_foundry_stats`

Detects Zenstruck Foundry: `ObjectFactory`, `PersistentProxyObjectFactory`, `FactoryCollection`,
`Story`, `Faker`, `ResetDatabase` trait, `UseStory`. Warns on factory without `defaults()`,
missing `make()` vs `create()` distinction, story not registered in `behat.yml`.

---

### phpspec-config

**Source:** `src/tools/phpspec-config.ts`
**Functions:** `list_phpspec_config`, `get_phpspec_config_stats`

PHPSpec specification BDD: `phpspec.yml` suites, `ObjectBehavior`, `let`/`letGo`, subject
wiring.

---

### codeception-config

**Source:** `src/tools/codeception-config.ts`
**Functions:** `list_codeception_config`, `get_codeception_config_stats`

Codeception testing framework: `codeception.yml` modules, actor setup, suites, helpers.

---

### symfony-http-client-mock

**Source:** `src/tools/symfony-http-client-mock.ts`
**Functions:** `list_http_client_mock`, `get_http_client_mock_stats`

Reads `MockHttpClient`/`MockResponse` usage in tests; warns on mock with no expected URL check,
`MockResponse` without status code, `MockHttpClient` in non-test code.

---

### symfony-browser-kit

**Source:** `src/tools/symfony-browser-kit.ts`
**Functions:** `list_browser_kit_usage`, `get_browser_kit_stats`

Detects `BrowserKitAssertionsTrait`, `KernelBrowser::getContainer()`, `followRedirects()`;
warns on `getContainer()` in test (use the test client container snapshot), direct container
access without kernel reboot.

---

### api-contract-testing

**Source:** `src/tools/api-contract-testing.ts`
**Functions:** `list_api_contract_testing`, `get_api_contract_testing_stats`

Pact consumer/provider setup, broker config, CI verification.

---

### symfony-fixtures

**Source:** `src/tools/symfony-fixtures.ts`
**Functions:** `list_fixtures`, `get_fixture_stats`

All classes implementing `FixtureInterface`/`OrderedFixtureInterface` in `src/DataFixtures/`:
file name, numeric order, `getDependencies()` for `DependentFixtureInterface`. Cross-checks
for circular dependency cycles in the dependency graph and gaps in the order sequence.

---

### symfony-fixture-groups

**Source:** `src/tools/symfony-fixture-groups.ts`
**Functions:** `list_fixture_groups`, `get_fixture_group_stats`

Scans Alice / Hautelook fixtures: `FixtureGroupInterface`, `grouping` in `DoctrineFixturesBundle`.
Warns on fixture not in any group, group loaded in wrong order.

---

### symfony-debug-artifacts

**Source:** `src/tools/symfony-debug-artifacts.ts`
**Functions:** `list_debug_artifacts`, `get_debug_artifact_stats`

Scans PHP and YAML files for residual debug artifacts: `var_dump()`, `dd()`, `dump()`,
`\Symfony\Component\VarDumper\VarDumper::dump()`, `console.log()` in Twig files, `<div
class="debug*">`, `// debug`, `// temp`. Reports file and line. Warns: VarDumper in
non-test/non-dev code, console.log in JS without removal comment.

---

### symfony-profiler-storage

**Source:** `src/tools/symfony-profiler-storage.ts`
**Functions:** `list_profiler_storage`, `get_profiler_storage_stats`

Reads `profiler.yaml` DSN (file/redis/sqlite); warns on profiler enabled in prod,
file storage in production (disk fill), missing `collect: false` on performance-critical routes.
