# Category: frontend

Frontend tools — Twig, translations, asset mapper, Symfony UX, Turbo, live components, Webpack.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### twig-inspector

**Source:** `src/tools/twig-inspector.ts`
**Functions:** `list_twig_templates`, `get_twig_template_stats`

All Twig templates in `templates/` with their block definitions, parent (`extends`) chain,
macro count, and included sub-templates. Detects orphan templates (not included or extended
by any other template), templates missing `{% block body %}`, and recursive include loops.

---

### twig-extensions

**Source:** `src/tools/twig-extensions.ts`
**Functions:** `list_twig_extensions`, `get_twig_extension_stats`

Detects all custom Twig extensions: classes extending `AbstractExtension` or implementing
`ExtensionInterface`. For each: name, functions, filters, globals, tests, operators, token
parsers. Flags extensions registered as services without the `twig.extension` tag (will not
be loaded), and extensions with the tag but not extending `AbstractExtension`.

---

### twig-functions

**Source:** `src/tools/twig-functions.ts`
**Functions:** `list_twig_functions_and_filters`, `get_twig_function_stats`

Extension-registered `TwigFunction` and `TwigFilter` objects from all Twig extension classes.
Extracts name, PHP callable, `is_safe: ['html']` flag, and `needs_environment` / `needs_context`
flags. Groups by extension. Warns when `is_safe: html` is combined with user-controlled
arguments (potential XSS).

---

### twig-lint

**Source:** `src/tools/twig-lint.ts`
**Functions:** `lint_twig_templates`, `get_twig_lint_stats`

Scans all Twig template files for syntax patterns likely to cause lint failures: unclosed blocks,
mismatched `{% if %}` / `{% endif %}`, `{% for %}` / `{% endfor %}`, deprecated `{% spaceless %}`/
`{% spaceless %}`, raw user output without `|e`, and use of `loop.revindex0` (deprecated in
Twig 3). Does not exec `twig:lint` — pure text parsing.

---

### twig-macros

**Source:** `src/tools/twig-macros.ts`
**Functions:** `list_twig_macros`, `get_twig_macro_stats`

All macro definitions (`{% macro name(...) %}`) across all templates, with parameter lists and
call-sites found via `{{ macros.name() }}` or `{% from 'file.html.twig' import name %}`. Flags
macros defined but never called, and macros called without import.

---

### twig-inheritance

**Source:** `src/tools/twig-inheritance.ts`
**Functions:** `list_twig_inheritance`, `get_twig_inheritance_stats`

Full template inheritance chains: `{% extends 'base.html.twig' %}` relationships; detects
multiple inheritance levels (chain depth), orphan templates (no parent and not a base),
templates overriding zero blocks (extends without customization).

---

### twig-namespace

**Source:** `src/tools/twig-namespace.ts`
**Functions:** `list_twig_namespaces`, `get_twig_namespace_stats`

Reads `twig.paths` from `twig.yaml` (namespace → directory mapping). Detects `@BundleName/`
style references in templates. Warns on namespace-prefixed include pointing to non-existent
directory, bundle path override without actual template files, circular namespace mapping.

---

### twig-globals

**Source:** `src/tools/twig-globals.ts`
**Functions:** `list_twig_globals`, `get_twig_global_stats`

Reads `twig.globals` from `twig.yaml`. Reports all global variable names, their type (service
alias or scalar value), and usage count in template files. Warns on service-type globals that
make templates hard to test and on globals whose names shadow common Twig built-ins.

---

### twig-components

**Source:** `src/tools/twig-components.ts`
**Functions:** `list_twig_components`, `get_twig_component_stats`

Detects Symfony UX Twig Components (`#[AsTwigComponent]`); reads `name`, `template` override,
exposed properties and actions. Scans `templates/components/` for `.html.twig` files. Warns
on component class without a matching template, public property without type declaration.

---

### twig-sandbox

**Source:** `src/tools/twig-sandbox.ts`
**Functions:** `list_twig_sandbox`, `get_twig_sandbox_stats`

Reads `SandboxExtension` registration, allowed tags/filters/methods from `SecurityPolicy`.
Warns on sandbox-disabled for user-generated content, `SandboxExtension` with permissive
policy (all methods allowed).

---

### twig-form-rendering

**Source:** `src/tools/twig-form-rendering.ts`
**Functions:** `list_twig_form_rendering`, `get_twig_form_rendering_stats`

