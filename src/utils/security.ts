/**
 * Security utilities for sanitizing sensitive data
 * Ensures no passwords, API keys, or secrets are exposed
 */

import * as path from 'path';
import * as fs from 'fs';
import { redactText } from './dlp-detector.js';

/**
 * List of sensitive field names that should be redacted
 */
const SENSITIVE_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'private_key',
  'encryption_key',
  'auth_key',
  'session_key',
  'webhook_secret',
  'slack_token',
  'github_token',
  'database_url',
  'db_password',
  'mysql_password',
  'postgres_password',
  'mongodb_password',
  'redis_password',
  'aws_secret',
  'azure_secret',
  'gcp_key',
  'oauth_secret',
];

/**
 * Redacts sensitive values from configuration objects
 * @param obj - Object to sanitize
 * @param depth - Current recursion depth
 * @returns Sanitized object with sensitive values masked
 */
export function sanitizeConfig(
  obj: unknown,
  depth: number = 0
): unknown {
  // Prevent infinite recursion
  if (depth > 10) return '[object - max depth]';

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // First apply structural DLP detection (credit cards, JWTs, API keys, etc.)
    const dlpResult = redactText(obj);
    // Then check legacy heuristic for anything DLP didn't catch
    if (isLikelySecret(dlpResult)) {
      return '[REDACTED]';
    }
    return dlpResult;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeConfig(item, depth + 1));
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();

    // Check if this key is sensitive
    if (SENSITIVE_KEYS.some((sensitive) => lowerKey.includes(sensitive))) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    // Recursively sanitize nested objects
    if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeConfig(value, depth + 1);
    } else if (typeof value === 'string') {
      const dlpResult = redactText(value);
      sanitized[key] = isLikelySecret(dlpResult) ? '[REDACTED]' : dlpResult;
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Determines if a string value is likely a secret based on length and content
 * @param value - String to check
 * @returns true if the value appears to be a secret
 */
function isLikelySecret(value: string): boolean {
  // URLs with passwords (mysql://user:pass@host)
  if (/[:@]/.test(value) && value.length > 20) {
    return true;
  }

  // Long base64-like strings
  if (/^[A-Za-z0-9+/=]{40,}$/.test(value)) {
    return true;
  }

  // JWT tokens
  if (/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./.test(value)) {
    return true;
  }

  return false;
}

/**
 * Sanitizes environment variables, removing sensitive values
 * @param envVars - Environment variables object
 * @returns Sanitized environment variables
 */
export function sanitizeEnvironment(envVars: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(envVars)) {
    if (SENSITIVE_KEYS.some((sensitive) => key.toLowerCase().includes(sensitive))) {
      sanitized[key] = '[REDACTED]';
    } else if (isLikelySecret(value)) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Sanitizes database URLs, removing passwords
 * @param url - Database URL
 * @returns Sanitized URL with password redacted
 */
export function sanitizeDatabaseUrl(url: string): string {
  if (!url) return url;

  // PostgreSQL, MySQL, etc.
  const pattern = /(:\/\/[^:]+:)([^@]+)(@)/;
  return url.replace(pattern, '$1[REDACTED]$3');
}

/**
 * Validates and sanitizes log output to prevent exposure of sensitive data
 * @param logContent - Raw log content
 * @returns Sanitized log content
 */
export function sanitizeLogOutput(logContent: string): string {
  // Run full DLP scan first (catches structured patterns: CC, JWTs, API keys, etc.)
  let sanitized = redactText(logContent);

  // Then apply legacy keyword-context patterns as a secondary pass
  sanitized = sanitized.replace(/(key|token|password)[\s:="]+([A-Za-z0-9_-]{20,})/gi, '$1=[REDACTED]');
  sanitized = sanitized.replace(/([a-z]+:\/\/[^:]+:)([^@]+)(@)/gi, '$1[REDACTED]$3');

  return sanitized;
}

/**
 * Validates that a file path is safe to read.
 * Prevents directory traversal and symlink-based escape attacks.
 *
 * @param basePath - Base directory path (the Symfony app root)
 * @param filePath - Requested file path (relative or absolute)
 * @returns true if the path is safe to read
 */
export function isPathSafe(basePath: string, filePath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedPath = path.resolve(basePath, filePath);

  // Step 1: lexical containment check (fast, catches most traversal)
  if (!resolvedPath.startsWith(resolvedBase)) return false;

  // Step 2: symlink resolution — prevents symlinks inside the project
  //         that point outside the project root.
  //         If the base path doesn't exist (e.g. in tests or before first run),
  //         fall back to the lexical check already passed above.
  let realBase: string;
  try {
    realBase = fs.realpathSync(resolvedBase);
  } catch {
    // Base doesn't exist — lexical check (already passed) is the only guard.
    return true;
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(resolvedPath);
  } catch {
    // Target doesn't exist — resolve parent and append filename.
    try {
      const parentReal = fs.realpathSync(path.dirname(resolvedPath));
      realPath = path.join(parentReal, path.basename(resolvedPath));
    } catch {
      return true; // Parent doesn't exist either — lexical check suffices.
    }
  }

  return realPath.startsWith(realBase);
}
