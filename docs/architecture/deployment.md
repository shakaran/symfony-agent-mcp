# Testing, Deployment and References

## Testing

Run the test suite:

```bash
pnpm test                                      # full suite
pnpm test:coverage                             # with coverage report
pnpm test -- --testPathPattern security        # security-specific cases
```

Test types:

1. **Unit tests** — individual tool functions with mock file fixtures
2. **Integration tests** — tool + utils together through the full security pipeline
3. **Security tests** — path traversal, DLP redaction, injection detection

## Deployment

### Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
CMD ["node", "dist/server.js"]
```

### From a local clone

```bash
pnpm install
pnpm build
node dist/server.js
```

### Via MCP Client Config (npx)

```json
{
  "mcpServers": {
    "symfony": {
      "command": "npx",
      "args": ["@shakaran/symfony-agent-mcp"],
      "env": {
        "SYMFONY_APP_PATH": "/var/www/myapp"
      }
    }
  }
}
```

### Via MCP Client Config (local build)

```json
{
  "mcpServers": {
    "symfony": {
      "command": "node",
      "args": ["/path/to/symfony-agent-mcp/dist/server.js"],
      "env": {
        "SYMFONY_APP_PATH": "/var/www/myapp"
      }
    }
  }
}
```

## References

- MCP Specification: <https://modelcontextprotocol.io/>
- Symfony Documentation: <https://symfony.com/doc/>
- Doctrine ORM: <https://www.doctrine-project.org/>

Back to [Architecture Documentation](../../ARCHITECTURE.md)
