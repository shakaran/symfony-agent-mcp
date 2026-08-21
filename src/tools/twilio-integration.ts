import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface TwilioIntegrationInfo {
  file: string;
  type: 'sms' | 'voice' | 'verify' | 'webhook';
  config: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecrets(val: string): string {
  return val.replace(/(?<=[=:]\s*)[a-zA-Z0-9_-]{4,}/g, '***');
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

function buildTwilioIntegrationInfos(appPath: string): TwilioIntegrationInfo[] {
  const results: TwilioIntegrationInfo[] = [];

  // Check composer.json for twilio/sdk
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  const hasSdk = composerContent ? composerContent.includes('twilio/sdk') : false;
  if (hasSdk) {
    results.push({ file: 'composer.json', type: 'webhook', config: 'sdk:twilio/sdk', issues: [] });
  }

  // Scan .env* files for credentials
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;
    const relFile = fname;

    const sidMatch = /TWILIO_ACCOUNT_SID\s*=\s*([^\n]+)/.exec(content);
    const tokenMatch = /TWILIO_AUTH_TOKEN\s*=\s*([^\n]+)/.exec(content);
    const fromMatch = /TWILIO_FROM_NUMBER\s*=\s*([^\n]+)/.exec(content);

    // M-16: helper to fully redact vars whose name matches sensitive patterns (avoids {20,} minimum threshold)
    const maskSensitiveVar = (varName: string, raw: string): string =>
      /secret|token|auth|key|pass|cert|credential/i.test(varName) ? `${varName}=***` : maskSecrets(`${varName}=${raw}`);

    if (sidMatch) {
      results.push({ file: relFile, type: 'sms', config: maskSensitiveVar('TWILIO_ACCOUNT_SID', sidMatch[1].trim()), issues: [] });
    }
    if (tokenMatch) {
      const rawToken = tokenMatch[1].trim();
      const maskedLine = maskSensitiveVar('TWILIO_AUTH_TOKEN', rawToken);
      const issues: string[] = [];
      if (rawToken && !rawToken.startsWith('%env(') && !rawToken.startsWith('${')) {
        issues.push(`TWILIO_AUTH_TOKEN present in ${relFile} — mask with '***' and inject via CI secrets; never commit auth tokens to version control`);
      }
      results.push({ file: relFile, type: 'sms', config: maskedLine, issues });
    }
    if (fromMatch) {
      // M-16: mask FROM_NUMBER (phone numbers are PII/attack-surface data)
      results.push({ file: relFile, type: 'sms', config: maskSensitiveVar('TWILIO_FROM_NUMBER', fromMatch[1].trim()), issues: [] });
    }
  }

  // Scan src/**/*.php for Twilio usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('TwilioClient') &&
      !content.includes('new Client(') &&
      !content.includes('->messages->create(') &&
      !content.includes('->calls->create(') &&
      !content.includes('Twilio')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    // Hardcoded credentials check
    if (/new\s+Client\s*\(\s*['"][A-Za-z0-9]{20,}/.test(content)) {
      issues.push(`Hardcoded Twilio credentials in ${relFile} — use environment variables (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) instead of inline strings`);
    }

    // Missing webhook signature validation
    if (content.includes('Request') && (content.includes('twilio') || content.includes('Twilio'))) {
      const hasValidation = content.includes('X-Twilio-Signature') || content.includes('validateRequest') || content.includes('RequestValidator');
      if (!hasValidation) {
        issues.push(`Possible Twilio webhook handler in ${relFile} without signature validation — use Twilio\\Security\\RequestValidator to verify X-Twilio-Signature header`);
      }
    }

    // No exception handling around Twilio calls
    const hasTwilioCall = content.includes('->messages->create(') || content.includes('->calls->create(');
    if (hasTwilioCall) {
      const hasCatch = content.includes('catch') && (content.includes('TwilioException') || content.includes('RestException') || content.includes('Exception'));
      if (!hasCatch) {
        issues.push(`Twilio API call in ${relFile} without exception handling — catch \\Twilio\\Exceptions\\RestException to handle rate limits, invalid numbers, and service errors`);
      }
    }

    const type: TwilioIntegrationInfo['type'] = content.includes('->calls->create(') ? 'voice'
      : content.includes('Verify') ? 'verify'
      : content.includes('webhook') || content.includes('Webhook') ? 'webhook'
      : 'sms';

    results.push({ file: relFile, type, config: 'twilio-usage', issues });
  }

  return results;
}

export function listTwilioIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildTwilioIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Twilio integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Twilio Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.config}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTwilioIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildTwilioIntegrationInfos(appPath);
    let text = `Twilio Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `SMS patterns:     ${infos.filter((i) => i.type === 'sms').length}\n`;
    text += `Voice patterns:   ${infos.filter((i) => i.type === 'voice').length}\n`;
    text += `Verify patterns:  ${infos.filter((i) => i.type === 'verify').length}\n`;
    text += `Webhook patterns: ${infos.filter((i) => i.type === 'webhook').length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTwilioIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_twilio_integration',
      description: 'Analyze Twilio integration: detect composer SDK, env credentials (TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER), PHP usage of TwilioClient/messages/calls, and flag hardcoded credentials, missing webhook signature validation, no exception handling',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_twilio_integration_stats',
      description: 'Statistics for Twilio integration: SMS/voice/verify/webhook pattern counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
