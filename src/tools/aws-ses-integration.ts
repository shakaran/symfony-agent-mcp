import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface AwsSesIntegrationInfo {
  source: string;
  type: 'dsn' | 'env' | 'php' | 'config';
  value: string;
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

function maskDsn(dsn: string): string {
  return dsn
    .replace(/(ses\+(?:smtp|api|https):\/\/)[^@\s]{1,200}@/g, '$1***@')
    .replace(/(ses\+(?:smtp|api|https):\/\/)[^\s]{1,200}/g, '$1***');
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

function buildAwsSesIntegrationInfos(appPath: string): AwsSesIntegrationInfo[] {
  const results: AwsSesIntegrationInfo[] = [];

  // Scan .env* config files
  const envFiles = ['.env', '.env.local', '.env.prod'];
  let foundSesDsn = false;
  let usingSMTP = false;
  let hasSnsOrSqs = false;

  for (const fname of envFiles) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    // Detect MAILER_DSN with SES
    const mailerDsnMatch = /MAILER_DSN\s*=\s*([^\n]{1,300})/.exec(content);
    if (mailerDsnMatch) {
      const dsn = mailerDsnMatch[1].trim();
      if (/ses\+(?:smtp|api|https):\/\//.test(dsn)) {
        foundSesDsn = true;
        const masked = maskDsn(dsn);
        let issue: string | null = null;
        if (/ses\+smtp:\/\//.test(dsn)) {
          usingSMTP = true;
          issue = `ses+smtp:// found in ${fname} — uses SMTP with username/password credentials; prefer ses+api:// with IAM role (instance profile) for better security and performance`;
        }
        results.push({ source: fname, type: 'dsn', value: `MAILER_DSN=${masked}`, issue });
      }
    }

    // Detect mailer.dsn in YAML-like inline env
    const mailerDsnYamlMatch = /mailer\.dsn\s*:\s*([^\n]{1,300})/.exec(content);
    if (mailerDsnYamlMatch) {
      const dsn = mailerDsnYamlMatch[1].trim();
      if (/ses\+(?:smtp|api|https):\/\//.test(dsn)) {
        foundSesDsn = true;
        results.push({ source: fname, type: 'dsn', value: `mailer.dsn=${maskDsn(dsn)}`, issue: null });
      }
    }

    // Detect AWS_SES_* env vars
    const awsSesPattern = /^(AWS_SES_[A-Z0-9_]{1,60})\s*=\s*([^\n]{1,200})/gm;
    let m: RegExpExecArray | null;
    while ((m = awsSesPattern.exec(content)) !== null) {
      const varName = m[1];
      const rawVal = m[2].trim();
      const masked = maskSecrets(`${varName}=${rawVal}`);
      results.push({
        source: fname,
        type: 'env',
        value: masked,
        issue: `${varName} present in ${fname} — inject via CI/CD secrets manager; never commit AWS credentials to version control`,
      });
    }

    // Check for SNS/SQS topics (bounce/complaint handler)
    if (/SNS_TOPIC|SQS_QUEUE|sns\.amazonaws|sqs\.amazonaws/.test(content)) {
      hasSnsOrSqs = true;
    }

    // Check APP_ENV=prod
    if (/APP_ENV\s*=\s*prod/.test(content) && foundSesDsn) {
      results.push({
        source: fname,
        type: 'config',
        value: 'APP_ENV=prod with SES configured',
        issue: 'APP_ENV=prod with SES detected — verify SES domain/email is verified and account is out of sandbox mode; sandbox limits sending to verified addresses only',
      });
    }
  }

  // Check config/packages/mailer.yaml
  const mailerYamlPath = path.join(appPath, 'config', 'packages', 'mailer.yaml');
  const mailerYamlContent = safeRead(mailerYamlPath, appPath);
  if (mailerYamlContent) {
    const dsnMatch = /dsn\s*:\s*([^\n]{1,300})/.exec(mailerYamlContent);
    if (dsnMatch) {
      const dsn = dsnMatch[1].trim();
      if (/ses\+(?:smtp|api|https):\/\//.test(dsn)) {
        foundSesDsn = true;
        results.push({
          source: 'config/packages/mailer.yaml',
          type: 'config',
          value: `dsn: ${maskDsn(dsn)}`,
          issue: /ses\+smtp:\/\//.test(dsn)
            ? 'ses+smtp:// in mailer.yaml — prefer ses+api:// with IAM role for better security'
            : null,
        });
      }
    }

    if (/sns_topic|sqs_queue|bounce.*handler|complaint.*handler/.test(mailerYamlContent)) {
      hasSnsOrSqs = true;
    }
  }

  // Flag missing bounce/complaint handler
  if (foundSesDsn && !hasSnsOrSqs) {
    results.push({
      source: 'config',
      type: 'config',
      value: 'bounce/complaint handler',
      issue: 'SES configured but no SNS/SQS bounce or complaint handler detected — AWS requires handling bounces and complaints to maintain sender reputation; configure SNS topic for SES notifications',
    });
  }

  // Flag SMTP vs API
  if (usingSMTP && foundSesDsn) {
    results.push({
      source: 'config',
      type: 'config',
      value: 'transport type',
      issue: 'ses+smtp:// transport is slower than ses+api:// — ses+api:// uses AWS SDK directly with IAM role authentication and avoids SMTP credential management',
    });
  }

  // Scan src/**/*.php
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('SesClient') &&
      !content.includes('SesV2Client') &&
      !content.includes('SimpleEmailServiceV2Client') &&
      !content.includes('Aws\\Ses') &&
      !content.includes('Aws\\SesV2')
    ) continue;

    const relFile = path.relative(appPath, filePath);

    // SesClient or SesV2Client usage
    if (content.includes('SesClient') || content.includes('SesV2Client')) {
      results.push({
        source: relFile,
        type: 'php',
        value: 'SesClient/SesV2Client usage detected',
        issue: null,
      });
    }

    if (content.includes('SimpleEmailServiceV2Client')) {
      results.push({
        source: relFile,
        type: 'php',
        value: 'SimpleEmailServiceV2Client usage detected',
        issue: null,
      });
    }

    // Hardcoded AWS credentials in PHP
    const accessKeyPattern = /['"](?:AWS_ACCESS_KEY_ID|aws_access_key_id)['"]\s*=>\s*['"][A-Z0-9]{16,20}['"]/;
    if (accessKeyPattern.test(content)) {
      results.push({
        source: relFile,
        type: 'php',
        value: 'Hardcoded AWS_ACCESS_KEY_ID in PHP',
        issue: `Hardcoded AWS access key found in ${relFile} — never hardcode AWS credentials in PHP; use IAM instance profile, ECS task role, or inject via environment variables`,
      });
    }

    const secretKeyPattern = /['"](?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)['"]\s*=>\s*['"][^\s'"]{20,60}['"]/;
    if (secretKeyPattern.test(content)) {
      results.push({
        source: relFile,
        type: 'php',
        value: 'Hardcoded AWS_SECRET_ACCESS_KEY in PHP',
        issue: `Hardcoded AWS secret key found in ${relFile} — rotate the key immediately and use IAM roles or environment injection instead`,
      });
    }
  }

  return results;
}

export function listAwsSesIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildAwsSesIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No AWS SES integration found.' }] };
    }
    const totalIssues = infos.filter((i) => i.issue !== null).length;
    let text = `AWS SES Integration Analysis\n${'='.repeat(55)}\n\nFindings: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  (${info.source})\n`;
      text += `    ${info.value}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAwsSesIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildAwsSesIntegrationInfos(appPath);
    let text = `AWS SES Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `DSN findings:    ${infos.filter((i) => i.type === 'dsn').length}\n`;
    text += `Env var findings: ${infos.filter((i) => i.type === 'env').length}\n`;
    text += `PHP findings:    ${infos.filter((i) => i.type === 'php').length}\n`;
    text += `Config findings: ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Total issues:    ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAwsSesIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_aws_ses_integration',
      description: 'Analyze AWS SES integration: scan .env/.env.local/.env.prod/mailer.yaml for MAILER_DSN with ses+smtp/api/https, AWS_SES_* env vars (masked), PHP SesClient/SesV2Client/SimpleEmailServiceV2Client usage, hardcoded AWS credentials in PHP. Flags: missing bounce/complaint handler, ses+smtp vs ses+api, APP_ENV=prod sandbox risk',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_aws_ses_integration_stats',
      description: 'Statistics for AWS SES integration: counts by type (dsn/env/php/config) and total issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
