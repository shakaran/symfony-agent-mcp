import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SecretsRotationInfo {
  secret: string;
  source: string;
  type: 'vault' | 'env' | 'config' | 'rotation-hint' | 'issue';
  issues: string[];
}

const SENSITIVE_ENV_PATTERNS = [
  'APP_SECRET', 'DATABASE_URL', 'MAILER_DSN', 'REDIS_URL',
  'JWT_SECRET', 'JWT_PRIVATE_KEY', 'OAUTH_CLIENT_SECRET', 'STRIPE_SECRET',
  'AWS_SECRET_ACCESS_KEY', 'API_KEY', 'DD_API_KEY', 'SENTRY_DSN',
  'TWILIO_AUTH_TOKEN', 'PUSHER_APP_SECRET', 'WEBHOOK_SECRET',
  'AUTH_TOKEN', 'PRIVATE_KEY', 'SSL_CERT', 'TLS_CERT', 'CLIENT_SECRET',
];

function buildSecretsRotationInfos(appPath: string): SecretsRotationInfo[] {
  const results: SecretsRotationInfo[] = [];

  const vaultDir = path.join(appPath, 'config', 'secrets');
  const prodVaultDir = path.join(appPath, 'config', 'secrets', 'prod');
  const devVaultDir = path.join(appPath, 'config', 'secrets', 'dev');

  const hasVault = fs.existsSync(vaultDir);
  const hasProdVault = fs.existsSync(prodVaultDir);

  if (hasVault) {
    const decryptKeyPath = path.join(appPath, 'config', 'secrets', 'prod', 'prod.decrypt.private.php');
    const encryptKeyPath = path.join(appPath, 'config', 'secrets', 'prod', 'prod.encrypt.public.php');

    if (fs.existsSync(decryptKeyPath)) {
      results.push({ secret: 'prod.decrypt.private.php', source: 'config/secrets/prod/', type: 'issue', issues: ['prod.decrypt.private.php is committed to the repository — decrypt key grants access to ALL secrets; use an environment variable or secret manager instead, and remove from git history'] });
    }

    if (hasProdVault) {
      let encryptedFiles: string[] = [];
      try { encryptedFiles = fs.readdirSync(prodVaultDir); } catch { /* skip */ }
      for (const f of encryptedFiles) {
        if (f.endsWith('.php') && !f.includes('decrypt')) {
          const secretName = f.replace(/\.php$/, '');
          results.push({ secret: secretName, source: `config/secrets/prod/${f}`, type: 'vault', issues: [] });
        }
      }
    }

    if (fs.existsSync(devVaultDir) && hasProdVault) {
      let devFiles: string[] = [];
      try { devFiles = fs.readdirSync(devVaultDir); } catch { /* skip */ }
      let prodFiles: string[] = [];
      try { prodFiles = fs.readdirSync(prodVaultDir); } catch { /* skip */ }

      const devSecrets = new Set(devFiles.map((f) => f.replace(/\.php$/, '')));
      const prodSecrets = new Set(prodFiles.map((f) => f.replace(/\.php$/, '')));

      for (const s of devSecrets) {
        if (!prodSecrets.has(s) && !s.includes('encrypt') && !s.includes('decrypt')) {
          results.push({ secret: s, source: 'config/secrets/dev/', type: 'issue', issues: [`Secret "${s}" exists in dev vault but not in prod vault — prod vault may be missing this secret, causing runtime errors`] });
        }
      }
    }

    if (!fs.existsSync(encryptKeyPath)) {
      results.push({ secret: 'prod.encrypt.public.php', source: 'config/secrets/prod/', type: 'issue', issues: ['prod.encrypt.public.php not found — cannot add new secrets to prod vault without the public key; commit only the PUBLIC key (never the private)'] });
    }
  }

  const envFiles = ['.env', '.env.local', '.env.production', '.env.prod'];
  for (const envFile of envFiles) {
    const envPath = path.join(appPath, envFile);
    if (!fs.existsSync(envPath)) continue;
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf-8'); } catch { continue; }

    for (const envVar of SENSITIVE_ENV_PATTERNS) {
      const lineMatch = content.split('\n').find((l) => l.startsWith(envVar + '=') && !l.includes('!'));
      if (!lineMatch) continue;
      const value = lineMatch.split('=').slice(1).join('=').trim();
      const issues: string[] = [];

      if (value && !value.startsWith('${') && !value.startsWith('%')) {
        if (envFile !== '.env.local') {
          issues.push(`Secret "${envVar}" has a literal value in ${envFile} — only placeholder values (like "changeme") should appear here; real values go in .env.local (not committed) or a secret manager`);
        }
        if (value.toLowerCase().includes('changeme') || value.toLowerCase().includes('secret') || value === '""' || value === "''") {
          issues.push(`Secret "${envVar}" has a weak/placeholder value (redacted) in ${envFile} — replace before deploying`);
        }
      }

      if (!hasVault) {
        results.push({ secret: envVar, source: envFile, type: 'env', issues });
      }
    }
  }

  const gitignorePath = path.join(appPath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    let gitignore = '';
    try { gitignore = fs.readFileSync(gitignorePath, 'utf-8'); } catch { /* skip */ }
    if (!gitignore.includes('.env.local') && !gitignore.includes('*.local')) {
      results.push({ secret: '.env.local', source: '.gitignore', type: 'issue', issues: ['.env.local is not in .gitignore — local secrets could be accidentally committed; add ".env.local" to .gitignore'] });
    }
    if (hasVault && !gitignore.includes('decrypt.private')) {
      results.push({ secret: 'decrypt.private', source: '.gitignore', type: 'issue', issues: ['Symfony secrets vault detected but decrypt.private.php is not in .gitignore — add "**/decrypt.private.php" to .gitignore to prevent accidental commit of the decrypt key'] });
    }
  }

  if (!hasVault && results.length === 0) {
    results.push({ secret: 'symfony/secrets', source: 'config/', type: 'issue', issues: ['No Symfony secrets vault found (config/secrets/) — consider using "bin/console secrets:set" to manage encrypted production secrets instead of .env files'] });
  }

  return results;
}

export function listSymfonySecretsRotation(appPath: string): McpToolResult {
  try {
    const infos = buildSecretsRotationInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Secrets Rotation Analysis\n${'='.repeat(55)}\n\nSecrets: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      const label = info.issues.length > 0 ? 'ISSUE' : info.type.toUpperCase();
      text += `\n  [${label}] ${info.secret}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySecretsRotationStats(appPath: string): McpToolResult {
  try {
    const infos = buildSecretsRotationInfos(appPath);
    const vaultSecrets = infos.filter((i) => i.type === 'vault').length;
    const envSecrets = infos.filter((i) => i.type === 'env').length;
    let text = `Secrets Rotation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Vault secrets: ${vaultSecrets}\n`;
    text += `Env secrets:   ${envSecrets}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySecretsRotationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_secrets_rotation', description: 'Audit Symfony secrets vault and .env files; warns on committed decrypt key, missing secrets in prod vault, literal values in .env, placeholder secrets, .env.local not in .gitignore, no vault configured', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_secrets_rotation_stats', description: 'Statistics for secrets: vault secret count, env secret count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
