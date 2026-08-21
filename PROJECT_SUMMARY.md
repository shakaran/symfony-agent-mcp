# symfony-agent-mcp — Project Summary

## Project Overview

**symfony-agent-mcp** is a complete, production-ready Model Context Protocol (MCP) server for
Symfony applications. It provides AI assistants (Claude, Cursor, etc.) with read-only
introspection capabilities into Symfony application structure, configuration, and security posture.

### Key Statistics

- **Total Tools**: 1,679 across 16 functional categories
- **Tool Files**: 820 TypeScript files in `src/tools/`
- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js 22+
- **Package manager**: pnpm 11+
- **License**: MIT
- **MCP SDK**: `@modelcontextprotocol/sdk`

## Project Structure

```text
symfony-agent-mcp/
├── src/
│   ├── index.ts                # Public exports
│   ├── server.ts               # MCP server entry point and tool registry
│   │
│   ├── tools/                  # 820 tool files (1,679 tools total)
│   │   ├── routes-inspector.ts
│   │   ├── di-inspector.ts
│   │   ├── security-voters.ts
│   │   └── ...                 # One file per tool domain
│   │
│   └── utils/                  # Shared utilities
│       ├── security.ts         # Path validation, output sanitization
│       ├── symfony-parser.ts   # YAML/config parsing
│       ├── app-guard.ts        # App path guard middleware
│       ├── audit-logger.ts     # Audit trail
│       ├── output-sanitizer.ts # Sensitive value masking
│       ├── tool-registry.ts    # Tool registration helpers
│       └── ...
│
├── docs/architecture/          # Architecture documentation
│   ├── tool-categories.md      # Index of all 16 categories
│   ├── tools-symfony-core.md   # 549 core tools
│   ├── tools-database.md       # 176 database tools
│   ├── tools-security.md       # 133 security tools
│   └── ...                     # One file per category
│
├── README.md
├── ARCHITECTURE.md
├── DEVELOPMENT.md
├── SECURITY.md
├── GETTING_STARTED.md
├── CHANGELOG.md
└── PROJECT_SUMMARY.md          # This file
```

## Tool Categories (16 total)

| Category | Tools | Description |
| --- | --- | --- |
| symfony-core | 549 | Routes, services, DI, events, commands, bundles, kernel, PHP patterns |
| database | 176 | Doctrine ORM, entities, migrations, DBAL, query patterns, indexes |
| security | 133 | Voters, firewalls, JWT, OAuth, CSRF, access control, secrets vault |
| frontend | 121 | Twig, translations, asset mapper, Symfony UX, Turbo, live components |
| testing | 110 | PHPUnit, Behat, Cypress, Playwright, Pest, mutation testing |
| integrations | 106 | Stripe, Slack, Sentry, Elasticsearch, OpenAI, OAuth providers |
| serializer | 91 | Serializer, validation, forms, constraints, DTOs, normalizers |
| messaging | 87 | Messenger, Notifier, Webhooks, Mercure, Mailer, transports |
| api | 68 | API Platform, OpenAPI, GraphQL, REST patterns, versioning |
| infrastructure | 68 | Docker, CI/CD, Kubernetes, Terraform, Helm, Nginx, serverless |
| cache-sessions | 62 | Cache pools, HTTP cache, sessions, rate limiter, lock, warmers |
| config | 35 | Env config, Monolog, CORS, locale, feature flags, PHP INI |
| code-quality | 25 | PHPStan, Psalm, Rector, CS-Fixer, complexity, architecture rules |
| cloud-aws | 18 | S3, SES, ECS, Lambda, Cognito, CloudFront, Parameter Store |
| cloud-other | 16 | Azure, GCP, Firebase, DigitalOcean, Fly.io, Heroku, Render |
| queues | 14 | RabbitMQ, Kafka, SQS, Redis Streams, Redis PubSub, Pusher |

## Key Features

### Read-Only Security Model

- All operations are pure `fs.readFileSync` — no exec, spawn, or eval
- App path validated against root on every call (directory traversal prevention)
- Symlink guards on filesystem walkers
- Sensitive values (passwords, tokens, keys, DSNs) masked before returning

### 5-Layer Security Pipeline

```text
validateToolArgs → guardAppPath → withAudit → tool → sanitizeToolResult
```

Each tool call passes through all five layers before returning output.

### MCP Protocol

- Full Model Context Protocol compliance (JSON-RPC over stdio)
- Tool registration with typed input schemas
- Structured error responses

## Supported Symfony Versions

- Symfony 5.4+, 6.x, 7.x, 8.x

Works with standard Symfony directory layout (`config/`, `src/`, `var/log/`, etc.).

## Technology Stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript 5+ (strict mode) |
| Runtime | Node.js 22+ |
| Package manager | pnpm 11+ |
| Protocol | Model Context Protocol (MCP) |
| Transport | stdio |
| Config parsing | js-yaml |
| Env loading | dotenv |
| Tests | Jest |
| Linting | ESLint + markdownlint-cli2 |

## Documentation

| File | Purpose |
| --- | --- |
| `README.md` | Features, installation, quick start |
| `ARCHITECTURE.md` | System design, security model, component overview |
| `DEVELOPMENT.md` | Setup, adding tools, code style |
| `SECURITY.md` | Threat model, mitigations, audit checklist |
| `GETTING_STARTED.md` | Step-by-step first-run guide |
| `CHANGELOG.md` | Release history |
| `docs/architecture/` | Per-category tool reference |

## License

MIT — see `LICENSE`.
