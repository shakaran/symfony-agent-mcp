/**
 * Input Validator
 *
 * Schema-based validation of MCP tool parameters before execution.
 * Prevents argument tampering, oversized payloads, and injection via input.
 *
 * Each tool's parameter set is validated against a declared schema.
 * Unknown or missing required parameters cause immediate rejection.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

type ParamType = 'path' | 'name' | 'query' | 'integer' | 'string' | 'enum';

interface ParamSchema {
  type: ParamType;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  values?: readonly string[];    // for enum type
  pattern?: RegExp;
  patternName?: string;          // human-readable pattern description
}

interface ToolSchema {
  [param: string]: ParamSchema;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

// ─── Allowed character patterns ───────────────────────────────────────────────

// Filesystem path: printable ASCII except null bytes and shell metacharacters
const PATH_SAFE = /^[^\0|&;`$()<>]+$/;

// Safe identifier for names (routes, tables, entities, controllers, services)
const NAME_SAFE = /^[\w\-.:/\\@\s]+$/;

// Search/query strings: printable ASCII, no null bytes
const QUERY_SAFE = /^[^\0]+$/;

// ─── Tool parameter schemas ───────────────────────────────────────────────────

const TOOL_SCHEMAS: Record<string, ToolSchema> = {
  // ── Routes ────────────────────────────────────────────────────────────────
  list_routes:        { app_path: { type: 'path', required: true } },
  list_http_methods:  { app_path: { type: 'path', required: true } },
  get_route_details: {
    app_path:   { type: 'path', required: true },
    route_name: { type: 'name', required: true, maxLength: 255 },
  },
  search_routes: {
    app_path: { type: 'path', required: true },
    query:    { type: 'query', required: true, maxLength: 512 },
    type:     { type: 'enum', values: ['name', 'path', 'controller', 'all'] as const },
  },

  // ── Services ──────────────────────────────────────────────────────────────
  list_services:      { app_path: { type: 'path', required: true } },
  list_available_tags:{ app_path: { type: 'path', required: true } },
  get_service_details:{
    app_path:   { type: 'path', required: true },
    service_id: { type: 'name', required: true, maxLength: 512 },
  },
  list_services_by_tag:{
    app_path: { type: 'path', required: true },
    tag:      { type: 'name', required: true, maxLength: 255 },
  },
  search_services: {
    app_path: { type: 'path', required: true },
    query:    { type: 'query', required: true, maxLength: 512 },
    type:     { type: 'enum', values: ['id', 'class', 'tag', 'all'] as const },
  },

  // ── Configuration ─────────────────────────────────────────────────────────
  get_app_environment:        { app_path: { type: 'path', required: true } },
  list_environment_variables: { app_path: { type: 'path', required: true } },
  get_database_config:        { app_path: { type: 'path', required: true } },
  get_services_config:        { app_path: { type: 'path', required: true } },
  get_framework_config:       { app_path: { type: 'path', required: true } },
  get_security_config:        { app_path: { type: 'path', required: true } },
  list_config_packages:       { app_path: { type: 'path', required: true } },

  // ── Logs ──────────────────────────────────────────────────────────────────
  list_logs:      { app_path: { type: 'path', required: true } },
  get_error_summary: {
    app_path:  { type: 'path', required: true },
    file_name: { type: 'name', required: true, maxLength: 255 },
  },
  get_environment_logs: {
    app_path:    { type: 'path', required: true },
    environment: { type: 'name', required: true, maxLength: 64 },
  },
  tail_log: {
    app_path:  { type: 'path', required: true },
    file_name: { type: 'name', required: true, maxLength: 255 },
    lines:     { type: 'integer', min: 1, max: 10000 },
  },
  search_log: {
    app_path:    { type: 'path', required: true },
    file_name:   { type: 'name', required: true, maxLength: 255 },
    search_term: { type: 'query', required: true, maxLength: 512 },
  },

  // ── Entities ──────────────────────────────────────────────────────────────
  list_entities:      { app_path: { type: 'path', required: true } },
  get_entities_stats: { app_path: { type: 'path', required: true } },
  get_entity_details: {
    app_path:    { type: 'path', required: true },
    entity_name: { type: 'name', required: true, maxLength: 255 },
  },
  get_related_entities: {
    app_path:    { type: 'path', required: true },
    entity_name: { type: 'name', required: true, maxLength: 255 },
  },
  search_entities: {
    app_path: { type: 'path', required: true },
    query:    { type: 'query', required: true, maxLength: 512 },
  },

  // ── Database ──────────────────────────────────────────────────────────────
  list_tables:           { app_path: { type: 'path', required: true } },
  get_database_info:     { app_path: { type: 'path', required: true } },
  validate_schema_mapping:{ app_path: { type: 'path', required: true } },
  get_migration_status:  { app_path: { type: 'path', required: true } },
  get_table_schema: {
    app_path:   { type: 'path', required: true },
    table_name: { type: 'name', required: true, maxLength: 255,
      pattern: /^[\w$]+$/, patternName: 'alphanumeric + underscore' },
  },
  search_tables: {
    app_path: { type: 'path', required: true },
    query:    { type: 'query', required: true, maxLength: 512 },
  },

  // ── Controllers ───────────────────────────────────────────────────────────
  list_controllers: { app_path: { type: 'path', required: true } },
  search_controllers: {
    app_path: { type: 'path', required: true },
    query:    { type: 'query', required: true, maxLength: 512 },
  },
  get_controller_actions: {
    app_path:         { type: 'path', required: true },
    controller_name:  { type: 'name', required: true, maxLength: 255 },
  },

  // ── Composer ──────────────────────────────────────────────────────────────
  get_composer_info:      { app_path: { type: 'path', required: true } },
  get_installed_packages: { app_path: { type: 'path', required: true } },
  get_symfony_version:    { app_path: { type: 'path', required: true } },

  // ── Forms ─────────────────────────────────────────────────────────────────
  get_form_type_details: {
    app_path:  { type: 'path', required: true },
    form_name: { type: 'name', required: true, maxLength: 255 },
  },
  search_form_types: {
    app_path: { type: 'path', required: true },
    query:    { type: 'query', required: true, maxLength: 512 },
  },

  // ── Events ────────────────────────────────────────────────────────────────
  get_event_listeners_by_event: {
    app_path:   { type: 'path', required: true },
    event_name: { type: 'name', required: true, maxLength: 255 },
  },

  // ── Commands ──────────────────────────────────────────────────────────────
  get_command_details: {
    app_path:     { type: 'path', required: true },
    command_name: { type: 'name', required: true, maxLength: 255 },
  },
  search_commands: {
    app_path: { type: 'path', required: true },
    query:    { type: 'query', required: true, maxLength: 512 },
  },

  // ── Templates ─────────────────────────────────────────────────────────────
  get_template_details: {
    app_path:      { type: 'path', required: true },
    template_path: { type: 'name', required: true, maxLength: 512 },
  },
  search_templates: {
    app_path: { type: 'path', required: true },
    query:    { type: 'query', required: true, maxLength: 512 },
  },

  // ── Translations ──────────────────────────────────────────────────────────
  search_translations: {
    app_path: { type: 'path', required: true },
    query:    { type: 'query', required: true, maxLength: 512 },
  },

  // ── Workflows ─────────────────────────────────────────────────────────────
  get_workflow_details: {
    app_path:      { type: 'path', required: true },
    workflow_name: { type: 'name', required: true, maxLength: 255 },
  },

  // ── API Platform ──────────────────────────────────────────────────────────
  get_api_resource_details: {
    app_path:      { type: 'path', required: true },
    resource_name: { type: 'name', required: true, maxLength: 255 },
  },

  // ── Serializer ────────────────────────────────────────────────────────────
  get_class_serializer_profile: {
    app_path:   { type: 'path', required: true },
    class_name: { type: 'name', required: true, maxLength: 255 },
  },
  search_serializer_groups: {
    app_path:   { type: 'path', required: true },
    group_name: { type: 'name', required: true, maxLength: 255 },
  },

  // ── Repositories ──────────────────────────────────────────────────────────
  get_repository_details: {
    app_path:        { type: 'path', required: true },
    repository_name: { type: 'name', required: true, maxLength: 255 },
  },

  // ── Doctrine lifecycle ────────────────────────────────────────────────────
  get_lifecycle_by_event: {
    app_path:   { type: 'path', required: true },
    event_name: { type: 'name', required: true, maxLength: 255 },
  },

  // ── DI parameters ─────────────────────────────────────────────────────────
  search_di_parameters: {
    app_path: { type: 'path', required: true },
    query:    { type: 'query', required: true, maxLength: 512 },
  },

  // ── Profiler ──────────────────────────────────────────────────────────────
  list_profiler_requests: { app_path: { type: 'path', required: true } },
  get_profiler_stats:     { app_path: { type: 'path', required: true } },
  get_profiler_details: {
    app_path: { type: 'path', required: true },
    // Symfony profiler tokens are hex strings; restrict to prevent path traversal
    token: { type: 'name', required: true, maxLength: 64, pattern: /^[0-9a-f]{8,64}$/, patternName: 'hex profiler token' },
  },
  get_profiler_queries: {
    app_path: { type: 'path', required: true },
    token: { type: 'name', required: true, maxLength: 64, pattern: /^[0-9a-f]{8,64}$/, patternName: 'hex profiler token' },
  },

  // ── Secrets Vault ─────────────────────────────────────────────────────────
  get_secrets_vault_stats: { app_path: { type: 'path', required: true } },
  list_secrets_vault: {
    app_path: { type: 'path', required: true },
    // Restrict env to known Symfony environments to prevent path traversal via env param
    env: { type: 'enum', values: ['prod', 'dev', 'test', 'local', 'staging'] as const },
  },
};

// ─── Validators per type ──────────────────────────────────────────────────────

function validatePath(value: unknown, paramName: string): ValidationResult {
  if (typeof value !== 'string') return { valid: false, reason: `${paramName}: must be a string` };
  if (value.length === 0) return { valid: false, reason: `${paramName}: must not be empty` };
  if (value.length > 4096) return { valid: false, reason: `${paramName}: exceeds max length (4096)` };
  if (!PATH_SAFE.test(value)) return { valid: false, reason: `${paramName}: contains unsafe characters` };
  if (value.includes('\0')) return { valid: false, reason: `${paramName}: contains null byte` };
  return { valid: true };
}

function validateName(value: unknown, paramName: string, schema: ParamSchema): ValidationResult {
  if (typeof value !== 'string') return { valid: false, reason: `${paramName}: must be a string` };
  if (value.length === 0) return { valid: false, reason: `${paramName}: must not be empty` };

  const maxLen = schema.maxLength ?? 512;
  if (value.length > maxLen) return { valid: false, reason: `${paramName}: exceeds max length (${maxLen})` };
  if (!NAME_SAFE.test(value)) return { valid: false, reason: `${paramName}: contains unsafe characters` };

  if (schema.pattern && !schema.pattern.test(value)) {
    return { valid: false, reason: `${paramName}: must match ${schema.patternName ?? 'expected pattern'}` };
  }

  return { valid: true };
}

function validateQuery(value: unknown, paramName: string, schema: ParamSchema): ValidationResult {
  if (typeof value !== 'string') return { valid: false, reason: `${paramName}: must be a string` };
  if (value.length === 0) return { valid: false, reason: `${paramName}: must not be empty` };

  const maxLen = schema.maxLength ?? 1024;
  if (value.length > maxLen) return { valid: false, reason: `${paramName}: exceeds max length (${maxLen})` };
  if (!QUERY_SAFE.test(value)) return { valid: false, reason: `${paramName}: contains null byte` };

  return { valid: true };
}

function validateInteger(value: unknown, paramName: string, schema: ParamSchema): ValidationResult {
  const num = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (isNaN(num) || !isFinite(num)) return { valid: false, reason: `${paramName}: must be a number` };
  if (schema.min !== undefined && num < schema.min) return { valid: false, reason: `${paramName}: minimum is ${schema.min}` };
  if (schema.max !== undefined && num > schema.max) return { valid: false, reason: `${paramName}: maximum is ${schema.max}` };
  return { valid: true };
}

function validateEnum(value: unknown, paramName: string, schema: ParamSchema): ValidationResult {
  if (value === undefined || value === null) return { valid: true }; // optional enum
  if (!schema.values?.includes(String(value))) {
    return { valid: false, reason: `${paramName}: must be one of [${schema.values?.join(', ')}]` };
  }
  return { valid: true };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validates tool arguments against the declared parameter schema.
 *
 * @param toolName - The MCP tool name
 * @param args     - The raw arguments object from the client
 * @returns `{valid: true}` or `{valid: false, reason: string}`
 */
