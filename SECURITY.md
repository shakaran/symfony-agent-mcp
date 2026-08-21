# Security Guidelines

## Overview

`symfony-agent-mcp` is designed with security as a first-class concern. This document outlines the security model, threat mitigations, and best practices for using the MCP server.

## Security Model

### What This MCP Does NOT Do

- **No write operations** - Cannot modify files, configuration, or database
- **No code execution** - Cannot run PHP, shell, or any executable code
- **No external calls** - Cannot make HTTP requests or call external APIs
- **No credential storage** - Does not store or cache sensitive data
- **No authentication** - Assumes trusted local environment

### What This MCP DOES Do

- **Read configuration** - Parses YAML, .env, and other config files
- **Inspect file system** - Lists and reads files within Symfony app structure
- **Query database metadata** - Reads database schema without executing queries
- **Analyze logs** - Reads and searches application logs
- **Parse source code** - Regex-based analysis of entity files

## Threat Mitigations

### 1. Sensitive Data Exposure

**Threat**: Passwords, API keys, and secrets could be exposed to the AI assistant.

**Mitigation**:

- All outputs are automatically scanned for sensitive data
- Passwords, tokens, and secrets are masked with `[REDACTED]`
- Database URLs have credentials removed
- Email addresses in logs are redacted

**Sensitive Keywords Detected**:

```text
password, passwd, pwd, secret, token,
api_key, apikey, access_token, refresh_token,
private_key, encryption_key, auth_key, session_key,
webhook_secret, slack_token, github_token,
database_url, db_password, mysql_password,
postgres_password, mongodb_password, redis_password,
aws_secret, azure_secret, gcp_key, oauth_secret
```

**Examples**:

```text
Input:  APP_ENV=prod
        DATABASE_URL=mysql://user:secretpass@localhost/db
        STRIPE_API_KEY=sk_live_<32-char-key>

Output: APP_ENV=prod
        DATABASE_URL=mysql://user:[REDACTED]@localhost/db
        STRIPE_API_KEY=[REDACTED]
```

**Usage**: All tools automatically call `sanitizeConfig()` on results.

### 2. Unauthorized File Access

**Threat**: AI could request access to source code, private keys, or other sensitive files.

**Mitigation**:

- File access is restricted to specific directories
- Log reading restricted to `var/log/`
- Config reading restricted to `config/`
- Entity reading restricted to `src/Entity/`
- Directory traversal attacks are prevented

**Path Validation**:

```typescript
function isPathSafe(basePath: string, filePath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedPath = path.resolve(basePath, filePath);
  return resolvedPath.startsWith(resolvedBase);
}
```

**Rejected Paths**:

- `../../../etc/passwd`
- `/etc/passwd`
- `/root/.ssh/id_rsa`
- `src/Application.php`
- Symlink traversal

**Allowed Paths**:

- `var/log/dev.log`
- `config/services.yaml`
- `src/Entity/User.php`

### 3. Database Attacks

**Threat**: AI could request malicious SQL queries to modify or delete data.

**Mitigation**:

- All SQL queries are validated as read-only
- Write operations (INSERT, UPDATE, DELETE, etc.) are rejected
- Database connections use read-only credentials
- No query execution, only metadata inspection

**Query Validation**:

```typescript
const dangerousPatterns = [
  'INSERT', 'UPDATE', 'DELETE',
  'DROP', 'CREATE', 'ALTER',
  'TRUNCATE', 'REPLACE', 'GRANT', 'REVOKE'
];

const safePatterns = [
  'SELECT', 'DESCRIBE', 'DESC', 'EXPLAIN', 'SHOW', 'PRAGMA'
];
```

**Implementation**:

```typescript
if (!isQuerySafe(query)) {
  throw new Error('Query rejected: write operations not allowed');
}
```

### 4. Configuration Injection

**Threat**: AI could try to inject malicious config through tool parameters.

**Mitigation**:

- All tool inputs are typed and validated
- File paths are resolved and validated
- No dynamic code evaluation
- Regex parsing of configs (not evaluation)

**Validation Examples**:

```typescript
// Tool input: app_path must be string
if (typeof appPath !== 'string') {
  throw new Error('Invalid app_path');
}

// Route name must be alphanumeric + underscore/dash
if (!/^[a-zA-Z0-9_\-\.]+$/.test(routeName)) {
  throw new Error('Invalid route name');
}
```

