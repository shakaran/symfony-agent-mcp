import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface VaultDynamicSecretInfo {
  source: string;
  type: 'static-creds' | 'lease' | 'token' | 'hardcoded-addr' | 'no-refresh';
  detail: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecrets(value: string): string {
  return value.replace(/(VAULT_TOKEN|password|secret|token|key)\s*=\s*\S+/gi, '$1=***');
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

function buildVaultDynamicSecretsInfos(appPath: string): VaultDynamicSecretInfo[] {
  const results: VaultDynamicSecretInfo[] = [];

  // Scan .env* files for Vault token in plaintext and VAULT_ADDR
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    // VAULT_TOKEN stored in plaintext .env
    const tokenMatch = /VAULT_TOKEN\s*=\s*([^\n#]{1,200})/.exec(content);
    if (tokenMatch) {
      const rawToken = tokenMatch[1].trim();
      if (rawToken && !rawToken.startsWith('%env(') && !rawToken.startsWith('${') && rawToken !== '') {
        results.push({
          source: fname,
          type: 'token',
          detail: maskSecrets(`VAULT_TOKEN=${rawToken}`),
          issue: `VAULT_TOKEN stored in plaintext ${fname} — static Vault tokens cannot be rotated automatically and are committed to version control risk; use AppRole auth or Kubernetes service account auth instead`,
        });
      }
    }

    // Missing VAULT_ADDR / VAULT_TOKEN env var reference — using hardcoded Vault URL in code
    const addrMatch = /VAULT_ADDR\s*=\s*([^\n#]{1,200})/.exec(content);
    if (addrMatch) {
      const addr = addrMatch[1].trim();
      const isHttpAddr = addr.startsWith('http://') || addr.startsWith('https://');
      const hasIpAddr = isHttpAddr && /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(addr);
      if (hasIpAddr) {
        results.push({
          source: fname,
          type: 'hardcoded-addr',
          detail: `VAULT_ADDR=${addr}`,
          issue: `VAULT_ADDR in ${fname} uses hardcoded IP address — use a DNS name or service discovery alias so the address survives infrastructure changes`,
        });
      } else {
        results.push({ source: fname, type: 'hardcoded-addr', detail: `VAULT_ADDR=${addr}`, issue: null });
      }
    }
  }

  // Scan config/**/*.yaml for static DB credentials instead of Vault dynamic secrets
  const configDir = path.join(appPath, 'config');
  if (fs.existsSync(configDir)) {
    const configFiles = [
      ...scanDirRecursive(configDir, '.yaml'),
      ...scanDirRecursive(configDir, '.yml'),
    ];
    for (const fpath of configFiles) {
      const content = safeRead(fpath, appPath);
      if (!content) continue;
      const relFile = path.relative(appPath, fpath);

      // Static credentials in config instead of Vault dynamic secrets
      const hasDbConfig = content.includes('database_url') || content.includes('DATABASE_URL') || content.includes('dbal:') || content.includes('doctrine:');
      const hasStaticUser = /(?:user|username)\s*:\s*(?!%env)[^\n%$]{3,50}/.exec(content);
      const hasStaticPass = /password\s*:\s*(?!%env|~|null|'')[^\n%$]{3,50}/.exec(content);
      const hasVaultRef = content.includes('vault') || content.includes('VAULT') || content.includes('%env(VAULT');

      if (hasDbConfig && hasStaticUser && hasStaticPass && !hasVaultRef) {
        results.push({
          source: relFile,
          type: 'static-creds',
          detail: `Static DB credentials detected in ${relFile}`,
          issue: `Static database credentials in ${relFile} instead of Vault dynamic secrets — use Vault database secrets engine to generate short-lived credentials and reference via %env(VAULT_DB_PASSWORD)%`,
        });
      }
    }
  }

  // Scan src/**/*.php for Vault usage patterns
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasVaultPkg = content.includes('VaultClient') || content.includes('vault') || content.includes('Vault');
    if (!hasVaultPkg) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Vault lease TTL not handled — no renewLease()/renewSelf() call
      if ((line.includes('->read(') || line.includes('->get(')) && content.includes('vault')) {
        const hasRenewal = content.includes('renewLease') || content.includes('renewSelf') || content.includes('renew') || content.includes('ttl') || content.includes('TTL');
        if (!hasRenewal) {
          results.push({
            source: `${relFile}:${lineNum}`,
            type: 'lease',
            detail: 'Vault secret read without lease renewal',
            issue: `Vault secret read at ${relFile}:${lineNum} without renewLease()/renewSelf() call — Vault dynamic secrets expire; implement lease renewal before TTL expiry to avoid runtime credential failures`,
          });
        }
      }

      // Missing VAULT_ADDR / VAULT_TOKEN env var reference — hardcoded Vault URL
      if (/new\s+VaultClient\s*\(/.test(line) || /VaultClient::create\s*\(/.test(line)) {
        const contextEnd = Math.min(lines.length - 1, i + 5);
        const context = lines.slice(i, contextEnd + 1).join('\n');
        const hasHardcodedUrl = context.includes("'http://") || context.includes("'https://") || context.includes('"http://') || context.includes('"https://');
        const usesEnvVar = context.includes('getenv(') || context.includes('$_ENV[') || context.includes('$_SERVER[') || context.includes('env(');
        if (hasHardcodedUrl && !usesEnvVar) {
          results.push({
            source: `${relFile}:${lineNum}`,
            type: 'hardcoded-addr',
            detail: 'Hardcoded Vault URL in VaultClient instantiation',
            issue: `VaultClient at ${relFile}:${lineNum} uses hardcoded Vault URL — use VAULT_ADDR environment variable so the address can change without code modification`,
          });
        }
      }

      // vault/ package used without TTL-aware credential refresh
      if (content.includes('vault-php') || content.includes('jippi/php-vault')) {
        const hasCredRefresh = content.includes('refresh') || content.includes('renew') || content.includes('ttl') || content.includes('TTL') || content.includes('lease');
        if (!hasCredRefresh && (line.includes('VaultClient') || line.includes('vault-php'))) {
          results.push({
            source: `${relFile}:${lineNum}`,
            type: 'no-refresh',
            detail: 'Vault package used without TTL-aware credential refresh',
            issue: `vault-php package at ${relFile}:${lineNum} without TTL-aware refresh — implement credential refresh using lease TTL from Vault response to prevent using expired dynamic credentials`,
          });
        }
      }
    }
  }

  return results;
}

export function listVaultDynamicSecrets(appPath: string): McpToolResult {
  try {
    const infos = buildVaultDynamicSecretsInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Vault dynamic secrets patterns found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Vault Dynamic Secrets Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  ${info.source}\n`;
      text += `    ${info.detail}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getVaultDynamicSecretsStats(appPath: string): McpToolResult {
  try {
    const infos = buildVaultDynamicSecretsInfos(appPath);
    let text = `Vault Dynamic Secrets Statistics\n${'='.repeat(40)}\n\n`;
    text += `Static creds:     ${infos.filter((i) => i.type === 'static-creds').length}\n`;
    text += `Lease issues:     ${infos.filter((i) => i.type === 'lease').length}\n`;
    text += `Token in .env:    ${infos.filter((i) => i.type === 'token').length}\n`;
    text += `Hardcoded addr:   ${infos.filter((i) => i.type === 'hardcoded-addr').length}\n`;
    text += `No refresh:       ${infos.filter((i) => i.type === 'no-refresh').length}\n`;
    text += `Total issues:     ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getVaultDynamicSecretsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_vault_dynamic_secrets',
      description: 'Scan src/**/*.php, config/**/*.yaml, .env* for HashiCorp Vault dynamic secrets patterns: static credentials instead of Vault dynamic secrets, missing lease TTL renewal (renewLease/renewSelf), VAULT_TOKEN in plaintext .env (masked), hardcoded Vault URL instead of VAULT_ADDR env var, vault/ package without TTL-aware credential refresh.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_vault_dynamic_secrets_stats',
      description: 'Statistics for Vault dynamic secrets: static-creds/lease/token/hardcoded-addr/no-refresh issue counts.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
