import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface AwsSecretsManagerInfo {
  source: string;
  type: 'rotation' | 'version' | 'cache' | 'hardcoded' | 'parse' | 'credentials';
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
  return value.replace(/([A-Za-z_][A-Za-z0-9_]*\s*=\s*)[^\s$#'"]{4,}/g, '$1***');
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

function buildAwsSecretsManagerInfos(appPath: string): AwsSecretsManagerInfo[] {
  const results: AwsSecretsManagerInfo[] = [];

  // Scan .env* files for AWS credentials and hardcoded secret ARNs
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    // AWS credentials in env files
    const secretKeyMatch = /AWS_SECRET_ACCESS_KEY\s*=\s*([^\n#]{1,200})/.exec(content);
    if (secretKeyMatch) {
      const raw = secretKeyMatch[1].trim();
      if (raw && !raw.startsWith('%env(') && !raw.startsWith('${')) {
        results.push({
          source: fname,
          type: 'credentials',
          detail: maskSecrets(`AWS_SECRET_ACCESS_KEY=${raw}`),
          issue: `AWS_SECRET_ACCESS_KEY in plaintext ${fname} — static AWS credentials should be replaced with IAM roles (EC2/ECS/Lambda) or OIDC identity federation to avoid rotation burden`,
        });
      }
    }

    // Hardcoded secret ARN in env file
    const arnMatch = /arn:aws:secretsmanager:[^:\s'"]{5,50}:[0-9]{12}:secret:[^\s'"]{5,100}/.exec(content);
    if (arnMatch) {
      results.push({
        source: fname,
        type: 'hardcoded',
        detail: `Hardcoded secret ARN in ${fname}: ${arnMatch[0]}`,
        issue: `Secret ARN hardcoded in ${fname} — store secret ARN or name in env var (e.g., AWS_SECRET_NAME) so it can be changed per environment without modifying source files`,
      });
    }

    // RotationEnabled: false in comments
    if (/RotationEnabled.*false/i.test(content) || /rotation.*disabled/i.test(content)) {
      results.push({
        source: fname,
        type: 'rotation',
        detail: 'RotationEnabled: false detected in env comments',
        issue: `${fname} indicates secret rotation is disabled — enable automatic rotation in AWS Secrets Manager to reduce exposure window if credentials are compromised`,
      });
    }
  }

  // Scan src/**/*.php for Secrets Manager patterns
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasSecretsManager = content.includes('SecretsManagerClient') || content.includes('GetSecretValue') || content.includes('getSecretValue') || content.includes('SecretsManager') || content.includes('secrets-manager');
    if (!hasSecretsManager) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    // Check for SecretCache / SecretsManagerCache usage
    const hasCache = content.includes('SecretCache') || content.includes('SecretsManagerCache') || content.includes('cache') || content.includes('Cache');
    if (!hasCache) {
      results.push({
        source: relFile,
        type: 'cache',
        detail: 'SecretsManagerClient without caching layer',
        issue: `${relFile} uses AWS Secrets Manager without SecretCache/SecretsManagerCache — each GetSecretValue call incurs latency and API cost; implement client-side caching with TTL to reduce overhead`,
      });
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // GetSecretValue without VersionStage AWSCURRENT
      if (line.includes('GetSecretValue') || line.includes('getSecretValue')) {
        const contextEnd = Math.min(lines.length - 1, i + 10);
        const context = lines.slice(i, contextEnd + 1).join('\n');
        const hasVersionStage = context.includes('VersionStage') || context.includes('version_stage') || context.includes('AWSCURRENT') || context.includes('AWSPREVIOUS');
        if (!hasVersionStage) {
          results.push({
            source: `${relFile}:${lineNum}`,
            type: 'version',
            detail: 'GetSecretValue without explicit VersionStage',
            issue: `GetSecretValue at ${relFile}:${lineNum} without VersionStage parameter — AWS defaults to AWSCURRENT but explicit specification prevents accidentally reading a previous version during rotation`,
          });
        }
      }

      // Secret value parsed without error handling (JSON parse without try/catch)
      if ((line.includes('json_decode') || line.includes('JSON.parse') || line.includes('json_decode(')) && content.includes('SecretString')) {
        const contextStart = Math.max(0, i - 3);
        const contextEnd = Math.min(lines.length - 1, i + 3);
        const context = lines.slice(contextStart, contextEnd + 1).join('\n');
        const hasTryCatch = context.includes('try') || context.includes('catch') || context.includes('@json_decode') || context.includes('JSON_THROW_ON_ERROR');
        if (!hasTryCatch) {
          results.push({
            source: `${relFile}:${lineNum}`,
            type: 'parse',
            detail: 'JSON parse of secret without error handling',
            issue: `json_decode of secret value at ${relFile}:${lineNum} without try/catch or JSON_THROW_ON_ERROR — malformed secrets cause silent null returns; use json_decode($value, true, 512, JSON_THROW_ON_ERROR) in a try/catch`,
          });
        }
      }

      // Secret ARN or name hardcoded in source
      const arnInCode = /['"]arn:aws:secretsmanager:[^'"]{10,}['"]/.exec(line);
      if (arnInCode) {
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'hardcoded',
          detail: `Hardcoded secret ARN in source: ${arnInCode[0]}`,
          issue: `Secret ARN hardcoded at ${relFile}:${lineNum} — use an environment variable reference (getenv('AWS_SECRET_NAME')) so the secret can be changed per environment`,
        });
      }

      // AWS credentials hardcoded in source
      if (/['"]aws_secret_access_key['"]\s*=>\s*['"][^'"]{10,}['"]/i.test(line) || /['"]secretAccessKey['"]\s*=>\s*['"][^'"]{10,}['"]/.test(line)) {
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'credentials',
          detail: maskSecrets(line.trim()),
          issue: `AWS credentials hardcoded at ${relFile}:${lineNum} — never embed AWS access keys in source code; use IAM roles or environment variables`,
        });
      }

      // RotationEnabled: false in config comments or SDK calls
      if (/RotationEnabled.*false/i.test(line) || /rotation_enabled.*false/i.test(line)) {
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'rotation',
          detail: 'RotationEnabled: false detected',
          issue: `${relFile}:${lineNum} indicates secret rotation is disabled — enable rotation in AWS Secrets Manager; use Lambda rotation function or Secrets Manager managed rotation for supported services`,
        });
      }
    }
  }

  // Scan config/**/*.yaml for Secrets Manager references
  const configDir = path.join(appPath, 'config');
  if (fs.existsSync(configDir)) {
    const configFiles = [
      ...scanDirRecursive(configDir, '.yaml'),
      ...scanDirRecursive(configDir, '.yml'),
    ];
    for (const fpath of configFiles) {
      const content = safeRead(fpath, appPath);
      if (!content) continue;
      if (!content.includes('secrets_manager') && !content.includes('SecretsManager') && !content.includes('secretsmanager')) continue;
      const relFile = path.relative(appPath, fpath);
      results.push({ source: relFile, type: 'hardcoded', detail: 'Secrets Manager reference in config YAML', issue: null });
    }
  }

  return results;
}