Reads `twig.yaml` `form_themes`; detects `form_widget(form)` (full-form shortcut — skips
customization), custom form themes in `templates/form/`; warns on custom theme not registered
in `form_themes`, theme file not inheriting from Bootstrap/base.

---

### twig-runtime

**Source:** `src/tools/twig-runtime.ts`
**Functions:** `list_twig_runtimes`, `get_twig_runtime_stats`

Detects `AbstractExtension::getRuntimeExtension()` and `TwigRuntimeInterface` implementations;
warns on lazy runtime not tagged `twig.runtime`, runtime loading a service that should be
eager.

---

### twig-profiling

**Source:** `src/tools/twig-profiling.ts`
**Functions:** `list_twig_profiling`, `get_twig_profiling_stats`

Detects Twig profiler extension (`twig.yaml profile: true`); warns on profiling enabled in
production, no profiler data collector registered.

---

### twig-email-structure

**Source:** `src/tools/twig-email-structure.ts`
**Functions:** `list_twig_email_structure`, `get_twig_email_structure_stats`

Reads templates in `templates/emails/`; warns on templates without a plain-text alternative,
`<link rel="stylesheet">` not inlined (`CssInlinerExtension` not applied), image `src` using
`asset()` (absolute URL required in email), missing `{% block subject %}`.

---

### twig-test-functions

**Source:** `src/tools/twig-test-functions.ts`
**Functions:** `list_twig_test_functions`, `get_twig_test_function_stats`

Detects custom Twig `TwigTest` objects (`is mytest` syntax); warns on test without callable,
test name conflicting with built-in tests (`empty`, `defined`, `null`, etc.).

---

### symfony-twig-extensions

**Source:** `src/tools/symfony-twig-extensions.ts`
**Functions:** `list_symfony_twig_extensions`, `get_symfony_twig_extension_stats`

Symfony-provided Twig extension helper tools: `twig/extra-bundle` (`IntlExtension`,
`HtmlExtension`, `MarkdownExtension`, `CssInlinerExtension`, etc.); warns on extension
installed but not enabled in `twig.yaml`.

---

### symfony-ux

**Source:** `src/tools/symfony-ux.ts`
**Functions:** `list_ux_packages`, `get_ux_stats`

Detects all installed UX packages from `composer.json` (`symfony/ux-*`, `symfony/stimulus-bundle`).
For each: name, version, whether the asset recipe was applied. Scans `assets/controllers/` for
custom Stimulus controllers registered in `assets/controllers.json`. Warns on UX package
installed but not initialized in `app.js`.

---

### symfony-ux-react

**Source:** `src/tools/symfony-ux-react.ts`
**Functions:** `list_ux_react`, `get_ux_react_stats`

Detects `symfony/ux-react` + `@symfony/ux-react` npm package; React component registrations
in `assets/react/controllers/`; `<ReactComponent>` Twig usage; warns on components not
registered, missing `enableReactComponent()` in Webpack config.

---

### symfony-ux-vue

**Source:** `src/tools/symfony-ux-vue.ts`
**Functions:** `list_ux_vue`, `get_ux_vue_stats`

Detects `symfony/ux-vue` + `@symfony/ux-vue` npm package; Vue SFC registrations in
`assets/vue/controllers/`; `<VueComponent>` Twig usage; warns on missing `enableVueLoader()`.

---

### symfony-ux-svelte

**Source:** `src/tools/symfony-ux-svelte.ts`
**Functions:** `list_ux_svelte`, `get_ux_svelte_stats`

Detects `symfony/ux-svelte` + `@symfony/ux-svelte` npm package; Svelte component registrations;
`<SvelteComponent>` Twig usage; warns on `svelte-loader` missing in Webpack.

---

### symfony-ux-map

**Source:** `src/tools/symfony-ux-map.ts`
**Functions:** `list_ux_map`, `get_ux_map_stats`

Detects Symfony UX Map (`symfony/ux-map`); provider config (Google/Leaflet/MapLibre);
`Map::centerOn()`/`addMarker()`/`addPolyline()` usage; warns on API key not in env var,
map width/height not set.

---

### symfony-ux-icons

**Source:** `src/tools/symfony-ux-icons.ts`
**Functions:** `list_ux_icons`, `get_ux_icons_stats`

Detects Symfony UX Icons: icon sets (`ux_icons.yaml`), `<twig:ux:icon name="..."/>` usage in
templates; warns on icon set downloaded but not referenced, invalid icon name format.

