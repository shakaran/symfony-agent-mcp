import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface VaultIntegrationInfo {
  file: string;
  type: 'kv' | 'transit' | 'pki' | 'auth' | 'config';
  path: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecrets(val: string): string {
  return val.replace(/(?<=[=:]\s*)[a-zA-Z0-9_-]{20,}/g, '***');
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildVaultIntegrationInfos(appPath: string): VaultIntegrationInfo[] {
  const results: VaultIntegrationInfo[] = [];

  // Check composer.json for Vault packages
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (composerContent.includes('vault-php/vault')) {
      results.push({ file: 'composer.json', type: 'config', path: 'sdk:vault-php/vault', issues: [] });
    }
    if (composerContent.includes('jippi/php-vault')) {
      results.push({ file: 'composer.json', type: 'config', path: 'sdk:jippi/php-vault', issues: [] });
    }
  }

  // Scan .env* for Vault credentials
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const addrMatch = /VAULT_ADDR\s*=\s*([^\n]+)/.exec(content);
    const tokenMatch = /VAULT_TOKEN\s*=\s*([^\n]+)/.exec(content);
    const roleIdMatch = /VAULT_ROLE_ID\s*=\s*([^\n]+)/.exec(content);
    const secretIdMatch = /VAULT_SECRET_ID\s*=\s*([^\n]+)/.exec(content);

    if (addrMatch) {
      const addr = addrMatch[1].trim();
      const issues: string[] = [];
      if (addr.startsWith('http://') && !addr.includes('localhost') && !addr.includes('127.0.0.1')) {
        issues.push(`VAULT_ADDR uses HTTP (non-TLS) in ${fname} for non-localhost — Vault must use TLS in production; set VAULT_ADDR to an https:// address`);
      }
      results.push({ file: fname, type: 'config', path: maskSecrets(`VAULT_ADDR=${addr}`), issues });
    }

    if (tokenMatch) {
      const rawToken = tokenMatch[1].trim();
      const issues: string[] = [];
      if (rawToken && !rawToken.startsWith('%env(') && !rawToken.startsWith('${') && rawToken !== '') {
        issues.push(`VAULT_TOKEN in ${fname} — root/static tokens in .env are a security risk; use AppRole (VAULT_ROLE_ID + VAULT_SECRET_ID) or Kubernetes auth instead; tokens in .env cannot be rotated automatically`);
      }
      // M-17: always fully redact VAULT_TOKEN (maskSecrets requires 20+ chars, missing short tokens like hvs.abc123)
      const display = /token|secret|key|pass|auth/i.test('VAULT_TOKEN') ? 'VAULT_TOKEN=***' : maskSecrets(`VAULT_TOKEN=${rawToken}`);
      results.push({ file: fname, type: 'auth', path: display, issues });
    }

    if (roleIdMatch) {
      results.push({ file: fname, type: 'auth', path: 'VAULT_ROLE_ID=***', issues: [] });
    }

    if (secretIdMatch) {
      results.push({ file: fname, type: 'auth', path: 'VAULT_SECRET_ID=***', issues: [] });
    }
  }

  // Check config/ for vault-related service definitions
  const configDir = path.join(appPath, 'config');
  if (fs.existsSync(configDir)) {
    const configFiles = [
      ...scanDirRecursive(path.join(configDir, 'packages'), '.yaml'),
      ...scanDirRecursive(path.join(configDir, 'packages'), '.yml'),
      ...scanDirRecursive(path.join(configDir, 'services'), '.yaml'),
      ...scanDirRecursive(path.join(configDir, 'services'), '.yml'),
    ];
    const servicesPath = path.join(configDir, 'services.yaml');
    const servicesContent = safeRead(servicesPath, appPath);
    if (servicesContent && (servicesContent.includes('vault') || servicesContent.includes('Vault'))) {
      const relFile = path.relative(appPath, servicesPath);
      results.push({ file: relFile, type: 'config', path: 'services.yaml vault config', issues: [] });
    }
    for (const f of configFiles) {
      const content = safeRead(f, appPath);
      if (!content) continue;
      if (!content.includes('vault') && !content.includes('Vault')) continue;
      const relFile = path.relative(appPath, f);
      results.push({ file: relFile, type: 'config', path: relFile, issues: [] });
    }
  }

  // Scan src/**/*.php for Vault usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('VaultClient') &&
      !content.includes('->kv()->read(') &&
      !content.includes('->sys()->health(') &&
      !content.includes('AppRoleAuth') &&
      !content.includes('vault')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    // Missing TLS verification
    if (content.includes('VaultClient') || content.includes('vault')) {
      const hasTlsVerify = content.includes('verify') || content.includes('ssl') || content.includes('tls') || content.includes('VAULT_CACERT');
      if (!hasTlsVerify) {
        issues.push(`Vault client in ${relFile} without explicit TLS verification — ensure SSL/TLS certificate verification is enabled; do not set verify=false in production`);
      }
    }

    // No token renewal
    const hasTokenUsage = content.includes('VAULT_TOKEN') || content.includes('token');
    if (hasTokenUsage && !content.includes('renew') && !content.includes('Renew') && !content.includes('ttl')) {
      issues.push(`Vault token usage in ${relFile} without renewal logic — implement token renewal before expiry using token TTL awareness; expired tokens will cause runtime failures`);
    }

    const type: VaultIntegrationInfo['type'] = content.includes('->kv()->') ? 'kv'
      : content.includes('transit') || content.includes('Transit') ? 'transit'
      : content.includes('pki') || content.includes('PKI') ? 'pki'
      : content.includes('AppRoleAuth') || content.includes('auth') ? 'auth'
      : 'config';

    const vaultPathM = /['"]secret\/([a-zA-Z0-9/_-]{1,100})['"]/.exec(content)
      ?? /['"]([a-zA-Z0-9/_-]{1,100})['"]/.exec(content);
    const vaultPath = vaultPathM ? vaultPathM[1] : relFile;

    results.push({ file: relFile, type, path: vaultPath, issues });
  }

  return results;
}

export function listVaultIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildVaultIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No HashiCorp Vault integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Vault Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.path}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getVaultIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildVaultIntegrationInfos(appPath);
    let text = `Vault Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `KV patterns:      ${infos.filter((i) => i.type === 'kv').length}\n`;
    text += `Transit patterns: ${infos.filter((i) => i.type === 'transit').length}\n`;
    text += `PKI patterns:     ${infos.filter((i) => i.type === 'pki').length}\n`;
    text += `Auth patterns:    ${infos.filter((i) => i.type === 'auth').length}\n`;
    text += `Config patterns:  ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getVaultIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_vault_integration',
      description: 'Analyze HashiCorp Vault integration: detect composer packages (vault-php/vault, jippi/php-vault), env credentials (VAULT_ADDR/TOKEN/ROLE_ID/SECRET_ID), config/ service definitions, PHP VaultClient/kv/sys/AppRoleAuth usage, flag VAULT_TOKEN in .env (use approle/k8s auth), missing TLS verification, no token renewal',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_vault_integration_stats',
      description: 'Statistics for Vault integration: kv/transit/pki/auth/config pattern counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
