# Development Guide

## Setup

### Prerequisites

- Node.js 22+
- pnpm 11+
- Git

### Initial Setup

```bash
cd symfony-agent-mcp
pnpm install
pnpm build
```

## Daily Workflow

```bash
pnpm build          # compile TypeScript once
pnpm dev            # watch mode — rebuilds on save
pnpm start          # run the MCP server
pnpm test           # run Jest test suite
pnpm test:coverage  # with coverage report
pnpm lint           # ESLint
pnpm lint:fix       # ESLint with auto-fix
pnpm lint:md        # markdownlint
pnpm typecheck      # tsc --noEmit (no output files)
```

> **Note:** always use `nice -n 19 ionice -c 3 ./node_modules/.bin/tsc --noEmit` for standalone
> type-checks — bare `npx tsc` can starve the machine on large codebases.

## Project Structure

```text
symfony-agent-mcp/
├── src/
│   ├── index.ts                # Public exports
│   ├── server.ts               # MCP server, tool registry, security pipeline
│   │
│   ├── tools/                  # 820 TypeScript files, one per tool domain
│   │   ├── routes-inspector.ts
│   │   ├── di-inspector.ts
│   │   ├── security-voters.ts
│   │   └── ...
│   │
│   └── utils/
│       ├── security.ts         # Path validation helpers
│       ├── symfony-parser.ts   # YAML / .env parsing
│       ├── app-guard.ts        # guardAppPath middleware
│       ├── audit-logger.ts     # withAudit middleware
│       ├── output-sanitizer.ts # sanitizeToolResult middleware
│       ├── tool-registry.ts    # Tool registration helpers
│       └── ...
│
├── docs/architecture/
│   ├── tool-categories.md      # Category index (16 categories)
│   ├── tools-symfony-core.md   # 549 tools
│   ├── tools-database.md       # 176 tools
│   └── ...                     # one file per category
│
├── dist/                       # compiled output (generated)
└── package.json
```

## Security Pipeline

Every tool call passes through five layers in `server.ts`:

```text
validateToolArgs → guardAppPath → withAudit → tool → sanitizeToolResult
```

- **validateToolArgs** — schema validation of MCP input
- **guardAppPath** — resolves and validates `app_path` against allowed roots
- **withAudit** — writes structured audit log entry
- **tool** — the actual tool function in `src/tools/*.ts`
- **sanitizeToolResult** — masks passwords, tokens, DSNs in output

## Adding a New Tool

### 1. Create the tool file

`src/tools/my-feature.ts`:

```typescript
import { validateAppPath } from '../utils/security.js';

export function listMyFeature(appPath: string): string {
  validateAppPath(appPath);
  // pure fs.readFileSync — no exec, no network
  return JSON.stringify({ items: [] });
}

export function getMyFeatureStats(appPath: string): string {
  validateAppPath(appPath);
  return JSON.stringify({ total: 0 });
}
```

Rules:

- **No** `exec`, `spawn`, `eval`, or outbound HTTP
- Always call `validateAppPath(appPath)` first
- Return a plain string (JSON) — the pipeline wraps it in the MCP envelope
- Sensitive values (passwords, tokens) must not appear raw in output; `sanitizeToolResult` masks
  them, but do not rely on that as the only layer

### 2. Register in the tool registry

In `src/utils/tool-registry.ts` (or the relevant category registration file), add the tool
definition and handler following the existing pattern for its category.

### 3. Build and verify

```bash
pnpm build
pnpm start
# send a test MCP request
```

### 4. Document

Add a section for the new tool in the appropriate category file under `docs/architecture/`.

## Modifying Existing Tools

1. Edit the file in `src/tools/`
2. Run `pnpm build`
3. Run `pnpm test` — confirm no regressions
4. Update the category doc if the description changed

## Writing Tests

```typescript
// src/tools/my-feature.test.ts
import { listMyFeature } from './my-feature.js';

describe('my-feature', () => {
  test('returns empty list for missing directory', () => {
    const result = JSON.parse(listMyFeature('/tmp/nonexistent'));
    expect(result.items).toEqual([]);
  });
});
```

```bash
pnpm test -- --testPathPattern my-feature
pnpm test -- --watch
pnpm test:coverage
```

## Using Utilities

### Path validation

```typescript
import { validateAppPath, isPathSafe } from '../utils/security.js';

validateAppPath(appPath);          // throws if outside allowed root
isPathSafe(appPath, filePath);     // boolean guard for sub-paths
```

### YAML / config parsing

```typescript
import { parseYamlFile, loadEnvironmentVariables } from '../utils/symfony-parser.js';

const config = parseYamlFile('/path/to/config.yaml');
const env    = loadEnvironmentVariables('/app');
```

### Output sanitization (applied automatically by the pipeline)

```typescript
import { sanitizeOutput } from '../utils/output-sanitizer.js';

const safe = sanitizeOutput(rawString); // masks passwords, tokens, DSNs
```

## Code Style

- TypeScript strict mode — no `any`, always specify types
- No comments explaining *what* the code does — only *why* when non-obvious
- File names: `kebab-case.ts`
- No `console.log` — use `console.error` for debug output (MCP uses stdout)

### Commit messages (Conventional Commits)

```text
feat: add symfony-ux-map tool
fix: path escape in terraform-config walker
docs: update tools-infrastructure category file
test: add phpunit-isolation test cases
```

## Publishing

```bash
pnpm build
pnpm publish
```

## Resources

- [MCP Protocol](https://modelcontextprotocol.io/)
- [Symfony Docs](https://symfony.com/doc/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
