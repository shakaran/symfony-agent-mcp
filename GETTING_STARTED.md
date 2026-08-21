# Getting Started with symfony-agent-mcp

This guide will get the MCP server running and connected to Claude Code in a few minutes.

## Prerequisites

- Node.js 22.x or higher
- pnpm 11.x or higher

## Quick Start

### 1. Install Node 22

```bash
nvm install 22
nvm use 22
```

### 2. Install pnpm

```bash
npm install -g pnpm
```

### 3. Install Dependencies

```bash
cd /path/to/symfony-agent-mcp
pnpm install
```

### 4. Build the Project

```bash
pnpm build
```

Compiles TypeScript to JavaScript in `dist/`.

### 5. Verify

```bash
ls dist/
# Should show: index.js, server.js, tools/*.js, utils/*.js
```

### 6. Run the Server

```bash
pnpm start
```

The server listens on stdio, ready for MCP clients.

## Integration with Claude Code

### Option A — via `claude mcp add`

```bash
claude mcp add symfony node /path/to/symfony-agent-mcp/dist/server.js
```

### Option B — manual entry in `~/.claude/settings.json`

```json
{
  "mcpServers": {
    "symfony": {
      "command": "node",
      "args": ["/path/to/symfony-agent-mcp/dist/server.js"],
      "env": {
        "SYMFONY_APP_PATH": "/path/to/your/symfony/app"
      }
    }
  }
}
```

## Troubleshooting

### `pnpm: command not found`

```bash
npm install -g pnpm
```

### TypeScript compilation errors

The compiled JavaScript in `dist/` is what runs. Compilation warnings do not affect execution.
If you need a clean build:

```bash
pnpm build
```

### Port already in use

The MCP server uses stdio, not a TCP port — no port configuration needed.

## Project Structure

```text
symfony-agent-mcp/
├── src/
│   ├── server.ts           # MCP server entry point
│   ├── tools/              # 820 tool files (1,679 tools)
│   └── utils/              # Security, parsing, audit utilities
├── dist/                   # Compiled JavaScript (generated)
├── docs/architecture/      # Per-category tool documentation
├── README.md
└── ARCHITECTURE.md
```

## Tool Categories

1,679 tools organized in 16 categories — see [docs/architecture/tool-categories.md](docs/architecture/tool-categories.md)
for the full reference.

| Category | Tools |
| --- | --- |
| symfony-core | 549 |
| database | 176 |
| security | 133 |
| frontend | 121 |
| testing | 110 |
| integrations | 106 |
| serializer | 91 |
| messaging | 87 |
| api | 68 |
| infrastructure | 68 |
| cache-sessions | 62 |
| config | 35 |
| code-quality | 25 |
| cloud-aws | 18 |
| cloud-other | 16 |
| queues | 14 |

## Next Steps

1. **README.md** — full feature overview and tool examples
2. **ARCHITECTURE.md** — security model and component design
3. **DEVELOPMENT.md** — how to add tools or contribute
4. **docs/architecture/tool-categories.md** — per-category tool reference
