import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface AwsParameterStoreInfo {
  source: string;
  type: 'decryption' | 'hardcoded' | 'kms' | 'naming' | 'batch' | 'credentials';
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
  return value
    .replace(/([A-Za-z_][A-Za-z0-9_]*\s*=\s*)[^\s$#'"]{4,}/g, '$1***')
    .replace(/(['"][A-Za-z_][A-Za-z0-9_]*['"]\s*=>\s*['"])[^'"]{4,}(['"])/g, '$1***$2');
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

function buildAwsParameterStoreInfos(appPath: string): AwsParameterStoreInfo[] {
  const results: AwsParameterStoreInfo[] = [];

  // Scan .env* files for SSM credentials in plaintext
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    // SSM credentials in source code
    const secretKeyMatch = /AWS_SECRET_ACCESS_KEY\s*=\s*([^\n#]{1,200})/.exec(content);
    if (secretKeyMatch) {
      const raw = secretKeyMatch[1].trim();
      if (raw && !raw.startsWith('%env(') && !raw.startsWith('${')) {
        results.push({
          source: fname,
          type: 'credentials',
          detail: maskSecrets(`AWS_SECRET_ACCESS_KEY=${raw}`),
          issue: `AWS_SECRET_ACCESS_KEY in ${fname} — hardcoded AWS credentials in env files risk exposure; use IAM roles (EC2/ECS/Lambda instance roles) or AWS SSO instead of static access keys`,
        });
      }
    }

    const accessKeyMatch = /AWS_ACCESS_KEY_ID\s*=\s*([^\n#]{1,200})/.exec(content);
    if (accessKeyMatch) {
      const raw = accessKeyMatch[1].trim();
      if (raw && !raw.startsWith('%env(') && !raw.startsWith('${')) {
        results.push({
          source: fname,
          type: 'credentials',
          detail: maskSecrets(`AWS_ACCESS_KEY_ID=${raw}`),
          issue: `AWS_ACCESS_KEY_ID in ${fname} — use IAM instance roles or OIDC federation instead of static access keys to eliminate credential rotation burden`,
        });
      }
    }
  }

  // Scan src/**/*.php for SSM Parameter Store patterns
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasSsm = content.includes('SsmClient') || content.includes('GetParameter') || content.includes('GetParameters') || content.includes('ssm') || content.includes('ParameterStore');
    if (!hasSsm) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // GetParameter with WithDecryption: false on SecureString
      if (line.includes('GetParameter') || line.includes('getParameter')) {
        const contextEnd = Math.min(lines.length - 1, i + 10);
        const context = lines.slice(i, contextEnd + 1).join('\n');
        const hasWithDecryptionFalse = /WithDecryption.*false/i.test(context) || /with_decryption.*false/i.test(context);
        if (hasWithDecryptionFalse) {
          results.push({
            source: `${relFile}:${lineNum}`,
            type: 'decryption',
            detail: 'GetParameter with WithDecryption: false',
            issue: `GetParameter at ${relFile}:${lineNum} uses WithDecryption: false — SecureString parameters will be returned encrypted; set WithDecryption: true to decrypt KMS-encrypted parameters`,
          });
        }
      }

      // Parameter name hardcoded instead of env var reference
      if ((line.includes('GetParameter') || line.includes('getParameter')) && (line.includes("'Name'") || line.includes('"Name"'))) {
        const contextEnd = Math.min(lines.length - 1, i + 5);
        const context = lines.slice(i, contextEnd + 1).join('\n');
        const hasHardcodedParam = /['"]Name['"]\s*=>\s*['"][^'"$%{]{5,}['"]/.test(context);
        const usesEnvVar = context.includes('getenv(') || context.includes('$_ENV[') || context.includes('$_SERVER[') || context.includes('env(');
        if (hasHardcodedParam && !usesEnvVar) {
          results.push({
            source: `${relFile}:${lineNum}`,
            type: 'hardcoded',
            detail: 'Parameter name hardcoded in GetParameter call',
            issue: `GetParameter at ${relFile}:${lineNum} uses hardcoded parameter name — store the SSM parameter path in an environment variable (e.g., SSM_PARAM_NAME) for environment-specific configuration`,
          });
        }
      }

      // Batch GetParameters not used (multiple individual GetParameter calls)
      if (line.includes('GetParameter') && !line.includes('GetParameters')) {
        const surroundingStart = Math.max(0, i - 20);
        const surroundingEnd = Math.min(lines.length - 1, i + 20);
        const surrounding = lines.slice(surroundingStart, surroundingEnd + 1).join('\n');
        const getParamCount = (surrounding.match(/GetParameter\b(?!s)/g) ?? []).length;
        if (getParamCount >= 3) {
          results.push({
            source: `${relFile}:${lineNum}`,
            type: 'batch',
            detail: `Multiple individual GetParameter calls detected (${getParamCount} in nearby lines)`,
            issue: `${relFile}:${lineNum} makes multiple individual GetParameter calls — use GetParameters (batch) to fetch up to 10 parameters in one API call, reducing latency and API costs`,
          });
        }
      }

      // SSM credentials in source code
      if (/['"]aws_secret_access_key['"]\s*=>\s*['"][^'"]{10,}['"]/i.test(line) || /['"]secretAccessKey['"]\s*=>\s*['"][^'"]{10,}['"]/.test(line)) {
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'credentials',
          detail: maskSecrets(line.trim()),
          issue: `AWS credentials hardcoded at ${relFile}:${lineNum} — never embed AWS access keys in source code; use IAM roles, environment variables, or AWS credentials file`,
        });
      }
    }

    // Missing KMS key alias for SecureString — uses default aws/ssm
    if (content.includes('SecureString') && !content.includes('alias/') && !content.includes('KmsKeyId') && !content.includes('kms_key')) {
      results.push({
        source: relFile,
        type: 'kms',
        detail: 'SecureString without custom KMS key alias',
        issue: `${relFile} uses SecureString parameters without specifying a custom KMS key — the default aws/ssm key is shared across all SSM parameters in the account; use a customer-managed KMS key (alias/) for better key policy control`,
      });
    }

    // Parameter path not following naming convention /app/env/param
    const paramPathPattern = /['"][/][^/'"]{1,50}['"]/.exec(content);
    if (paramPathPattern) {
      const paramPath = paramPathPattern[0].replace(/['"]/g, '');
      const parts = paramPath.split('/').filter((p) => p.length > 0);
      if (parts.length < 3) {
        results.push({
          source: relFile,
          type: 'naming',
          detail: `Parameter path "${paramPath}" has only ${parts.length} level(s)`,
          issue: `SSM parameter path "${paramPath}" in ${relFile} does not follow /app/env/param naming convention — use at least 3 path levels (e.g., /myapp/prod/database-password) for proper namespace isolation`,
        });
      }
    }
  }

  // Scan config/**/*.yaml for SSM references
  const configDir = path.join(appPath, 'config');
  if (fs.existsSync(configDir)) {
    const configFiles = [
      ...scanDirRecursive(configDir, '.yaml'),
      ...scanDirRecursive(configDir, '.yml'),
    ];
    for (const fpath of configFiles) {
      const content = safeRead(fpath, appPath);
      if (!content) continue;
      if (!content.includes('ssm') && !content.includes('parameter_store') && !content.includes('ParameterStore')) continue;
      const relFile = path.relative(appPath, fpath);
      results.push({ source: relFile, type: 'hardcoded', detail: 'SSM reference in config YAML', issue: null });
    }
  }

  return results;
}

export function listAwsParameterStore(appPath: string): McpToolResult {
  try {
    const infos = buildAwsParameterStoreInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No AWS SSM Parameter Store patterns found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `AWS SSM Parameter Store Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
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

export function getAwsParameterStoreStats(appPath: string): McpToolResult {
  try {
    const infos = buildAwsParameterStoreInfos(appPath);
    let text = `AWS SSM Parameter Store Statistics\n${'='.repeat(40)}\n\n`;
    text += `Decryption issues:  ${infos.filter((i) => i.type === 'decryption').length}\n`;
    text += `Hardcoded params:   ${infos.filter((i) => i.type === 'hardcoded').length}\n`;
    text += `KMS issues:         ${infos.filter((i) => i.type === 'kms').length}\n`;
    text += `Naming issues:      ${infos.filter((i) => i.type === 'naming').length}\n`;
    text += `Batch issues:       ${infos.filter((i) => i.type === 'batch').length}\n`;
    text += `Credential issues:  ${infos.filter((i) => i.type === 'credentials').length}\n`;
    text += `Total issues:       ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAwsParameterStoreTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_aws_parameter_store',
      description: 'Scan src/**/*.php, config/**/*.yaml, .env* for AWS SSM Parameter Store patterns: GetParameter with WithDecryption: false on SecureString, hardcoded parameter name (not env var), missing custom KMS key alias (uses default aws/ssm), parameter path not following /app/env/param convention, multiple individual GetParameter calls instead of batch GetParameters, AWS credentials in source (masked).',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_aws_parameter_store_stats',
      description: 'Statistics for AWS SSM Parameter Store: decryption/hardcoded/kms/naming/batch/credentials issue counts.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