---

### symfony-ux-autocomplete

**Source:** `src/tools/symfony-ux-autocomplete.ts`
**Functions:** `list_ux_autocomplete`, `get_ux_autocomplete_stats`

Detects `symfony/ux-autocomplete` usage; `AsEntityAutocompleteField`, `EntityAutocompleteType`
fields; security: `is_granted` option; warns on autocomplete without security expression
(exposes all entities), field without `maxResults` (unbounded query).

---

### symfony-ux-autocomplete-js

**Source:** `src/tools/symfony-ux-autocomplete-js.ts`
**Functions:** `list_ux_autocomplete_js`, `get_ux_autocomplete_js_stats`

Tomselect/Autocomplete Stimulus controller JS config (`@symfony/ux-autocomplete` npm package);
warns on missing `min_characters` threshold (fires on every keystroke).

---

### symfony-ux-chart-js

**Source:** `src/tools/symfony-ux-chart-js.ts`
**Functions:** `list_ux_chart_js`, `get_ux_chart_js_stats`

Detects `symfony/ux-chartjs` + `Chart` PHP class; chart types, `createChart()` usage;
warns on datasets without `label` (inaccessible), chart rendered server-side without
lazy-loading.

---

### symfony-ux-cropperjs

**Source:** `src/tools/symfony-ux-cropperjs.ts`
**Functions:** `list_ux_cropperjs`, `get_ux_cropperjs_stats`

Detects `symfony/ux-cropperjs`; `CropperJs` form type; `public_url` configuration;
warns on `public_url` not using `asset()`, missing `max_file_size` validation.

---

### symfony-ux-notify

**Source:** `src/tools/symfony-ux-notify.ts`
**Functions:** `list_ux_notify`, `get_ux_notify_stats`

UX Notify Mercure integration: `NotificationStream`, Mercure topic subscription in JS;
warns on Mercure hub not configured, notification without subscriber auth.

---

### symfony-ux-typed

**Source:** `src/tools/symfony-ux-typed.ts`
**Functions:** `list_symfony_ux_typed`, `get_symfony_ux_typed_stats`

UX Typed typewriter Stimulus controller: `<div {{ stimulus_controller('symfony/ux-typed', {strings: [...]}) }}>`;
warns on empty strings array, very long string (overflow risk).

---

### symfony-live-components

**Source:** `src/tools/symfony-live-components.ts`
**Functions:** `list_live_components`, `get_live_component_stats`

Detects `#[AsLiveComponent]` classes; `#[LiveProp]`, `#[LiveAction]`, `#[PostMount]` usage.
Reports writable live props. Warns: `LiveProp(writable: true)` on sensitive fields (user ID,
role), actions without CSRF protection, dehydration on collection props (large payload).

---

### symfony-live-component-security

**Source:** `src/tools/symfony-live-component-security.ts`
**Functions:** `list_live_component_security`, `get_live_component_security_stats`

Audits `#[AsLiveComponent]` classes: CSRF token presence on actions, `LiveProp(writable: true)`
on fields containing `id`/`role`/`permission` (privilege escalation risk), `#[LiveAction]`
without `#[IsGranted]`.

---

### symfony-ux-stimulus-controllers

**Source:** `src/tools/symfony-ux-stimulus-controllers.ts`
**Functions:** `list_stimulus_controllers`, `get_stimulus_controller_stats`

Scans `assets/controllers/` for custom Stimulus controllers: JS file name, controller
identifier (`kebab-case`), targets, values, CSS classes declared. Cross-checks
`assets/controllers.json` for enabled status. Warns on controllers not listed in JSON.

---

### symfony-ux-stimulus-values

**Source:** `src/tools/symfony-ux-stimulus-values.ts`
**Functions:** `list_stimulus_values`, `get_stimulus_values_stats`

Reads Stimulus controller `static values` declarations; warns on values without type
declaration, `ObjectValue`/`ArrayValue` with default `{}` (shared reference bug in JS).

---

### symfony-turbo

**Source:** `src/tools/symfony-turbo.ts`
**Functions:** `list_turbo_config`, `get_turbo_stats`

