# Architecture Documentation

## Overview

`symfony-agent-mcp` is a Model Context Protocol (MCP) server that provides read-only introspection
into Symfony applications. It works by parsing configuration files, reading the file system, and
providing structured information to AI assistants and other MCP clients.

**Version:** 1.0.0 | **Tools:** 1,677 | **Categories:** 16

## Architecture Documents

- [System Architecture](docs/architecture/system-architecture.md) — server layers, component
  diagram, data flow examples
- [Security Design and Implementation](docs/architecture/implementation.md) — threat model,
  mitigations, configuration discovery, error handling, performance
- [Tool Categories Reference](docs/architecture/tool-categories.md) — index linking to all 16
  category files: [symfony-core](docs/architecture/tools-symfony-core.md),
  [database](docs/architecture/tools-database.md),
  [security](docs/architecture/tools-security.md),
  [frontend](docs/architecture/tools-frontend.md),
  [testing](docs/architecture/tools-testing.md),
  [integrations](docs/architecture/tools-integrations.md),
  [serializer](docs/architecture/tools-serializer.md),
  [messaging](docs/architecture/tools-messaging.md),
  [api](docs/architecture/tools-api.md),
  [infrastructure](docs/architecture/tools-infrastructure.md),
  [cache-sessions](docs/architecture/tools-cache-sessions.md),
  [config](docs/architecture/tools-config.md),
  [code-quality](docs/architecture/tools-code-quality.md),
  [cloud-aws](docs/architecture/tools-cloud-aws.md),
  [cloud-other](docs/architecture/tools-cloud-other.md),
  [queues](docs/architecture/tools-queues.md)
- [Testing, Deployment and References](docs/architecture/deployment.md) — test strategy,
  deployment options, external references

## Quick Reference

### Tool Categories

| Category | Tools | Examples |
| --- | --- | --- |
| symfony-core | 549 | routes, services, DI, events, commands, bundles, kernel |
| database | 176 | Doctrine ORM, entities, migrations, DBAL, query patterns |
| security | 133 | voters, firewalls, JWT, OAuth, CSRF, encryption |
| frontend | 121 | Twig, translations, asset mapper, UX, Turbo, live components |
| testing | 110 | PHPUnit, Behat, Cypress, Playwright, Pest, mutation testing |
| integrations | 106 | Stripe, Slack, Sentry, Elasticsearch, OpenAI, OAuth |
| serializer | 91 | serializer, validation, forms, constraints, DTOs |
| messaging | 87 | Messenger, Notifier, Webhooks, Mercure, Mailer |
| api | 68 | API Platform, OpenAPI, GraphQL, REST, versioning |
| infrastructure | 68 | Docker, CI/CD, Kubernetes, Terraform, Nginx |
| cache-sessions | 62 | cache pools, HTTP cache, sessions, rate limiter, lock |
| config | 35 | env config, Monolog, CORS, locale, feature flags |
| code-quality | 25 | PHPStan, Psalm, Rector, CS-Fixer, complexity |
| cloud-aws | 18 | S3, SES, ECS, Lambda, Cognito, CloudFront |
| cloud-other | 16 | Azure, GCP, Firebase, DO, Fly.io, Heroku |
| queues | 14 | RabbitMQ, Kafka, SQS, Redis Streams, Pusher |

### Key Files

| File | Purpose |
| --- | --- |
| `src/server.ts` | MCP server entry point, tool registry, security pipeline |
| `src/index.ts` | Public exports for all tool functions |
| `src/tools/*.ts` | Individual tool implementations (1,677 tools across 16 categories) |
| `src/utils/symfony-parser.ts` | YAML/config parsing utilities |
| `src/utils/security.ts` | Path validation, output sanitization |

### Security Principles

- **Read-only**: no exec/spawn/eval — pure `fs.readFileSync` + `path.join`
- **Path-safe**: all file paths validated against `appPath` to prevent directory traversal
- **Output-sanitized**: sensitive values (passwords, tokens, keys) masked before returning
- **No network**: no outbound HTTP calls, no external APIs called at runtime

## Tool Documentation

All tools are documented by category in [docs/architecture/tool-categories.md](docs/architecture/tool-categories.md).
