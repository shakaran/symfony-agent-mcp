# symfony-agent-mcp

[![npm version](https://img.shields.io/npm/v/@shakaran/symfony-agent-mcp)](https://www.npmjs.com/package/@shakaran/symfony-agent-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-purple)](https://modelcontextprotocol.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](DEVELOPMENT.md)
[![GitHub issues](https://img.shields.io/github/issues/shakaran/symfony-agent-mcp)](https://github.com/shakaran/symfony-agent-mcp/issues)
[![GitHub stars](https://img.shields.io/github/stars/shakaran/symfony-agent-mcp)](https://github.com/shakaran/symfony-agent-mcp/stargazers)
[![Build Status](https://github.com/shakaran/symfony-agent-mcp/actions/workflows/tests.yml/badge.svg)](https://github.com/shakaran/symfony-agent-mcp/actions)
[![Coverage](https://codecov.io/gh/shakaran/symfony-agent-mcp/graph/badge.svg)](https://codecov.io/gh/shakaran/symfony-agent-mcp)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/shakaran/symfony-agent-mcp/badge)](https://scorecard.dev/viewer/?uri=github.com/shakaran/symfony-agent-mcp)

[Features](#features) • [Quick Start](#quick-start) • [Integration](#integration) • [Usage](#usage) • [Documentation](#documentation) • [Contributing](#contributing) • [License](#license)

---

A production-ready **Model Context Protocol (MCP) server** for Symfony applications.
Gives AI assistants deep, read-only introspection into your entire Symfony codebase —
routes, controllers, services, entities, database schema, migrations, events, forms,
security, Doctrine, Messenger, Twig, API Platform, and much more.

| Client | Install |
| --- | --- |
| **Claude Code** | Run `claude mcp add` → [setup](#claude-code) |
| **Claude Desktop** | Add to `claude_desktop_config.json` → [setup](#claude-desktop) |
| **Cursor** | Add to `.cursor/mcp.json` → [setup](#cursor) |
| **VS Code Copilot** | Add to `.vscode/mcp.json` → [setup](#vs-code-copilot) |
| **Any MCP client** | stdio transport, `command: npx @shakaran/symfony-agent-mcp` |

---

## Features

### 1,679 Tools across 16 Categories

```text
Available tool categories (16 categories, 1,679 tools total, ~164,729 tokens if all active)

  Category         │ Tools      │ Est. tokens    │ Description
  ─────────────────┼────────────┼────────────────┼────────────────────────────────────────────────────────
  symfony-core     │  549 tools │ ~ 53995 tokens │ Routes, services, controllers, events, commands, bundles, DI container, kernel
  database         │  176 tools │ ~ 17121 tokens │ Entities, migrations, Doctrine ORM, relationships, query patterns, indexes, DBAL
  security         │  133 tools │ ~ 13008 tokens │ Voters, firewalls, authenticators, JWT, OAuth, CSRF, access control, secrets vault
  frontend         │  121 tools │ ~ 11568 tokens │ Twig, translations, asset mapper, Symfony UX, Turbo, live components, Webpack
  testing          │  110 tools │ ~ 10559 tokens │ PHPUnit, Behat, Cypress, Playwright, Psalm, PHPStan, Rector, static analysis
  integrations     │  106 tools │ ~ 10939 tokens │ Stripe, Slack, Sentry, Elasticsearch, Twilio, SendGrid, Mailgun, Datadog, OpenAI
  serializer       │   91 tools │ ~  9031 tokens │ Serializer, validation, forms, constraints, DTOs, transformers, normalizers
  messaging        │   87 tools │ ~  8455 tokens │ Messenger, notifier, webhooks, Mercure, mailer, transports, stamps, failure handling
  api              │   68 tools │ ~  6438 tokens │ API Platform, OpenAPI, GraphQL, REST patterns, versioning, rate limits, Nelmio
  infrastructure   │   68 tools │ ~  6794 tokens │ Docker, CI/CD, Kubernetes, Terraform, Helm, Nginx, serverless, cloud platforms
  cache-sessions   │   62 tools │ ~  5945 tokens │ Cache pools, HTTP cache, sessions, rate limiter, lock, cache warmers, OPcache
  config           │   35 tools │ ~  3157 tokens │ Environment config, framework settings, Monolog, CORS, locale, feature flags
  code-quality     │   25 tools │ ~  2447 tokens │ Profiler, dead code detection, dependency graph, accessibility, code metrics
  cloud-aws        │   18 tools │ ~  1945 tokens │ AWS S3, SES, Cognito, ECS, Lambda/Bref, Parameter Store, Secrets Manager, CloudFront
  cloud-other      │   16 tools │ ~  1851 tokens │ Azure Blob/Pipelines, Google Cloud Run/Storage, Firebase, DigitalOcean, Consul
  queues           │   14 tools │ ~  1476 tokens │ RabbitMQ, Kafka, SQS FIFO/DLQ, Pusher, Redis pub/sub and streams

To activate a category: call activate_category(category: "<key>")
To search for specific tools: call search_tools(query: "what you want to do")
```

### [Security-first design](SECURITY.md)

- **Read-only** — never writes, modifies, or executes anything
- **Auto-redaction** — passwords, tokens, API keys, and database credentials are replaced with `[REDACTED]` before any data reaches the AI
- **DLP pipeline** — multi-layer Data Loss Prevention scanner (regex patterns + structural detection for credit cards, JWTs, SSH keys, cloud credentials, etc.)
- **Path validation** — directory traversal attacks are blocked at the input layer
- **No code execution** — PHP files are parsed statically (no `eval`, no PHP runtime)
- **No network calls** — all data comes from local files only
- **Prompt injection filter** — tool output is scanned for injection patterns before being forwarded to the AI

---

## Quick Start

### Option A: npx (no install required)

```bash
npx @shakaran/symfony-agent-mcp
```

### Option B: Install globally

```bash
npm install -g @shakaran/symfony-agent-mcp
symfony-agent-mcp
```

### Option C: From source

```bash
git clone https://github.com/shakaran/symfony-agent-mcp
cd symfony-agent-mcp
pnpm install
pnpm build
pnpm start
```

See [GETTING_STARTED.md](GETTING_STARTED.md) for a step-by-step guide including Node.js setup, troubleshooting, and first-use verification.

---

## Integration

### One-click Install

| Client | Install |
| --- | --- |
| **Cursor** | <a href="https://cursor.com/install-mcp?name=symfony-agent-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyJAc2hha2FyYW4vc3ltZm9ueS1hZ2VudC1tY3AiXX0="><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/deeplink/mcp-install-dark.svg"><img alt="Install in Cursor" src="https://cursor.com/deeplink/mcp-install-light.svg"></picture></a> |
| **VS Code** | [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22symfony-agent-mcp%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22%40shakaran%2Fsymfony-agent-mcp%22%5D%7D) |
| **VS Code Insiders** | [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_MCP_Server-24bfa5?style=for-the-badge&logo=visualstudiocode&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22symfony-agent-mcp%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22%40shakaran%2Fsymfony-agent-mcp%22%5D%7D) |
| **Windsurf** | [![Install in Windsurf](https://img.shields.io/badge/Windsurf-Install_MCP_Server-00B8A9?style=for-the-badge&logo=codeium&logoColor=white)](https://windsurf.com/editor/directory/mcp/install?name=symfony-agent-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyJAc2hha2FyYW4vc3ltZm9ueS1hZ2VudC1tY3AiXX0=) |
| **Claude Code** | [![Install in Claude Code](https://img.shields.io/badge/Claude_Code-Add_MCP_Server-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](#claude-code) |
| **Claude Desktop** | [![Install in Claude Desktop](https://img.shields.io/badge/Claude_Desktop-Add_MCP_Server-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](#claude-desktop) |

### Claude Code

Run once to register the server:

```bash
# npx (no local install required)
claude mcp add symfony -- npx @shakaran/symfony-agent-mcp

# Or from a local source build
claude mcp add symfony -- node /path/to/symfony-agent-mcp/dist/server.js
```

To make it available globally across all projects, add the `--scope user` flag:

```bash
claude mcp add --scope user symfony -- npx @shakaran/symfony-agent-mcp
```

### Claude Desktop

Add to your Claude Desktop configuration file (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "symfony": {
      "command": "npx",
      "args": ["@shakaran/symfony-agent-mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "symfony": {
    "command": "npx",
    "args": ["@shakaran/symfony-agent-mcp"]
  }
}
```

### VS Code Copilot

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "symfony": {
      "type": "stdio",
      "command": "npx",
      "args": ["@shakaran/symfony-agent-mcp"]
    }
  }
}
```

---

## Usage

Every tool accepts an `app_path` parameter pointing to the root of your Symfony application:

```text
list_routes(app_path: "/var/www/myapp")
→ Found 42 routes: GET /api/users [api_users], POST /login [app_login], …

get_entity_details(app_path: "/var/www/myapp", entity_name: "User")
→ Entity: User  |  Table: users
  Properties: id (int, PK), email (string 180), isActive (bool)
  Relationships: OneToMany → Post (author)

get_error_summary(app_path: "/var/www/myapp")
→ Last 24h: 3 CRITICAL, 12 ERROR, 47 WARNING

get_code_quality_report(app_path: "/var/www/myapp")
→ God classes: UserManager (1240 lines), dead services: 4, N+1 risks: 7
```

Example prompts you can use with Claude:

- *"Show me all routes with POST methods and their controllers"*
- *"Which services are tagged with `doctrine.event_listener`?"*
- *"List the last 50 lines of the production log"*
- *"Are there any circular dependencies in the service container?"*
- *"What Doctrine entities have relationships with User?"*
- *"Show me the migration history and any destructive migrations"*
- *"Which controllers have no security attributes?"*

---

## Configuration

All configuration is done via environment variables passed to the MCP server process.

### Tool Discovery

| Variable | Default | Description |
| --- | --- | --- |
| `SYMFONY_MCP_DYNAMIC_TOOLS` | `true` | Enable dynamic tool discovery. When `true`, `tools/list` returns only 5 meta-tools instead of all 1,679. Set to `false` to restore the legacy behaviour (all tools always visible). |
| `SYMFONY_MCP_TOKEN_BUDGET` | `40000` | Maximum estimated tokens that can be activated per session. Activation is blocked when this limit would be exceeded; pass `force=true` in `activate_category` to override. |

### Security & Access

| Variable | Default | Description |
| --- | --- | --- |
| `SYMFONY_MCP_ALLOWED_PATHS` | *(any)* | Colon-separated list of absolute app paths the server may inspect. Example: `/var/www/app1:/var/www/app2` |
| `SYMFONY_MCP_REQUIRE_SYMFONY` | `true` | Set to `false` to skip Symfony project validation (useful for testing). |
| `SYMFONY_MCP_ALLOWED_TOOLS` | *(all)* | Comma-separated allowlist of tool names. Only listed tools are callable. |
| `SYMFONY_MCP_BLOCKED_TOOLS` | *(none)* | Comma-separated denylist. Takes precedence over the allowlist. |
| `SYMFONY_MCP_SIGNING_SECRET` | *(off)* | 32+ character secret for request signing. Enables per-request authentication. |
| `SYMFONY_MCP_SESSION_SECRET` | *(off)* | Secret for session token generation. |
| `SYMFONY_MCP_SESSION_TOKEN` | *(off)* | Token to validate on incoming requests. |
| `SYMFONY_MCP_SESSION_STRICT` | `false` | Set to `true` to reject requests without a valid session token. |
| `SYMFONY_MCP_SESSION_WINDOW` | `300` | Session token validity window in seconds. |

### Rate Limiting

| Variable | Default | Description |
| --- | --- | --- |
| `SYMFONY_MCP_RATE_LIMIT` | `60` | Max requests per window. Set to `0` to disable. |
| `SYMFONY_MCP_RATE_WINDOW_MS` | `60000` | Rate limit window in milliseconds (1 minute). |
| `SYMFONY_MCP_RATE_BURST` | `10` | Max burst requests in 1 second. |

### Transport

| Variable | Default | Description |
| --- | --- | --- |
| `SYMFONY_MCP_HTTP_PORT` | *(off)* | Port for HTTP/SSE transport. When set, starts an HTTP server in addition to stdio. |
| `SYMFONY_MCP_STDIO` | `true` | Set to `false` to disable stdio transport (useful when running HTTP-only). |
| `SYMFONY_MCP_TOOL_TIMEOUT_MS` | `30000` | Per-tool execution timeout in milliseconds. |

### Example: Claude Code with dynamic tools disabled

```json
{
  "mcpServers": {
    "symfony": {
      "command": "npx",
      "args": ["@shakaran/symfony-agent-mcp"],
      "env": {
        "SYMFONY_MCP_DYNAMIC_TOOLS": "false"
      }
    }
  }
}
```

### Example: token budget increased to 80 000 tokens

```json
{
  "mcpServers": {
    "symfony": {
      "command": "node",
      "args": ["/path/to/symfony-agent-mcp/dist/server.js"],
      "env": {
        "SYMFONY_MCP_TOKEN_BUDGET": "80000"
      }
    }
  }
}
```

---

## Local Install (from source)

Use this when you want to run the server from a local clone (no npm publish needed).

```bash
# 1. Clone the repo
git clone https://github.com/shakaran/symfony-agent-mcp
cd symfony-agent-mcp

# 2. Install dependencies (Node.js ≥ 22 required)
pnpm install         # or: npm install

# 3. Build TypeScript → dist/
pnpm build           # or: npm run build

# 4. Test the server responds
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/server.js
```

Then configure your MCP client to point at the built file:

**Claude Code** (run once):

```bash
claude mcp add symfony -- node /absolute/path/to/symfony-agent-mcp/dist/server.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "symfony": {
      "command": "node",
      "args": ["/absolute/path/to/symfony-agent-mcp/dist/server.js"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "symfony": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/symfony-agent-mcp/dist/server.js"]
    }
  }
}
```

> **Tip:** After rebuilding (`pnpm build`), restart your MCP client to pick up the changes.

---

## What It Reads

The server reads files directly from your Symfony app — no database connection, no PHP runtime needed:

- `config/routes.yaml`, `config/routes/*.yaml` — YAML routes
- PHP 8 `#[Route]` attributes on controllers in `src/Controller/`
- `config/services.yaml` — DI container services
- `config/packages/*.yaml` — Framework, security, doctrine, messenger, mailer config
- `src/Entity/*.php` — Doctrine entity files (PHP 8 attributes + annotations)
- `var/log/*.log` — Application logs
- `migrations/`, `src/Migrations/` — Doctrine migration files
- `composer.json`, `composer.lock` — Package info
- `.env`, `.env.local`, `.env.*.local` — Environment variables (sensitive values auto-redacted)

---

## Symfony Compatibility

| Symfony | PHP | ORM mapping |
| --- | --- | --- |
| 5.4 LTS | 8.0+ | Annotations or Attributes |
| 6.x | 8.0+ | Attributes |
| 7.x | 8.2+ | Attributes |
| 8.x | 8.2+ | Attributes |

---

## Requirements

- **Node.js** ≥ 22.0.0
- **pnpm** ≥ 11.0.0 (or npm/yarn for development)

---

## Development

```bash
pnpm install
pnpm dev            # watch mode (TypeScript → dist/)
pnpm test           # run all tests
pnpm lint           # ESLint
pnpm typecheck      # tsc --noEmit
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full development guide: architecture overview, adding new tools, testing strategy, and contribution guidelines.

---

## Documentation

| Document | Description |
| --- | --- |
| [GETTING_STARTED.md](GETTING_STARTED.md) | Step-by-step setup, Node.js prerequisites, troubleshooting |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, security pipeline, component overview, all 1,679 tools across 16 categories documented |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Development workflow, adding tools, testing, contributing |
| [SECURITY.md](SECURITY.md) | Threat model, DLP pipeline, responsible disclosure policy |
| [CHANGELOG.md](CHANGELOG.md) | Release history and roadmap |
| [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) | High-level project overview and statistics |

---

## Contributing

Issues and pull requests are welcome at [github.com/shakaran/symfony-agent-mcp](https://github.com/shakaran/symfony-agent-mcp).

Please read [DEVELOPMENT.md](DEVELOPMENT.md) before submitting a PR, and [SECURITY.md](SECURITY.md) for the responsible disclosure policy.

---

## License

MIT © [Ángel Guzmán Maeso](https://github.com/shakaran)