Detects `symfony/ux-turbo` in `composer.json` and `@hotwired/turbo` npm package. Reads
`mercure.yaml` for the hub used by Turbo streams. Scans templates for `<turbo-stream>`,
`<turbo-frame>` tags. Scans PHP for `TurboBundle::STREAM_FORMAT` responses and
`BroadcastInterface` usage. Warns on Turbo Streams without a Mercure hub, missing `id` on
`<turbo-frame>` elements.

---

### symfony-turbo-streams

**Source:** `src/tools/symfony-turbo-streams.ts`
**Functions:** `list_symfony_turbo_streams`, `get_symfony_turbo_streams_stats`

Analyzes Symfony Turbo Streams configuration; warns on Turbo Streams without Mercure hub
configured, `<turbo-stream>` actions with invalid `action` attribute, broadcast without
`#[Broadcast]` attribute on entity.

---

### symfony-turbo-frames

**Source:** `src/tools/symfony-turbo-frames.ts`
**Functions:** `list_symfony_turbo_frames`, `get_symfony_turbo_frames_stats`

Detects `<turbo-frame>` usage in Twig templates; warns on frames without `id`, lazy-loaded
frames without `loading="lazy"`, frames containing forms without turbo-stream responses.

---

### asset-mapper

**Source:** `src/tools/asset-mapper.ts`
**Functions:** `list_importmaps`, `list_asset_paths`, `get_asset_stats`

Reads `importmap.php` entries (local + CDN), resolves local paths. Detects asset directories
from `asset_mapper.yaml`. Reads `assets/app.js` imports. Detects outdated CDN packages
(checks `importmap.php` CDN URLs for version patterns). Flags missing `importmap.php`,
CDN URLs without an integrity hash (SRI risk).

---

### asset-preload-hints

**Source:** `src/tools/asset-preload-hints.ts`
**Functions:** `list_asset_preload_hints`, `get_asset_preload_hint_stats`

Detects `<link rel="preload">` hints in base templates; warns on preloaded assets missing
from AssetMapper, preload without `crossorigin` for CORS assets, critical CSS not preloaded.

---

### symfony-asset-integrity

**Source:** `src/tools/symfony-asset-integrity.ts`
**Functions:** `list_asset_integrity`, `get_asset_integrity_stats`

Reads `importmap.php` CDN entries for `integrity` attribute; warns on CDN asset without SRI
hash, local assets served over CDN without integrity, `crossorigin` missing when `integrity`
present.

---

### webpack-encore

**Source:** `src/tools/webpack-encore.ts`
**Functions:** `list_webpack_config`, `get_webpack_stats`

Reads `webpack.config.js`: enabled Encore features (`enableSassLoader`, `enableBabelTypeScriptPreset`,
`enableReactPreset`, `enableVueLoader`, `enableSourceMaps`, etc.), entry points, output path,
CDN public path, split chunks. Detects common misconfigs: `enableSourceMaps()` in production
(security info leak), missing `splitEntryChunks()`, multiple entries without `disableSingleRuntimeChunk()`.

---

### vite-bundle

**Source:** `src/tools/vite-bundle.ts`
**Functions:** `list_vite_bundle`, `get_vite_bundle_stats`

Detects `pentatrion/vite-bundle`: `vite.config.js`/`vite.config.ts` entry points, build
outDir, `server.origin`; warns on mismatched Symfony `vite.yaml` publicDirectory, HMR not
configured for dev.

---

### translations

**Source:** `src/tools/translations.ts`
**Functions:** `list_translation_files`, `get_missing_translations`, `get_translation_stats`

All translation files (YAML/XLF) by locale and domain, per-locale key counts, missing-key
analysis comparing every locale against the primary (first detected) locale. Scans
`translations/` (all sub-dirs). Supports YAML flat/nested and XLIFF 1.2/2.0 formats.
Reports domains present only in some locales.

---

### symfony-translation-plurals

**Source:** `src/tools/symfony-translation-plurals.ts`
**Functions:** `list_translation_plurals`, `get_translation_plural_stats`

Reads `translations/` YAML/XLIFF files for plural forms: keys using `|` (Symfony ICU),
pipe-form patterns. Scans PHP `->trans()`/`transChoice()` calls with `count` argument and
Twig `|trans({count: n})`. Warns on plural keys without both singular and plural (missing `|`),
`transChoice()` deprecated in Symfony 5+.

---

### symfony-translation-domains

**Source:** `src/tools/symfony-translation-domains.ts`
**Functions:** `list_translation_domains`, `get_translation_domain_stats`

