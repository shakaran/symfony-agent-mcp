import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface BugsnagIntegrationInfo {
  file: string;
  type: 'php' | 'js' | 'config';
  setting: string;
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

function buildBugsnagIntegrationInfos(appPath: string): BugsnagIntegrationInfo[] {
  const results: BugsnagIntegrationInfo[] = [];

  // Check composer.json for bugsnag packages
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (composerContent.includes('bugsnag/bugsnag-symfony')) {
      results.push({ file: 'composer.json', type: 'php', setting: 'sdk:bugsnag/bugsnag-symfony', issues: [] });
    } else if (composerContent.includes('bugsnag/bugsnag')) {
      results.push({ file: 'composer.json', type: 'php', setting: 'sdk:bugsnag/bugsnag', issues: [] });
    }
  }

  // Scan .env* for BUGSNAG_API_KEY
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const apiKeyMatch = /BUGSNAG_API_KEY\s*=\s*([^\n]+)/.exec(content);
    if (apiKeyMatch) {
      const rawKey = apiKeyMatch[1].trim();
      const issues: string[] = [];
      if (rawKey && !rawKey.startsWith('%env(') && !rawKey.startsWith('${')) {
        issues.push(`Hardcoded BUGSNAG_API_KEY in ${fname} — inject via CI secrets; never commit API keys to version control`);
      }
      results.push({ file: fname, type: 'config', setting: maskSecrets(`BUGSNAG_API_KEY=${rawKey}`), issues });
    }
  }

  // Check config/packages/bugsnag.yaml
  const bugsnagConfigPath = path.join(appPath, 'config', 'packages', 'bugsnag.yaml');
  const bugsnagConfig = safeRead(bugsnagConfigPath, appPath);
  if (bugsnagConfig) {
    const relFile = path.relative(appPath, bugsnagConfigPath);
    const issues: string[] = [];

    const hasApiKey = bugsnagConfig.includes('api_key');
    const hasNotifyStages = bugsnagConfig.includes('notify_release_stages');
    const hasAppVersion = bugsnagConfig.includes('app_version');
    const hasAppType = bugsnagConfig.includes('app_type');

    if (hasApiKey && /api_key:\s*['"a-zA-Z0-9]{20,}/.test(bugsnagConfig)) {
      issues.push(`Hardcoded api_key in ${relFile} — use env variable (%env(BUGSNAG_API_KEY)%) instead`);
    }

    if (!hasNotifyStages) {
      issues.push(`notify_release_stages not configured in ${relFile} — without this filter, Bugsnag will report errors from all environments including dev; set notify_release_stages: [prod, staging]`);
    }

    if (!hasAppVersion) {
      issues.push(`app_version not set in ${relFile} — setting app_version helps correlate errors to specific deployments and use Bugsnag's error stability features`);
    }

    if (!hasAppType) {
      issues.push(`app_type not set in ${relFile} — setting app_type (e.g. 'web' or 'worker') helps filter errors in the Bugsnag dashboard`);
    }

    results.push({ file: relFile, type: 'config', setting: 'bugsnag.yaml', issues });
  } else {
    // No config file — check if SDK is present and warn
    const hasSdk = composerContent && (composerContent.includes('bugsnag/bugsnag-symfony') || composerContent.includes('bugsnag/bugsnag'));
    if (hasSdk) {
      results.push({
        file: 'config/packages/bugsnag.yaml',
        type: 'config',
        setting: 'missing',
        issues: ['Bugsnag SDK present but config/packages/bugsnag.yaml not found — create configuration with api_key, notify_release_stages, app_version, and app_type'],
      });
    }
  }

  // Scan src/**/*.php for Bugsnag usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('Bugsnag') &&
      !content.includes('->notifyException(') &&
      !content.includes('->notifyError(')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    if (content.includes('->notifyException(') || content.includes('->notifyError(')) {
      const hasSeverity = content.includes('severity') || content.includes('Severity');
      if (!hasSeverity) {
        issues.push(`Bugsnag notify call in ${relFile} without severity — set severity (error/warning/info) to help triage issues in the Bugsnag dashboard`);
      }
    }

    results.push({ file: relFile, type: 'php', setting: 'bugsnag-usage', issues });
  }

  return results;
}

export function listBugsnagIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildBugsnagIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Bugsnag integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Bugsnag Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.setting}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getBugsnagIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildBugsnagIntegrationInfos(appPath);
    let text = `Bugsnag Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `PHP patterns:    ${infos.filter((i) => i.type === 'php').length}\n`;
    text += `JS patterns:     ${infos.filter((i) => i.type === 'js').length}\n`;
    text += `Config patterns: ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getBugsnagIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_bugsnag_integration',
      description: 'Analyze Bugsnag integration: detect composer packages (bugsnag/bugsnag-symfony, bugsnag/bugsnag), env BUGSNAG_API_KEY, config/packages/bugsnag.yaml (api_key/notify_release_stages/app_version/app_type), PHP notifyException/notifyError usage, flag missing release stage filter, no app_version, hardcoded API key',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_bugsnag_integration_stats',
      description: 'Statistics for Bugsnag integration: php/js/config pattern counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
