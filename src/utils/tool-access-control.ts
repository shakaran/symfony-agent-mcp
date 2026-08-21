/**
 * Per-Tool Access Control
 *
 * Restricts which tools a caller can invoke. Useful for exposing a limited
 * subset of tools in production or read-only environments without touching
 * the tool implementations themselves.
 *
 * Configuration:
 *   SYMFONY_MCP_ALLOWED_TOOLS=list_routes,list_services,get_entity_details
 *       Comma-separated allowlist. Only listed tools are callable.
 *       If unset (default), ALL tools are allowed — no restriction.
 *
 *   SYMFONY_MCP_BLOCKED_TOOLS=get_database_config,get_security_config
 *       Comma-separated denylist. Takes precedence over the allowlist.
 *       Useful for blocking specific sensitive tools while keeping everything else.
 *
 * Precedence: blocked > allowed > default-allow-all
 *
 * Examples:
 *   # Read-only mode — expose only structural inspection tools
 *   SYMFONY_MCP_ALLOWED_TOOLS=list_routes,list_services,list_entities,list_tables
 *
 *   # Full access except config/secrets exposure
 *   SYMFONY_MCP_BLOCKED_TOOLS=get_security_config,list_environment_variables,get_database_config
 */

// ─── Config parsing ───────────────────────────────────────────────────────────

function parseList(envVar: string): Set<string> | null {
  const raw = process.env[envVar];
  if (!raw?.trim()) return null;
  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  return items.length > 0 ? new Set(items) : null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns whether a tool call is permitted under the current access-control config.
 *
 * @param toolName - The MCP tool name being invoked
 * @returns `{allowed: true}` or `{allowed: false, reason: string}`
 */
export function checkToolAccess(toolName: string): { allowed: boolean; reason?: string } {
  const blocked = parseList('SYMFONY_MCP_BLOCKED_TOOLS');
  if (blocked?.has(toolName)) {
    return { allowed: false, reason: `tool "${toolName}" is in the blocked list (SYMFONY_MCP_BLOCKED_TOOLS)` };
  }

  const allowed = parseList('SYMFONY_MCP_ALLOWED_TOOLS');
  if (allowed && !allowed.has(toolName)) {
    return { allowed: false, reason: `tool "${toolName}" is not in the allowed list (SYMFONY_MCP_ALLOWED_TOOLS)` };
  }

  return { allowed: true };
}

/**
 * Filters a tools array to only include tools that pass access control.
 * Used when building the tools/list response so clients only see tools they can call.
 *
 * @param tools - Full tool list from the server
 */
export function filterAllowedTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter(t => checkToolAccess(t.name).allowed);
}

/**
 * Returns whether any access-control restrictions are configured.
 */
export function isAccessControlConfigured(): boolean {
  return !!(process.env['SYMFONY_MCP_ALLOWED_TOOLS'] || process.env['SYMFONY_MCP_BLOCKED_TOOLS']);
}

/**
 * Returns a status summary for diagnostics / startup audit.
 */
export function getAccessControlStatus(): {
  mode: 'allowlist' | 'denylist' | 'none';
  allowedTools: string[] | null;
  blockedTools: string[] | null;
} {
  const allowed = parseList('SYMFONY_MCP_ALLOWED_TOOLS');
  const blocked = parseList('SYMFONY_MCP_BLOCKED_TOOLS');
  return {
    mode: blocked ? 'denylist' : allowed ? 'allowlist' : 'none',
    allowedTools: allowed ? [...allowed] : null,
    blockedTools: blocked ? [...blocked] : null,
  };
}
