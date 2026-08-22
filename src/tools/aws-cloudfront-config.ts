import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface AwsCloudfrontConfigInfo {
  source: string;
  type: 'env' | 'php' | 'config';
  detail: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function buildAwsCloudfrontConfigInfos(appPath: string): AwsCloudfrontConfigInfo[] {
  const results: AwsCloudfrontConfigInfo[] = [];

  // composer.json — check aws/aws-sdk-php
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent && composerContent.includes('aws/aws-sdk-php')) {
    results.push({ source: 'composer.json', type: 'config', detail: 'aws/aws-sdk-php detected (CloudFront SDK available)', issue: null });
  }

  // .env* files — scan CloudFront env vars
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const cfVars: Array<{ pattern: RegExp; name: string; sensitive: boolean }> = [
      { pattern: /CLOUDFRONT_DISTRIBUTION_ID\s*=\s*([^\n]{1,200})/, name: 'CLOUDFRONT_DISTRIBUTION_ID', sensitive: false },
      { pattern: /CLOUDFRONT_KEY_PAIR_ID\s*=\s*([^\n]{1,200})/, name: 'CLOUDFRONT_KEY_PAIR_ID', sensitive: false },
      { pattern: /CLOUDFRONT_PRIVATE_KEY_PATH\s*=\s*([^\n]{1,200})/, name: 'CLOUDFRONT_PRIVATE_KEY_PATH', sensitive: true },
    ];

    for (const varDef of cfVars) {
      const m = varDef.pattern.exec(content);
      if (!m) continue;
      const raw = m[1].trim();
      const display = varDef.sensitive
        ? `${varDef.name}=***`
        : `${varDef.name}=${raw}`;

      let issue: string | null = null;
      if (varDef.name === 'CLOUDFRONT_PRIVATE_KEY_PATH') {
        // Check if the path points to a version-controlled file
        if (raw && !raw.startsWith('/var/') && !raw.startsWith('/run/') && !raw.startsWith('/tmp/') && !raw.startsWith('%env(')) {
          issue = `CLOUDFRONT_PRIVATE_KEY_PATH may point to a version-controlled file — store CloudFront private keys outside the repo (e.g., /run/secrets/) and inject via deployment`;
        }
      }
      results.push({ source: fname, type: 'env', detail: display, issue });
    }
  }

  // src/**/*.php — scan CloudFront usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasCf =
      content.includes('CloudFrontClient') ||
      content.includes('->createInvalidation(') ||
      content.includes('->getDistribution(') ||
      content.includes('CloudFrontCookieSigner') ||
      content.includes('CloudFrontUrlSigner') ||
      content.includes('->sign(');

    if (!hasCf) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.includes('CloudFrontClient')) {
        results.push({ source: `${relFile}:${lineNum}`, type: 'php', detail: 'CloudFrontClient instantiation', issue: null });
      }

      if (line.includes('->createInvalidation(')) {
        // Check surrounding context for wildcard path
        const contextStart = Math.max(0, i - 3);
        const contextEnd = Math.min(lines.length - 1, i + 5);
        const context = lines.slice(contextStart, contextEnd + 1).join('\n');
        const hasWildcard = /['"][/][*]['"]/.test(context) || context.includes("'/*'") || context.includes('"/*"');
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          detail: '->createInvalidation() call',
          issue: hasWildcard
            ? "createInvalidation with paths: ['/*'] invalidates the entire CloudFront distribution — very expensive and slow; use specific path patterns (e.g., '/images/*') to minimize invalidation cost"
            : null,
        });
      }

      if (line.includes('->getDistribution(')) {
        results.push({ source: `${relFile}:${lineNum}`, type: 'php', detail: '->getDistribution() call', issue: null });
      }

      if (line.includes('CloudFrontUrlSigner') || line.includes('CloudFrontCookieSigner')) {
        // Check for signed URL without expiry in surrounding context
        const contextStart = Math.max(0, i - 2);
        const contextEnd = Math.min(lines.length - 1, i + 10);
        const context = lines.slice(contextStart, contextEnd + 1).join('\n');
        const hasExpiry = context.includes('expires') || context.includes('Expires') || context.includes('expiry') || context.includes('+');
        const signerType = line.includes('CloudFrontUrlSigner') ? 'CloudFrontUrlSigner' : 'CloudFrontCookieSigner';
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          detail: `${signerType} instantiation`,
          issue: !hasExpiry
            ? `${signerType} used without apparent expiry — signed URLs/cookies without expiry are valid indefinitely; always pass an expiry time`
            : null,
        });
      }

      if (line.includes('->sign(') && (content.includes('CloudFront') || content.includes('Signer'))) {
        // Check for private key path in code (not env var)
        const hasHardcodedPath = /->sign\s*\([^)]{0,200}['"][/\\][^'"]{1,100}['"]/. test(line);
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          detail: '->sign() CloudFront signed URL generation',
          issue: hasHardcodedPath
            ? 'Private key path appears hardcoded in sign() call — use CLOUDFRONT_PRIVATE_KEY_PATH env var rather than literal path in source code'
            : null,
        });
      }
    }

    // Check for private key path in code (not env var) — broader check
    const hardcodedKeyPattern = /(?:private_key|privateKey|key_path|keyPath)\s*(?:=>|=)\s*['"][/\\][^'"]{1,100}['"]/;
    if (hardcodedKeyPattern.test(content)) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'Possible hardcoded private key path in CloudFront config',
        issue: 'Private key path appears hardcoded — store in CLOUDFRONT_PRIVATE_KEY_PATH env var to avoid committing key paths to version control',
      });
    }
  }

  // config/packages/ and config/aws/ — CloudFront distribution YAML/JSON
  const configDirs = [
    path.join(appPath, 'config', 'packages'),
    path.join(appPath, 'config', 'aws'),
  ];
  for (const configDir of configDirs) {
    if (!fs.existsSync(configDir)) continue;
    try {
      for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const lower = entry.name.toLowerCase();
        if (!lower.includes('cloudfront') && !lower.includes('cdn')) continue;
        const fpath = path.join(configDir, entry.name);
        const content = safeRead(fpath, appPath);
        if (!content) continue;
        const relFile = path.relative(appPath, fpath);
        results.push({
          source: relFile,
          type: 'config',
          detail: `CloudFront distribution config file: ${entry.name}`,
          issue: null,
        });
      }
    } catch { /* skip */ }
  }

  return results;
}