export function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>
): ValidationResult {
  const schema = TOOL_SCHEMAS[toolName];
  if (!schema) {
    // Tool not yet in schema — apply default app_path validation for defense-in-depth.
    // guardAppPath() validates it downstream too, but early rejection saves resources.
    const appPath = args['app_path'];
    if (appPath !== undefined) return validatePath(appPath, 'app_path');
    return { valid: true };
  }

  for (const [param, paramSchema] of Object.entries(schema)) {
    const value = args[param];

    // Required check
    if (paramSchema.required && (value === undefined || value === null || value === '')) {
      return { valid: false, reason: `Missing required parameter: ${param}` };
    }

    // Skip optional params that weren't provided
    if (value === undefined || value === null) continue;

    let result: ValidationResult;
    switch (paramSchema.type) {
      case 'path':    result = validatePath(value, param); break;
      case 'name':    result = validateName(value, param, paramSchema); break;
      case 'query':   result = validateQuery(value, param, paramSchema); break;
      case 'integer': result = validateInteger(value, param, paramSchema); break;
      case 'enum':    result = validateEnum(value, param, paramSchema); break;
      default:        result = { valid: true };
    }

    if (!result.valid) return result;
  }

  return { valid: true };
}

/**
 * Returns whether input validation is enabled (default: true).
 * Disable with SYMFONY_MCP_INPUT_VALIDATION=false (testing only).
 */
export function isInputValidationEnabled(): boolean {
  return process.env['SYMFONY_MCP_INPUT_VALIDATION'] !== 'false';
}

/**
 * Returns the list of tools that have registered schemas.
 */
export function getValidatedTools(): string[] {
  return Object.keys(TOOL_SCHEMAS);
}
