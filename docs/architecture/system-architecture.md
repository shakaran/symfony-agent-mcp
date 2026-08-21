# System Architecture

## Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                       MCP Client                             │
│       (Claude Code, Claude Desktop, Cursor, VS Code, …)      │
└────────────────────────┬────────────────────────────────────┘
                         │ MCP Protocol (JSON-RPC)
                         │ stdio (default) / HTTP+SSE
                         │
┌────────────────────────▼────────────────────────────────────┐
│                  MCP Server  (src/server.ts)                  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              5-Layer Security Pipeline                │   │
│  │  validateToolArgs → guardAppPath → withAudit          │   │
│  │                   → tool → sanitizeToolResult         │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │  Tool Registry │  │  Session Store  │  │ Rate Limiter│  │
│  │ 1,679 tools    │  │ (active cats)   │  │ sliding win │  │
│  └────────────────┘  └─────────────────┘  └─────────────┘  │
└────────────────────────┬────────────────────────────────────┘
                         │
        ┌────────────────┼─────────────────┐
        │                │                 │
        ▼                ▼                 ▼
┌─────────────┐  ┌───────────────┐  ┌───────────────┐
│  src/tools/ │  │  src/utils/   │  │  Symfony App  │
│  820 files  │  │               │  │  (read-only)  │
│             │  │ app-guard.ts  │  │               │
│ symfony-    │  │ audit-logger  │  │ config/*.yaml │
│ core  (549) │  │ output-       │  │ src/Entity/   │
│ database    │  │ sanitizer.ts  │  │ src/          │
│ (176)       │  │ symfony-      │  │ Controller/   │
│ security    │  │ parser.ts     │  │ var/log/      │
│ (133)       │  │ security.ts   │  │ migrations/   │
│ + 13 more   │  │ tool-registry │  │ .env files    │
└─────────────┘  └───────────────┘  └───────────────┘
```

## 5-Layer Security Pipeline

Every tool call passes through all five layers before returning output.

### 1. validateToolArgs

Schema validation of the MCP input against the tool's declared `inputSchema`. Rejects
missing or wrong-type arguments before they reach any code.

### 2. guardAppPath

Implemented in `src/utils/app-guard.ts`:

- Resolves `app_path` to an absolute real path (symlinks expanded)
- Checks against `SYMFONY_MCP_ALLOWED_PATHS` (colon-separated allowlist)
- Requires a valid Symfony project structure (unless `SYMFONY_MCP_REQUIRE_SYMFONY=false`)
- Rejects paths that resolve through symlinks outside the allowed root
- Throws `ToolError` on any violation; never falls through silently

### 3. withAudit

Implemented in `src/utils/audit-logger.ts`:

- Writes a structured audit log entry before tool execution
- Fields: timestamp, session ID, tool name, sanitized `app_path`, sanitized arguments
- Optional AES-256-GCM encryption of the log file
- Optional CEF format for SIEM integration

### 4. tool

The actual tool function from `src/tools/*.ts`:

- Pure `fs.readFileSync` — no exec, spawn, or eval
- YAML parsed via `js-yaml`; PHP files analyzed with regex
- Returns a plain JSON string; the pipeline wraps it in the MCP response envelope

### 5. sanitizeToolResult

Implemented in `src/utils/output-sanitizer.ts` — multi-layer DLP:

- **Keyword masking** — 40+ patterns (`password`, `token`, `secret`, `api_key`, …) replaced with `[REDACTED]`
- **Structural detection** — Base64-like strings ≥40 chars, JWTs (3-part dot-separated), SSH private
  key blocks, cloud credential patterns, credit card numbers
- **DSN masking** — removes passwords from `mysql://user:pass@host/db`, `redis://:pass@host`, etc.
- **Prompt injection scan** — output containing known injection phrases is stripped before returning

## Dynamic Tool Discovery

All 1,679 tools are registered at startup in `src/utils/tool-registry.ts` with category
metadata. With `SYMFONY_MCP_DYNAMIC_TOOLS=true` (default), the server's `tools/list`
response exposes only five meta-tools until the client activates categories:

| Meta-tool | Purpose |
| --- | --- |
| `search_tools` | Full-text search across all tool names and descriptions |
| `list_tool_categories` | Lists all 16 categories with tool counts |
| `activate_category` | Adds a category's tools to the current session |
| `get_active_tools` | Shows active tools and session token estimate |
| `deactivate_category` | Removes a category from the session |

`activate_category` sends `notifications/tools/list_changed` so MCP clients re-fetch the
tool list. A token budget guard (default 40,000 tokens) warns before activating large
categories.

## Data Flow Example

```text
Client: list_routes(app_path: "/var/www/myapp")

  1. validateToolArgs   — app_path is a non-empty string ✓
  2. guardAppPath       — /var/www/myapp is in ALLOWED_PATHS, contains symfony.lock ✓
  3. withAudit          — writes {ts, session, tool: "list_routes", app_path} ✓
  4. tool               — reads config/routes.yaml + src/Controller/*.php ✓
  5. sanitizeToolResult — no passwords/tokens in route output ✓

Response: [{name: "app_home", path: "/", methods: ["GET"], controller: "…"}]
```

## Key Files

| File | Purpose |
| --- | --- |
| `src/server.ts` | MCP server entry, tool registry, security pipeline |
| `src/index.ts` | Public exports |
| `src/tools/*.ts` | 820 tool files (1,679 tools across 16 categories) |
| `src/utils/security.ts` | Path validation helpers |
| `src/utils/app-guard.ts` | `guardAppPath` middleware |
| `src/utils/audit-logger.ts` | `withAudit` middleware |
| `src/utils/output-sanitizer.ts` | `sanitizeToolResult` middleware |
| `src/utils/symfony-parser.ts` | YAML/config/PHP parsing |
| `src/utils/tool-registry.ts` | Tool registration and category index |

Back to [Architecture Documentation](../../ARCHITECTURE.md)
