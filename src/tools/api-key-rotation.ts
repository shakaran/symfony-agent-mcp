import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecrets(value: string): string {
  return value.replace(/([A-Za-z_][A-Za-z0-9_]*\s*=\s*)[^\s$#'"]{4,}/g, '$1***');
}


interface ApiKeyRotationInfo {
  file: string;
  type: 'hardcoded' | 'versioned' | 'rotation' | 'storage' | 'config';
  directive: string;
  value: string;
  issues: string[];
}

function buildApiKeyRotationInfos(appPath: string): ApiKeyRotationInfo[] {
  const results: ApiKeyRotationInfo[] = [];

  const envFiles = [
    path.join(appPath, '.env'),
    path.join(appPath, '.env.local'),
    path.join(appPath, '.env.prod'),
    path.join(appPath, '.env.staging'),
  ];

  const keyPatterns = [
    { name: 'APP_SECRET', minLength: 32 },
    { name: 'JWT_PASSPHRASE', minLength: 16 },
    { name: 'MAILER_DSN', minLength: 20 },
    { name: 'DATABASE_URL', minLength: 20 },
  ];

  for (const envFile of envFiles) {
    if (!fs.existsSync(envFile)) continue;
    let content = '';
    try { content = fs.readFileSync(envFile, 'utf-8'); } catch { continue; }
    const relFile = path.relative(appPath, envFile);

    for (const pattern of keyPatterns) {
      const match = new RegExp(`${pattern.name}\\s*=\\s*([^\\n]+)`).exec(content);
      if (!match) continue;
      const value = match[1].trim();
      const isEnvRef = value.startsWith('$') || value.startsWith('%env(') || value === '';

      if (!isEnvRef && value.length >= pattern.minLength) {
        const issues: string[] = [];
        if (envFile.endsWith('.env') && !envFile.endsWith('.env.local')) {
          issues.push(`${pattern.name} hardcoded in "${relFile}" — .env files are committed to git; store secrets in .env.local (gitignored) or use a secret manager (Vault, AWS SSM, SOPS)`);
        }
        results.push({ file: relFile, type: 'hardcoded', directive: pattern.name, value: maskSecrets(`${pattern.name}=${value}`), issues });
      }
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            const content = safeRead(full, appPath);
            if (content === null) return;
            if (!content.includes('api_key') && !content.includes('apiKey') && !content.includes('API_KEY') && !content.includes('token') && !content.includes('accessToken')) return;

            const relFile = path.relative(appPath, full);
            const issues: string[] = [];

            const hasKeyVersioning = content.includes('key_id') || content.includes('keyId') || content.includes('kid') || content.includes('version');
            const hasKeyComparison = content.includes('hash_equals(') || content.includes('timingSafeEqual') || content.includes('sodium_compare');
            const hasInsecureComparison = content.includes('=== $apiKey') || content.includes('== $apiKey') || content.includes('=== $token') || content.includes('== $token');

            if (hasInsecureComparison && !hasKeyComparison) {
              issues.push(`API key comparison in "${relFile}" without timing-safe compare — direct string comparison leaks timing information; use hash_equals() to prevent timing attacks`);
            }

            if (!hasKeyVersioning && (content.includes('getApiKey()') || content.includes('api_keys') || content.includes('ApiKeyAuthenticator'))) {
              issues.push(`API key system in "${relFile}" without key versioning (kid/keyId) — add a key identifier so old keys can be invalidated without immediate breakage during key rotation`);
            }

            const hasExpiry = content.includes('expiresAt') || content.includes('expires_at') || content.includes('validUntil') || content.includes('KeyExpiredException');
            if (!hasExpiry && (content.includes('ApiKeyAuthenticator') || content.includes('api_key'))) {
              issues.push(`API key in "${relFile}" without expiry — non-expiring keys are a persistent credential risk; add expiresAt field to ApiKey entity and reject expired keys`);
            }

            if (issues.length > 0) {
              results.push({ file: relFile, type: 'rotation', directive: 'API key handling', value: 'PHP code', issues });
            }
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listApiKeyRotation(appPath: string): McpToolResult {
  try {
    const infos = buildApiKeyRotationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No API key rotation issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `API Key Rotation Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiKeyRotationStats(appPath: string): McpToolResult {
  try {
    const infos = buildApiKeyRotationInfos(appPath);
    let text = `API Key Rotation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Hardcoded:   ${infos.filter((i) => i.type === 'hardcoded').length}\n`;
    text += `Rotation:    ${infos.filter((i) => i.type === 'rotation').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiKeyRotationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_key_rotation', description: 'Analyze API key rotation and lifecycle management; warns on hardcoded keys in committed .env, non-timing-safe comparison, no key versioning for rotation, API keys without expiry field', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_key_rotation_stats', description: 'Statistics for API key rotation: hardcoded/rotation count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
