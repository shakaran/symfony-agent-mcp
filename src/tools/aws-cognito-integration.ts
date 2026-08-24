// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface AwsCognitoIntegrationInfo {
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

function maskSecrets(value: string): string {
  return value.replace(/([A-Za-z_][A-Za-z0-9_]*\s*=\s*)[^\s$#'"]{8,}/g, '$1***');
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

function buildAwsCognitoIntegrationInfos(appPath: string): AwsCognitoIntegrationInfo[] {
  const results: AwsCognitoIntegrationInfo[] = [];

  // composer.json — check aws/aws-sdk-php
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (composerContent.includes('aws/aws-sdk-php')) {
      results.push({ source: 'composer.json', type: 'config', detail: 'aws/aws-sdk-php detected', issue: null });
    }
    if (composerContent.includes('firebase/php-jwt')) {
      results.push({ source: 'composer.json', type: 'config', detail: 'firebase/php-jwt detected (Cognito JWT verification)', issue: null });
    }
    if (composerContent.includes('lcobucci/jwt')) {
      results.push({ source: 'composer.json', type: 'config', detail: 'lcobucci/jwt detected (Cognito JWT verification)', issue: null });
    }
  }

  // .env* files — scan Cognito env vars
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const cognitoVars: Array<{ pattern: RegExp; name: string; sensitive: boolean }> = [
      { pattern: /AWS_COGNITO_USER_POOL_ID\s*=\s*([^\n]{1,200})/, name: 'AWS_COGNITO_USER_POOL_ID', sensitive: false },
      { pattern: /AWS_COGNITO_CLIENT_ID\s*=\s*([^\n]{1,200})/, name: 'AWS_COGNITO_CLIENT_ID', sensitive: true },
      { pattern: /AWS_COGNITO_CLIENT_SECRET\s*=\s*([^\n]{1,200})/, name: 'AWS_COGNITO_CLIENT_SECRET', sensitive: true },
      { pattern: /AWS_COGNITO_REGION\s*=\s*([^\n]{1,200})/, name: 'AWS_COGNITO_REGION', sensitive: false },
    ];

    for (const varDef of cognitoVars) {
      const m = varDef.pattern.exec(content);
      if (!m) continue;
      const raw = m[1].trim();
      const display = varDef.sensitive ? maskSecrets(`${varDef.name}=${raw}`) : `${varDef.name}=${raw}`;
      let issue: string | null = null;
      if (varDef.name === 'AWS_COGNITO_CLIENT_SECRET') {
        const isPlaceholder = raw.startsWith('%env(') || raw.startsWith('${') || raw === '';
        if (!isPlaceholder && raw.length >= 8) {
          issue = `${varDef.name} appears hardcoded in ${fname} — store in CI secrets vault, never commit client secret to version control`;
        }
      }
      results.push({ source: fname, type: 'env', detail: display, issue });
    }
  }

  // src/**/*.php — scan Cognito usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasCognito =
      content.includes('CognitoIdentityProviderClient') ||
      content.includes('->initiateAuth(') ||
      content.includes('->adminInitiateAuth(') ||
      content.includes('->respondToAuthChallenge(') ||
      content.includes('->signUp(') ||
      content.includes('->adminGetUser(') ||
      content.includes('->getSigningKey(') ||
      content.includes('->adminConfirmSignUp(');

    if (!hasCognito) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.includes('CognitoIdentityProviderClient')) {
        results.push({ source: `${relFile}:${lineNum}`, type: 'php', detail: 'CognitoIdentityProviderClient instantiation', issue: null });
      }

      if (line.includes('->adminInitiateAuth(')) {
        const hasUserPasswordAuth = content.includes('USER_PASSWORD_AUTH');
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          detail: '->adminInitiateAuth() call',
          issue: hasUserPasswordAuth
            ? 'adminInitiateAuth with USER_PASSWORD_AUTH flow sends password server-side — use SRP (USER_SRP_AUTH) flow instead to avoid password exposure in transit'
            : 'adminInitiateAuth() detected — verify auth flow is not USER_PASSWORD_AUTH (password sent server-side); prefer USER_SRP_AUTH',
        });
      }

      if (line.includes('->initiateAuth(') && !line.includes('->adminInitiateAuth(')) {
        results.push({ source: `${relFile}:${lineNum}`, type: 'php', detail: '->initiateAuth() call', issue: null });
      }

      if (line.includes('->respondToAuthChallenge(')) {
        const hasMfa = content.includes('SMS_MFA') || content.includes('SOFTWARE_TOKEN_MFA') || content.includes('MFA_SETUP');
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          detail: '->respondToAuthChallenge() call',
          issue: hasMfa ? null : 'respondToAuthChallenge detected but no MFA challenge handling (SMS_MFA/SOFTWARE_TOKEN_MFA) found — ensure MFA challenges are handled or document why MFA is disabled',
        });
      }

      if (line.includes('->signUp(')) {
        results.push({ source: `${relFile}:${lineNum}`, type: 'php', detail: '->signUp() call', issue: null });
      }

      if (line.includes('->adminGetUser(')) {
        results.push({ source: `${relFile}:${lineNum}`, type: 'php', detail: '->adminGetUser() call', issue: null });
      }

      if (line.includes('->adminConfirmSignUp(')) {
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          detail: '->adminConfirmSignUp() call',
          issue: 'adminConfirmSignUp() in automated flow bypasses email verification — use confirmSignUp() triggered by user action to preserve email ownership verification',
        });
      }

      if (line.includes('->getSigningKey(')) {
        results.push({ source: `${relFile}:${lineNum}`, type: 'php', detail: 'JWT signing key retrieval (->getSigningKey())', issue: null });
      }
    }

    // Check for missing JWT signature verification
    if (
      (content.includes('firebase/php-jwt') || content.includes('lcobucci/jwt') || content.includes('JWT::decode')) &&
      !content.includes('->getSigningKey(') &&
      !content.includes('RS256') &&
      !content.includes('jwks')
    ) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'JWT usage without Cognito JWKS signature verification',
        issue: 'JWT decoded without fetching Cognito JWKS signing keys — fetch public keys from https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/jwks.json to verify RS256 signature',
      });
    }
  }

  return results;
}

export function listAwsCognitoIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildAwsCognitoIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No AWS Cognito integration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `AWS Cognito Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
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

export function getAwsCognitoIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildAwsCognitoIntegrationInfos(appPath);
    const envEntries = infos.filter((i) => i.type === 'env');
    const phpEntries = infos.filter((i) => i.type === 'php');
    const configEntries = infos.filter((i) => i.type === 'config');
    const issues = infos.filter((i) => i.issue !== null);
    let text = `AWS Cognito Integration Statistics\n${'='.repeat(40)}\n\n`;
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

export function getAwsCognitoIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_aws_cognito_integration',
      description: 'Scan for AWS Cognito user pool integration: composer.json aws/aws-sdk-php, .env* Cognito vars (masked secrets), PHP CognitoIdentityProviderClient/initiateAuth/adminInitiateAuth/respondToAuthChallenge/signUp/adminGetUser, JWT signing key verification. Flags USER_PASSWORD_AUTH flow, missing JWT verification, hardcoded client secret, adminConfirmSignUp bypassing email verification, missing MFA handling.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_aws_cognito_integration_stats',
      description: 'Statistics for AWS Cognito integration: env/PHP/config entry counts and issue breakdown.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
