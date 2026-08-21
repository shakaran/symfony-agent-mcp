/**
 * Privacy Mode
 *
 * Global data minimization layer applied to tool outputs.
 * Goes beyond redaction — removes entire categories of data at the output level.
 *
 * Levels:
 *   standard  — Normal operation. Keyword + DLP redaction only.
 *   strict    — Remove environment variables entirely (not just redact).
 *               Strip file contents from responses, keep only metadata.
 *               Mask all IP addresses.
 *               For GDPR/HIPAA compliance contexts.
 *   paranoid  — Everything in strict, plus:
 *               Remove line numbers, timestamps, version numbers.
 *               Replace all file paths with generic labels.
 *               Strip all numeric values that could be identifiers.
 *               For maximum-confidentiality deployments.
 *
 * Configuration:
 *   SYMFONY_MCP_PRIVACY=strict    — Enable strict privacy mode
 *   SYMFONY_MCP_PRIVACY=paranoid  — Enable paranoid privacy mode
 *   SYMFONY_MCP_PRIVACY_TOOLS     — Comma-separated list of tools to apply
 *                                   privacy mode to (default: all)
 */

export type PrivacyLevel = 'standard' | 'strict' | 'paranoid';

// ─── Configuration ──────────────────────────────────────────────────────────

export function getPrivacyLevel(): PrivacyLevel {
  const val = process.env['SYMFONY_MCP_PRIVACY']?.toLowerCase();
  if (val === 'paranoid') return 'paranoid';
  if (val === 'strict') return 'strict';
  return 'standard';
}

function getPrivacyTools(): Set<string> | null {
  const raw = process.env['SYMFONY_MCP_PRIVACY_TOOLS'];
  if (!raw) return null; // null = apply to all tools
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

export function isPrivacyApplicable(toolName: string): boolean {
  const level = getPrivacyLevel();
  if (level === 'standard') return false;

  const tools = getPrivacyTools();
  if (tools === null) return true; // apply to all
  return tools.has(toolName);
}

// ─── Transformation patterns ─────────────────────────────────────────────────

// ENV_VAR=value lines (both KEY=value and KEY: value formats)
const ENV_VAR_LINE = /^[A-Z][A-Z0-9_]*\s*[=:]\s*.+$/gm;

// IP addresses (v4)
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

// Ports
const PORT_RE = /:\d{2,5}\b/g;

// Version strings: 1.2.3, v1.2.3-alpha.1
const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.]+)?\b/g;

// Timestamps: ISO 8601, common log formats
const TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

// Line numbers in error messages / stack references
const LINE_NUMBER_RE = /\b(?:line|ln|L)\s*\d+\b/gi;

// Generic numeric identifiers (IDs in output)
const NUMERIC_ID_RE = /\b(?:id|ID|Id)\s*[:=]\s*\d+\b/g;

// File paths in output text
const FILE_PATH_RE = /(?:^|[\s"'`(])(\/?[a-zA-Z][a-zA-Z0-9_\-./]*\.[a-z]{2,4})\b/g;

// ─── Strict transformations ───────────────────────────────────────────────────

function applyStrict(text: string, toolName: string): string {
  let out = text;

  // Tools that expose environment variables — strip values entirely
  if (toolName === 'list_environment_variables' || toolName === 'get_app_environment') {
    out = out.replace(ENV_VAR_LINE, (match) => {
      const [key] = match.split(/\s*[=:]\s*/);
      return `${key}=[PRIVACY:STRICT]`;
    });
  }

  // Mask IP addresses
  out = out.replace(IPV4_RE, '[IP]');

  return out;
}

// ─── Schema-sensitive column annotation (paranoid mode) ───────────────────────

// Tools that return table/entity schemas
const SCHEMA_TOOLS = new Set([
  'get_table_schema', 'get_entity_details', 'get_database_config',
  'list_tables', 'validate_schema_mapping',
]);

// PII/sensitive column name patterns
const SENSITIVE_COLUMN_RE = /\b(password|passwd|pwd|secret|token|api_?key|credit_?card|card_?num|cvv|ssn|social_?security|dob|birth|email|phone|mobile|address|zip|postal|health|medical|diagnosis|salary|income|account_?num|iban|swift|routing_?num)\b/i;

// Column name in output patterns: `column_name` (type), | col_name |, fieldName:, field_name =
const COLUMN_CONTEXT_RE = /(?:^|\|)\s*([a-z][a-z0-9_]{2,})\s*(?:\||:|\(|\s+\w)/gim;

function applySchemaAnnotation(text: string, toolName: string): string {
  if (!SCHEMA_TOOLS.has(toolName)) return text;

  return text.replace(COLUMN_CONTEXT_RE, (match, colName: string) => {
    if (SENSITIVE_COLUMN_RE.test(colName)) {
      return match + ` [⚠️ SENSITIVE:PII]`;
    }
    return match;
  });
}

// ─── Paranoid transformations ─────────────────────────────────────────────────

function applyParanoid(text: string, toolName: string): string {
  let out = text;

  // Strip version numbers
  out = out.replace(VERSION_RE, '[VERSION]');

  // Strip timestamps
  out = out.replace(TIMESTAMP_RE, '[TIMESTAMP]');

  // Strip line number references
  out = out.replace(LINE_NUMBER_RE, '[LINE]');

  // Strip numeric IDs
  out = out.replace(NUMERIC_ID_RE, (match) => match.replace(/\d+$/, '[ID]'));

  // Strip ports
  out = out.replace(PORT_RE, ':[PORT]');

  // Anonymize file path basenames while keeping extension (for type context)
  out = out.replace(FILE_PATH_RE, (match, capture) => {
    const ext = capture.split('.').pop() ?? '';
    const prefix = match.slice(0, match.indexOf(capture));
    return `${prefix}[FILE.${ext.toUpperCase()}]`;
  });

  // Annotate sensitive schema columns
  out = applySchemaAnnotation(out, toolName);

  return out;
}

// ─── Content item interface (avoids circular import) ────────────────────────

interface ContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolResultLike {
  content: ContentItem[];
  isError?: boolean;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Applies privacy-mode transformations to a tool result.
 *
 * Call this AFTER DLP and error sanitization, as the final step.
 *
 * @param result   - Tool output to transform
 * @param toolName - Name of the tool that produced the result
 */
export function applyPrivacyMode(result: ToolResultLike, toolName: string): ToolResultLike {
  if (!isPrivacyApplicable(toolName)) return result;

  const level = getPrivacyLevel();

  return {
    ...result,
    content: result.content.map((item) => {
      if (typeof item.text !== 'string') return item;

      let text = item.text;

      if (level === 'strict' || level === 'paranoid') {
        text = applyStrict(text, toolName);
      }

      if (level === 'paranoid') {
        text = applyParanoid(text, toolName);
      }

      return { ...item, text };
    }),
  };
}

/**
 * Returns the current privacy configuration for diagnostics.
 */
export function getPrivacyStatus(): {
  level: PrivacyLevel;
  applicableTools: 'all' | string[];
} {
  const tools = getPrivacyTools();
  return {
    level: getPrivacyLevel(),
    applicableTools: tools === null ? 'all' : Array.from(tools),
  };
}