### 5. Resource Exhaustion

**Threat**: AI could request operations that consume excessive resources.

**Mitigation**:

- Log reading limits (default 50 lines, max reasonable)
- No recursive or unbounded operations
- Config files are assumed reasonably sized
- Large log files only tail (don't load entirely)

**Resource Limits**:

```typescript
// Log reading
const lines = Math.min(lines, 1000); // Cap at 1000 lines

// Entity parsing
const files = fs.readdirSync(entityPath);
// Reasonably expects < 1000 entity files

// Log searching
const allLines = fs.readFileSync(filePath, 'utf-8').split('\n');
const matching = allLines.filter(...).slice(0, 100); // Cap results
```

## Best Practices for Usage

### For Developers

1. **Use in Development Environment Only**
   - Run on localhost
   - Not suitable for public-facing servers
   - Restrict to trusted networks

2. **Audit MCP Clients**
   - Verify who can access the MCP server
   - Ensure AI assistant logs are private
   - Review conversations with sensitive data

3. **Keep Secrets Secure**
   - .env.local should never contain plaintext secrets
   - Use .env for defaults, .env.local for overrides
   - Consider environment variable vaults for production info

4. **Monitor Access**
   - Enable MCP server logging
   - Review what information is being requested
   - Report suspicious patterns

### For System Administrators

1. **Network Isolation**
   - Run MCP server on localhost only
   - Don't expose on public networks
   - Use firewall rules if needed

2. **Permission Configuration**
   - Run with minimal necessary privileges
   - Don't run as root
   - Use separate user for app server

3. **Audit and Monitoring**
   - Log all tool calls
   - Monitor CPU/memory usage
   - Alert on suspicious patterns

4. **Access Control**
   - Restrict to trusted applications
   - Implement rate limiting if needed
   - Use authentication if publicly exposed (not recommended)

## Audit Checklist

Before using `symfony-agent-mcp`, verify:

- [ ] Running in development/protected environment
- [ ] AI assistant logs are private/secure
- [ ] Sensitive data is not in .env or config files
- [ ] Application logs don't contain PII
- [ ] File permissions are correct
- [ ] No sensitive keys in database

## Reporting Security Issues

If you discover a security issue, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email: <angel@guzmanmaeso.com> (if available)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## Security Testing

### Manual Security Tests

```bash
# Test path traversal prevention
pnpm start
# Send: list_logs with file_name="../../../etc/passwd"
# Should return error or empty result

# Test SQL injection prevention
pnpm start
# Send: list_tables with query="'; DROP TABLE users; --"
# Should return empty results safely

# Test sensitive data redaction
pnpm start
# Send: list_environment_variables
# Verify all passwords/keys are [REDACTED]
```

### Automated Security Tests

```bash
# Run full test suite (includes security test cases)
pnpm test

# Run only tests matching the security pattern
pnpm test -- --testPathPattern security

# TypeScript strict-mode check
pnpm typecheck
```

## Dependencies Security

### Current Dependencies

- `@modelcontextprotocol/sdk` - Official MCP SDK
- `js-yaml` - YAML parsing
- `dotenv` - Environment loading

### Dependency Management

```bash
# Check for vulnerabilities
pnpm audit

# Fix vulnerabilities
pnpm audit fix

# Update dependencies
pnpm update
```

Regular dependency updates are important for security.

## Known Limitations

### Information Disclosure

The MCP cannot prevent disclosure of information that exists in:

- Application configuration (config/services.yaml)
- Environment variables (.env, .env.local)
- Database schema
- Source code structure
- Application logs

**Recommendation**: Don't put sensitive information in these files if you're analyzing with AI assistants.

### Sanitization Bypass

Theoretically, an AI could:

- Ask for logs containing "sanitize" to understand patterns
- Infer redacted values from context
- Combine multiple requests to reconstruct information

**Recommendation**: Review what information you're comfortable sharing before using the MCP.

## Compliance

### GDPR

The MCP could expose personal data in:

- User entity mappings
- Application logs
- Database schema with user relationships

**Compliance Steps**:

- Review GDPR implications before use
- Consider data minimization
- Ensure AI assistant has necessary agreements
- Implement right to deletion if needed

### PCI DSS

If handling payment card data:

- Do NOT expose card data in logs
- Do NOT expose payment configuration
- Be careful with database schema disclosure

**Compliance Steps**:

- Review PCI DSS before using MCP
- Ensure isolated environment
- Minimize exposed information

### HIPAA

If handling health information:

- Similar considerations as GDPR
- Ensure AI assistant has business associate agreement
- Minimize exposed information

## Implemented Security Enhancements (v1.0.0)

### 6. Audit Logging (`src/utils/audit-logger.ts`)

Every tool invocation is logged to `~/.symfony-agent-mcp/audit.log` (or a custom path).
The log records **what was called and when**, never the sensitive values:

```jsonc
// ~/.symfony-agent-mcp/audit.log
{"ts":"2024-01-15T10:23:41Z","tool":"list_routes","appHash":"a1b2c3d4","durationMs":12,"success":true}
{"ts":"2024-01-15T10:23:42Z","tool":"tail_log","appHash":"a1b2c3d4","durationMs":45,"success":true}
```

- `appHash` is the first 8 hex chars of SHA-256(`app_path`) — identifies the project without exposing the path
- File permissions: `0600` (owner read/write only), directory: `0700`
- Log file is append-only — never truncated

**Configuration**:

```bash
SYMFONY_MCP_AUDIT_LOG=/var/log/symfony-mcp/audit.log   # Custom log path
SYMFONY_MCP_AUDIT=false                                  # Disable file logging
SYMFONY_MCP_DEBUG=true                                   # Also echo to stderr
```

---

### 7. Rate Limiting (`src/utils/rate-limiter.ts`)

Sliding-window rate limiter prevents abuse with two independent limits:

| Window | Default | Config var |
| --- | --- | --- |
| Per minute (global) | 60 requests | `SYMFONY_MCP_RATE_LIMIT` |
| Per second (burst) | 10 requests | `SYMFONY_MCP_RATE_BURST` |

Expensive tools (`tail_log`, `search_log`, `list_entities`, `validate_schema_mapping`, `get_installed_packages`, `get_error_summary`) get **half** the per-minute limit.

When blocked, the response includes a `retryAfterMs` hint:

```text
Rate limit exceeded for tool "tail_log". Try again in 8s.
Set SYMFONY_MCP_RATE_LIMIT=0 to disable rate limiting.
```

**Configuration**:

```bash
SYMFONY_MCP_RATE_LIMIT=60        # Max requests per window (0 = disabled)
SYMFONY_MCP_RATE_WINDOW_MS=60000 # Window size in ms (default: 1 min)
SYMFONY_MCP_RATE_BURST=10        # Max burst in 1 second
```

---

### 8. App Path Authorization (`src/utils/app-guard.ts`)

Every tool call validates `app_path` before execution:

1. **Type check** — Must be a non-empty string
2. **Null byte injection** — Blocked (path cannot contain `\0`)
3. **Path normalization** — Resolves `..` before any check
4. **Existence check** — Must be a readable directory
5. **Symfony project validation** — Must contain ≥2 of: `composer.json`, `src/Kernel.php`, `config/bundles.php`, `bin/console`, `config/packages`
6. **composer.json dep check** — If present, must have `symfony/*` dependencies
7. **Allowlist** — Optional; blocks any path not in the list

**Configuration**:

```bash
# Allow only these project paths (colon-separated):
SYMFONY_MCP_ALLOWED_PATHS=/var/www/myapp:/var/www/otherap

# Skip Symfony project validation (for testing or non-standard layouts):
SYMFONY_MCP_REQUIRE_SYMFONY=false
```

**Example rejection messages**:

```text
Access denied: app_path contains invalid characters
Access denied: "/some/dir" does not appear to be a Symfony project (found 1/2 required indicators)
Access denied: app_path is not in the allowed paths list. Set SYMFONY_MCP_ALLOWED_PATHS to permit it.
```

---

### 9. Request Signing (`src/utils/request-signer.ts`)

HMAC-SHA256 signing prevents unauthorized callers and replay attacks:

```text
Canonical: "<timestamp>:<nonce>:<tool_name>:<sorted_args_json>"
Signature: "sha256=" + HMAC-SHA256(secret, canonical)
Attached as: { _signature: { ts, nonce, sig } } in tool arguments
```

- Constant-time comparison (`crypto.timingSafeEqual`) prevents timing attacks
- Nonce cache with TTL pruning prevents replay within the window

**Configuration**:

```bash
SYMFONY_MCP_SIGNING_SECRET=<32+ char shared secret>  # Enable signing
SYMFONY_MCP_SIGN_STRICT=true                          # Require signatures (reject unsigned)
SYMFONY_MCP_REPLAY_WINDOW_MS=30000                    # Replay prevention window (default 30s)
```

---

### 10. Time-Based Session Tokens (`src/utils/session-token.ts`)

TOTP-style session tokens expire automatically. Useful for both stdio and HTTP transport:

```text
token = HMAC-SHA256(secret, floor(unix_ts / window) + ":" + purpose).hex[:32]
```

- Accepts current window AND previous window (handles clock skew / window boundary)
- 128-bit tokens (32 hex chars)
- Constant-time comparison

**Configuration**:

```bash
SYMFONY_MCP_SESSION_SECRET=<shared secret>  # Enable token auth
SYMFONY_MCP_SESSION_WINDOW=300              # Window size in seconds (default 5 min)
SYMFONY_MCP_SESSION_STRICT=true             # Reject requests without valid token
SYMFONY_MCP_SESSION_TOKEN=<token>           # Set on the CLIENT side
```

---

### 11. HTTP/SSE Transport with TLS + IP Whitelisting (`src/transport/http-transport.ts`)

Optional HTTP transport activates when `SYMFONY_MCP_HTTP_PORT` is set:

- **TLS**: Full HTTPS via Node.js `tls` module — provide PEM cert + key
- **IP Whitelisting**: CIDR and exact-IP support (IPv4-mapped IPv6 normalized)
- **Session token** validated on SSE handshake (GET /sse)
- **Routes**: `GET /sse`, `POST /message?sessionId=<id>`, `GET /health`
- **CORS**: Configurable `Access-Control-Allow-Origin`

**Configuration**:

```bash
SYMFONY_MCP_HTTP_PORT=8080                          # Activate HTTP transport
SYMFONY_MCP_HTTP_HOST=127.0.0.1                     # Bind address (default: localhost)
SYMFONY_MCP_TLS_CERT=/etc/certs/server.crt          # PEM certificate (enables HTTPS)
SYMFONY_MCP_TLS_KEY=/etc/certs/server.key           # PEM private key
SYMFONY_MCP_ALLOWED_IPS=127.0.0.1,192.168.1.0/24   # IP allowlist (comma-separated, CIDR ok)
SYMFONY_MCP_CORS_ORIGIN=https://my-client.example   # Allowed CORS origin
SYMFONY_MCP_STDIO=false                             # Disable stdio when using HTTP-only mode
```

---

### 12. Secret Vault Integration (`src/utils/vault-resolver.ts`)

Resolves vault references in configuration values at runtime:

| Reference format | Backend |
| --- | --- |
| `vault:secret/data/app#db_pass` | HashiCorp Vault KV v1/v2 |
| `ssm:/myapp/prod/db_password` | AWS SSM Parameter Store |
| `aws-secret:myapp/creds#db_pass` | AWS Secrets Manager |

- Minimal SigV4 signing for AWS (no external SDK — pure Node.js `crypto` + `https`)
- 1-minute in-memory cache prevents hammering on every tool call
- AppRole authentication for HashiCorp Vault (no long-lived tokens needed)

**Configuration**:

```bash
# HashiCorp Vault
SYMFONY_MCP_VAULT_ADDR=https://vault.example.com:8200
SYMFONY_MCP_VAULT_TOKEN=s.xxxxx        # or use AppRole:
SYMFONY_MCP_VAULT_ROLE_ID=xxx
SYMFONY_MCP_VAULT_SECRET_ID=xxx

# AWS (SSM + Secrets Manager)
AWS_REGION=eu-west-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=xxx
AWS_SESSION_TOKEN=xxx  # optional, for STS temporary credentials
```

---

---

### 13. Advanced DLP Detection (`src/utils/dlp-detector.ts`)

Structural pattern matching beyond keyword redaction — detects secrets by their shape, not just their key name:

| Pattern type | Example | Severity |
| --- | --- | --- |
| `PRIVATE_KEY_PEM` | `-----BEGIN RSA PRIVATE KEY-----` | CRITICAL |
| `JWT_TOKEN` | `eyJhbGci...` | CRITICAL |
| `AWS_ACCESS_KEY` | `AKIA...` / `ASIA...` | CRITICAL |
| `AWS_SECRET_KEY` | keyword + 40-char base64url | CRITICAL |
| `GCP_API_KEY` | `AIza...` | CRITICAL |
| `GITHUB_TOKEN` | `ghp_`, `ghs_`, `gho_` prefixes | CRITICAL |
| `STRIPE_KEY` | `sk_live_`, `sk_test_` | CRITICAL |
| `SLACK_TOKEN` | `xoxb-`, `xoxp-` | CRITICAL |
| `SENDGRID_KEY` | `SG.xxx.yyy` | CRITICAL |
| `CREDENTIALS_IN_URL` | `mysql://user:pass@host` | CRITICAL |
| `CREDIT_CARD` | 13–19 digit PAN (Luhn-validated) | CRITICAL |
| `CERTIFICATE_PEM` | `-----BEGIN CERTIFICATE-----` | HIGH |
| `GOOGLE_OAUTH` | `...googleusercontent.com` | HIGH |
| `SLACK_WEBHOOK` | `hooks.slack.com/services/...` | HIGH |
| `TWILIO_ACCOUNT_SID` | `ACxxxxx` | HIGH |
| `SSN_US` | `123-45-6789` (invalid patterns excluded) | HIGH |
| `PHONE_US` | US phone format | MEDIUM |
| `EMAIL` | `user@domain.tld` | MEDIUM |

DLP runs automatically inside `sanitizeConfig()` and `sanitizeLogOutput()`.

**Configuration**:

```bash
SYMFONY_MCP_DLP=false       # Disable DLP scanning (not recommended)
SYMFONY_MCP_DLP_HASH=true   # Replace matches with [REDACTED:TYPE:sha256[:8]] fingerprint
                             # (allows forensic correlation without exposing the value)
```

---

### 14. Anomaly / Intrusion Detection (`src/utils/anomaly-detector.ts`)

Non-blocking anomaly detector that flags suspicious patterns across multiple dimensions:

| Event type | Trigger | Severity |
| --- | --- | --- |
| `PATH_TRAVERSAL_PROBE` | `app_path` contains `../..` or null byte | HIGH → CRITICAL (on 3rd attempt) |
| `TOOL_SCANNING` | 15+ distinct tools called in one window | HIGH |
| `AUTH_FAILURE_SPIKE` | 5+ auth failures in window | CRITICAL |
| `RATE_LIMIT_HAMMERING` | 8+ rate-limit retries for same tool | HIGH |
| `ERROR_RATE_SPIKE` | 10+ errors from one tool in window | MEDIUM |

By default anomaly events are **logged only** (non-blocking). Set `SYMFONY_MCP_ANOMALY_STRICT=true` to block HIGH+ severity events.

**Configuration**:

```bash
SYMFONY_MCP_ANOMALY=false           # Disable anomaly detection
SYMFONY_MCP_ANOMALY_STRICT=true     # Block requests on HIGH/CRITICAL events
SYMFONY_MCP_ANOMALY_WINDOW_MS=60000 # Detection window (default: 60s)
```

---

### 15. Security Metrics (`src/utils/security-metrics.ts`)

Prometheus-compatible counter registry. Exposed via `GET /metrics` on the HTTP transport.

**Metrics exported**:

```text
# Prometheus text format (exposition format v0.0.4)
symfony_mcp_tool_calls_total{tool="list_routes",status="success"} 42
symfony_mcp_rate_limit_hits_total{tool="tail_log"} 3
symfony_mcp_auth_failures_total{reason="missing__signature"} 1
symfony_mcp_path_guard_blocks_total{reason="not_in_allowed_paths_list"} 0
symfony_mcp_anomaly_events_total{type="PATH_TRAVERSAL_PROBE",severity="HIGH"} 2
symfony_mcp_dlp_redactions_total{type="JWT_TOKEN"} 7
symfony_mcp_sse_sessions_total{action="open"} 5
symfony_mcp_uptime_seconds 3600
```

**Configuration**:

```bash
SYMFONY_MCP_METRICS=false  # Disable metrics collection
```

Scrape with Prometheus: `scrape_configs: - job_name: symfony-mcp; static_configs: - targets: [localhost:8080]`

---

### 16. Audit Log Encryption at Rest (`src/utils/audit-logger.ts`)

AES-256-GCM encryption of audit log entries. Each entry has a unique 12-byte IV:

```text
Format: ENC:<base64(IV[12] + AuthTag[16] + Ciphertext)>
```

- Authentication tag prevents tampering (GCM mode)
- Unique IV per entry prevents pattern analysis across entries
- `readRecentAuditEntries()` auto-decrypts if key is set

Generate a key:

```bash
node -e "const crypto=require('crypto'); console.log('SYMFONY_MCP_AUDIT_KEY='+crypto.randomBytes(32).toString('base64'))"
```

**Configuration**:

```bash
SYMFONY_MCP_AUDIT_KEY=<32-byte base64 key>  # Enable AES-256-GCM encryption
SYMFONY_MCP_AUDIT_FORMAT=cef                # Use CEF/SIEM format instead of JSONL
```

---

### 17. SIEM-Compatible Audit Format (CEF)

CEF (Common Event Format) output compatible with Splunk, ArcSight, QRadar, and similar SIEMs:

```text
CEF:0|symfony-agent-mcp|symfony-mcp|1.0.0|list_routes|TOOL_CALL|1|rt=2024-01-15T10:23:41Z app=list_routes appHash=a1b2c3d4 durationMs=12 outcome=success
CEF:0|symfony-agent-mcp|symfony-mcp|1.0.0|tail_log|TOOL_ERROR|5|rt=2024-01-15T10:23:42Z app=tail_log appHash=a1b2c3d4 durationMs=3 outcome=failure msg=Rate limit exceeded
```

CEF severity: `1` (normal), `3` (slow >2s), `5` (error). Compatible with encryption — CEF lines are encrypted individually.

```bash
SYMFONY_MCP_AUDIT_FORMAT=cef  # Enable CEF output
```

---

### 18. HTTP Security Headers (`src/transport/http-transport.ts`)

All HTTP responses include hardened security headers:

| Header | Value |
| --- | --- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (HTTPS only) |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` |
| `Referrer-Policy` | `no-referrer` |
| `Cache-Control` | `no-store, no-cache, must-revalidate` |

---

### 19. Mutual TLS (mTLS) (`src/transport/http-transport.ts`)

When `SYMFONY_MCP_TLS_CA` is set, the server requires and validates client certificates:

```bash
SYMFONY_MCP_TLS_CERT=/etc/certs/server.crt
SYMFONY_MCP_TLS_KEY=/etc/certs/server.key
SYMFONY_MCP_TLS_CA=/etc/certs/ca.crt       # Enables mTLS client verification
```

- Client must present a certificate signed by the CA
- `rejectUnauthorized: true` — unauthenticated clients are rejected at the TLS layer

---

### 20. Request/Response Size Caps (`src/transport/http-transport.ts`)

POST request bodies are read with a hard byte limit before being passed to the MCP transport:

```bash
SYMFONY_MCP_MAX_PAYLOAD_BYTES=1048576  # 1 MB default
```

Requests exceeding the limit receive `413 Payload Too Large` before any processing occurs.

---

### 21. SBOM & Dependency Vulnerability Scanning (`.github/workflows/sbom.yml`)

CI workflow runs on every merge to `main` and weekly:

- **CycloneDX SBOM** (JSON + XML) for supply chain transparency
- **SPDX SBOM** for license compliance
- `pnpm audit --prod --audit-level=high` blocks on high-severity CVEs in production deps
- Store integrity verification (`--verify-store-integrity`) detects tampered packages
- SBOM artifacts uploaded for 90 days, optionally submitted to GitHub Dependency Graph (GHAS)

---

### 22. Universal Output Sanitizer (`src/utils/output-sanitizer.ts`)

Single choke-point that every tool result passes through before being sent to the MCP client:

1. **DLP structural scan** — JWTs, PEM blocks, API keys, credit cards, SSNs, credentials in URLs
2. **Keyword-based redaction** — passwords, tokens, secrets by field name (legacy patterns)
3. **Error message sanitization** — strips Node.js stack traces, absolute filesystem paths, node_modules internals
4. **Privacy mode** — data minimization (see §23)

Replaces ad-hoc per-tool redaction calls. Zero tool changes needed for coverage.

---

### 23. Privacy Mode (`src/utils/privacy-mode.ts`)

Global data-minimization layer applied after DLP. Three levels:

| Level | What it removes |
| --- | --- |
| `standard` | Nothing extra — DLP + keyword redaction only |
| `strict` | Env var values → `[PRIVACY:STRICT]`, all IPv4 addresses → `[IP]` |
| `paranoid` | Everything in strict + version strings, ISO timestamps, ports, line numbers, numeric IDs |

**Configuration**:

```bash
SYMFONY_MCP_PRIVACY=strict                           # Enable strict privacy
SYMFONY_MCP_PRIVACY=paranoid                         # Enable paranoid privacy
SYMFONY_MCP_PRIVACY_TOOLS=list_environment_variables,tail_log  # Limit to specific tools
```

Designed for GDPR/HIPAA/PCI environments where the AI should see structure but not values.

---

### 24. Symlink Traversal Prevention (`src/utils/security.ts`, `src/utils/app-guard.ts`)

`isPathSafe()` now performs a two-stage check:

1. **Lexical check**: `resolvedPath.startsWith(resolvedBase)` — fast, catches `../` attacks
2. **Symlink resolution**: `fs.realpathSync()` on both the target and the base — prevents a symlink inside the project pointing to `/etc/passwd` or similar

If the target file doesn't exist yet (new file creation paths), the parent directory is resolved and the filename appended. `app-guard.ts` applies the same double-check on every file operation.

---

### 25. Anomaly Webhook Notifications (`src/utils/anomaly-notifier.ts`)

Fire-and-forget alerting to external systems when anomaly events are emitted.

| Channel | Config env var |
| --- | --- |
| Generic HTTP webhook (POST JSON) | `SYMFONY_MCP_WEBHOOK_URL` |
| Slack Incoming Webhook | `SYMFONY_MCP_SLACK_WEBHOOK` |
| PagerDuty Events API v2 | `SYMFONY_MCP_PAGERDUTY_KEY` |

Notifications only fire at or above the configured minimum severity (default: `HIGH`).

```bash
SYMFONY_MCP_WEBHOOK_URL=https://your-siem.example.com/events
SYMFONY_MCP_SLACK_WEBHOOK=https://hooks.slack.com/services/T.../B.../XXX
SYMFONY_MCP_PAGERDUTY_KEY=your_integration_key
SYMFONY_MCP_NOTIFY_MIN_SEVERITY=HIGH  # LOW|MEDIUM|HIGH|CRITICAL
```

5-second timeout per channel; failures are logged to stderr but never surface to callers.

---

### 26. Error Message Sanitization (`src/utils/output-sanitizer.ts`)

When a tool returns `isError: true`, the error text is additionally sanitized before reaching the client:

- Node.js stack trace lines (`at Function.xxx (file:line:col)`) are stripped
- Absolute paths under `/home/`, `/var/`, `/usr/`, `/etc/` are replaced with `[PATH]/basename`
- Windows paths (`C:\...`) are replaced with `[PATH]`
- `node_modules/package/file` references are collapsed to `[node_modules/...]`
- DLP runs on the cleaned message to catch any secrets in error strings

Error cause (first line) is preserved; internals are hidden.

---

### 27. SAST & Supply-Chain CI (`.github/workflows/security.yml`)

Runs on every push to `main`, every PR, and weekly:

| Job | Tool | What it checks |
| --- | --- | --- |
| `codeql` | GitHub CodeQL (security-extended) | OWASP Top 10 in TypeScript/JavaScript source |
| `gitleaks` | Gitleaks v2 (full history) | Secrets committed in any commit, SARIF to GitHub Security tab |
| `eslint-security` | eslint-plugin-security | Non-literal fs calls, timing attacks, object injection |
| `license-check` | license-checker | Only approved open-source licenses (MIT, Apache-2.0, BSD, ISC…) |
| `dependency-review` | actions/dependency-review-action@v4 | Blocks PRs introducing HIGH/CRITICAL CVEs or GPL-family licenses |
| `pnpm-audit` | pnpm audit | Fails on high-severity CVEs in production deps |

---

## Security Roadmap Status

| # | Feature | Status | Version |
| --- | --- | --- | --- |
| 1 | Sensitive data redaction (keyword) | ✅ Complete | v1.0.0 |
| 2 | Path traversal prevention | ✅ Complete | v1.0.0 |
| 3 | App path authorization (`app-guard`) | ✅ Complete | v1.0.0 |
| 4 | Rate limiting (sliding window) | ✅ Complete | v1.0.0 |
| 5 | Audit logging | ✅ Complete | v1.0.0 |
| 6 | Request signing (HMAC-SHA256) | ✅ Complete | v1.0.0 |
| 7 | Nonce-based replay prevention | ✅ Complete | v1.0.0 |
| 8 | Session tokens (TOTP-style) | ✅ Complete | v1.0.0 |
| 9 | Vault / SSM / Secrets Manager resolver | ✅ Complete | v1.0.0 |
| 10 | HTTP/SSE transport | ✅ Complete | v1.0.0 |
| 11 | Advanced DLP (structural patterns) | ✅ Complete | v1.0.0 |
| 12 | Anomaly / intrusion detection | ✅ Complete | v1.0.0 |
| 13 | Prometheus security metrics | ✅ Complete | v1.0.0 |
| 14 | Audit log AES-256-GCM encryption | ✅ Complete | v1.0.0 |
| 15 | SIEM / CEF audit format | ✅ Complete | v1.0.0 |
| 16 | HTTP security headers | ✅ Complete | v1.0.0 |
| 17 | Mutual TLS (mTLS) | ✅ Complete | v1.0.0 |
| 18 | Request body size caps | ✅ Complete | v1.0.0 |
| 19 | SBOM + dependency scanning CI | ✅ Complete | v1.0.0 |
| 20 | Universal output sanitizer (DLP gate) | ✅ Complete | v1.0.0 |
| 21 | Privacy mode (strict / paranoid) | ✅ Complete | v1.0.0 |
| 22 | Symlink traversal prevention | ✅ Complete | v1.0.0 |
| 23 | Anomaly webhook notifications | ✅ Complete | v1.0.0 |
| 24 | Error message sanitization | ✅ Complete | v1.0.0 |
| 25 | SAST CI (CodeQL + Gitleaks) | ✅ Complete | v1.0.0 |
| 26 | Input validation (schema-based) | ✅ Complete | v1.0.0 |
| 27 | Security startup audit | ✅ Complete | v1.0.0 |
| 28 | DB schema PII annotation | ✅ Complete | v1.0.0 |
| 29 | Multi-vector anomaly correlation | ✅ Complete | v1.0.0 |
| 30 | Secrets rotation (SIGUSR2 + Vault TTL) | ✅ Complete | v1.0.0 |
| 31 | SDK error hardening | ✅ Complete | v1.0.0 |
| 32 | Per-tool RBAC / allowlist | ✅ Complete | v1.0.0 |
| 33 | Tool execution timeout | ✅ Complete | v1.0.0 |
| 34 | Concurrent request limiter | ✅ Complete | v1.0.0 |
| 35 | TLS cert validation (Vault resolver) | ✅ Complete | v1.0.0 |
| 36 | Hardened Dockerfile (multi-stage, non-root) | ✅ Complete | v1.0.0 |
| 37 | tools/list rate-limit + anomaly guard | ✅ Complete | v1.0.0 |
| 38 | Response / output size cap | ✅ Complete | v1.0.0 |
| 39 | Audit log rotation | ✅ Complete | v1.0.0 |
| 40 | OpenSSF Scorecard CI + security.txt | ✅ Complete | v1.0.0 |
| 41 | Prompt injection detection in tool outputs | ✅ Complete | v1.0.0 |
| 42 | Per-IP rate limiting for HTTP transport | ✅ Complete | v1.0.0 |
| 43 | GitHub Actions Dependabot + SHA pinning | ✅ Complete | v1.0.0 |
| 44 | DLP ReDoS hardening with scan timeout | ✅ Complete | v1.0.0 |
| 45 | npm package registry signature audit in CI | ✅ Complete | v1.0.0 |
| 46 | SLSA v1.0 build provenance attestation in CI | ✅ Complete | v1.0.0 |
| 47 | Property-based fuzz tests for the security pipeline | ✅ Complete | v1.0.0 |
| 48 | Kernel seccomp profile for Docker deployment | ✅ Complete | v1.0.0 |
| 49 | Zero-downtime audit key rotation with TTL enforcement | ✅ Complete | v1.0.0 |

All planned security enhancements implemented. The security roadmap is current as of v1.0.0.

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Symfony Security](https://symfony.com/doc/current/security.html)
- [Node.js Security](https://nodejs.org/en/docs/guides/security/)
- [MCP Security](https://modelcontextprotocol.io/docs/security)
