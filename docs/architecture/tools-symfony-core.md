# Category: symfony-core

Core Symfony tools — routes, services, controllers, events, commands, bundles, DI container, kernel.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### workflow-inspector

**Source:** `src/tools/workflow-inspector.ts`
**Functions:** `list_workflows`, `get_workflow_details`, `get_workflow_stats`

All workflows and state machines from `config/packages/workflow.yaml` and
`framework.workflows`. Reports: type (workflow/state\_machine), subject class, places,
transitions (from→to), guards (expression), initial places. Detects unreachable places
(no transition leads to them), duplicate transition names. Warnings when a workflow has
no initial marking or when the subject class doesn't exist.

---

### symfony-workflow-state-machine

**Source:** `src/tools/symfony-workflow-state-machine.ts`
**Functions:** `list_symfony_workflow_state_machine`, `get_symfony_workflow_state_machine_stats`

Symfony Workflow component: guards, marking stores, transitions, persistence; warns on marking
store not configured, workflow with no initial place, parallel-transition misconfiguration.

---

### symfony-workflow-guards

**Source:** `src/tools/symfony-workflow-guards.ts`
**Functions:** `list_workflow_guards`, `get_workflow_guard_stats`

Reads `framework.workflows[*].transitions[*].guard` expressions; scans `WorkflowGuardEvent`
listeners; warns on workflow transitions without guard, guard expression referencing undefined
voter.

---

### symfony-workflow-events

**Source:** `src/tools/symfony-workflow-events.ts`
**Functions:** `list_workflow_events`, `get_workflow_event_stats`

Scans `WorkflowEvents::*` listener registrations: `GUARD`, `LEAVE`, `TRANSITION`, `ENTER`,
`ENTERED`, `COMPLETED`, `ANNOUNCE`; warns on `GUARD` listener without returning void
(must call `$event->setBlocked()`), `COMPLETED` without next-step trigger.

---

### symfony-workflow-marking

**Source:** `src/tools/symfony-workflow-marking.ts`
**Functions:** `list_workflow_marking`, `get_workflow_marking_stats`

Reads `marking_store:` config (single/multiple state, property); detects `MarkingStoreInterface`
implementations; warns on marking stored in non-persisted field, `multiple_state: false` for
workflows with parallel transitions.

---

### symfony-workflow-persistence

**Source:** `src/tools/symfony-workflow-persistence.ts`
**Functions:** `list_symfony_workflow_persistence`, `get_symfony_workflow_persistence_stats`

Workflow place persistence: `MethodMarkingStore` field mapping, event listener flushing on
`workflow.entered`; warns on `flush()` not called after marking update, marking stored in
transient property.

---

### symfony-workflow-parallel-transitions

**Source:** `src/tools/symfony-workflow-parallel-transitions.ts`
**Functions:** (parallel workflow transitions analysis)

Detects parallel workflow transition configuration: `type: workflow` with multiple simultaneous
places; warns on parallel transitions without `MultipleStateMarkingStore`, parallel workflow
with single-state property (data loss).

---

### routes-inspector

**Source:** `src/tools/routes-inspector.ts`
**Functions:** `list_routes`, `search_routes`, `get_route_stats`

All routes from PHP attribute `#[Route]` scanning and YAML/XML route config: path, HTTP methods,
requirements, defaults, controller. Detects duplicate paths (same path + method = conflict)
and `{parameter}` patterns without `requirements`. Also reads `config/routes.yaml` and
`config/routes/*.yaml`. Stats: count by method, annotated vs YAML, routes with/without requirements.

---

### symfony-routing-sub-collections

**Source:** `src/tools/symfony-routing-sub-collections.ts`
**Functions:** (routing sub-collection analysis)

Detects route sub-collection prefixes and requirements in YAML/XML routing; warns on
sub-collection without prefix (no grouping benefit), nested sub-collections deeper than
2 levels (maintenance complexity), requirement inconsistency between sub-collection and
child routes.

---

### symfony-routing-loaders

**Source:** `src/tools/symfony-routing-loaders.ts`
**Functions:** `list_routing_loaders`, `get_routing_loader_stats`

Reads `LoaderInterface`/`AbstractLoader` implementations for custom route loading; warns on
loader not tagged `routing.loader`, loader importing from external URL (no caching),
cache-busting import path without `refresh` support.

---

### symfony-routing-requirements

**Source:** `src/tools/symfony-routing-requirements.ts`
**Functions:** `list_routing_requirements`, `get_routing_requirement_stats`

Reads `requirements:` in YAML routes and `#[Route(requirements:)]` in PHP; warns on
`requirements` without `{param}` placeholder in path, ReDoS-prone pattern (`.*+`), integer
ID requirement missing `\d+`, UUID requirement not using `[0-9a-f-]{36}`.

---

### symfony-routing-conflicts

**Source:** `src/tools/symfony-routing-conflicts.ts`
**Functions:** `list_routing_conflicts`, `get_routing_conflict_stats`

Detects routes with identical paths and overlapping methods; warns on static route shadowed
by dynamic route (order matters in Symfony router), routes differing only by trailing slash
without `redirect_trailing_slash`.

---

### symfony-invokable-controllers

**Source:** `src/tools/symfony-invokable-controllers.ts`
**Functions:** `list_invokable_controllers`, `get_invokable_controller_stats`

Detects `__invoke()` controllers with single route; warns on invokable controller with
multiple `#[Route]` attributes (use standard controller), missing `#[Route]` attribute on
invokable controller.

---

### di-inspector

**Source:** `src/tools/di-inspector.ts`
**Functions:** `list_services`, `search_services`, `get_service_stats`

All services from `config/services.yaml` (explicit + auto-discovered): alias, class, public,
shared, synthetic, abstract, lazy, tags, arguments. Parses `bind`, `instanceof`, and top-level
`defaults`. Distinguishes public vs private services. Reports services tagged with
`kernel.event_listener`, `twig.extension`, etc. Warns on public services without a compelling
reason and on circular-looking arguments.

---

### symfony-service-aliases

**Source:** `src/tools/symfony-service-aliases.ts`
**Functions:** `list_service_aliases`, `get_service_alias_stats`

Reads `services.yaml` alias definitions and `interface → concrete` bindings; warns on alias
pointing to non-existent service, deprecated alias without `deprecation:` message, alias
overriding a decorated service.

---

### symfony-service-decorators

**Source:** `src/tools/symfony-service-decorators.ts`
**Functions:** `list_service_decorators`, `get_service_decorator_stats`

Reads `decorates:`, `decoration_inner_name`, `decoration_priority`, `decoration_on_invalid`
in `services.yaml`. Scans PHP for `#[AsDecorator]` attributes. Reports decoration chains.
Warns on missing `decoration_inner_name` (default naming conflict), negative priority without
explicit ordering intent.

---

### symfony-lazy-services

**Source:** `src/tools/symfony-lazy-services.ts`
**Functions:** `list_lazy_services`, `get_lazy_service_stats`

Reads `lazy: true` services and `#[Lazy]` attribute; detects `LazyGhostTrait` usage; warns on
lazy service with constructor doing IO (defeats lazy purpose), non-interface lazy service (uses
proxy — requires extra package).

---

### symfony-abstract-parent-services

**Source:** `src/tools/symfony-abstract-parent-services.ts`
**Functions:** `list_abstract_parent_services`, `get_abstract_parent_service_stats`

Reads `abstract: true` service definitions and `parent:` inheritance in `services.yaml`;
warns on parent service not marked abstract (creates concrete instance), child overriding all
parent arguments (pointless inheritance).

---

### symfony-service-locators

**Source:** `src/tools/symfony-service-locators.ts`
**Functions:** `list_service_locators`, `get_service_locator_stats`

Reads `ServiceLocatorArgument`, `ServiceSubscriberInterface`, `#[AsServiceSubscriber]`;
warns on service locator used as service registry anti-pattern, `getSubscribedServices()` not
returning static methods.

---

### symfony-tagged-iterators

**Source:** `src/tools/symfony-tagged-iterators.ts`
**Functions:** `list_tagged_iterators`, `get_tagged_iterator_stats`

Reads `!tagged_iterator` / `!tagged_locator` in `services.yaml`; detects `#[AutoconfigureTag]`
on abstract classes; warns on tagged iterator with no matching tags, priority attribute ignored
because no `defaultPriorityMethod` configured.

---

### symfony-di-factories

**Source:** `src/tools/symfony-di-factories.ts`
**Functions:** `list_di_factories`, `get_di_factory_stats`

