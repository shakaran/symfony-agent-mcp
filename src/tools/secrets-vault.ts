/**
 * Symfony Secrets Vault Inspector
 *
 * Reads the Symfony secrets vault without decrypting values:
 *   - Lists secret names from config/secrets/{prod,dev}/ directories
 *   - Shows which secrets have local overrides (.env.local or secrets/local/)
 *   - Detects vault type (sodium, GPG)
 *   - Reads framework.secrets config for vault storage path
 *   - Cross-references with .env files to show secrets vs plain env vars
 *
 * Never reads or displays secret values — only names and metadata.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface SecretEntry {
  name: string;
  env: string;
  hasLocalOverride: boolean;
  encryptedSize?: number;
}

interface VaultInfo {
  type: 'sodium' | 'gpg' | 'unknown';
  storageDir: string;
  hasDecryptKey: boolean;
  hasEncryptKey: boolean;
  secrets: SecretEntry[];
}

// ─── Vault directory detection ─────────────────────────────────────────────

function detectVaultDir(appPath: string, env: string): string | null {
  const resolvedBase = path.resolve(appPath);
  const candidates = [
    path.join(appPath, 'config', 'secrets', env),
    path.join(appPath, 'config', 'secrets'),
    path.join(appPath, 'secrets', env),
  ];
  for (const d of candidates) {
    // Containment check: prevent path traversal via env parameter
    if (!path.resolve(d).startsWith(resolvedBase + path.sep) &&
        path.resolve(d) !== resolvedBase) continue;
    if (fs.existsSync(d)) return d;
  }
  return null;
}

function detectVaultType(dir: string): 'sodium' | 'gpg' | 'unknown' {
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith('.sodium')) return 'sodium';
      if (entry.endsWith('.gpg') || entry.endsWith('.asc')) return 'gpg';
    }
  } catch { /* skip */ }
  return 'unknown';
}

// ─── Frameworks config ────────────────────────────────────────────────────

function getVaultConfig(appPath: string): { storageDir?: string; env?: string } {
  const frameworkFile = path.join(appPath, 'config', 'packages', 'framework.yaml');
  const raw = parseYamlFile(frameworkFile) as Record<string, unknown> | null;
  if (!raw) return {};

  const fw = (raw['framework'] ?? raw) as Record<string, unknown>;
  const secrets = fw['secrets'] as Record<string, unknown> | undefined;
  if (!secrets) return {};

  return {
    storageDir: secrets['vault_directory'] ? String(secrets['vault_directory']) : undefined,
  };
}

// ─── Env var cross-reference ───────────────────────────────────────────────

function readEnvKeys(appPath: string): Set<string> {
  const keys = new Set<string>();
  const envFiles = ['.env', '.env.local', '.env.dist'];
  for (const file of envFiles) {
    try {
      const content = fs.readFileSync(path.join(appPath, file), 'utf-8');
      for (const line of content.split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=/.exec(line.trim());
        if (m) keys.add(m[1]);
      }
    } catch { /* skip */ }
  }
  return keys;
}

// ─── Secret discovery ─────────────────────────────────────────────────────

function discoverSecrets(vaultDir: string, localDir: string | null): SecretEntry[] {
  const secrets: SecretEntry[] = [];

  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(vaultDir, { withFileTypes: true }); } catch { return []; }

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    // Secret files are named like: SECRET_NAME.sodium or SECRET_NAME.gpg
    const nameMatch = /^(.+)\.(sodium|gpg|asc)$/.exec(entry.name);
    if (!nameMatch) continue;

    // Skip key files
    if (nameMatch[1].endsWith('.decrypt') || nameMatch[1].endsWith('.encrypt')) continue;
    const rawName = nameMatch[1];
    if (rawName === 'decrypt' || rawName === 'encrypt') continue;

    const fullPath = path.join(vaultDir, entry.name);
    let encSize: number | undefined;
    try { encSize = fs.statSync(fullPath).size; } catch { /* skip */ }

    // Check for local override
    let hasLocal = false;
    if (localDir) {
      hasLocal = fs.existsSync(path.join(localDir, entry.name));
    }

    secrets.push({
      name: rawName,
      env: rawName,
      hasLocalOverride: hasLocal,
      encryptedSize: encSize,
    });
  }

  return secrets.sort((a, b) => a.name.localeCompare(b.name));
}

