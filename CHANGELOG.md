# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project icon (`assets/icon.svg` and a 512×512 PNG), carried inside the MCPB
  bundle. Smithery scores an icon at 8 of its 35 server-metadata points, and a
  listing without one renders a grey placeholder.

- Smithery badge in the README. Note that the badge endpoint currently returns
  HTTP 500 for every server on Smithery, popular ones included, so it renders
  broken until they fix it.

- `mcpb/manifest.json` and `pnpm run build:mcpb`, producing the self-contained
  `.mcpb` bundle Smithery distributes for local installs (5.7 MB packed). The
  bundle carries its production dependencies and is stripped of source maps and
  declarations, which are a third of the unpacked size and never read at
  runtime. The five configuration options appear as a form at install time.

  The manifest deliberately declares no `tools`. Doing so looked like the fix
  for Smithery's empty listing, but the two schemas contradict each other: MCPB
  rejects `inputSchema` inside a tool entry, and Smithery rejects a tool entry
  without it — the publish fails with one 400 per tool.

### Removed

- `smithery.yaml`. Smithery retired the `startCommand` / `commandFunction`
  route for stdio servers on 2025-09-07; a local server is now published as an
  MCPB bundle. The file was written against examples that had not been updated
  and would not have worked.

## [1.0.2] - 2026-08-23

### Added

- The server now publishes `instructions` in its `initialize` response. With
  progressive discovery on, `tools/list` advertises five meta-tools and hides
  the other 1,672 until a category is activated — a client had no way to learn
  they existed. The instructions carry the real tool count, the category count,
  the five meta-tools by name, the `SYMFONY_MCP_DYNAMIC_TOOLS=false` escape
  hatch, and the read-only guarantee. They cost 261 tokens; advertising every
  schema up front costs about 154,000.

- `server.json`, so the server can be published to the official MCP Registry,
  and `mcpName` in `package.json`, which is how the registry verifies that the
  npm package belongs to the claimed namespace.

- `glama.json` naming the maintainer, and `smithery.yaml` describing how to
  launch the server over stdio with its optional configuration.

- `registry-metadata` test suite, asserting that `server.json` and
  `package.json` agree on name, namespace, version and npm identifier, that
  the description fits the registry's 100-character limit, and that no
  environment variable is marked required. Three values have to be bumped
  together in two files at every release; getting it wrong only surfaces as a
  failed publish.

### Fixed

- `symfony-health-endpoint-security` only ever scanned files already named
  `*health*`, `*ping*` or `*status*`: the filename check ran `continue` before
  the route check, so the `HEALTH_PATHS` lookup below it could never change the
  outcome. A health endpoint declared in a differently-named controller was
  skipped. Either signal now qualifies.

- `symfony-translation-yaml-lint` built its domain map as a plain object, so
  `hasOwnProperty(map, '__proto__')` read false, the guarded assignment went
  through the prototype setter, and the write landed on the map's prototype
  instead of an own key. Both levels now have a null prototype.

- `doctrine-dbal-driveroptions` and `php-gd-security` each tested the same
  condition on both sides of an `||`.

- `http-cache` coerced `trusted_proxies` and `trusted_headers` with `?? []`
  inside an `if` that had already excluded nullish values; a non-array in YAML
  passed straight through the cast. Both now check `Array.isArray`.

### Changed

- CodeQL scans GitHub Actions workflows alongside JavaScript/TypeScript, one
  job per language so each keeps its own alert category.

## [1.0.1] - 2026-08-21

### Fixed

- Three tools were advertised in `tools/list` but had no handler, so calling
  them returned `Unknown tool` after the client had already offered them:
  - `get_php_dnf_type_stats` was missing the plural its handler and its
    implementation both use. Renamed to `get_php_dnf_types_stats`.
  - `get_php_hash_algorithm_security_tools` and
    `get_php_socket_programming_tools` were "list my own definitions" entries
    that were never implemented. Removed — `list_tool_categories` and
    `search_tools` already do this properly.

  Tool count goes from 1,679 to 1,677 as a result.

### Added

- `tool-registry-integrity` test suite, asserting that every advertised tool
  has a handler, every handler is advertised or is a discovery meta-tool, and
  no name is advertised twice. The tool list and the handler map are built in
  different places with nothing tying them together; this is what would have
  caught the above.

## [1.0.0] - 2026-06-16

### MCP Server

- Model Context Protocol server using stdio transport and `@modelcontextprotocol/sdk`
- Tool registration and routing with 5-layer security pipeline:
  `validateToolArgs → guardAppPath → withAudit → tool → sanitizeToolResult`
- TypeScript 5+ strict mode, Node.js 22+, pnpm 11+
- Full error handling with MCP-compliant structured error responses

### Dynamic Tool Discovery

- `SYMFONY_MCP_DYNAMIC_TOOLS` env var (default `true`) — enables dynamic tool exposure;
  default `tools/list` returns 5 meta-tools instead of all 1,679
- `activate_category(category, force?)` — activates a tool category for the current session;
  triggers `notifications/tools/list_changed` so MCP clients re-fetch the tool list
- `search_tools(query, limit?)` — full-text search across all 1,679 tool definitions using
  an in-memory inverted index built at startup
- `list_tool_categories()` — lists all 16 categories with tool counts and descriptions
- `get_active_tools()` — shows currently active tool names and session token estimate
- `deactivate_category(category)` — removes a category from the session to free context budget