export function listAwsSecretsManager(appPath: string): McpToolResult {
  try {
    const infos = buildAwsSecretsManagerInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No AWS Secrets Manager patterns found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `AWS Secrets Manager Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
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

export function getAwsSecretsManagerStats(appPath: string): McpToolResult {
  try {
    const infos = buildAwsSecretsManagerInfos(appPath);
    let text = `AWS Secrets Manager Statistics\n${'='.repeat(40)}\n\n`;
    text += `Rotation issues:    ${infos.filter((i) => i.type === 'rotation').length}\n`;
    text += `Version issues:     ${infos.filter((i) => i.type === 'version').length}\n`;
    text += `Cache issues:       ${infos.filter((i) => i.type === 'cache').length}\n`;
    text += `Hardcoded refs:     ${infos.filter((i) => i.type === 'hardcoded').length}\n`;
    text += `Parse issues:       ${infos.filter((i) => i.type === 'parse').length}\n`;
    text += `Credential issues:  ${infos.filter((i) => i.type === 'credentials').length}\n`;
    text += `Total issues:       ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAwsSecretsManagerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_aws_secrets_manager',
      description: 'Scan src/**/*.php, config/**/*.yaml, .env* for AWS Secrets Manager patterns: RotationEnabled: false, GetSecretValue without VersionStage AWSCURRENT, missing SecretCache/SecretsManagerCache, hardcoded secret ARN or name, JSON parse without error handling, AWS credentials in source (masked).',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_aws_secrets_manager_stats',
      description: 'Statistics for AWS Secrets Manager: rotation/version/cache/hardcoded/parse/credentials issue counts.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