Lists all translation domains (file stem before `.locale.format`), warns on domain-less keys
in `messages` (no organization), unused domains (domain files with no PHP/Twig references found).

---

### symfony-translation-icu

**Source:** `src/tools/symfony-translation-icu.ts`
**Functions:** `list_translation_icu`, `get_translation_icu_stats`

Detects ICU message format usage (curly-brace placeholders, `{count, plural, one{} other{}}`);
warns on ICU format without `icu_message_formatter` intl extension installed, mixing ICU and
Symfony plural syntax in same file.

---

### symfony-translation-xliff

**Source:** `src/tools/symfony-translation-xliff.ts`
**Functions:** `list_translation_xliff`, `get_translation_xliff_stats`

Reads XLIFF 1.2/2.0 files; detects `<trans-unit state="needs-translation">`, untranslated
targets, missing `target` elements, XLIFF 1.2 without `resname`.

---

### symfony-translation-providers

**Source:** `src/tools/symfony-translation-providers.ts`
**Functions:** `list_symfony_translation_providers`, `get_symfony_translation_provider_stats`

Remote translation providers from `translation.yaml`: `crowdin`, `loco`, `lokalise`,
`phrase`; warns on provider DSN in plain `.env`, missing `enabled_locales` restriction.

---

### symfony-translation-yaml-lint

**Source:** `src/tools/symfony-translation-yaml-lint.ts`
**Functions:** `list_translation_yaml_lint`, `get_translation_yaml_lint_stats`

Scans `translations/*.yaml` files for: duplicate keys, reserved YAML scalars as keys
(`yes`/`no`/`true`/`false` without quotes), inconsistent indentation, keys containing
dots (should use nested YAML), very long translation strings (> 500 chars).

---

### symfony-translation-lint-all

**Source:** `src/tools/symfony-translation-lint-all.ts`
**Functions:** (translation linting across all locales)

Detects missing `%placeholder%` parameters across locales (locale A has `%name%` in key,
locale B does not), inconsistent placeholder naming conventions (camelCase vs snake_case),
keys present in all locales but empty in some.

---

### symfony-translation-gaps

**Source:** `src/tools/symfony-translation-gaps.ts`
**Functions:** `list_translation_gaps`, `get_translation_gap_stats`

Compares translation key counts per locale; outputs gap count. Detects keys in primary locale
missing from other locales; distinguishes intentional absence (configured fallback locale) from
genuine gap.

---

### symfony-flash-messages

**Source:** `src/tools/symfony-flash-messages.ts`
**Functions:** `list_flash_messages`, `get_flash_message_stats`

Scans `addFlash()` call sites in controllers: flash type (success/error/warning/info/custom),
translation key or hardcoded string. Scans Twig templates for `app.flashes()` with matching
type rendering. Warns on flash types added in PHP but never rendered in Twig.

---

### symfony-accessibility

**Source:** `src/tools/symfony-accessibility.ts`
**Functions:** `list_accessibility_issues`, `get_accessibility_stats`

Scans Twig templates for accessibility patterns: `<img>` without `alt`, `<a>` without text
content or `aria-label`, `<button>` without type, `<input>` without associated `<label>`,
missing `lang` on `<html>`, `role="button"` without keyboard listener placeholder comment.

---

### maintenance-mode

**Source:** `src/tools/maintenance-mode.ts`
**Functions:** `list_maintenance_mode`, `get_maintenance_mode_stats`

Detects maintenance mode patterns: `MAINTENANCE=true` env var check in kernel/controller,
`maintenance.html` in public, Nginx `return 503` pattern, `maintenance.lock` file check;
warns on maintenance mode not returning `503`, missing `Retry-After` header.

---

### symfony-webpack-analyzer

**Source:** `src/tools/symfony-webpack-analyzer.ts`
**Functions:** `list_webpack_analyzer`, `get_webpack_analyzer_stats`

Reads `webpack.config.js` for `enableBuildNotifications()`, `addPlugin(new BundleAnalyzerPlugin())`;
warns on large bundle without split chunks, `moment.js` imported entirely (use `date-fns`),
no `analyzeBundle` CI step.

---

### importmap

**Source:** `src/tools/importmap.ts`
**Functions:** `list_importmap`, `get_importmap_stats`

Reads `importmap.php`: local vs CDN entries, version pinning, preload flag; warns on CDN
without integrity, `preload: true` on non-critical imports, two entries for same package.
