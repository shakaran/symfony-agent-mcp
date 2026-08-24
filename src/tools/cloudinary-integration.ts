// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CloudinaryIntegrationInfo {
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

function maskCloudinaryUrl(url: string): string {
  // cloudinary://API_KEY:API_SECRET@CLOUD_NAME => cloudinary://***:***@CLOUD_NAME
  return url.replace(/(cloudinary:\/\/)[^:@]{1,100}:[^@]{1,100}(@)/, '$1***:***$2');
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

function buildCloudinaryIntegrationInfos(appPath: string): CloudinaryIntegrationInfo[] {
  const results: CloudinaryIntegrationInfo[] = [];

  // Check composer.json for cloudinary package
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent && composerContent.includes('cloudinary/cloudinary_php')) {
    const verMatch = /"cloudinary\/cloudinary_php"\s*:\s*"([^"]{1,30})"/.exec(composerContent);
    const ver = verMatch ? verMatch[1] : 'unknown';
    results.push({ source: 'composer.json', type: 'config', detail: `cloudinary/cloudinary_php: ${ver}`, issue: null });
  }

  // Scan .env* files for Cloudinary credentials
  const envFileNames = ['.env', '.env.local', '.env.prod', '.env.test'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    // CLOUDINARY_URL=cloudinary://KEY:SECRET@CLOUD
    const urlMatch = /CLOUDINARY_URL\s*=\s*([^\n]{1,300})/.exec(content);
    if (urlMatch) {
      const rawUrl = urlMatch[1].trim();
      const masked = rawUrl.startsWith('cloudinary://') ? maskCloudinaryUrl(rawUrl) : maskSecrets(`CLOUDINARY_URL=${rawUrl}`);
      results.push({
        source: fname,
        type: 'env',
        detail: `CLOUDINARY_URL=${masked}`,
        issue: `CLOUDINARY_URL in ${fname} embeds api_key and api_secret — inject via CI/CD secrets; never commit Cloudinary credentials to version control`,
      });
    }

    // Individual credential vars
    const cloudVars = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
    for (const varName of cloudVars) {
      const pattern = new RegExp(`${varName}\\s*=\\s*([^\\n]{1,200})`);
      const m = pattern.exec(content);
      if (!m) continue;
      const rawVal = m[1].trim();
      const masked = maskSecrets(`${varName}=${rawVal}`);
      const isSecret = varName === 'CLOUDINARY_API_SECRET';
      results.push({
        source: fname,
        type: 'env',
        detail: masked,
        issue: isSecret
          ? `${varName} found in ${fname} — inject via CI/CD secrets manager; never commit API secret to version control`
          : null,
      });
    }
  }

  // Check cloudinary.yaml config if present
  const cloudinaryYamlPath = path.join(appPath, 'config', 'packages', 'cloudinary.yaml');
  const cloudinaryYamlContent = safeRead(cloudinaryYamlPath, appPath);
  if (cloudinaryYamlContent) {
    results.push({ source: 'config/packages/cloudinary.yaml', type: 'config', detail: 'Cloudinary config file found', issue: null });
    // Check for hardcoded secrets in YAML
    if (/api_secret\s*:\s*[a-zA-Z0-9_-]{16,}/.test(cloudinaryYamlContent)) {
      results.push({
        source: 'config/packages/cloudinary.yaml',
        type: 'config',
        detail: 'api_secret hardcoded in cloudinary.yaml',
        issue: 'api_secret appears hardcoded in cloudinary.yaml — use %env(CLOUDINARY_API_SECRET)% instead',
      });
    }
  }

  // Scan src/**/*.php for Cloudinary usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('Cloudinary') &&
      !content.includes('cloudinary') &&
      !content.includes('->upload(') &&
      !content.includes('->uploadLarge(') &&
      !content.includes('->adminApi(') &&
      !content.includes('->uploadApi(')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const hasCloudinaryUsage = content.includes('new Cloudinary(') ||
      content.includes('Cloudinary::config(') ||
      content.includes('->upload(') ||
      content.includes('->uploadLarge(') ||
      content.includes('->adminApi(') ||
      content.includes('->uploadApi(');
    if (!hasCloudinaryUsage) continue;

    // Hardcoded API_SECRET in PHP
    const hardcodedSecret = /Cloudinary::config\s*\([^)]{0,500}api_secret[^)]{0,200}\)/.exec(content);
    if (hardcodedSecret) {
      const args = hardcodedSecret[0];
      if (!/getenv|\$_ENV|\$this->|->get\(|%env/.test(args)) {
        results.push({
          source: relFile,
          type: 'php',
          detail: 'Cloudinary::config() with possible hardcoded api_secret',
          issue: `CLOUDINARY_API_SECRET may be hardcoded in ${relFile} — use getenv('CLOUDINARY_API_SECRET') or inject via DI container`,
        });
      }
    }

    // Unsigned preset in upload
    if (/unsigned_preset|upload_preset/.test(content)) {
      const presetMatch = /['"]upload_preset['"]\s*=>\s*['"][^'"]{1,80}['"]/.exec(content);
      const hasUnsigned = content.includes('unsigned_preset') ||
        (presetMatch && !/signed_preset/.test(content));
      if (hasUnsigned) {
        results.push({
          source: relFile,
          type: 'php',
          detail: 'Unsigned upload preset detected',
          issue: `Unsigned upload preset in ${relFile} — unsigned uploads allow anyone to upload files without authentication; validate preset restrictions or use signed uploads`,
        });
      }
    }

    // Upload without transformation restrictions
    if ((content.includes('->upload(') || content.includes('->uploadLarge(')) && !content.includes('transformation')) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'Upload without transformation restrictions',
        issue: `Upload call in ${relFile} has no transformation parameter — unrestricted transformations can be abused via dynamic URL parameters to generate unlimited image variants; consider eager transformations or restrict with upload presets`,
      });
    }

    // adminApi() in potentially web-facing code
    if (content.includes('->adminApi(')) {
      const isWebFacing = /Controller|Action|Handler|Request|Response/.test(relFile) ||
        /Controller|Request|Response/.test(content);
      if (isWebFacing) {
        results.push({
          source: relFile,
          type: 'php',
          detail: 'adminApi() called from web-facing code',
          issue: `->adminApi() found in ${relFile} which appears to be web-facing — Admin API has rate limits and full account access; restrict to CLI commands or background jobs only`,
        });
      } else {
        results.push({ source: relFile, type: 'php', detail: 'adminApi() usage detected', issue: null });
      }
    }

    // Missing notification_url for async uploads
    if (content.includes('->upload(') || content.includes('->uploadLarge(')) {
      if (!content.includes('notification_url') && !content.includes('eager_notification_url')) {
        results.push({
          source: relFile,
          type: 'php',
          detail: 'Upload without notification_url',
          issue: `Upload in ${relFile} has no notification_url — async upload callbacks (eager transformations, moderation) silently fail without a notification_url; add notification_url for production reliability`,
        });
      }
    }

    // General usage (informational)
    results.push({ source: relFile, type: 'php', detail: 'Cloudinary API usage detected', issue: null });
  }

  return results;
}

export function listCloudinaryIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildCloudinaryIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Cloudinary integration found.' }] };
    }
    const totalIssues = infos.filter((i) => i.issue !== null).length;
    let text = `Cloudinary Integration Analysis\n${'='.repeat(55)}\n\nFindings: ${infos.length}  Issues: ${totalIssues}\n`;
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

export function getCloudinaryIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildCloudinaryIntegrationInfos(appPath);
    let text = `Cloudinary Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Env findings:    ${infos.filter((i) => i.type === 'env').length}\n`;
    text += `PHP findings:    ${infos.filter((i) => i.type === 'php').length}\n`;
    text += `Config findings: ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Total issues:    ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCloudinaryIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_cloudinary_integration',
      description: 'Analyze Cloudinary media management integration: detect composer.json cloudinary/cloudinary_php, scan .env* for CLOUDINARY_URL/CLOUD_NAME/API_KEY/API_SECRET (masked), cloudinary.yaml, PHP new Cloudinary/config/upload/uploadLarge/adminApi/uploadApi usage. Flags: exposed api_secret, unsigned upload preset, missing transformation restrictions, adminApi in web code, missing notification_url',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_cloudinary_integration_stats',
      description: 'Statistics for Cloudinary integration: counts by type (env/php/config) and total issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