function loadVaultInfo(appPath: string, env: string): VaultInfo | null {
  const vaultDir = detectVaultDir(appPath, env);
  if (!vaultDir) return null;

  const localDir = detectVaultDir(appPath, 'local');
  const type = detectVaultType(vaultDir);

  // Check for key files
  let hasDecryptKey = false;
  let hasEncryptKey = false;
  try {
    for (const entry of fs.readdirSync(vaultDir)) {
      if (entry.includes('decrypt')) hasDecryptKey = true;
      if (entry.includes('encrypt')) hasEncryptKey = true;
    }
  } catch { /* skip */ }

  const secrets = discoverSecrets(vaultDir, localDir);

  return {
    type,
    storageDir: path.relative(appPath, vaultDir),
    hasDecryptKey,
    hasEncryptKey,
    secrets,
  };
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listSecretsVault(appPath: string, env: string = 'prod'): McpToolResult {
  try {
    const vault = loadVaultInfo(appPath, env);

    if (!vault || vault.secrets.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No secrets vault found for env "${env}".\n\nSetup:\n  php bin/console secrets:generate-keys --env=${env}\n  php bin/console secrets:set MY_SECRET --env=${env}`,
        }],
      };
    }

    const envKeys = readEnvKeys(appPath);
    const vaultConfig = getVaultConfig(appPath);

    let text = `Secrets Vault  (${env}, ${vault.secrets.length} secrets)\n${'='.repeat(55)}\n`;
    text += `\nVault type:    ${vault.type}\n`;
    text += `Storage dir:   ${vault.storageDir}\n`;
    text += `Encrypt key:   ${vault.hasEncryptKey ? 'present' : 'absent'}\n`;
    text += `Decrypt key:   ${vault.hasDecryptKey ? 'present (can decrypt locally)' : 'absent (deploy-only)'}\n`;
    if (vaultConfig.storageDir) text += `Config dir:    ${vaultConfig.storageDir}\n`;

    text += `\nSecrets (names only — values never shown):\n`;
    for (const s of vault.secrets) {
      const local = s.hasLocalOverride ? '  [local override]' : '';
      const alsoEnv = envKeys.has(s.name) ? '  [also in .env]' : '';
      const size = s.encryptedSize ? `  ${s.encryptedSize}B` : '';
      text += `  ${s.name}${local}${alsoEnv}${size}\n`;
    }

    const inBoth = vault.secrets.filter((s) => envKeys.has(s.name));
    if (inBoth.length > 0) {
      text += `\n⚠ ${inBoth.length} secret(s) also present as plain env vars — secrets take precedence:\n`;
      for (const s of inBoth) text += `  ${s.name}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSecretsVaultStats(appPath: string): McpToolResult {
  try {
    const prodVault = loadVaultInfo(appPath, 'prod');
    const devVault = loadVaultInfo(appPath, 'dev');
    const envKeys = readEnvKeys(appPath);

    let text = `Secrets Vault Statistics\n${'='.repeat(40)}\n\n`;

    if (!prodVault && !devVault) {
      text += 'No secrets vault found.\n';
      return { content: [{ type: 'text', text }] };
    }

    if (prodVault) {
      text += `Prod vault:\n`;
      text += `  Type:          ${prodVault.type}\n`;
      text += `  Secrets:       ${prodVault.secrets.length}\n`;
      text += `  Decrypt key:   ${prodVault.hasDecryptKey ? 'present' : 'absent'}\n`;
      text += `  Local overrides: ${prodVault.secrets.filter((s) => s.hasLocalOverride).length}\n`;
    }

    if (devVault) {
      text += `\nDev vault:\n`;
      text += `  Secrets:       ${devVault.secrets.length}\n`;
    }

    const allSecrets = [...new Set([
      ...(prodVault?.secrets.map((s) => s.name) ?? []),
      ...(devVault?.secrets.map((s) => s.name) ?? []),
    ])];

    const alsoInEnv = allSecrets.filter((n) => envKeys.has(n));
    if (alsoInEnv.length > 0) {
      text += `\n⚠ Secrets also in .env (${alsoInEnv.length}): ${alsoInEnv.join(', ')}\n`;
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

export function getSecretsVaultTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return [
    {
      name: 'list_secrets_vault',
      description: 'List Symfony secrets vault entries (names only, never values): vault type, key presence, local overrides, cross-reference with .env files',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Root path of the Symfony application' },
          env: { type: 'string', description: 'Environment to inspect (prod, dev, test). Defaults to prod.' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_secrets_vault_stats',
      description: 'Show secrets vault statistics: secret count per env, vault type, decrypt key presence, secrets that duplicate .env entries',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Root path of the Symfony application' },
        },
        required: ['app_path'],
      },
    },
  ];
}
