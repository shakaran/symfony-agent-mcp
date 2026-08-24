// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface AwsS3IntegrationInfo {
  file: string;
  type: 'upload' | 'download' | 'presigned' | 'acl';
  bucket: string;
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

function buildAwsS3IntegrationInfos(appPath: string): AwsS3IntegrationInfo[] {
  const results: AwsS3IntegrationInfo[] = [];

  // Check composer.json for AWS SDK / Flysystem
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (composerContent.includes('aws/aws-sdk-php')) {
      results.push({ file: 'composer.json', type: 'upload', bucket: '', issues: [] });
    }
    if (composerContent.includes('league/flysystem-aws-s3-v3')) {
      results.push({ file: 'composer.json', type: 'upload', bucket: '', issues: [] });
    }
  }

  // Scan .env* files
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod'];
  let detectedBucket = '';
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const keyIdMatch = /AWS_ACCESS_KEY_ID\s*=\s*([^\n]+)/.exec(content);
    const secretMatch = /AWS_SECRET_ACCESS_KEY\s*=\s*([^\n]+)/.exec(content);
    const bucketMatch = /AWS_S3_BUCKET\s*=\s*([^\n]+)/.exec(content);
    const regionMatch = /AWS_DEFAULT_REGION\s*=\s*([^\n]+)/.exec(content);

    if (keyIdMatch) {
      results.push({ file: fname, type: 'upload', bucket: '', issues: [] });
    }
    if (secretMatch) {
      const rawSecret = secretMatch[1].trim();
      const issues: string[] = [];
      if (rawSecret && !rawSecret.startsWith('%env(') && !rawSecret.startsWith('${')) {
        issues.push(`AWS_SECRET_ACCESS_KEY present in ${fname} — inject via IAM role or CI secrets; never commit secret keys to version control`);
      }
      results.push({ file: fname, type: 'upload', bucket: '', config: maskSecrets(`AWS_SECRET_ACCESS_KEY=${rawSecret}`), issues } as AwsS3IntegrationInfo & { config?: string });
    }
    if (bucketMatch) {
      detectedBucket = bucketMatch[1].trim();
      results.push({ file: fname, type: 'upload', bucket: detectedBucket, issues: [] });
    }
    if (regionMatch) {
      results.push({ file: fname, type: 'upload', bucket: '', issues: [] });
    }
  }

  // Scan src/**/*.php for S3 usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('S3Client') &&
      !content.includes('putObject') &&
      !content.includes('getObject') &&
      !content.includes('createPresignedRequest') &&
      !content.includes('s3')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    // Public-read ACL
    if (content.includes("'ACL' => 'public-read'") || content.includes('"ACL" => "public-read"')) {
      issues.push(`public-read ACL in ${relFile} — avoid public-read S3 ACLs; use pre-signed URLs with limited expiry to serve objects instead`);
    }

    // Hardcoded bucket names
    if (/['"][a-z0-9][a-z0-9-]{3,60}[a-z0-9]['"]/.test(content) && content.includes('Bucket')) {
      if (!content.includes('getenv') && !content.includes('$_ENV') && !content.includes('%env(')) {
        issues.push(`Possible hardcoded bucket name in ${relFile} — use AWS_S3_BUCKET env variable to avoid environment-specific hardcoding`);
      }
    }

    // No server-side encryption
    if (content.includes('putObject') && !content.includes('ServerSideEncryption') && !content.includes('SSEAlgorithm')) {
      issues.push(`putObject in ${relFile} without server-side encryption — add 'ServerSideEncryption' => 'AES256' or 'aws:kms' to protect data at rest`);
    }

    // Presigned URL without expiry
    if (content.includes('createPresignedRequest') && !content.includes('+') && !content.includes('expires') && !content.includes('Expires')) {
      issues.push(`createPresignedRequest in ${relFile} without explicit expiry — always set a short expiry (e.g. '+15 minutes') on pre-signed URLs`);
    }

    const type: AwsS3IntegrationInfo['type'] = content.includes('createPresignedRequest') ? 'presigned'
      : content.includes('getObject') ? 'download'
      : content.includes("'ACL'") ? 'acl'
      : 'upload';

    const bucketM = /['"]Bucket['"]\s*=>\s*['"]([a-zA-Z0-9_-]{1,63})['"]/.exec(content);
    const bucket = bucketM ? bucketM[1] : detectedBucket;

    results.push({ file: relFile, type, bucket, issues });
  }

  return results;
}

export function listAwsS3Integration(appPath: string): McpToolResult {
  try {
    const infos = buildAwsS3IntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No AWS S3 integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `AWS S3 Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      const bucketStr = info.bucket ? `  bucket:${info.bucket}` : '';
      text += `\n  [${info.type.toUpperCase()}]${bucketStr}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAwsS3IntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildAwsS3IntegrationInfos(appPath);
    let text = `AWS S3 Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Upload patterns:   ${infos.filter((i) => i.type === 'upload').length}\n`;
    text += `Download patterns: ${infos.filter((i) => i.type === 'download').length}\n`;
    text += `Presigned patterns:${infos.filter((i) => i.type === 'presigned').length}\n`;
    text += `ACL patterns:      ${infos.filter((i) => i.type === 'acl').length}\n`;
    text += `Issues:            ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAwsS3IntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_aws_s3_integration',
      description: 'Analyze AWS S3 integration: detect composer SDK (aws-sdk-php, flysystem-aws-s3-v3), env credentials (AWS_ACCESS_KEY_ID/SECRET/S3_BUCKET/REGION), PHP S3Client/putObject/getObject/presigned usage, flag public-read ACL, hardcoded buckets, no server-side encryption, presigned URL without expiry',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_aws_s3_integration_stats',
      description: 'Statistics for AWS S3 integration: upload/download/presigned/acl pattern counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
