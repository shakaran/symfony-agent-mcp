import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PusherIntegrationInfo {
  source: string;
  type: 'config' | 'php' | 'env';
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

function buildPusherIntegrationInfos(appPath: string): PusherIntegrationInfo[] {
  const results: PusherIntegrationInfo[] = [];

  // Check composer.json for pusher dependency
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  let composerVersion = '';
  if (composerContent) {
    if (composerContent.includes('pusher/pusher-php-server')) {
      const verMatch = /"pusher\/pusher-php-server"\s*:\s*"([^"]{1,30})"/.exec(composerContent);
      composerVersion = verMatch ? verMatch[1] : 'unknown';
      const issue = /[^0-9]([1-6])\.[0-9]/.test(composerVersion)
        ? `pusher/pusher-php-server version ${composerVersion} in composer.json — v7+ is required; v1-v6 use deprecated APIs and have breaking changes in channel auth and trigger signatures`
        : null;
      results.push({ source: 'composer.json', type: 'config', detail: `pusher/pusher-php-server: ${composerVersion}`, issue });
    }
  }

  // Scan .env* files for Pusher credentials
  const envFileNames = ['.env', '.env.local', '.env.prod', '.env.test'];
  let foundSecret = false;
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const pusherVars = [
      'PUSHER_APP_ID',
      'PUSHER_APP_KEY',
      'PUSHER_APP_SECRET',
      'PUSHER_APP_CLUSTER',
    ];

    for (const varName of pusherVars) {
      const pattern = new RegExp(`${varName}\\s*=\\s*([^\\n]{1,200})`);
      const m = pattern.exec(content);
      if (!m) continue;
      const rawVal = m[1].trim();
      const masked = maskSecrets(`${varName}=${rawVal}`);
      const isSecret = varName === 'PUSHER_APP_SECRET';
      if (isSecret) foundSecret = true;
      results.push({
        source: fname,
        type: 'env',
        detail: masked,
        issue: isSecret
          ? `${varName} found in ${fname} — inject via CI/CD secrets; never commit Pusher app secret to version control`
          : null,
      });
    }

    // Check for pusher DSN patterns in YAML-style env
    if (/pusher:\/\//.test(content)) {
      const dsnMatch = /pusher:\/\/[^\s]{1,200}/.exec(content);
      const dsnVal = dsnMatch ? dsnMatch[0] : 'pusher://...';
      const maskedDsn = dsnVal
        .replace(/:\/\/[^@\s]{1,200}@/g, '://***@')
        .replace(/([?&])(password|auth|token|secret|key)=[^&\s]*/gi, '$1$2=***');
      results.push({
        source: fname,
        type: 'config',
        detail: `Pusher DSN pattern: ${maskedDsn}`,
        issue: null,
      });
    }
  }

  // Scan config/packages/ YAML for pusher config
  const configDir = path.join(appPath, 'config', 'packages');
  if (fs.existsSync(configDir)) {
    try {
      for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const fpath = path.join(configDir, entry.name);
        const content = safeRead(fpath, appPath);
        if (!content || !content.includes('pusher')) continue;
        const relFile = path.relative(appPath, fpath);
        results.push({ source: relFile, type: 'config', detail: `Pusher config found in ${relFile}`, issue: null });
      }
    } catch { /* skip */ }
  }

  // Scan src/**/*.php for Pusher usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('new Pusher(') &&
      !content.includes('Pusher::') &&
      !content.includes('->trigger(') &&
      !content.includes('->triggerBatch(') &&
      !content.includes('->authenticate(')
    ) continue;

    const relFile = path.relative(appPath, filePath);

    // Hardcoded PUSHER_APP_SECRET in PHP
    if (foundSecret || /PUSHER_APP_SECRET|pusher.*secret/i.test(content)) {
      const hardcoded = /new Pusher\s*\([^)]{0,300}\)/.exec(content);
      if (hardcoded) {
        const ctorArgs = hardcoded[0];
        // Check if args look like raw strings rather than env references
        if (!/getenv|\$_ENV|\$this->|->get\(/.test(ctorArgs)) {
          results.push({
            source: relFile,
            type: 'php',
            detail: 'Pusher constructor with possible hardcoded credentials',
            issue: `Pusher constructor in ${relFile} does not appear to use env variable references — PUSHER_APP_SECRET must be injected via environment, not hardcoded in source`,
          });
        }
      }
    }

    // Check for private/presence channel usage without authenticate
    const hasPrivateChannel = /['"]private-|['"]presence-/.test(content);
    const hasTrigger = content.includes('->trigger(') || content.includes('->triggerBatch(');
    const hasAuthenticate = content.includes('->authenticate(') || content.includes('Pusher::authenticate(');
    if (hasPrivateChannel && hasTrigger && !hasAuthenticate) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'Private/presence channel trigger without authenticate()',
        issue: `${relFile} uses private- or presence- channels but no ->authenticate() call detected — implement channel authentication endpoint to prevent unauthorized subscription to private channels`,
      });
    }

    // Webhook signature validation missing
    const isWebhookController = /webhook|pusher.*event|handle.*pusher/i.test(relFile) ||
      /pusher.*webhook|handlePusher|pusherWebhook/i.test(content);
    if (isWebhookController) {
      const hasHmac = content.includes('hash_hmac') || content.includes('verifySignature') || content.includes('X-Pusher-Signature');
      if (!hasHmac) {
        results.push({
          source: relFile,
          type: 'php',
          detail: 'Pusher webhook handler without signature validation',
          issue: `Pusher webhook handler in ${relFile} does not validate X-Pusher-Signature — verify HMAC-SHA256 signature using app secret to prevent forged webhook events`,
        });
      }
    }

    // debug: true in Pusher constructor
    if (/['"]debug['"]\s*=>\s*true/.test(content) && content.includes('new Pusher(')) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'debug: true in Pusher constructor',
        issue: `Pusher constructed with debug:true in ${relFile} — disable debug mode in production as it logs all HTTP requests and responses including credentials`,
      });
    }

    // Detect basic usage with no issues (informational)
    const hasTriggerOnly = content.includes('->trigger(') || content.includes('->triggerBatch(');
    if (hasTriggerOnly) {
      results.push({ source: relFile, type: 'php', detail: 'Pusher event trigger usage', issue: null });
    }
  }

  return results;
}

export function listPusherIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildPusherIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Pusher integration found.' }] };
    }
    const totalIssues = infos.filter((i) => i.issue !== null).length;
    let text = `Pusher Integration Analysis\n${'='.repeat(55)}\n\nFindings: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  (${info.source})\n`;
      text += `    ${info.detail}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPusherIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildPusherIntegrationInfos(appPath);
    let text = `Pusher Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config findings: ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Env findings:    ${infos.filter((i) => i.type === 'env').length}\n`;
    text += `PHP findings:    ${infos.filter((i) => i.type === 'php').length}\n`;
    text += `Total issues:    ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPusherIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_pusher_integration',
      description: 'Analyze Pusher Channels integration: detect composer.json pusher/pusher-php-server dependency (flag v1-v6), scan .env* for PUSHER_APP_ID/KEY/SECRET/CLUSTER (masked), config/packages YAML, PHP new Pusher/authenticate/trigger/triggerBatch usage. Flags: hardcoded secret, missing channel auth, missing webhook HMAC, debug:true in production',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_pusher_integration_stats',
      description: 'Statistics for Pusher integration: counts by type (config/env/php) and total issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
