import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RabbitMqManagementApiInfo {
  file: string;
  type: 'vhost' | 'queue' | 'exchange' | 'binding' | 'policy';
  config: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskUrl(s: string): string {
  return s.replace(/([a-z][a-z0-9+\-.]*:\/\/)[^@\s]*@/gi, '$1***@');
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

function buildRabbitmqManagementApiInfos(appPath: string): RabbitMqManagementApiInfo[] {
  const results: RabbitMqManagementApiInfo[] = [];

  // Check composer.json for RabbitMQ packages
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (composerContent.includes('php-amqplib/rabbitmq-bundle')) {
      results.push({ file: 'composer.json', type: 'queue', config: 'sdk:php-amqplib/rabbitmq-bundle', issues: [] });
    }
    if (composerContent.includes('enqueue/amqp-bunny')) {
      results.push({ file: 'composer.json', type: 'queue', config: 'sdk:enqueue/amqp-bunny', issues: [] });
    }
  }

  // Scan .env* for RabbitMQ management credentials
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod'];
  let detectedUser = '';
  let detectedPass = '';
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const mgmtUrlMatch = /RABBITMQ_MANAGEMENT_URL\s*=\s*([^\n]+)/.exec(content);
    const userMatch = /RABBITMQ_DEFAULT_USER\s*=\s*([^\n]+)/.exec(content);
    const passMatch = /RABBITMQ_DEFAULT_PASS\s*=\s*([^\n]+)/.exec(content);

    if (mgmtUrlMatch) {
      const rawUrl = mgmtUrlMatch[1].trim();
      const issues: string[] = [];
      if (rawUrl.startsWith('http://') && !rawUrl.includes('localhost') && !rawUrl.includes('127.0.0.1')) {
        issues.push(`RABBITMQ_MANAGEMENT_URL uses HTTP in ${fname} for non-localhost — RabbitMQ management API should use HTTPS in production to prevent credential interception`);
      }
      results.push({ file: fname, type: 'vhost', config: maskSecrets(maskUrl(`RABBITMQ_MANAGEMENT_URL=${rawUrl}`)), issues });
    }

    if (userMatch) {
      detectedUser = userMatch[1].trim();
      const issues: string[] = [];
      if (detectedUser === 'guest') {
        issues.push(`RABBITMQ_DEFAULT_USER=guest in ${fname} — guest is the default RabbitMQ credential and only works on localhost by default; use a strong, unique username in production`);
      }
      results.push({ file: fname, type: 'vhost', config: `RABBITMQ_DEFAULT_USER=${detectedUser}`, issues });
    }

    if (passMatch) {
      detectedPass = passMatch[1].trim();
      const issues: string[] = [];
      if (detectedPass === 'guest') {
        issues.push(`RABBITMQ_DEFAULT_PASS=guest in ${fname} — default guest/guest credentials must be changed before deployment; attackers commonly scan for default RabbitMQ credentials`);
      } else if (detectedPass && !detectedPass.startsWith('%env(') && !detectedPass.startsWith('${')) {
        issues.push(`RABBITMQ_DEFAULT_PASS present in ${fname} — inject via CI secrets; never commit RabbitMQ passwords to version control`);
      }
      results.push({ file: fname, type: 'vhost', config: `RABBITMQ_DEFAULT_PASS=***`, issues });
    }
  }

  // Scan src/**/*.php for RabbitMQ management API usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('RabbitMqManagementClient') &&
      !content.includes('management/api') &&
      !content.includes('/api/queues/') &&
      !content.includes('/api/vhosts/') &&
      !content.includes('rabbitmq')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    // Management API user same as app user
    if ((content.includes('/api/queues/') || content.includes('/api/vhosts/') || content.includes('management/api')) && detectedUser) {
      const hasAdminUser = content.includes('admin') || content.includes('management');
      if (!hasAdminUser) {
        issues.push(`RabbitMQ management API call in ${relFile} — ensure the management API uses a dedicated admin user separate from the application AMQP user to limit blast radius if app credentials are compromised`);
      }
    }

    // No TLS for management API
    if (/http:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+.*\/api/.test(content)) {
      issues.push(`RabbitMQ management API called over HTTP in ${relFile} — use HTTPS for management API calls outside localhost to prevent credential interception`);
    }

    // Detect type from path patterns
    const type: RabbitMqManagementApiInfo['type'] = content.includes('/api/queues/') ? 'queue'
      : content.includes('/api/exchanges/') ? 'exchange'
      : content.includes('/api/bindings/') ? 'binding'
      : content.includes('/api/policies/') ? 'policy'
      : 'vhost';

    results.push({ file: relFile, type, config: 'management-api-usage', issues });
  }

  // Check config/ for management API endpoint configuration
  const configDir = path.join(appPath, 'config');
  if (fs.existsSync(configDir)) {
    const configFiles = [
      ...scanDirRecursive(path.join(configDir, 'packages'), '.yaml'),
      ...scanDirRecursive(path.join(configDir, 'packages'), '.yml'),
    ];
    for (const f of configFiles) {
      const content = safeRead(f, appPath);
      if (!content) continue;
      if (!content.includes('rabbitmq') && !content.includes('amqp') && !content.includes('messenger')) continue;
      const relFile = path.relative(appPath, f);
      const issues: string[] = [];
      if (content.includes('rabbitmq') || content.includes('amqp')) {
        // Check if management API is referenced
        if (content.includes('management') || content.includes('15672')) {
          const hasTls = content.includes('ssl') || content.includes('tls') || content.includes('https');
          if (!hasTls) {
            issues.push(`RabbitMQ management config in ${relFile} without TLS settings — configure SSL/TLS for management API access in production`);
          }
        }
      }
      if (issues.length > 0 || content.includes('management')) {
        results.push({ file: relFile, type: 'vhost', config: relFile, issues });
      }
    }
  }

  return results;
}

export function listRabbitmqManagementApi(appPath: string): McpToolResult {
  try {
    const infos = buildRabbitmqManagementApiInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No RabbitMQ management API integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `RabbitMQ Management API Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.config}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRabbitmqManagementApiStats(appPath: string): McpToolResult {
  try {
    const infos = buildRabbitmqManagementApiInfos(appPath);
    let text = `RabbitMQ Management API Statistics\n${'='.repeat(40)}\n\n`;
    text += `VHost patterns:    ${infos.filter((i) => i.type === 'vhost').length}\n`;
    text += `Queue patterns:    ${infos.filter((i) => i.type === 'queue').length}\n`;
    text += `Exchange patterns: ${infos.filter((i) => i.type === 'exchange').length}\n`;
    text += `Binding patterns:  ${infos.filter((i) => i.type === 'binding').length}\n`;
    text += `Policy patterns:   ${infos.filter((i) => i.type === 'policy').length}\n`;
    text += `Issues:            ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRabbitmqManagementApiTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_rabbitmq_management_api',
      description: 'Analyze RabbitMQ management API integration: detect composer packages (php-amqplib/rabbitmq-bundle, enqueue/amqp-bunny), env credentials (RABBITMQ_MANAGEMENT_URL/DEFAULT_USER/PASS), PHP management API calls (/api/queues//api/vhosts/), config/ endpoint settings, flag management user same as app user, no TLS, default guest/guest credentials',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_rabbitmq_management_api_stats',
      description: 'Statistics for RabbitMQ management API: vhost/queue/exchange/binding/policy pattern counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
