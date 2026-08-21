/**
 * App Path Authorization Guard
 *
 * Validates that app_path:
 *  1. Is an actual directory we can read
 *  2. Looks like a valid Symfony project
 *  3. Is in the optional allowlist (SYMFONY_MCP_ALLOWED_PATHS)
 *  4. Does not contain directory traversal sequences
 *
 * Configuration via environment variables:
 *   SYMFONY_MCP_ALLOWED_PATHS   — colon-separated list of allowed absolute paths
 *                                 If unset, any readable Symfony project is allowed.
 *   SYMFONY_MCP_REQUIRE_SYMFONY — set to "false" to skip Symfony project validation
 *                                 (useful for testing or non-standard layouts)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

// Indicators that confirm a directory is a Symfony project
const SYMFONY_INDICATORS = [
  'composer.json',
  'src/Kernel.php',
  'config/bundles.php',
  'bin/console',
  'config/packages',
];

// Minimum required indicators (need at least 2 to avoid false positives)
const MIN_INDICATOR_MATCHES = 2;

let allowlistCache: string[] | null = null;

function getAllowlist(): string[] | null {
  if (allowlistCache !== null) return allowlistCache;

  const raw = process.env['SYMFONY_MCP_ALLOWED_PATHS'];
  if (!raw || raw.trim() === '') {
    allowlistCache = null;
    return null;
  }

  allowlistCache = raw
    .split(':')
    .map((p) => path.resolve(p.trim()))
    .filter((p) => p.length > 0);

  return allowlistCache;
}

/**
 * Validates that `appPath` is an allowed, readable Symfony application directory.
 *
 * @param appPath - The `app_path` value from a tool invocation
 */
export function guardAppPath(appPath: string): GuardResult {
  // Basic type check
  if (!appPath || typeof appPath !== 'string') {
    return { allowed: false, reason: 'app_path is required and must be a string' };
  }

  // Normalize — this also collapses any `..` sequences
  const resolved = path.resolve(appPath);

  // Block paths containing null bytes (poison null byte attack)
  if (appPath.includes('\0')) {
    return { allowed: false, reason: 'app_path contains invalid characters' };
  }

  // Allowlist check
  const allowlist = getAllowlist();
  if (allowlist !== null) {
    const permitted = allowlist.some(
      (allowed) => resolved === allowed || resolved.startsWith(allowed + path.sep)
    );
    if (!permitted) {
      return {
        allowed: false,
        reason: `app_path is not in the allowed paths list. Set SYMFONY_MCP_ALLOWED_PATHS to permit it.`,
      };
    }
  }

  // Directory existence + readability
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { allowed: false, reason: `app_path "${resolved}" is not a directory` };
    }
  } catch {
    return { allowed: false, reason: `app_path "${resolved}" does not exist or is not readable` };
  }

  // Symlink traversal prevention: resolve symlinks and re-check allowlist
  // Prevents: /var/www/safe-link -> /etc/passwd style attacks
  try {
    const realResolved = fs.realpathSync(resolved);
    if (realResolved !== resolved) {
      // Path has symlinks — re-check the real path against the allowlist
      if (allowlist !== null) {
        const realPermitted = allowlist.some(
          (allowed) => {
            try {
              const realAllowed = fs.realpathSync(allowed);
              return realResolved === realAllowed || realResolved.startsWith(realAllowed + path.sep);
            } catch {
              return false;
            }
          }
        );
        if (!realPermitted) {
          return {
            allowed: false,
            reason: `app_path resolves via symlink to "${realResolved}" which is not in the allowed paths list`,
          };
        }
      }
    }
  } catch {
    // realpathSync fails on broken symlinks — reject them
    return { allowed: false, reason: `app_path "${resolved}" contains a broken or inaccessible symlink` };
  }

  // Symfony project validation (can be skipped for testing)
  if (process.env['SYMFONY_MCP_REQUIRE_SYMFONY'] !== 'false') {
    const result = validateSymfonyProject(resolved);
    if (!result.allowed) return result;
  }

  return { allowed: true };
}

/**
 * Checks that the directory contains enough Symfony-specific files to be considered
 * a valid Symfony project. This prevents the MCP from being pointed at arbitrary
 * system directories.
 */
function validateSymfonyProject(dirPath: string): GuardResult {
  let matches = 0;

  for (const indicator of SYMFONY_INDICATORS) {
    const indicatorPath = path.join(dirPath, indicator);
    try {
      fs.accessSync(indicatorPath, fs.constants.R_OK);
      matches++;
      if (matches >= MIN_INDICATOR_MATCHES) break;
    } catch {
      // Indicator not found — continue
    }
  }

  if (matches < MIN_INDICATOR_MATCHES) {
    return {
      allowed: false,
      reason:
        `"${dirPath}" does not appear to be a Symfony project ` +
        `(found ${matches}/${MIN_INDICATOR_MATCHES} required indicators: ${SYMFONY_INDICATORS.join(', ')}). ` +
        `Set SYMFONY_MCP_REQUIRE_SYMFONY=false to skip this check.`,
    };
  }

  // Extra check: composer.json must reference symfony/* if present
  const composerPath = path.join(dirPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composerRaw = fs.readFileSync(composerPath, 'utf-8');
      const composer = JSON.parse(composerRaw) as Record<string, unknown>;
      const require = (composer['require'] || {}) as Record<string, string>;
      const requireDev = (composer['require-dev'] || {}) as Record<string, string>;
      const allDeps = { ...require, ...requireDev };

      const hasSymfony = Object.keys(allDeps).some((dep) => dep.startsWith('symfony/'));
      if (!hasSymfony) {
        return {
          allowed: false,
          reason:
            `"${dirPath}" has a composer.json but no symfony/* dependencies. ` +
            `This does not appear to be a Symfony project.`,
        };
      }
    } catch {
      // Can't parse — allow it (the earlier indicator check was sufficient)
    }
  }

  return { allowed: true };
}

/**
 * Resets internal caches (useful for testing with different env vars).
 */
export function resetGuardCache(): void {
  allowlistCache = null;
}
