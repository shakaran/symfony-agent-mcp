/**
 * Symfony Environment Variable Diff
 *
 * Compares .env* files to detect:
 *   - Variables defined in .env but missing from .env.local / .env.test / .env.prod
 *   - Variables present in environment-specific files but absent from .env (undocumented)
 *   - Variables with identical values across all envs (candidates for .env promotion)
 *   - Sensitive-looking variable names that should NOT have real values in .env
 *
 * Reads: .env, .env.local, .env.test, .env.prod, .env.dev, .env.staging,
 *        .env.local.php (warns if present — Symfony optimizer format)
 *
 * Does NOT read actual values in .env.local (by default) — only key presence.
 * Set SYMFONY_MCP_SHOW_ENV_VALUES=true to show values for non-sensitive keys.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface EnvFile {
  name: string;
  path: string;
  keys: string[];
  values: Record<string, string>;
  exists: boolean;
}

const SENSITIVE_PATTERNS = [
  /SECRET/i, /PASSWORD/i, /PASSWD/i, /\bPASS\b/i, /TOKEN/i, /API_KEY/i, /PRIVATE_KEY/i,
  /DSN/i, /DATABASE_URL/i, /MAILER_DSN/i, /AUTH/i, /CREDENTIAL/i,
  /ENCRYPTION/i, /WEBHOOK/i, /STRIPE/i, /TWILIO/i, /SENDGRID/i,
  /CERT/i, /\bKEY\b/i,
];

function isSensitive(key: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(key));
}

// ─── Parsing ───────────────────────────────────────────────────────────────

function parseEnvFile(filePath: string): { keys: string[]; values: Record<string, string> } {
  const keys: string[] = [];
  const values: Record<string, string> = {};

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      // Handle: KEY=value, KEY="value", KEY='value', export KEY=value
      const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)(?:\s*=\s*(.*))?$/.exec(line);
      if (!m) continue;

      const key = m[1];
      let value = (m[2] ?? '').trim();

      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Strip inline comment (unquoted)
      const commentIdx = value.indexOf(' #');
      if (commentIdx > 0) value = value.slice(0, commentIdx).trim();

      keys.push(key);
      values[key] = value;
    }
  } catch {
    // File not readable
  }

  return { keys, values };
}

function loadEnvFiles(appPath: string): EnvFile[] {
  const candidates = [
    '.env',
    '.env.local',
    '.env.dev',
    '.env.test',
    '.env.prod',
    '.env.staging',
    '.env.ci',
  ];

  return candidates.map((name) => {
    const fullPath = path.join(appPath, name);
    const exists = fs.existsSync(fullPath);
    if (!exists) {
      return { name, path: fullPath, keys: [], values: {}, exists: false };
    }
    const { keys, values } = parseEnvFile(fullPath);
    return { name, path: fullPath, keys, values, exists: true };
  });
}

const SHOW_VALUES = process.env['SYMFONY_MCP_SHOW_ENV_VALUES'] === 'true';

function maskValue(key: string, value: string): string {
  if (!SHOW_VALUES) return '(hidden)';
  if (isSensitive(key)) return '***';
  return value.length > 60 ? value.slice(0, 57) + '...' : value;
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listEnvFiles(appPath: string): McpToolResult {
  try {
    const envFiles = loadEnvFiles(appPath);
    const existing = envFiles.filter((f) => f.exists);

    if (existing.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No .env files found in ${appPath}.\n\nExpected: .env (base), .env.local (local overrides — git-ignored)`,
        }],
      };
    }

    // Warn if .env.local.php is present (Symfony optimizer-generated, bypasses .env parsing)
    const optimizerFile = path.join(appPath, '.env.local.php');
    const hasOptimizer = fs.existsSync(optimizerFile);

    let text = `Environment Files\n${'='.repeat(50)}\n\n`;

    for (const f of existing) {
      text += `  ${f.name.padEnd(20)} ${String(f.keys.length).padStart(4)} keys\n`;
    }

    const missing = envFiles.filter((f) => !f.exists);
    if (missing.length > 0) {
      text += `\nNot present:\n`;
      for (const f of missing) text += `  ${f.name}\n`;
    }

    if (hasOptimizer) {
      text += `\n⚠ .env.local.php detected — Symfony optimizer is active.\n`;
      text += `  This file takes precedence over .env* files. Run:\n`;
      text += `  composer dump-env <env>  to regenerate after changes.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function diffEnvFiles(appPath: string, referenceFile: string = '.env'): McpToolResult {
  try {
    const envFiles = loadEnvFiles(appPath);
    const ref = envFiles.find((f) => f.name === referenceFile);

    if (!ref || !ref.exists) {
      return {
        content: [{ type: 'text', text: `Reference file "${referenceFile}" not found.` }],
        isError: true,
      };
    }

    const others = envFiles.filter((f) => f.exists && f.name !== referenceFile);

    if (others.length === 0) {
      return {
        content: [{ type: 'text', text: `Only ${referenceFile} exists — nothing to diff against.` }],
      };
    }

    const refKeys = new Set(ref.keys);
    let text = `Env Diff — base: ${referenceFile}\n${'='.repeat(50)}\n`;

    let totalMissing = 0;
    let totalExtra = 0;

    for (const other of others) {
      const otherKeys = new Set(other.keys);
      const missing = ref.keys.filter((k) => !otherKeys.has(k));
      const extra = other.keys.filter((k) => !refKeys.has(k));

      text += `\n  ${other.name}:\n`;

      if (missing.length === 0 && extra.length === 0) {
        text += `    ✓ All keys in sync\n`;
        continue;
      }

      if (missing.length > 0) {
        text += `    Missing (in ${referenceFile} but not here):\n`;
        for (const k of missing) {
          const refVal = maskValue(k, ref.values[k] ?? '');
          text += `      ${k}  (ref: ${refVal})\n`;
        }
        totalMissing += missing.length;
      }

      if (extra.length > 0) {
        text += `    Extra (undocumented in ${referenceFile}):\n`;
        for (const k of extra) {
          text += `      ${k}\n`;
        }
        totalExtra += extra.length;
      }
    }

    if (totalMissing + totalExtra === 0) {
      text += `\n✓ All files are in sync with ${referenceFile}.\n`;
    } else {
      text += `\nSummary: ${totalMissing} missing keys, ${totalExtra} undocumented keys.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function findSensitiveEnvKeys(appPath: string): McpToolResult {
  try {
    const envFiles = loadEnvFiles(appPath);
    const baseFile = envFiles.find((f) => f.name === '.env' && f.exists);

    if (!baseFile) {
      return { content: [{ type: 'text', text: 'No .env file found.' }] };
    }

    const sensitiveInBase = baseFile.keys.filter((k) => isSensitive(k));
    const withRealValues = sensitiveInBase.filter((k) => {
      const v = baseFile.values[k] ?? '';
      return v && !v.startsWith('%') && !v.startsWith('$') && v !== '' && !v.startsWith('!!');
    });

    let text = `Sensitive Environment Key Audit\n${'='.repeat(50)}\n\n`;
    text += `Sensitive-looking keys in .env: ${sensitiveInBase.length}\n`;

    if (sensitiveInBase.length === 0) {
      text += `\n✓ No sensitive-looking keys found in .env.\n`;
      return { content: [{ type: 'text', text }] };
    }

    text += `\nAll sensitive keys:\n`;
    for (const k of sensitiveInBase) {
      const v = baseFile.values[k] ?? '';
      const isEmpty = !v || v === '';
      const isPlaceholder = v.startsWith('%') || v.startsWith('$') || v.includes('your-') || v.includes('change-me');
      const status = isEmpty ? '✓ empty' : isPlaceholder ? '✓ placeholder' : '⚠ has value';
      text += `  ${k.padEnd(40)} ${status}\n`;
    }

    if (withRealValues.length > 0) {
      text += `\n⚠ Keys with apparent real values in .env (should be in .env.local):\n`;
      for (const k of withRealValues) {
        text += `  ${k}\n`;
      }
      text += `\n  These should be empty or use placeholders in .env.\n`;
      text += `  Real values belong in .env.local (git-ignored).\n`;
    } else {
      text += `\n✓ No sensitive keys have real values committed in .env.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getEnvStats(appPath: string): McpToolResult {
  try {
    const envFiles = loadEnvFiles(appPath).filter((f) => f.exists);

    if (envFiles.length === 0) {
      return { content: [{ type: 'text', text: 'No .env files found.' }] };
    }

    const allKeys = new Set(envFiles.flatMap((f) => f.keys));
    // Keys consistent across all files (same value)
    const consistent: string[] = [];
    const inconsistent: string[] = [];

    for (const key of allKeys) {
      const filesWithKey = envFiles.filter((f) => f.keys.includes(key));
      if (filesWithKey.length < 2) continue;
      const values = filesWithKey.map((f) => f.values[key] ?? '');
      const allSame = values.every((v) => v === values[0]);
      if (allSame) consistent.push(key);
      else inconsistent.push(key);
    }

    const sensitiveCount = Array.from(allKeys).filter(isSensitive).length;

    let text = `Environment Variable Statistics\n${'='.repeat(40)}\n\n`;
    text += `Env files found:    ${envFiles.length}\n`;
    text += `Total unique keys:  ${allKeys.size}\n`;
    text += `Sensitive keys:     ${sensitiveCount}\n`;
    if (inconsistent.length > 0) text += `Keys that differ:   ${inconsistent.length}\n`;
    if (consistent.length > 0) text += `Keys identical everywhere: ${consistent.length}\n`;

    text += `\nFiles:\n`;
    for (const f of envFiles) {
      text += `  ${f.name.padEnd(20)} ${f.keys.length} keys\n`;
    }

    if (inconsistent.length > 0) {
      text += `\nKeys with different values across files:\n`;
      for (const k of inconsistent.slice(0, 15)) {
        text += `  ${k}\n`;
      }
      if (inconsistent.length > 15) text += `  ... and ${inconsistent.length - 15} more\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getEnvDiffTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_env_files',
      description: 'List all .env* files (.env, .env.local, .env.test, .env.prod, etc.) with key counts and warn about .env.local.php optimizer',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'diff_env_files',
      description: 'Compare all .env* files against a reference file and report missing or undocumented keys per environment',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          reference_file: { type: 'string', description: 'Reference file to compare against (default: .env)' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'find_sensitive_env_keys',
      description: 'Audit .env for sensitive keys (passwords, tokens, DSNs) that have real values committed — they should be in .env.local',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_env_stats',
      description: 'Show environment variable statistics: total keys, sensitive count, keys that differ across envs',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