export function listAwsCloudfrontConfig(appPath: string): McpToolResult {
  try {
    const infos = buildAwsCloudfrontConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No AWS CloudFront configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `AWS CloudFront Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
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

export function getAwsCloudfrontConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildAwsCloudfrontConfigInfos(appPath);
    const envEntries = infos.filter((i) => i.type === 'env');
    const phpEntries = infos.filter((i) => i.type === 'php');
    const configEntries = infos.filter((i) => i.type === 'config');
    const issues = infos.filter((i) => i.issue !== null);
    let text = `AWS CloudFront Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Env entries:    ${envEntries.length}\n`;
    text += `PHP patterns:   ${phpEntries.length}\n`;
    text += `Config entries: ${configEntries.length}\n`;
    text += `Issues:         ${issues.length}\n`;
    if (issues.length > 0) {
      text += `\nIssue breakdown:\n`;
      for (const info of issues) {
        text += `  - [${info.source}] ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAwsCloudfrontConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_aws_cloudfront_config',
      description: 'Scan for AWS CloudFront distribution configuration: composer.json aws/aws-sdk-php, .env* CLOUDFRONT_DISTRIBUTION_ID/KEY_PAIR_ID/PRIVATE_KEY_PATH (masked), PHP CloudFrontClient/createInvalidation/getDistribution/sign/CloudFrontCookieSigner/CloudFrontUrlSigner usage, config/packages/ and config/aws/ YAML/JSON. Flags wildcard invalidation (/*), signed URL without expiry, hardcoded private key path.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_aws_cloudfront_config_stats',
      description: 'Statistics for AWS CloudFront configuration: env/PHP/config entry counts and issue breakdown.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
