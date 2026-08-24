// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface GoogleCloudStorageInfo {
  source: string;
  type: 'package' | 'acl' | 'signed-url' | 'hmac' | 'key-path' | 'credentials';
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
  return value.replace(/([A-Za-z_][A-Za-z0-9_]*\s*[=:]\s*)[^\s$#'"]{8,}/g, '$1***');
}

function safeKeyPath(p: string): string {
  return p.replace(/\S+\.(key|p12|pfx|der|crt|pem)$/i, '[KEY-PATH]');
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

function buildGoogleCloudStorageInfos(appPath: string): GoogleCloudStorageInfo[] {
  const results: GoogleCloudStorageInfo[] = [];

  // Check composer.json for google/cloud-storage
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (composerContent.includes('google/cloud-storage')) {
      results.push({ source: 'composer.json', type: 'package', detail: 'google/cloud-storage package detected', issue: null });
    }
    if (composerContent.includes('google/cloud')) {
      results.push({ source: 'composer.json', type: 'package', detail: 'google/cloud SDK detected', issue: null });
    }
  }

  // Scan config/**/*.yaml for GCS config
  const configDir = path.join(appPath, 'config');
  if (fs.existsSync(configDir)) {
    const configFiles = [
      ...scanDirRecursive(configDir, '.yaml'),
      ...scanDirRecursive(configDir, '.yml'),
    ];
    for (const fpath of configFiles) {
      const content = safeRead(fpath, appPath);
      if (!content) continue;
      if (!content.includes('google') && !content.includes('gcs') && !content.includes('storage')) continue;
      const relFile = path.relative(appPath, fpath);

      // keyFilePath hardcoded in YAML config
      const keyFileMatch = /keyFilePath\s*:\s*([^\n#]{1,200})/.exec(content) ?? /key_file_path\s*:\s*([^\n#]{1,200})/.exec(content);
      if (keyFileMatch) {
        const val = keyFileMatch[1].trim();
        const usesEnvVar = val.startsWith('%env(') || val.startsWith('${') || val.startsWith('!php/const');
        results.push({
          source: relFile,
          type: 'key-path',
          detail: maskSecrets(safeKeyPath(`keyFilePath: ${val}`)),
          issue: usesEnvVar ? null : `keyFilePath in ${relFile} is hardcoded — store the service account key file path in GOOGLE_APPLICATION_CREDENTIALS env var and reference it as %env(GOOGLE_APPLICATION_CREDENTIALS)%`,
        });
      }

      // allUsers / allAuthenticatedUsers ACL in config
      if (content.includes('allUsers') || content.includes('allAuthenticatedUsers')) {
        results.push({
          source: relFile,
          type: 'acl',
          detail: 'allUsers or allAuthenticatedUsers ACL in config',
          issue: `${relFile} references allUsers or allAuthenticatedUsers bucket ACL — this makes the GCS bucket publicly accessible; remove public ACL and use signed URLs or IAM-based access instead`,
        });
      }
    }
  }

  // Scan src/**/*.php for GCS patterns
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasGcs = content.includes('StorageClient') || content.includes('google/cloud-storage') || content.includes('Cloud\\Storage') || content.includes('GcsAdapter') || content.includes('GoogleCloudStorage');
    if (!hasGcs) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // StorageClient with keyFilePath hardcoded
      if (line.includes('StorageClient') || line.includes('new StorageClient')) {
        const contextEnd = Math.min(lines.length - 1, i + 10);
        const context = lines.slice(i, contextEnd + 1).join('\n');
        const hasHardcodedKey = /keyFilePath\s*=>\s*['"][^'"$%]{5,}['"]/i.test(context) || /key_file_path\s*=>\s*['"][^'"$%]{5,}['"]/i.test(context);
        const usesEnvVar = context.includes('getenv(') || context.includes('$_ENV[') || context.includes('$_SERVER[') || context.includes('env(');
        if (hasHardcodedKey && !usesEnvVar) {
          results.push({
            source: `${relFile}:${lineNum}`,
            type: 'key-path',
            detail: maskSecrets('StorageClient with hardcoded keyFilePath'),
            issue: `StorageClient at ${relFile}:${lineNum} uses hardcoded keyFilePath — set GOOGLE_APPLICATION_CREDENTIALS environment variable and use Application Default Credentials (ADC) instead`,
          });
        } else {
          results.push({ source: `${relFile}:${lineNum}`, type: 'package', detail: 'StorageClient instantiation', issue: null });
        }
      }

      // Bucket ACL set to allUsers or allAuthenticatedUsers
      if (line.includes('allUsers') || line.includes('allAuthenticatedUsers')) {
        const contextEnd = Math.min(lines.length - 1, i + 5);
        const context = lines.slice(i, contextEnd + 1).join('\n');
        const isAclSet = context.includes('acl') || context.includes('Acl') || context.includes('predefinedAcl') || context.includes('entity');
        if (isAclSet) {
          results.push({
            source: `${relFile}:${lineNum}`,
            type: 'acl',
            detail: 'Bucket/object ACL set to allUsers or allAuthenticatedUsers',
            issue: `GCS ACL set to public at ${relFile}:${lineNum} — allUsers/allAuthenticatedUsers makes objects publicly accessible; use signed URLs for temporary access or IAM Conditions for fine-grained control`,
          });
        }
      }

      // Signed URL TTL exceeding 7 days (GCS v4 max)
      if (line.includes('signedUrl') || line.includes('signed_url') || line.includes('->signUrl(') || line.includes('signUrl')) {
        const contextEnd = Math.min(lines.length - 1, i + 10);
        const context = lines.slice(i, contextEnd + 1).join('\n');
        // Check for TTL values > 7 days in seconds (604800), days, or explicit large values
        const ttlMatch = /(?:expires|expiration|ttl|duration)\s*[=>:]+\s*(\d+)/.exec(context);
        if (ttlMatch) {
          const ttlValue = parseInt(ttlMatch[1], 10);
          // If value > 604800 seconds = 7 days, or > 7 (could be days)
          if (ttlValue > 604800) {
            results.push({
              source: `${relFile}:${lineNum}`,
              type: 'signed-url',
              detail: `Signed URL TTL ${ttlValue} seconds (exceeds 7-day GCS maximum)`,
              issue: `GCS signed URL at ${relFile}:${lineNum} has TTL of ${ttlValue} seconds which exceeds the 7-day (604800s) maximum for v4 signed URLs; reduce the expiry to 7 days or less`,
            });
          } else {
            results.push({ source: `${relFile}:${lineNum}`, type: 'signed-url', detail: `Signed URL with TTL ${ttlValue}`, issue: null });
          }
        } else {
          results.push({ source: `${relFile}:${lineNum}`, type: 'signed-url', detail: 'Signed URL generation detected', issue: null });
        }
      }

      // Credentials JSON path in source — mask values
      if (/keyFilePath\s*=>\s*['"][^'"]{5,}['"]/.test(line) || /['"]private_key['"]\s*=>/.test(line)) {
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'credentials',
          detail: maskSecrets(safeKeyPath(line.trim())),
          issue: `Credentials reference at ${relFile}:${lineNum} — do not embed service account key file paths or private key values in source code; use GOOGLE_APPLICATION_CREDENTIALS env var or Workload Identity`,
        });
      }

      // Missing HMAC key rotation check (service account keys > 90 days via config comment)
      if (content.includes('hmacKey') || content.includes('hmac_key') || content.includes('HMAC')) {
        const hasRotationComment = content.includes('rotation') || content.includes('rotate') || content.includes('90') || content.includes('expire');
        if (!hasRotationComment) {
          results.push({
            source: `${relFile}:${lineNum}`,
            type: 'hmac',
            detail: 'HMAC key usage without rotation policy',
            issue: `${relFile} uses GCS HMAC keys without a rotation policy comment or check — HMAC keys older than 90 days should be rotated; implement key rotation or use Workload Identity instead`,
          });
          break;
        }
      }
    }
  }

  return results;
}

