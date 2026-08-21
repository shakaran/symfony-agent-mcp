# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:22-alpine3.22 AS builder

WORKDIR /build

# Apply available Alpine security patches before installing anything
RUN apk upgrade --no-cache

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy manifests first for layer cache efficiency
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (dev included — needed for tsc)
RUN pnpm install --frozen-lockfile

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

# Prune to production-only deps
RUN pnpm prune --prod


# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine3.22 AS runtime

# Apply available Alpine security patches before adding users
RUN apk upgrade --no-cache

# Security: run as non-root
RUN addgroup -S mcpgroup && adduser -S mcpuser -G mcpgroup

WORKDIR /app

# Copy compiled output and production node_modules
COPY --from=builder --chown=mcpuser:mcpgroup /build/dist ./dist
COPY --from=builder --chown=mcpuser:mcpgroup /build/node_modules ./node_modules
COPY --from=builder --chown=mcpuser:mcpgroup /build/package.json ./package.json

# Create audit log directory with correct permissions
RUN mkdir -p /var/log/symfony-mcp && \
    chown mcpuser:mcpgroup /var/log/symfony-mcp && \
    chmod 700 /var/log/symfony-mcp

# Switch to non-root user
USER mcpuser

# Default environment — operators should override these
ENV NODE_ENV=production \
    SYMFONY_MCP_AUDIT_LOG=/var/log/symfony-mcp/audit.log \
    SYMFONY_MCP_ANOMALY_STRICT=true \
    SYMFONY_MCP_STARTUP_AUDIT=true

# stdio transport — no network ports exposed by default
# Set SYMFONY_MCP_HTTP_PORT to expose HTTP/SSE transport
EXPOSE 8080

# Health check via HTTP transport (only active when SYMFONY_MCP_HTTP_PORT is set)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${SYMFONY_MCP_HTTP_PORT:-8080}/health 2>/dev/null | \
      grep -q '"status":"ok"' || exit 1

# Read-only root filesystem note:
# Mount /tmp and /var/log/symfony-mcp as tmpfs/volumes when running with --read-only
# docker run --read-only \
#   --tmpfs /tmp \
#   --mount type=volume,src=symfony-mcp-logs,dst=/var/log/symfony-mcp \
#   symfony-agent-mcp

ENTRYPOINT ["node", "dist/server.js"]
