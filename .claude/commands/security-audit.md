# Security Audit — symfony-agent-mcp

Run a comprehensive security audit of the Symfony MCP server codebase.

## Architecture context

The security pipeline in `server.ts` is applied to every tool call:

```text
validateToolArgs()       ← input-validator.ts: schema + PATH_SAFE regex
  → guardAppPath()       ← app-guard.ts: path traversal + symlink + allowlist
    → withAudit()        ← audit-logger.ts: encrypted audit log
      → tool handler()   ← src/tools/*.ts
    → sanitizeToolResult() ← output-sanitizer.ts: DLP + injection filter + size cap
```

## What to look for in tool files

**Real vulnerabilities:**

- Secondary user-supplied param (not `app_path`) joined into a filesystem path without containment check
- Regex with nested quantifiers `(a+)+` on large file content (no file size guard)
- DSN/URL credentials not caught by DLP: `?password=` query-string, `redis://:pass@`, `redis://token@host`
- HTTP headers `Authorization`, `X-Api-Key` emitted verbatim (DLP only catches JWT-format tokens)
- Env var masking missing: PASS, KEY, DSN, AUTH, CERT
- Stateful `/g` regex with `lastIndex` shared across loop iterations → false negatives

**Not vulnerabilities (pipeline handles them):**

- Reading files under appPath — guardAppPath validated it
- Returning credential-shaped strings — DLP redacts AWS keys, JWTs, PEM blocks, URLs with `user:pass@host`
- Large output — size cap enforced
- Missing per-tool input validation — validateToolArgs handles it centrally

## Key utility files

| File | Purpose |
|------|---------|
| `src/utils/dlp-detector.ts` | DLP patterns: AWS, GitHub, Stripe, Slack, SendGrid, JWT, PEM, CREDENTIALS_IN_URL |
| `src/utils/app-guard.ts` | Path traversal prevention, symlink resolution, allowlist |
| `src/utils/input-validator.ts` | TOOL_SCHEMAS — all tool params with type/length/pattern constraints |
| `src/utils/output-sanitizer.ts` | Wraps DLP + prompt injection + size cap |
| `src/utils/prompt-injection-detector.ts` | 9 regex patterns; see PATTERNS array for exact syntax |
| `src/utils/startup-audit.ts` | Warns on missing SIGNING_SECRET, SESSION_SECRET, DLP disabled, key TTL |
| `src/utils/audit-logger.ts` | AES-256-GCM encrypted audit log, key rotation (SIGUSR2), TTL enforcement |
| `src/utils/anomaly-detector.ts` | Detects PATH_TRAVERSAL_PROBE, TOOL_SCANNING, AUTH_FAILURE_SPIKE, etc. |
| `src/utils/vault-resolver.ts` | HashiCorp Vault + AWS Secrets Manager integration |
| `src/fuzz/generators.ts` | Deterministic PRNG + SECRET_SAMPLES / INJECTION_SAMPLES for fuzz tests |

## Common fix patterns

### Path containment check

```typescript
const resolved = path.resolve(filePath);
const base = path.resolve(baseDir);
if (!resolved.startsWith(base + path.sep)) return null;
```

### Stateful /g regex fix

```typescript
for (const { pattern } of patterns) {
  pattern.lastIndex = 0;
  if (pattern.test(content)) {
    pattern.lastIndex = 0;
    findings.push(...);
    break;
  }
}
```

### Query-string credential strip

```typescript
dsn.replace(/([?&](?:password|auth|token|secret|key|api_key)=)[^&\s]+/gi, '$1***')
```

### Header value masking

```typescript
const CREDENTIAL_HEADERS = /^(authorization|proxy-authorization|x-api-key|x-auth-token|cookie|set-cookie)/i;
function maskHeaderValue(name: string, value: string): string {
  return CREDENTIAL_HEADERS.test(name) ? '***' : value;
}
```

### New tool registration in TOOL_SCHEMAS

```typescript
my_tool: {
  app_path:    { type: 'path', required: true },
  entity_name: { type: 'name', required: true, maxLength: 255 },
  query:       { type: 'query', maxLength: 512 },
  env:         { type: 'enum', values: ['prod','dev','test','local','staging'] as const },
},
```

## Running tests

```bash
# Full suite (always use maxWorkers=1 to avoid CPU saturation)
node node_modules/jest/bin/jest.js --maxWorkers=1 --forceExit

# Security-specific tests only
node node_modules/jest/bin/jest.js --maxWorkers=1 --forceExit --testPathPattern "security|dlp|fuzz|audit|anomaly|app-guard|prompt-injection"
```

## Security roadmap

49/49 items complete in v1.0.0. Key env vars:

- `SYMFONY_MCP_SIGNING_SECRET` — HMAC-SHA256 request signing
- `SYMFONY_MCP_SESSION_SECRET` — session token verification
- `SYMFONY_MCP_AUDIT_KEY` — AES-256-GCM audit log encryption (base64, 32 bytes)
- `SYMFONY_MCP_AUDIT_KEY_PREV` — previous key for zero-downtime rotation
- `SYMFONY_MCP_AUDIT_KEY_CREATED_AT` — ISO timestamp for TTL tracking
- `SYMFONY_MCP_AUDIT_KEY_TTL_DAYS` — default 90 days
- `SYMFONY_MCP_ALLOWED_PATHS` — colon-separated allowlist of app paths
- `SYMFONY_MCP_DLP` — set to `false` to disable (not recommended)
- `SYMFONY_MCP_PROMPT_INJECTION` — set to `false` to disable
- `SYMFONY_MCP_MAX_OUTPUT_BYTES` — output size cap (default 1MB)
- `SYMFONY_MCP_ANOMALY_STRICT` — set to `true` to block on HIGH anomaly events