### Token Budget Guard

- `SYMFONY_MCP_TOKEN_BUDGET` (default `40000`) — blocks category activation when it would
  exceed the token budget; pass `force=true` to `activate_category` to override

### Transport & Rate Limiting

- HTTP/SSE transport via `SYMFONY_MCP_HTTP_PORT` — starts an HTTP server alongside stdio
- `SYMFONY_MCP_STDIO` — toggle stdio transport independently
- `SYMFONY_MCP_RATE_LIMIT` / `SYMFONY_MCP_RATE_WINDOW_MS` / `SYMFONY_MCP_RATE_BURST` —
  configurable sliding-window rate limiting
- `SYMFONY_MCP_TOOL_TIMEOUT_MS` — per-tool execution timeout in milliseconds

### Access Control

- `SYMFONY_MCP_ALLOWED_PATHS` — colon-separated list of allowed app roots
- `SYMFONY_MCP_ALLOWED_TOOLS` — comma-separated allowlist; only listed tools are callable
- `SYMFONY_MCP_BLOCKED_TOOLS` — comma-separated denylist; takes precedence over allowlist
- `SYMFONY_MCP_SIGNING_SECRET` — 32+ char secret for HMAC-SHA256 request signing
- `SYMFONY_MCP_SESSION_SECRET` / `SYMFONY_MCP_SESSION_TOKEN` / `SYMFONY_MCP_SESSION_STRICT` /
  `SYMFONY_MCP_SESSION_WINDOW` — session token validation

### 1,679 Tools across 16 Categories

820 TypeScript files in `src/tools/`, one per tool domain:

| Category | Tools | Description |
| --- | --- | --- |
| symfony-core | 549 | Routes, services, DI, events, commands, bundles, kernel, PHP patterns |
| database | 176 | Doctrine ORM, entities, migrations, DBAL, relationships, query patterns |
| security | 133 | Voters, firewalls, JWT, OAuth, CSRF, access control, secrets vault |
| frontend | 121 | Twig, translations, asset mapper, Symfony UX, Turbo, live components |
| testing | 110 | PHPUnit, Behat, Cypress, Playwright, Pest, mutation testing |
| integrations | 106 | Stripe, Slack, Sentry, Elasticsearch, Twilio, SendGrid, OpenAI, OAuth |
| serializer | 91 | Serializer, validation, forms, constraints, DTOs, normalizers |
| messaging | 87 | Messenger, Notifier, Webhooks, Mercure, Mailer, transports |
| api | 68 | API Platform, OpenAPI, GraphQL, REST patterns, versioning, Nelmio |
| infrastructure | 68 | Docker, CI/CD, Kubernetes, Terraform, Helm, Nginx, serverless |
| cache-sessions | 62 | Cache pools, HTTP cache, sessions, rate limiter, lock, warmers |
| config | 35 | Env config, Monolog, CORS, locale, feature flags, PHP INI |
| code-quality | 25 | PHPStan, Psalm, Rector, CS-Fixer, complexity, architecture rules |
| cloud-aws | 18 | S3, SES, ECS, Lambda, Cognito, CloudFront, Parameter Store |
| cloud-other | 16 | Azure, GCP, Firebase, DigitalOcean, Fly.io, Heroku, Render |
| queues | 14 | RabbitMQ, Kafka, SQS, Redis Streams, Redis PubSub, Pusher |

### Security Pipeline

```text
validateToolArgs → guardAppPath → withAudit → tool → sanitizeToolResult
```

- **validateToolArgs** — MCP schema validation; rejects wrong types before any code runs
- **guardAppPath** — resolves `app_path`, validates against allowed roots, blocks symlink escapes
- **withAudit** — structured audit log entry before execution; optional AES-256-GCM encryption
- **tool** — pure `fs.readFileSync`, no exec/spawn/eval/network
- **sanitizeToolResult** — multi-layer DLP: keywords, Base64, JWTs, SSH keys, cloud credentials,
  DSN passwords, prompt injection patterns

### 49 Security Enhancements

Sensitive data redaction, path traversal prevention, app path authorization (`app-guard`),
rate limiting (sliding window), audit logging, HMAC-SHA256 request signing, nonce-based
replay prevention, session tokens (TOTP-style), secrets vault/SSM/Secrets Manager resolver,
advanced DLP (structural patterns), anomaly/intrusion detection, Prometheus security metrics,
audit log AES-256-GCM encryption, SIEM/CEF audit format, HTTP security headers, mTLS,
request body size caps, SBOM + dependency scanning CI, npm package registry signature audit.

See [SECURITY.md](SECURITY.md) for the full checklist.

### Read-Only Design

- No PHP execution — files parsed statically with regex and YAML parsing
- No outbound network calls at runtime
- No file writes, no shell commands
- Symlink guards on all filesystem walkers

### Supported Symfony Versions

Symfony 5.4 LTS, 6.x, 7.x, 8.x — PHP 8.0+

### Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design and component overview
- [SECURITY.md](SECURITY.md) — threat model, DLP pipeline, responsible disclosure
- [DEVELOPMENT.md](DEVELOPMENT.md) — adding tools, code style, testing
- [GETTING_STARTED.md](GETTING_STARTED.md) — step-by-step setup guide
- [docs/architecture/](docs/architecture/) — 16 per-category tool reference files