export function listGoogleCloudStorage(appPath: string): McpToolResult {
  try {
    const infos = buildGoogleCloudStorageInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Google Cloud Storage patterns found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Google Cloud Storage Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
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

export function getGoogleCloudStorageStats(appPath: string): McpToolResult {
  try {
    const infos = buildGoogleCloudStorageInfos(appPath);
    let text = `Google Cloud Storage Statistics\n${'='.repeat(40)}\n\n`;
    text += `Package detected:  ${infos.filter((i) => i.type === 'package').length}\n`;
    text += `ACL issues:        ${infos.filter((i) => i.type === 'acl').length}\n`;
    text += `Signed URL issues: ${infos.filter((i) => i.type === 'signed-url').length}\n`;
    text += `HMAC issues:       ${infos.filter((i) => i.type === 'hmac').length}\n`;
    text += `Key path issues:   ${infos.filter((i) => i.type === 'key-path').length}\n`;
    text += `Credential issues: ${infos.filter((i) => i.type === 'credentials').length}\n`;
    text += `Total issues:      ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGoogleCloudStorageTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_google_cloud_storage',
      description: 'Scan src/**/*.php, composer.json, config/**/*.yaml for Google Cloud Storage patterns: google/cloud-storage in composer.json, bucket allUsers/allAuthenticatedUsers ACL (public access), signed URL TTL > 7 days (GCS v4 max), HMAC key without rotation policy, StorageClient with hardcoded keyFilePath instead of env var, credentials JSON path (masked).',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_google_cloud_storage_stats',
      description: 'Statistics for Google Cloud Storage: package/acl/signed-url/hmac/key-path/credentials issue counts.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