Reads `factory:` entries in `services.yaml`; scans PHP for `#[AsService(factory:)]`; warns on
factory service not defined, factory method not static for static factory, factory returning
wrong type.

---

### symfony-autowire-attributes

**Source:** `src/tools/symfony-autowire-attributes.ts`
**Functions:** `list_autowire_attributes`, `get_autowire_attribute_stats`

Reads `#[Autowire]`, `#[AutowireLocator]`, `#[AutowireIterator]`, `#[AutowireCallable]`,
`#[Target]` in PHP source; warns on `#[Autowire('%env(...)%')]` with secret (use Secrets
instead), `#[Target]` on interface without multiple implementations.

---

### symfony-compiler-passes

**Source:** `src/tools/symfony-compiler-passes.ts`
**Functions:** `list_compiler_passes`, `get_compiler_pass_stats`

Classes implementing `CompilerPassInterface` detected in `src/`. Reports `process()` method,
whether registered in `Kernel::build()` or via `#[AsCompilerPass]`, and the pass priority.
Flags compiler passes not registered anywhere.

---

### symfony-container-tags

**Source:** `src/tools/symfony-container-tags.ts`
**Functions:** `list_container_tags`, `get_container_tag_stats`

All service tags from `services.yaml` and PHP attributes. Groups services by tag. Reports
custom tags (not in Symfony's known tag list), tags with no consumer (orphan tags), services
with conflicting tags. Cross-references `CompilerPassInterface` looking for `findTaggedServiceIds`.

---

### symfony-container-compile

**Source:** `src/tools/symfony-container-compile.ts`
**Functions:** `list_symfony_container_compile`, `get_symfony_container_compile_stats`

Detects container dump configuration: `cache_dir`, `build_dir`, `dump_container` in `Kernel`;
warns on no container dump in production (slow cold boot), container recompile on every request
in dev (common misconfiguration), inconsistent `build_id`.

---

### symfony-conditional-di

**Source:** `src/tools/symfony-conditional-di.ts`
**Functions:** `list_symfony_conditional_di`, `get_symfony_conditional_di_stats`

Detects conditional service registration: `%env(bool:...)%` parameter as condition,
`#[When(env: 'dev')]`, `Extension::load()` with env checks; warns on `dev`-only services
not excluded from prod container, conditional tag without `!php/const` for the condition.

---

### symfony-service-reset

**Source:** `src/tools/symfony-service-reset.ts`
**Functions:** `list_symfony_service_reset`, `get_symfony_service_reset_stats`

Detects `ResettableInterface` implementations; warns on stateful service (properties set in
request) without `ResettableInterface`, `reset()` method that doesn't clear all mutable state.

---

### events

**Source:** `src/tools/events.ts`
**Functions:** `list_events`, `get_event_stats`

All event subscriber and listener classes: subscribed event names + priorities + listener
method names. Detects `EventSubscriberInterface` + `getSubscribedEvents()` implementations
and `#[AsEventListener]` attribute usage. Warns on empty subscriber (no events), listener
method not found in class, event names matching Symfony deprecated constants.

---

### symfony-custom-events

**Source:** `src/tools/symfony-custom-events.ts`
**Functions:** `list_custom_events`, `get_custom_event_stats`

Classes extending `Event` (Symfony EventDispatcher) that are not Doctrine/Symfony built-ins.
Reports dispatch call sites (via `EventDispatcherInterface::dispatch()`), listener count, and
whether any listener is async (dispatched via Messenger). Warns on events with no listeners.

---

### symfony-kernel-events

**Source:** `src/tools/symfony-kernel-events.ts`
**Functions:** `list_kernel_events`, `get_kernel_event_stats`

Reads `KernelEvents::*` listeners (`REQUEST`, `CONTROLLER`, `CONTROLLER_ARGUMENTS`,
`RESPONSE`, `FINISH_REQUEST`, `VIEW`, `EXCEPTION`, `TERMINATE`); warns on expensive
operations in `REQUEST` listener (runs on every request), `TERMINATE` listener not tagged
properly.

---

### symfony-kernel-terminate

**Source:** `src/tools/symfony-kernel-terminate.ts`
**Functions:** `list_kernel_terminate`, `get_kernel_terminate_stats`

Detects `KernelEvents::TERMINATE` listeners; warns on terminate listener doing blocking I/O
(defeats async purpose), listener not compatible with FastCGI termination behavior.

---

### symfony-event-dispatcher-tracing

**Source:** `src/tools/symfony-event-dispatcher-tracing.ts`
**Functions:** `list_event_dispatcher_tracing`, `get_event_dispatcher_tracing_stats`

Reads `TraceableEventDispatcher` usage in tests, profiler `event_dispatcher.config`; warns
on no event tracing in functional tests, `stopwatch.php` not imported.

---

### symfony-event-priority-conflicts

**Source:** `src/tools/symfony-event-priority-conflicts.ts`
**Functions:** `list_event_priority_conflicts`, `get_event_priority_conflict_stats`

Reads `priority` values across listeners for same event; warns on two listeners at same
priority (order undefined), priority 0 (default) mixed with explicit priorities (ordering intent
unclear), `PRIORITY_EARLY`/`PRIORITY_LATE` constants not used.

---

### commands

**Source:** `src/tools/commands.ts`
**Functions:** `list_commands`, `get_command_stats`

All classes extending `Command` or using `#[AsCommand]`: command name, description, argument
names/modes, option names/modes/defaults, whether it calls `$this->addArgument()` / `->addOption()`
in `configure()`. Detects duplicate command names. Reads from `src/Command/`. Warns on commands
without a description or with an empty `configure()`.

---

### symfony-console-style

**Source:** `src/tools/symfony-console-style.ts`
**Functions:** `list_console_style_usage`, `get_console_style_stats`

Scans for `SymfonyStyle`, `$io->success()`, `$io->error()`, `$io->table()`, `$io->progressBar()`;
warns on commands using `$output->writeln()` directly (use `SymfonyStyle`), `$io->ask()` in
non-interactive mode without default.

---

### symfony-console-signals

**Source:** `src/tools/symfony-console-signals.ts`
**Functions:** `list_console_signals`, `get_console_signal_stats`

Reads `SignalableCommandInterface` implementations; warns on long-running commands without
signal handling (`SIGTERM`/`SIGINT`), signal handler not calling `parent::handleSignal()`.

---

### symfony-console-hidden-commands

**Source:** `src/tools/symfony-console-hidden-commands.ts`
**Functions:** (hidden command analysis)

Detects `#[AsCommand(hidden: true)]` or `$this->setHidden(true)` in commands; warns on
hidden commands with no purpose comment, hidden command that should be a cron job instead,
hidden command with required user-facing arguments.

---

### symfony-console-events

**Source:** `src/tools/symfony-console-events.ts`
**Functions:** `list_console_events`, `get_console_event_stats`

Reads `ConsoleEvents::COMMAND`, `ConsoleEvents::TERMINATE`, `ConsoleEvents::ERROR`,
`ConsoleEvents::SIGNAL` listener registrations; warns on `TERMINATE` listener suppressing
exception, `ERROR` listener not re-throwing.

---

### symfony-console-table

**Source:** `src/tools/symfony-console-table.ts`
**Functions:** `list_console_table`, `get_console_table_stats`

Scans `Table::setHeaders()`/`->addRow()`/`->render()`; warns on table without headers,
table in non-interactive environment without fallback.

---

### symfony-console-question

**Source:** `src/tools/symfony-console-question.ts`
**Functions:** `list_console_question`, `get_console_question_stats`

Detects `QuestionHelper::ask()`, `ChoiceQuestion`, `ConfirmationQuestion`; warns on
`ask()` without `isInteractive()` guard, `ConfirmationQuestion` default `true` in destructive
commands.

---

### symfony-console-completion

**Source:** `src/tools/symfony-console-completion.ts`
**Functions:** `list_console_completion`, `get_console_completion_stats`

Reads `CompletionInput` / `CompletionSuggestions` usage in `complete()` method; warns on
commands with `InputArgument::REQUIRED` without `complete()` implementation, `complete()`
making slow DB queries.

---

### symfony-console-command-options

**Source:** `src/tools/symfony-console-command-options.ts`
**Functions:** `list_console_command_options`, `get_console_command_option_stats`

Reads `addOption()` calls: name, shortcut, mode, default; warns on options with no description,
`InputOption::VALUE_OPTIONAL` without default (null surprise), short option conflicting with
global (`-h`, `-v`, `-q`, `-n`, `-e`).

---

### symfony-console-helpers

**Source:** `src/tools/symfony-console-helpers.ts`
**Functions:** `list_console_helpers`, `get_console_helper_stats`

Reads `HelperSet` registration in `Application`, `HelperInterface` implementations; warns on
custom helper not overriding `getName()`, duplicate helper names.

---

### symfony-console-daemon

**Source:** `src/tools/symfony-console-daemon.ts`
**Functions:** `list_symfony_console_daemon`, `get_symfony_console_daemon_stats`

Detects long-running daemon commands: loop-based commands, `while(true)` or `do { } while(true)`,
missing `pcntl_signal()` registration; warns on daemon without memory limit check, daemon
without sleep/idle strategy.

---

### symfony-console-progress-bar

**Source:** `src/tools/symfony-console-progress-bar.ts`
**Functions:** `list_symfony_console_progress_bar`, `get_symfony_console_progress_bar_stats`

Scans `ProgressBar` usage: `new ProgressBar($output, $max)`, `advance()`, `finish()`,
`setFormat()`; warns on `ProgressBar` without `setMaxSteps()` in indeterminate mode, `advance()`
inside very fast loop (rendering overhead).

---

### symfony-command-lock

**Source:** `src/tools/symfony-command-lock.ts`
**Functions:** `list_command_locks`, `get_command_lock_stats`

Detects `LockableTrait`/`StoreInterface` in commands; warns on lock without TTL (process crash
= infinite lock), lock resource not unique per command name.

---

### bundles

**Source:** `src/tools/bundles.ts`
**Functions:** `list_bundles`, `get_bundle_stats`

Reads `config/bundles.php`: all registered bundles with their environment restriction. Flags
dev-only bundles registered in production (no env check), duplicate bundle registrations, and
bundles missing from `composer.json` `require` section.

---

### symfony-bundle-analysis

**Source:** `src/tools/symfony-bundle-analysis.ts`
**Functions:** `list_bundle_analysis`, `get_bundle_analysis_stats`

Detects `AbstractBundle`/`Bundle` subclasses in `src/`; reads `configure()`, `loadExtension()`,
`prependExtension()`; warns on bundle without `Extension` class, missing `getPath()` override
for non-standard directory.

---

### symfony-dependency-graph

**Source:** `src/tools/symfony-dependency-graph.ts`
**Functions:** `list_dependency_graph`, `get_dependency_graph_stats`

Builds a dependency graph from constructor injection across all service classes. Reports
hub services (many dependents), services with high in-degree (coupling risk), and circular
dependency candidates. Also reads `services.yaml` explicit `arguments:` definitions.

---

### symfony-di-params

**Source:** `src/tools/symfony-di-params.ts`
**Functions:** `list_di_params`, `get_di_param_stats`

All `%parameters%` from `services.yaml` and `config/packages/*.yaml`. Search by name or
value with masking for sensitive values. Shows which services inject each parameter.

---

### symfony-dbal-config

**Source:** `src/tools/symfony-dbal-config.ts`
**Functions:** `list_dbal_config`, `get_dbal_config_stats`

DBAL connection configuration: driver, charset, server_version, replicas. Warns on
missing charset, no server version configured.

---

### symfony-http-middleware

**Source:** `src/tools/symfony-http-middleware.ts`
**Functions:** `list_symfony_http_middleware`, `get_symfony_http_middleware_stats`

Symfony HTTP kernel middleware layers: `KernelEvents::REQUEST` listeners acting as middleware
(authentication, locale, firewall, router), `HttpCache` store/surrogate; warns on middleware
not returning response for early exits, middleware priority conflicts.

---

### symfony-http-client-events

**Source:** `src/tools/symfony-http-client-events.ts`
**Functions:** `list_http_client_events`, `get_http_client_event_stats`

Scans `EventSourceHttpClient`, `ResponseInterface::getStatusCode()` inside listeners; warns on
HTTP client event listener not handling `TransportException`, retrying inside listener (use
`RetryableHttpClient` instead).

---

### symfony-http-client-scopes

**Source:** `src/tools/symfony-http-client-scopes.ts`
**Functions:** `list_http_client_scopes`, `get_http_client_scope_stats`

Reads `framework.http_client.scoped_clients:` configuration: base\_uri, headers (masked),
auth\_bearer, auth\_basic; warns on auth credentials hardcoded in `services.yaml`, scoped client
without `verify_peer: true`, overly broad `base_uri`.

---

### symfony-http-client-auth

**Source:** `src/tools/symfony-http-client-auth.ts`
**Functions:** `list_http_client_auth`, `get_http_client_auth_stats`

Reads `auth_bearer`, `auth_basic`, `headers.Authorization` from `framework.http_client`
config; warns on auth token committed in `services.yaml`, basic auth without TLS.

---

### symfony-http-client-caching

**Source:** `src/tools/symfony-http-client-caching.ts`
**Functions:** `list_symfony_http_client_caching`, `get_symfony_http_client_caching_stats`

Detects HTTP client response caching: `CachingHttpClient` + `HttpStore`, `stale-while-revalidate`
header; warns on caching without `Vary` header, cache store not shared between workers.

---

### symfony-http-client-retry

**Source:** `src/tools/symfony-http-client-retry.ts`
**Functions:** `list_http_client_retry`, `get_http_client_retry_stats`

Reads `RetryableHttpClient` or `max_retries` in `framework.http_client`; warns on retry
without backoff delay, retry on POST (non-idempotent), no `delay` between retries.

---

### symfony-http-client-concurrent

**Source:** `src/tools/symfony-http-client-concurrent.ts`
**Functions:** `list_symfony_http_client_concurrent`, `get_symfony_http_client_concurrent_stats`

Detects concurrent HTTP requests: `$client->stream([...])`, multiple `$response =
$client->request()` calls before `->getContent()` (lazy concurrency); warns on sequential
`->getContent()` where concurrent stream would help, missing timeout on concurrent requests.

---

### symfony-http-foundation-bag

**Source:** `src/tools/symfony-http-foundation-bag.ts`
**Functions:** `list_http_foundation_bag`, `get_http_foundation_bag_stats`

Scans `ParameterBag`, `HeaderBag`, `FileBag`, `InputBag` access patterns; warns on `get()`
without default on required parameter (null-coalesce risk), `all()` on large `InputBag`
(memory), `FileBag::get()` without `UploadedFile` type check.

---

### symfony-request-stack

**Source:** `src/tools/symfony-request-stack.ts`
**Functions:** `list_request_stack_usage`, `get_request_stack_stats`

Scans `RequestStack::getMainRequest()`, `getCurrentRequest()`, `push()`; warns on
`getCurrentRequest()` in CLI context (returns null), `getMainRequest()` in subrequest
context (returns outer — may be wrong).

---

### symfony-kernel-analysis

**Source:** `src/tools/symfony-kernel-analysis.ts`
**Functions:** `list_kernel_analysis`, `get_kernel_analysis_stats`

Full Kernel inspection: `getCacheDir()`, `getLogDir()`, `getProjectDir()`, `registerBundles()`,
`configureContainer()`, `configureRoutes()`, `boot()`, `shutdown()`. Detects non-standard
cache/log paths, bundles not in `bundles.php`, custom kernel not extending `MicroKernelTrait`.

---

### symfony-psr-bridge

**Source:** `src/tools/symfony-psr-bridge.ts`
**Functions:** `list_psr_bridge`, `get_psr_bridge_stats`

Reads `symfony/psr-http-message-bridge` usage; detects `PsrHttpFactory`, `HttpFoundationFactory`;
warns on bridge used without PSR-17 factory installed, PSR-7 request not converted back to
Symfony Request for middleware.

---

### symfony-string-encoding

**Source:** `src/tools/symfony-string-encoding.ts`
**Functions:** `list_string_encoding`, `get_string_encoding_stats`

Reads `UnicodeString`/`ByteString`/`AbstractString` usage; warns on `mb_*` functions mixed
with `UnicodeString` (inconsistent), `ByteString::chunk()` used on multibyte strings.

---

### symfony-string-normalizer

**Source:** `src/tools/symfony-string-normalizer.ts`
**Functions:** `list_string_normalizer`, `get_string_normalizer_stats`

Detects `UnicodeString::normalize()` with NFC/NFD/NFKC/NFKD; warns on form submission without
normalization (diacritics comparison fail), missing normalization before `SluggerInterface::slug()`.

---

### symfony-locale-switcher

**Source:** `src/tools/symfony-locale-switcher.ts`
**Functions:** `list_locale_switcher`, `get_locale_switcher_stats`

Detects `LocaleSwitcher::runWithLocale()` usage (Symfony 6.3+); warns on locale switch without
restoring via try/finally, `setLocale()` instead of `runWithLocale()` (non-reversible).

---

### symfony-clock

**Source:** `src/tools/symfony-clock.ts`
**Functions:** `list_clock_usage`, `get_clock_stats`

Reads `ClockInterface`/`NativeClock`/`MockClock` usages; warns on `new \DateTime()` or `time()`
not going through clock abstraction, `Clock::get()` static call in testable code.

---

### symfony-stopwatch

**Source:** `src/tools/symfony-stopwatch.ts`
**Functions:** `list_stopwatch_usage`, `get_stopwatch_stats`

Scans `Stopwatch::start()`/`stop()`/`lap()`; warns on stopwatch not stopped in finally block,
stopwatch in production non-profiler code (performance overhead).

---

### symfony-process

**Source:** `src/tools/symfony-process.ts`
**Functions:** `list_process_usage`, `get_process_stats`

Scans `Process::fromShellCommandline()`, `new Process([...])`, `->run()`, `->mustRun()`,
`->setTimeout()`; warns on `fromShellCommandline()` (shell injection risk — use array form),
process without timeout, `mustRun()` uncaught `ProcessFailedException`.

---

### symfony-filesystem

**Source:** `src/tools/symfony-filesystem.ts`
**Functions:** `list_filesystem_usage`, `get_filesystem_stats`

Scans `Filesystem::copy()`, `mkdir()`, `remove()`, `exists()`, `dumpFile()`, `appendToFile()`
usage; warns on `dumpFile()` with user-controlled path, `remove()` without `exists()` guard
in public context.

---

### symfony-finder

**Source:** `src/tools/symfony-finder.ts`
**Functions:** `list_finder_usage`, `get_finder_stats`

Scans `Finder::create()->in()`, `->files()`, `->name()`, `->depth()`; warns on `Finder` in
`in('/')` (full filesystem scan), `->followLinks()` without depth limit (symlink loop),
`Finder` result not sorted (non-deterministic iteration order).

---

### symfony-profiler-panels

**Source:** `src/tools/symfony-profiler-panels.ts`
**Functions:** `list_profiler_panels`, `get_profiler_panel_stats`

Custom `DataCollectorInterface` implementations; reads `template` reference; warns on data
collector not tagged `data_collector`, template missing `{% block panel %}`, `collect()` doing
heavy processing.

---

### symfony-debug-dump

**Source:** `src/tools/symfony-debug-dump.ts`
**Functions:** `list_debug_dump`, `get_debug_dump_stats`

Scans `VarDumper::dump()`, `dump()`, `dd()` calls across `src/`; warns on dump in non-test
production code, `VarDumper` called with no cast registered.

---

### symfony-debug-var-dumper

**Source:** `src/tools/symfony-debug-var-dumper.ts`
**Functions:** `list_var_dumper_casters`, `get_var_dumper_caster_stats`

Detects custom `VarDumper` casters registered via `AbstractDumper::setDisplayOptions()` or
`CliDumper`/`HtmlDumper` subclasses; warns on caster revealing sensitive data (passwords,
keys).

---

### symfony-error-pages

**Source:** `src/tools/symfony-error-pages.ts`
**Functions:** `list_error_pages`, `get_error_page_stats`

Reads Twig error page templates in `templates/bundles/TwigBundle/Exception/`: `error404.html.twig`,
`error500.html.twig`, `error.html.twig`. Detects `ErrorController` customization. Warns on
missing 404 page, error pages without `{% extends %}` (raw HTML), debug info rendered on 500.

---

### symfony-error-controller

**Source:** `src/tools/symfony-error-controller.ts`
**Functions:** `list_error_controller`, `get_error_controller_stats`

Reads `framework.error_controller` in `framework.yaml`; detects `ErrorController` subclasses;
warns on missing custom error controller for API format, `JsonResponse` not returned for
JSON-accepting clients.

---

### symfony-exception-subscribers

**Source:** `src/tools/symfony-exception-subscribers.ts`
**Functions:** `list_exception_subscribers`, `get_exception_subscriber_stats`

Reads `KernelEvents::EXCEPTION` listeners; warns on subscriber swallowing exceptions silently
(sets response without logging), subscriber priority too low (runs after built-in handler).

---

### symfony-exception-mapping

**Source:** `src/tools/symfony-exception-mapping.ts`
**Functions:** `list_exception_mappings`, `get_exception_mapping_stats`

Reads `when@prod.framework.exceptions` mapping: exception class → HTTP status code; detects
`ExceptionEvent` listeners modifying status; warns on 500 mapped to 403 (misleading), missing
`NotFoundHttpException` mapping.

---

### symfony-custom-exception-hierarchy

**Source:** `src/tools/symfony-custom-exception-hierarchy.ts`
**Functions:** `list_custom_exception_hierarchy`, `get_custom_exception_hierarchy_stats`

Reads exception class hierarchy in `src/Exception/`; warns on exception not extending domain
base exception, catching `\Exception` instead of specific type, exception with no message
constructor.

---

### symfony-maintenance-mode-env

**Source:** `src/tools/symfony-maintenance-mode-env.ts`
**Functions:** (maintenance mode env check)

Alias for `maintenance-mode.ts` — maintenance mode env/lock patterns across kernel and entry
points. Warns on `APP_ENV=maintenance` used without actual HTTP 503 response.

---

### symfony-error-renderer

**Source:** `src/tools/symfony-error-renderer.ts`
**Functions:** `list_error_renderer`, `get_error_renderer_stats`

Reads `ErrorRendererInterface` implementations; detects `HtmlErrorRenderer`/`SerializerErrorRenderer`
registration; warns on no JSON error renderer for API-only apps, HTML renderer enabled in API-first
context.

---

### symfony-static-analysis-ignores

**Source:** `src/tools/symfony-static-analysis-ignores.ts`
**Functions:** `list_static_analysis_ignores`, `get_static_analysis_ignore_stats`

Reads `@phpstan-ignore`, `@psalm-suppress`, `/** @noinspection */`, `@phpcs:ignore` comments
across PHP; warns on blanket suppression without justification comment, suppressions on lines
with multiple issues (unclear which is suppressed).

---

### symfony-magic-methods

**Source:** `src/tools/symfony-magic-methods.ts`
**Functions:** `list_magic_methods`, `get_magic_method_stats`

Detects `__get`, `__set`, `__call`, `__callStatic`, `__toString`, `__clone`, `__sleep`,
`__wakeup`, `__serialize`, `__unserialize`; warns on `__sleep`/`__wakeup` without
`__serialize`/`__unserialize` equivalent, `__toString` throwing exceptions (fatal in PHP 8
catch contexts).

---

### symfony-runtime-env-vars

**Source:** `src/tools/symfony-runtime-env-vars.ts`
**Functions:** `list_runtime_env_vars`, `get_runtime_env_var_stats`

Reads `%env(...)%` processors: `base64`, `bool`, `int`, `float`, `json`, `not`, `resolve`,
`csv`, `trim`, `default`, `key`, `url`, `query_string`, `require`, `constant`, `enum`; warns
on `env()` with no fallback in prod, `resolve:` processor on multiline value.

---

### symfony-env-processors

**Source:** `src/tools/symfony-env-processors.ts`
**Functions:** `list_env_processors`, `get_env_processor_stats`

Reads `EnvVarProcessorInterface` implementations; warns on processor not tagged
`routing.env_var_processor` (missed tag), processor with expensive `getEnv()` (cached by
container, but beware of side effects).

---

### symfony-openssl-cert

**Source:** `src/tools/symfony-openssl-cert.ts`
**Functions:** (SSL/TLS certificate analysis)

Scans for TLS/SSL certificate paths referenced in config (`ssl_cert`, `ssl_key`, `tls_cert`);
warns on hardcoded cert path, cert path not using environment variable, cert path pointing
to non-existent file.

---

### symfony-obfuscation

**Source:** `src/tools/symfony-obfuscation.ts`
**Functions:** (obfuscation pattern detection)

Detects obfuscation anti-patterns: `eval(base64_decode(...))`, `str_rot13()` with eval,
compressed+eval patterns; warns on obfuscated code in production codebase (supply chain risk).

---

### symfony-cqrs-event-sourcing

**Source:** `src/tools/symfony-cqrs-event-sourcing.ts`
**Functions:** `list_cqrs_event_sourcing`, `get_cqrs_event_sourcing_stats`

Combined CQRS + event sourcing pattern: `AggregateRoot`, `DomainEvent`, command/query bus
separation, event store; warns on aggregate without `apply()` method, event store without
snapshot strategy.

---

### symfony-psr

**Source:** `src/tools/symfony-psr.ts`
**Functions:** `list_psr_compliance`, `get_psr_compliance_stats`

PSR-3 (logger), PSR-6 (cache), PSR-7/17 (HTTP), PSR-11 (container), PSR-14 (event),
PSR-16 (simple cache), PSR-18 (HTTP client) implementations. Warns on Symfony service
not implementing PSR interface where one exists.

---

### symfony-remote-events

**Source:** `src/tools/symfony-remote-events.ts`
**Functions:** `list_remote_events`, `get_remote_event_stats`

Symfony 6.3 `RemoteEvent` / `#[AsRemoteEventConsumer]` for webhook consumption; warns on
consumer without idempotency check, missing `RemoteEventBus` configuration.

---

### symfony-signed-requests

**Source:** `src/tools/symfony-signed-requests.ts`
**Functions:** (signed request analysis)

Detects `UriSigner`/`RequestSigner` usage; warns on signer without expiry check, signed URL
secret committed to `.env`, no validation of signature before processing request body.

---

### symfony-web-link

**Source:** `src/tools/symfony-web-link.ts`
**Functions:** `list_web_link_usage`, `get_web_link_stats`

Reads `WebLinkManager` / `Link` usage; warns on WebLink without `preload` or `dns-prefetch`
type, link added after response committed (ignored), HTTP/2 push link without actual asset.

---

### symfony-php-deprecations

**Source:** `src/tools/symfony-php-deprecations.ts`
**Functions:** `list_php_deprecations`, `get_php_deprecation_stats`

Scans for PHP deprecated function calls (based on PHP 8.x deprecation list): `each()`,
`create_function()`, `money_format()`, `strftime()`, `mktime()` without args; also Symfony-level
deprecations via `trigger_deprecation()` calls.

---

### symfony-deprecation-detector

**Source:** `src/tools/symfony-deprecation-detector.ts`
**Functions:** `list_symfony_deprecations`, `get_symfony_deprecation_stats`

Reads `@deprecated` PHPDoc and `trigger_deprecation()` calls; warns on deprecated API still
called internally, deprecation without version annotation, deprecation without replacement
suggestion.

---

### symfony-dead-code

**Source:** `src/tools/symfony-dead-code.ts`
**Functions:** `list_dead_code`, `get_dead_code_stats`

Detects potentially dead code: private methods with no call sites in the same class, constants
defined but never referenced, events dispatched but no listener registered, services defined
but never injected and not public.

---

### symfony-env-var-masking

**Source:** `src/tools/symfony-env-var-masking.ts`
**Functions:** `list_env_var_masking`, `get_env_var_masking_stats`

Reads Symfony sensitive value parameters: `$parameters->markSensitive()`; warns on sensitive
parameters not masked in `debug:container` output, env var masking not applied to DSNs.

---

### symfony-asset-mapper-extended

**Source:** `src/tools/symfony-asset-mapper-extended.ts`
**Functions:** `list_asset_mapper_extended`, `get_asset_mapper_extended_stats`

Extended asset mapper: `asset_mapper.yaml` paths, `importmap.php` local vs CDN, `preload` flag,
integrity hashes; warns on CDN package without pinned version, local asset without integrity.

---

### symfony-symfony-cloud

**Source:** `src/tools/symfony-symfony-cloud.ts`
**Functions:** `list_symfony_cloud`, `get_symfony_cloud_stats`

SymfonyCloud `.symfony.cloud.yaml` configuration: app name, PHP version, build flavor,
relationships, workers, crons, mounts, disk; warns on PHP version behind latest, missing
cron health-check, worker without restart policy.

---

### symfony-php-generic-annotations

**Source:** `src/tools/symfony-php-generic-annotations.ts`
**Functions:** `list_php_generic_annotations`, `get_php_generic_annotation_stats`

Reads `@template`, `@extends`, `@implements`, `@param`, `@return` generics in PHPDoc;
warns on unresolved template, `@extends` without `@template`, return type annotation
inconsistent with PHP declaration.

---

### symfony-php-intersection-types

**Source:** `src/tools/symfony-php-intersection-types.ts`
**Functions:** `list_php_intersection_types`, `get_php_intersection_type_stats`

Detects PHP 8.1 intersection type declarations (`A&B`); warns on intersection with final class
(always resolved to single type), intersection with interface extending another in same
intersection (redundant).

---

### symfony-php-complexity

**Source:** `src/tools/symfony-php-complexity.ts`
**Functions:** `list_php_complexity`, `get_php_complexity_stats`

Cyclomatic complexity per method: counts `if`, `elseif`, `?:`, `??`, `&&`, `||`, `foreach`,
`for`, `while`, `do`, `switch`, `case`, `catch`. Warns on methods with complexity > 10 (hard
to test), classes with average complexity > 5.

---

### symfony-php-namespace

**Source:** `src/tools/symfony-php-namespace.ts`
**Functions:** `list_php_namespaces`, `get_php_namespace_stats`

Reads all PHP file namespaces; warns on file namespace not matching directory structure
(PSR-4 violation), mixed `App\` and `AppBundle\` namespaces, class name not matching filename.

---

### symfony-php-match

**Source:** `src/tools/symfony-php-match.ts`
**Functions:** `list_php_match_usage`, `get_php_match_stats`

Detects PHP 8.0 `match()` usage; warns on `match` without default arm (throws `UnhandledMatchError`),
`match(true)` with complex conditions (use `if/elseif` for clarity).

---

### symfony-php-arrow-functions

**Source:** `src/tools/symfony-php-arrow-functions.ts`
**Functions:** `list_php_arrow_functions`, `get_php_arrow_function_stats`

Detects `fn()` arrow functions; warns on arrow function with side effects (mutating external
state), arrow function body spanning multiple lines (better as closure), `fn()` inside
`fn()` (hard to read).

---

### symfony-php-attributes-reader

**Source:** `src/tools/symfony-php-attributes-reader.ts`
**Functions:** `list_php_attributes`, `get_php_attribute_stats`

Reads all PHP 8 `#[Attribute]` declarations (not Doctrine/Symfony built-ins); detects
`AttributeTarget` flags; warns on attribute without `#[Attribute]` meta-attribute, attribute
class not in `src/Attribute/` directory.

---

### symfony-php-readonly

**Source:** `src/tools/symfony-php-readonly.ts`
**Functions:** `list_php_readonly`, `get_php_readonly_stats`

Reads `readonly` properties (PHP 8.1+); warns on `readonly` property without type declaration,
mutable collection assigned to `readonly` property (collection itself mutable), `readonly`
on static property (invalid).

---

### symfony-php-readonly-classes

**Source:** `src/tools/symfony-php-readonly-classes.ts`
**Functions:** `list_php_readonly_classes`, `get_php_readonly_class_stats`

Detects `readonly class` declarations (PHP 8.2+); warns on readonly class with non-promoted
constructor properties (must be explicitly `readonly`), readonly class extending non-readonly
(invalid in PHP 8.2).

---

### symfony-php-dnf-types

**Source:** `src/tools/symfony-php-dnf-types.ts`
**Functions:** (DNF type analysis)

Detects PHP 8.2 Disjunctive Normal Form type declarations (`(A&B)|C`); warns on DNF type with
`null` that could be `?A&B` instead, DNF with duplicate intersection parts.

---

### symfony-php-constant-visibility

**Source:** `src/tools/symfony-php-constant-visibility.ts`
**Functions:** (class constant visibility analysis)

Detects PHP 7.1+ typed constant visibility (`public const`, `protected const`, `private const`);
warns on constants without visibility modifier (implicit public), constants that should be
`private` (only used internally).

---

### symfony-php-typed-class-constants

**Source:** `src/tools/symfony-php-typed-class-constants.ts`
**Functions:** `list_php_typed_class_constants`, `get_php_typed_class_constant_stats`

Detects PHP 8.3 typed class constants (`const string NAME = 'value'`); warns on constant with
value inconsistent with type declaration, typed constant in interface overridden without type
in implementing class.

---

### symfony-php-property-hooks

**Source:** `src/tools/symfony-php-property-hooks.ts`
**Functions:** `list_php_property_hooks`, `get_php_property_hook_stats`

PHP 8.4 property hooks (`get`, `set`); warns on `set` hook without validation, `get` hook
with side effects, property hook on `readonly` property (only `get` hook allowed).

---

### symfony-php-asymmetric-visibility

**Source:** `src/tools/symfony-php-asymmetric-visibility.ts`
**Functions:** `list_php_asymmetric_visibility`, `get_php_asymmetric_visibility_stats`

PHP 8.4 asymmetric visibility (`public private(set)`); warns on asymmetric visibility without
property hooks (use `readonly` instead), `protected(set)` with no subclass (use `private(set)`).

---

### symfony-php-first-class-callables

**Source:** `src/tools/symfony-php-first-class-callables.ts`
**Functions:** `list_php_first_class_callables`, `get_php_first_class_callable_stats`

PHP 8.1 first-class callable syntax (`strlen(...)`); warns on callable used without type hint
(`Closure`), first-class callable on deprecated method.

---

### symfony-php-string-helpers

**Source:** `src/tools/symfony-php-string-helpers.ts`
**Functions:** `list_php_string_helpers`, `get_php_string_helper_stats`

PHP 8.0+ string functions (`str_contains()`, `str_starts_with()`, `str_ends_with()`); warns
on `strpos() !== false` pattern (use `str_contains()`), `substr($s, 0, strlen($prefix)) ===
$prefix` (use `str_starts_with()`).

---

### symfony-php-generators

**Source:** `src/tools/symfony-php-generators.ts`
**Functions:** `list_php_generators`, `get_php_generator_stats`

Detects `yield` / `yield from` usage; warns on generator not typed as `\Generator` or
`iterable`, `->send()` to generator without checking `->valid()`, generator in Doctrine
`iterateResult()` without `clear()`.

---

### symfony-php-weak-references

**Source:** `src/tools/symfony-php-weak-references.ts`
**Functions:** `list_php_weak_references`, `get_php_weak_reference_stats`

Reads `WeakReference::create()`/`WeakMap` usage; warns on `WeakReference::get()` without null
check, `WeakMap` used as persistent cache (keys may be collected).

---

### symfony-php-fibers

**Source:** `src/tools/symfony-php-fibers.ts`
**Functions:** `list_php_fibers`, `get_php_fiber_stats`

Detects PHP 8.1 `Fiber` usage: `new Fiber()`, `->start()`, `->resume()`, `->getReturn()`;
warns on Fiber not started before `resume()`, Fiber with blocking I/O (defeats async purpose),
uncaught `FiberError`.

---

### symfony-php-named-arguments

**Source:** `src/tools/symfony-php-named-arguments.ts`
**Functions:** `list_php_named_arguments`, `get_php_named_argument_stats`

Detects named argument usage (`func(param: value)`); warns on named argument on non-public
API (breaks on rename), named argument to function that also accepts spread (`...$args`),
both positional and named to same function.

---

### symfony-php-closures

**Source:** `src/tools/symfony-php-closures.ts`
**Functions:** `list_php_closures`, `get_php_closure_stats`

Reads `Closure::bind()`/`bindTo()`/`fromCallable()`; warns on binding to object without
`$this` usage (pointless), closure importing large objects by value (memory), `use (&$var)` in
long-lived service (memory leak).

---

### symfony-php-splat

**Source:** `src/tools/symfony-php-splat.ts`
**Functions:** `list_php_splat`, `get_php_splat_stats`

Detects spread operator (`...$args`) usage; warns on spread without iterable type hint,
`array_merge(...$arrays)` on very large number of arrays (memory peak), spread in named argument
context (PHP 8.1+).

---

### symfony-php-never-type

**Source:** `src/tools/symfony-php-never-type.ts`
**Functions:** `list_php_never_type`, `get_php_never_type_stats`

Detects PHP 8.1 `never` return type; warns on `never` without `throw`/`exit`/`die` in all
paths, `never` on non-final method (subclass cannot return a value either).

---

### symfony-php-trait-conflicts

**Source:** `src/tools/symfony-php-trait-conflicts.ts`
**Functions:** `list_php_trait_conflicts`, `get_php_trait_conflict_stats`

Detects trait method conflicts (same method name in multiple used traits); warns on unresolved
conflict without `insteadof` / `as` alias, trait method overriding abstract method with
incompatible signature.

---

### symfony-php-null-coalescing

**Source:** `src/tools/symfony-php-null-coalescing.ts`
**Functions:** `list_php_null_coalescing`, `get_php_null_coalescing_stats`

Reads `??`, `??=` usage; warns on `$x ?? null` (redundant), `$_GET['key'] ?? $default` without
filter_input (unsafe), `??=` on typed non-nullable property (TypeError).

---

### symfony-php-constructor-promotion

**Source:** `src/tools/symfony-php-constructor-promotion.ts`
**Functions:** `list_php_constructor_promotion`, `get_php_constructor_promotion_stats`

Reads promoted constructor properties; warns on promoted property without type (implicit mixed),
mix of promoted and non-promoted in same constructor, `private readonly` promoted property in
abstract class (requires concrete subclass).

---

### symfony-php-late-static-binding

**Source:** `src/tools/symfony-php-late-static-binding.ts`
**Functions:** `list_php_late_static_binding`, `get_php_late_static_binding_stats`

Detects `static::` usage; warns on `static::` in final class (identical to `self::`, misleading),
`static::$property` on undefined property in parent, `static::create()` factory without override.

---

### symfony-php-array-functions

**Source:** `src/tools/symfony-php-array-functions.ts`
**Functions:** `list_php_array_functions`, `get_php_array_function_stats`

Reads `array_map`, `array_filter`, `array_reduce`, `array_walk`, `usort`, `uasort`, `uksort`;
warns on `array_map(null, $a, $b)` (use `array_map(fn() => [$a, $b], ...)` for clarity),
`array_filter` without callback (truthy-filter bug on `0`, `""`), `array_walk` without
`&$value` (changes not persisted).

---

### symfony-php-array-find

**Source:** `src/tools/symfony-php-array-find.ts`
**Functions:** (PHP 8.4 array find functions)

Detects PHP 8.4 `array_find()`, `array_find_key()`, `array_any()`, `array_all()` usage;
warns on `array_find()` on empty array without null check (returns null), using `array_filter()[0]`
pattern replaceable with `array_find()`.

---

### symfony-php-object-cloning

**Source:** `src/tools/symfony-php-object-cloning.ts`
**Functions:** `list_php_object_cloning`, `get_php_object_cloning_stats`

Reads `clone $obj` usage; warns on cloning without `__clone()` on objects with mutable
references (shallow clone), cloning Doctrine entities (detached proxy), clone in loop (memory).

---

### symfony-php-date-time

**Source:** `src/tools/symfony-php-date-time.ts`
**Functions:** `list_php_date_time`, `get_php_date_time_stats`

Reads `new \DateTime()`, `new \DateTimeImmutable()`, `new \DateInterval()`; warns on mutable
`DateTime` passed to service (unintended mutation), `DateInterval` P0D used as zero check
instead of comparison.

---

### symfony-php-covariance

**Source:** `src/tools/symfony-php-covariance.ts`
**Functions:** `list_php_covariance`, `get_php_covariance_stats`

Detects covariant return types and contravariant parameter types (PHP 7.4+); warns on return
type wider than parent (invalid covariance), parameter type narrower than parent (invalid
contravariance).

---

### symfony-php-abstract

**Source:** `src/tools/symfony-php-abstract.ts`
**Functions:** `list_php_abstract`, `get_php_abstract_stats`

Reads `abstract class`/`abstract function` declarations; warns on abstract class with no
abstract methods (use interface), abstract class not extending another class (missing base
pattern), concrete class extending abstract without implementing all abstract methods.

---

### symfony-php-interface-patterns

**Source:** `src/tools/symfony-php-interface-patterns.ts`
**Functions:** `list_php_interface_patterns`, `get_php_interface_pattern_stats`

Reads interface declarations and implementations; warns on interface with > 10 methods (ISP
violation), interface implemented by single class (use concrete class), empty marker interface
(use PHP 8 attributes instead).

---

### symfony-php-static-methods

**Source:** `src/tools/symfony-php-static-methods.ts`
**Functions:** `list_php_static_methods`, `get_php_static_method_stats`

Reads `static function` declarations; warns on static method on non-final class with inheritance
that overrides it (use `self::`), static method accessing `$this` (invalid), static methods in
services (testability issue).

---

### symfony-php-backtrace-debug

**Source:** `src/tools/symfony-php-backtrace-debug.ts`
**Functions:** (backtrace debug detection)

Detects `debug_backtrace()`/`debug_print_backtrace()` in non-test production code; warns on
production backtrace (performance + info disclosure), backtrace without `DEBUG_BACKTRACE_IGNORE_ARGS`
(memory).

---

### symfony-php-preloading

**Source:** `src/tools/symfony-php-preloading.ts`
**Functions:** `list_php_preloading`, `get_php_preloading_stats`

Reads `preload.php` or `opcache.preload` ini setting; warns on preload file not generated by
Symfony (`bin/console cache:pool:prune`), preload script with `new` instantiation (triggers
class resolution on all workers), preload without `opcache.preload_user`.

---

### symfony-php-object-serialization

**Source:** `src/tools/symfony-php-object-serialization.ts`
**Functions:** `list_php_object_serialization`, `get_php_object_serialization_stats`

Reads `Serializable` interface / `__serialize`/`__unserialize` method implementations; warns
on `Serializable` without `__serialize` equivalent (deprecated PHP 8.1), serializing objects
containing closures (fails), `__wakeup` without `__sleep`.

---

### symfony-php-spl-data-structures

**Source:** `src/tools/symfony-php-spl-data-structures.ts`
**Functions:** `list_php_spl_data_structures`, `get_php_spl_data_structure_stats`

Detects `SplStack`, `SplQueue`, `SplDoublyLinkedList`, `SplPriorityQueue`, `SplFixedArray`,
`SplMinHeap`, `SplMaxHeap` usage; warns on `SplFixedArray` without size calculation, SPL data
structure used in Doctrine entity (not serializable).

---

### symfony-php-stream-wrappers

**Source:** `src/tools/symfony-php-stream-wrappers.ts`
**Functions:** `list_php_stream_wrappers`, `get_php_stream_wrapper_stats`

Detects custom stream wrappers (`stream_register_wrapper()`); warns on wrapper not unregistered
in test teardown (global state), wrapper missing `stream_seek` implementation (non-seekable).

---

### symfony-php-reflection-api

**Source:** `src/tools/symfony-php-reflection-api.ts`
**Functions:** `list_php_reflection_api`, `get_php_reflection_api_stats`

Reads `ReflectionClass`/`ReflectionMethod`/`ReflectionProperty` usage outside tests/tools;
warns on reflection in hot path (no caching), reflection used to access private properties
(testing anti-pattern), `ReflectionMethod::invoke()` breaking encapsulation.

---

### symfony-php-contract-tests

**Source:** `src/tools/symfony-php-contract-tests.ts`
**Functions:** `list_php_contract_tests`, `get_php_contract_test_stats`

Detects contract test pattern (abstract test case per interface implementation); warns on
interface without contract test, contract test not parameterized by implementation.

---

### symfony-php-immutable-value-objects

**Source:** `src/tools/symfony-php-immutable-value-objects.ts`
**Functions:** `list_php_immutable_value_objects`, `get_php_immutable_value_object_stats`

Detects value object pattern: no setters, `equals()` method, constructor validation; warns on
value object with public mutable property, value object without `equals()`, VO used as Doctrine
entity (not embeddable).

---

### symfony-php-type-coercion

**Source:** `src/tools/symfony-php-type-coercion.ts`
**Functions:** `list_php_type_coercion`, `get_php_type_coercion_stats`

Detects implicit type coercion: `(int)`, `(string)`, `intval()`, `strval()` on values that
should be validated first; warns on casting untrusted input without validation, `(bool)` on
string (truthy/falsy rules), `(array)` on null (becomes empty array).

---

### symfony-php-named-constructors

**Source:** `src/tools/symfony-php-named-constructors.ts`
**Functions:** `list_php_named_constructors`, `get_php_named_constructor_stats`

Detects static named constructor pattern (`static::create()`, `static::fromString()`, etc.);
warns on named constructor not returning `static` (breaks subclassing), constructor made
public alongside named constructors (inconsistency).

---

### symfony-webserver-config

**Source:** `src/tools/symfony-webserver-config.ts`
**Functions:** `list_webserver_config`, `get_webserver_config_stats`

Checks nginx/apache config for Symfony-specific rules: `try_files $uri /index.php`, PHP-FPM
socket vs TCP, proper `DOCUMENT_ROOT`, `APP_ENV` pass-through to FPM.

---

### symfony-composer-autoload

**Source:** `src/tools/symfony-composer-autoload.ts`
**Functions:** `list_symfony_composer_autoload`, `get_symfony_composer_autoload_stats`

Reads `composer.json` `autoload`/`autoload-dev` classmap and PSR-4 prefixes; warns on classmap
autoload in `src/` (slow), PSR-4 with empty prefix (matches everything), dev autoload in
`vendor/`.

---

### symfony-intl-patterns

**Source:** `src/tools/symfony-intl-patterns.ts`
**Functions:** `list_symfony_intl_patterns`, `get_symfony_intl_pattern_stats`

ICU-compliant number/date/currency formatting using `NumberFormatter`/`IntlDateFormatter`;
warns on `setPattern()` without locale, `DECIMAL` formatter without grouping separator.

---

### symfony-soap-patterns

**Source:** `src/tools/symfony-soap-patterns.ts`
**Functions:** `list_symfony_soap_patterns`, `get_symfony_soap_pattern_stats`

SOAP client/server (`SoapClient`/`SoapServer`); `wsdl` URL, authentication, options;
warns on SOAP without `WSDL_CACHE_DISK`, SOAP over HTTP (no TLS), `SoapFault` not caught.

---

### symfony-zip-archive

**Source:** `src/tools/symfony-zip-archive.ts`
**Functions:** `list_symfony_zip_archive`, `get_symfony_zip_archive_stats`

Reads `ZipArchive` usage; warns on `open()` without error code check (`ZipArchive::CREATE`),
`addFromString()` with path traversal risk, temp file not deleted after extraction.

---

### symfony-mbstring-patterns

**Source:** `src/tools/symfony-mbstring-patterns.ts`
**Functions:** `list_symfony_mbstring_patterns`, `get_symfony_mbstring_pattern_stats`

Reads `mb_*` function calls; warns on missing `mb_internal_encoding()` or no `mbstring.internal_encoding`
ini, `mb_detect_encoding()` without encoding list (non-deterministic), `mb_substr()` on byte
string (use `substr()`).

---

### symfony-ftp-sftp-patterns

**Source:** `src/tools/symfony-ftp-sftp-patterns.ts`
**Functions:** `list_symfony_ftp_sftp_patterns`, `get_symfony_ftp_sftp_pattern_stats`

FTP/SFTP (`ftp_connect`, `ssh2_connect`, `phpseclib`); warns on plain FTP (no TLS), hardcoded
credentials in `ftp_login()`, no host key verification for SFTP.

---

### symfony-csv-parsing

**Source:** `src/tools/symfony-csv-parsing.ts`
**Functions:** `list_symfony_csv_parsing`, `get_symfony_csv_parsing_stats`

Reads `fgetcsv()`/`str_getcsv()`/league-csv usage; warns on `fgetcsv` with no `length` param
(deprecated in PHP 9), CSV from user upload without column count validation, CSV without BOM
detection for Windows-origin files.

---

### symfony-php-benchmark-patterns

**Source:** `src/tools/symfony-php-benchmark-patterns.ts`
**Functions:** `list_symfony_php_benchmark_patterns`, `get_symfony_php_benchmark_pattern_stats`

PHPBench annotation patterns: `#[Bench]`, `#[BeforeMethods]`, `#[AfterMethods]`, iteration
count, warm-up; warns on benchmark without warm-up, very low iterations (unreliable results).

---

### symfony-php-heredoc-nowdoc

**Source:** `src/tools/symfony-php-heredoc-nowdoc.ts`
**Functions:** `list_symfony_php_heredoc_nowdoc`, `get_symfony_php_heredoc_nowdoc_stats`

Detects heredoc (`<<<EOT`) and nowdoc (`<<<'EOT'`) usage; warns on heredoc with user input
(potential injection if used in SQL/HTML), heredoc for large HTML (use Twig template instead).

---

### symfony-php-pdo-patterns

**Source:** `src/tools/symfony-php-pdo-patterns.ts`
**Functions:** `list_symfony_php_pdo_patterns`, `get_symfony_php_pdo_pattern_stats`

Reads direct `PDO`/`PDOStatement` usage (bypassing Doctrine); warns on `PDO::query()` with
string concatenation (SQL injection), `PDOStatement::bindValue` vs `bindParam` (pass-by-ref),
PDO connection without `PDO::ERRMODE_EXCEPTION`.

---

### symfony-php-type-narrowing

**Source:** `src/tools/symfony-php-type-narrowing.ts`
**Functions:** `list_symfony_php_type_narrowing`, `get_symfony_php_type_narrowing_stats`

Detects PHP type narrowing patterns: `is_array()`, `instanceof`, `is_string()`, `is_int()`
used before type-specific operations; warns on missing narrowing before `->method()` on mixed
type, narrowing inside loop without early return.

---

### symfony-php-sprintf-type-safety

**Source:** `src/tools/symfony-php-sprintf-type-safety.ts`
**Functions:** `list_symfony_php_sprintf_type_safety`, `get_symfony_php_sprintf_type_safety_stats`

Reads `sprintf()`/`printf()`/`vsprintf()` calls; warns on `%s` used for integer (use `%d`),
`%f` without precision (locale-dependent output), positional argument count mismatch.

---

### symfony-php-json-encode-flags

**Source:** `src/tools/symfony-php-json-encode-flags.ts`
**Functions:** `list_symfony_php_json_encode_flags`, `get_symfony_php_json_encode_flags_stats`

Reads `json_encode()` flag combinations; warns on `json_encode` without `JSON_THROW_ON_ERROR`
(silent failure), `JSON_UNESCAPED_UNICODE` for external API (may expose non-ASCII in security
context), `JSON_PRETTY_PRINT` in API response (bandwidth waste).

---

### symfony-php-gd-security

**Source:** `src/tools/symfony-php-gd-security.ts`
**Functions:** `list_symfony_php_gd_security`, `get_symfony_php_gd_security_stats`

GD image functions: `imagecreatefromstring()` on user-uploaded data (decompression bomb);
`getimagesizefromstring()` for type detection; warns on creating image from user data without
size limit, missing `imagedestroy()`.

---

### symfony-php-imap-patterns

**Source:** `src/tools/symfony-php-imap-patterns.ts`
**Functions:** `list_symfony_php_imap_patterns`, `get_symfony_php_imap_pattern_stats`

IMAP functions (`imap_open`, `imap_search`, `imap_fetchbody`); warns on plaintext IMAP
connection (use SSL), IMAP in request cycle (use queue), credentials hardcoded.

---

### symfony-uuid-generation

**Source:** `src/tools/symfony-uuid-generation.ts`
**Functions:** `list_symfony_uuid_generation`, `get_symfony_uuid_generation_stats`

Reads `UuidInterface`, `Uuid::uuid4()`, `Ulid`, `#[ORM\GeneratedValue(strategy: 'UUID')]`;
warns on `uuid4()` without `ramsey/uuid` package, UUID column not typed as `guid`, ULID used
without monotonic factory.

---

### symfony-weak-map

**Source:** `src/tools/symfony-weak-map.ts`
**Functions:** `list_symfony_weak_map`, `get_symfony_weak_map_stats`

Reads PHP 8.0 `WeakMap` usage; warns on `WeakMap` persisted in static property (defeats weak
semantics), `WeakMap` used as session storage, iterating `WeakMap` while removing entries.

---

### symfony-esi-config

**Source:** `src/tools/symfony-esi-config.ts`
**Functions:** `list_symfony_esi_config`, `get_symfony_esi_config_stats`

Edge Side Includes (ESI) config: `framework.esi` enabled, `SurrogateInterface` implementation,
Varnish/Squid surrogate detection; warns on ESI enabled without surrogate proxy, `<esi:include>`
on authenticated fragments.

---

### symfony-http2-push

**Source:** `src/tools/symfony-http2-push.ts`
**Functions:** `list_symfony_http2_push`, `get_symfony_http2_push_stats`

HTTP/2 Server Push (`Link` header with `rel=preload`): `WebLinkManager` usage, `preload()`
helper; warns on push without HTTPS, pushing large assets (can block stream), push without
checking `Cache-Control` (duplicate transfer).

---

### symfony-data-pipeline

**Source:** `src/tools/symfony-data-pipeline.ts`
**Functions:** `list_symfony_data_pipeline`, `get_symfony_data_pipeline_stats`

Data pipeline patterns: `ItemReaderInterface`, `ItemProcessorInterface`, `ItemWriterInterface`
(PortPHP/batch-bundle); warns on processor without rollback, missing checkpoint in long pipeline.

---

### symfony-php-bc-math

**Source:** `src/tools/symfony-php-bc-math.ts`
**Functions:** `list_symfony_php_bc_math`, `get_symfony_php_bc_math_stats`

Detects `bcadd()`, `bcsub()`, `bcmul()`, `bcdiv()` usage; warns on `bcdiv()` without scale
parameter (integer division), `bc*` without `bcscale()` set globally (default scale 0), mixing
`bc*` and float arithmetic.

---

### symfony-php-dom-xpath

**Source:** `src/tools/symfony-php-dom-xpath.ts`
**Functions:** `list_symfony_php_dom_xpath`, `get_symfony_php_dom_xpath_stats`

Detects `DOMXPath`, `DOMDocument::loadHTML()`, `DOMDocument::loadXML()`; warns on XML
external entity injection (XXE) via missing `LIBXML_NOENT`/`loadXML` without disabling
entities, loading untrusted HTML with `LIBXML_NOERROR` (hides injection warnings).

---

### symfony-php-signal-handling

**Source:** `src/tools/symfony-php-signal-handling.ts`
**Functions:** `list_symfony_php_signal_handling`, `get_symfony_php_signal_handling_stats`

Detects `pcntl_signal()`, `pcntl_async_signals()`, `shmop_open()`, POSIX function usage;
warns on `pcntl_signal()` without `pcntl_async_signals(true)` (deferred delivery), signal
handler doing I/O (unsafe in async context).

---

### symfony-php-xsl-transformation

**Source:** `src/tools/symfony-php-xsl-transformation.ts`
**Functions:** `list_symfony_php_xsl_transformation`, `get_symfony_php_xsl_transformation_stats`

Detects `XSLTProcessor` usage; warns on `transformToXml()` with user-supplied XSLT (SSRF via
`document()`, code execution via `php:function()`), missing `registerPHPFunctions(false)` to
disable PHP function bridge.

---

### symfony-php-parallel-extension

**Source:** `src/tools/symfony-php-parallel-extension.ts`
**Functions:** `list_symfony_php_parallel_extension`, `get_symfony_php_parallel_extension_stats`

Detects `parallel\Runtime`, `parallel\run()`, `parallel\Channel`; warns on shared mutable
state between parallel tasks, Channel without select timeout, task exception not caught in
`Future::value()`.

---

### symfony-php-lazy-objects

**Source:** `src/tools/symfony-php-lazy-objects.ts`
**Functions:** `list_symfony_php_lazy_objects`, `get_symfony_php_lazy_object_stats`

PHP 8.4 lazy objects via `ReflectionClass::newLazyGhost()` / `newLazyProxy()`; warns on lazy
ghost without initializer, lazy proxy without `resetAsLazyProxy()`, lazy object cloned before
initialization.

---

### symfony-php-array-unpacking

**Source:** `src/tools/symfony-php-array-unpacking.ts`
**Functions:** `list_symfony_php_array_unpacking`, `get_symfony_php_array_unpacking_stats`

Detects PHP 8.1 string-key array unpacking (`[...$assoc]`); warns on unpacking with duplicate
keys (last wins — silent data loss), spread inside very large array (memory peak).

---

### symfony-php-backed-enum

**Source:** `src/tools/symfony-php-backed-enum.ts`
**Functions:** `list_symfony_php_backed_enum`, `get_symfony_php_backed_enum_stats`

PHP 8.1 backed enums (`enum Status: string`); warns on `::from()` without try/catch on
user-supplied input (use `::tryFrom()` + null check), enum case value reuse across methods,
Doctrine column type not using `EnumType`.

---

### symfony-php-file-locking

**Source:** `src/tools/symfony-php-file-locking.ts`
**Functions:** `list_symfony_php_file_locking`, `get_symfony_php_file_locking_stats`

Detects `flock()` usage; warns on non-blocking `LOCK_NB` without retry loop, `flock()`
on NFS (unreliable), missing `flock($fp, LOCK_UN)` in finally block.
