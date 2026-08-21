# Security Design and Implementation Details

## Threat Model

1. **Sensitive data exposure** — passwords in `.env`, config files, database URLs, API keys,
   tokens, PII in logs
2. **Unauthorized file access** — directory traversal, symlink escapes, access to files
   outside the Symfony app root
3. **Context window poisoning** — prompt injection patterns embedded in application files
   (log entries, user-controlled config values)
4. **Resource exhaustion** — very large files, deeply nested configs, oversized MCP payloads

## Mitigations

### Output Sanitization — `sanitizeToolResult`

`src/utils/output-sanitizer.ts` runs after every tool call:

- **Keyword masking**: 40+ case-insensitive key patterns (`password`, `token`, `secret`,
  `api_key`, `aws_secret`, `github_token`, `mongodb_password`, …); matching values replaced
  with `[REDACTED]`
- **Structural patterns**: Base64-like strings ≥40 chars, JWTs (three dot-separated Base64
  segments), SSH private key blocks (`-----BEGIN … PRIVATE KEY-----`), cloud credential
  patterns (`AKIA…`, `AIza…`), credit card numbers (Luhn-validated)
- **DSN masking**: strips passwords from database and transport URLs
  (`mysql://user:pass@host/db` → `mysql://user:[REDACTED]@host/db`)
- **Prompt injection scan**: output containing known injection phrases is stripped before
  the MCP response is sent

### Path Validation — `guardAppPath`

`src/utils/app-guard.ts` runs before every tool call:

```typescript
const real = fs.realpathSync(appPath);   // resolves symlinks
if (!ALLOWED_PATHS.some(root => real.startsWith(root + path.sep))) {
  throw new ToolError('app_path outside allowed roots');
}
```

Prevents:

- `../../../etc/passwd` traversal
- Absolute paths outside the allowlist
- Symlink escapes to files or directories outside the app root

### No Code Execution

The MCP server:

- Does NOT execute PHP or shell commands
- Does NOT evaluate dynamic code (`eval`, `new Function`, `child_process`)
- Does NOT call external APIs at runtime
- Does NOT write files or modify configuration

All data comes from `fs.readFileSync` on known Symfony file locations.

### Rate Limiting

Sliding-window rate limiter in `src/server.ts`:

- Default: 60 requests per 60-second window, burst cap of 10 per second
- Configurable via `SYMFONY_MCP_RATE_LIMIT`, `SYMFONY_MCP_RATE_WINDOW_MS`,
  `SYMFONY_MCP_RATE_BURST`

### Request Size Cap

Incoming MCP frames capped at a configurable byte limit before JSON parsing to prevent
memory exhaustion from malformed or oversized payloads.

## Configuration Discovery

The server reads files from the Symfony app using conventional paths — no configuration
file required:

```text
/app/
├── config/
│   ├── routes.yaml           ← YAML routes
│   ├── services.yaml         ← DI container services
│   └── packages/
│       ├── framework.yaml    ← Framework settings
│       ├── security.yaml     ← Security config
│       ├── doctrine.yaml     ← Doctrine ORM/DBAL
│       └── …
├── src/
│   ├── Controller/           ← PHP 8 #[Route] attributes
│   └── Entity/               ← Doctrine entity files
├── migrations/               ← Doctrine migration files
├── var/log/                  ← Application logs
├── .env                      ← Environment variables (sensitive values redacted)
├── .env.local
└── composer.json
```

## YAML Parsing

Uses `js-yaml`:

```typescript
import * as yaml from 'js-yaml';
const config = yaml.load(fs.readFileSync(filePath, 'utf8'));
```

Handles anchors and aliases (`&default`, `*default`) common in Symfony's
auto-configuration and package configs.

## PHP File Analysis

Entity properties and relationships extracted with regex — no PHP runtime required:

```typescript
// PHP 8 attributes
const columnRegex =
  /#\[ORM\\Column\([^)]*\)]\s*(?:private|public)\s+\??[\w\\]+\s+\$(\w+)/g;

const relationRegex =
  /#\[ORM\\(OneToMany|ManyToOne|OneToOne|ManyToMany)\([^)]*\)]/g;

// Doctrine 2 annotations (Symfony 5.4 compatibility)
const annotationRegex = /@ORM\\(Column|OneToMany|ManyToOne)\b/g;
```

Route attributes on controllers follow the same pattern:

```typescript
const routeRegex = /#\[Route\(\s*['"]([^'"]+)['"]/g;
```

Back to [Architecture Documentation](../../ARCHITECTURE.md)
