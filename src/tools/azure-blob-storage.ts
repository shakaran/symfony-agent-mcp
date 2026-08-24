// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface AzureBlobStorageInfo {
  source: string;
  type: 'package' | 'sas' | 'acl' | 'connection-string' | 'retry' | 'content-type';
  detail: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskConnectionString(value: string): string {
  return value
    .replace(/(AccountKey=)[^;'"\s]*/gi, '$1***')
    .replace(/(SharedAccessSignature=)[^;'"\s]*/gi, '$1***')
    .replace(/(&sig=)[^&;\s]*/gi, '$1***')
    .replace(/(\bsig=)[^&;\s]*/gi, '$1***');
}

function maskSecrets(value: string): string {
  return value.replace(/(AccountKey|account_key|SAS_TOKEN|sas_token|AZURE_STORAGE_KEY)\s*[=:]\s*\S+/gi, '$1=***');
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

function buildAzureBlobStorageInfos(appPath: string): AzureBlobStorageInfo[] {
  const results: AzureBlobStorageInfo[] = [];

  // Check composer.json for Azure storage packages
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (composerContent.includes('azure/storage-blob') || composerContent.includes('azure-storage-blob')) {
      results.push({ source: 'composer.json', type: 'package', detail: 'azure/storage-blob package detected', issue: null });
    }
    if (composerContent.includes('microsoft/azure-storage-blob') || composerContent.includes('microsoft/azure-storage')) {
      results.push({ source: 'composer.json', type: 'package', detail: 'microsoft/azure-storage-blob package detected', issue: null });
    }
    if (composerContent.includes('league/flysystem-azure-blob-storage')) {
      results.push({ source: 'composer.json', type: 'package', detail: 'league/flysystem-azure-blob-storage detected', issue: null });
    }
  }

  // Scan .env* files for Azure connection strings and SAS tokens
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    // Connection string with AccountKey — detect and mask
    const connStringMatch = /AZURE_STORAGE_CONNECTION_STRING\s*=\s*([^\n#]{1,400})/.exec(content) ?? /DefaultEndpointsProtocol=https;AccountName=[^;\n]{1,100};AccountKey=[^\n]{1,300}/.exec(content);
    if (connStringMatch) {
      const raw = connStringMatch[1] ?? connStringMatch[0];
      results.push({
        source: fname,
        type: 'connection-string',
        detail: maskConnectionString(raw.trim()),
        issue: `Azure Storage connection string with AccountKey in ${fname} — connection strings with account keys grant full access to the storage account; use Azure AD authentication (DefaultAzureCredential) or SAS tokens with minimal permissions instead`,
      });
    }

    // SAS token in .env without expiry comment
    const sasMatch = /(?:SAS_TOKEN|AZURE_SAS_TOKEN|BLOB_SAS_TOKEN)\s*=\s*([^\n#]{1,400})/.exec(content);
    if (sasMatch) {
      const sasVal = sasMatch[1].trim();
      const hasExpiry = content.includes('se=') || content.includes('expiry') || content.includes('Expiry') || content.includes('expires');
      results.push({
        source: fname,
        type: 'sas',
        detail: maskSecrets(`SAS_TOKEN=${sasVal.substring(0, 30)}...`),
        issue: hasExpiry ? null : `SAS token in ${fname} without apparent expiry check — SAS tokens should have short TTLs; verify the token has se= (signedExpiry) parameter and rotate before expiry`,
      });
    }

    // Azure Storage account key
    const accountKeyMatch = /AZURE_STORAGE_KEY\s*=\s*([^\n#]{1,200})/.exec(content);
    if (accountKeyMatch) {
      const raw = accountKeyMatch[1].trim();
      if (raw && !raw.startsWith('%env(') && !raw.startsWith('${')) {
        results.push({
          source: fname,
          type: 'connection-string',
          detail: maskSecrets(`AZURE_STORAGE_KEY=${raw}`),
          issue: `AZURE_STORAGE_KEY (account key) in ${fname} — storage account keys grant full access; use Azure AD managed identity or SAS tokens with least-privilege permissions`,
        });
      }
    }
  }

  // Scan src/**/*.php for Azure Blob Storage patterns
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasAzure = content.includes('BlobServiceClient') || content.includes('BlobClient') || content.includes('ContainerClient') || content.includes('azure-storage') || content.includes('AzureBlobStorage') || content.includes('BlockBlobClient');
    if (!hasAzure) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    // Check for retry policy
    const hasRetry = content.includes('RetryMiddlewareFactory') || content.includes('RetryPolicy') || content.includes('retry') || content.includes('Retry') || content.includes('maxRetries');
    if (!hasRetry) {
      results.push({
        source: relFile,
        type: 'retry',
        detail: 'Azure Blob client without retry policy',
        issue: `${relFile} uses Azure Blob Storage without retry policy — Azure SDK transient failures are common; configure RetryMiddlewareFactory or RetryOptions to handle throttling and transient errors`,
      });
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Connection string hardcoded in source
      const connStringInCode = /DefaultEndpointsProtocol=https;AccountName=[^;'"]{1,100};AccountKey=[^;'"]{10,}/.exec(line);
      if (connStringInCode) {
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'connection-string',
          detail: maskConnectionString(connStringInCode[0]),
          issue: `Azure Storage connection string with AccountKey hardcoded at ${relFile}:${lineNum} — extract to AZURE_STORAGE_CONNECTION_STRING env var and use Azure AD authentication instead of account keys`,
        });
      }

      // Container access policy set to container or blob (public)
      if (line.includes('PublicAccessType') || line.includes('publicAccess') || line.includes('public_access')) {
        if (line.includes('Container') || line.includes('Blob') || line.includes('container') || line.includes('blob')) {
          const contextEnd = Math.min(lines.length - 1, i + 5);
          const context = lines.slice(i, contextEnd + 1).join('\n');
          const isPublic = /PublicAccessType::(Container|Blob)/i.test(context) || /publicAccess\s*[=>:]+\s*['"](?:container|blob)['"]/i.test(context);
          if (isPublic) {
            results.push({
              source: `${relFile}:${lineNum}`,
              type: 'acl',
              detail: 'Container access policy set to public (container or blob level)',
              issue: `Azure Blob container at ${relFile}:${lineNum} has public access (container or blob level) — disable anonymous public access and use SAS tokens or Azure AD for client access`,
            });
          }
        }
      }

      // SAS token in source without expiry check
      if (line.includes('generateSasToken') || line.includes('generate_sas') || line.includes('SasSignatureValues') || line.includes('BlobSasPermissions')) {
        const contextEnd = Math.min(lines.length - 1, i + 15);
        const context = lines.slice(i, contextEnd + 1).join('\n');
        const hasExpiry = context.includes('expiresOn') || context.includes('expires_on') || context.includes('ExpiresOn') || context.includes('Expiry') || context.includes('+');
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'sas',
          detail: 'SAS token generation',
          issue: hasExpiry ? null : `SAS token generated at ${relFile}:${lineNum} without explicit expiresOn — SAS tokens without expiry are valid indefinitely; always set expiresOn to a short TTL (e.g., 1 hour)`,
        });
      }

      // Uploading blob without content-type header
      if (line.includes('upload') || line.includes('Upload') || line.includes('->upload(') || line.includes('putBlob')) {
        const contextEnd = Math.min(lines.length - 1, i + 10);
        const context = lines.slice(i, contextEnd + 1).join('\n');
        const hasContentType = context.includes('ContentType') || context.includes('content_type') || context.includes('contentType') || context.includes('Content-Type') || context.includes('mime');
        if (!hasContentType) {
          results.push({
            source: `${relFile}:${lineNum}`,
            type: 'content-type',
            detail: 'Blob upload without content-type header',
            issue: `Blob upload at ${relFile}:${lineNum} without Content-Type header — blobs served without Content-Type default to application/octet-stream, preventing browsers from rendering files correctly; set ContentType in BlobHttpHeaders`,
          });
        }
      }
    }
  }

  // Scan config/**/*.yaml for Azure storage configuration
  const configDir = path.join(appPath, 'config');
  if (fs.existsSync(configDir)) {
    const configFiles = [
      ...scanDirRecursive(configDir, '.yaml'),
      ...scanDirRecursive(configDir, '.yml'),
    ];
    for (const fpath of configFiles) {
      const content = safeRead(fpath, appPath);
      if (!content) continue;
      if (!content.includes('azure') && !content.includes('Azure') && !content.includes('blob')) continue;
      const relFile = path.relative(appPath, fpath);

      // Connection string in YAML config
      const connInYaml = /DefaultEndpointsProtocol=https;AccountName=[^;\n]{1,100};AccountKey=[^\n]{10,}/.exec(content);
      if (connInYaml) {
        results.push({
          source: relFile,
          type: 'connection-string',
          detail: maskConnectionString(connInYaml[0]),
          issue: `Azure Storage connection string with AccountKey in ${relFile} — move to .env and reference via %env(AZURE_STORAGE_CONNECTION_STRING)%`,
        });
      } else {
        results.push({ source: relFile, type: 'package', detail: 'Azure Blob Storage config reference', issue: null });
      }
    }
  }

  return results;
}

export function listAzureBlobStorage(appPath: string): McpToolResult {
  try {
    const infos = buildAzureBlobStorageInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Azure Blob Storage patterns found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Azure Blob Storage Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
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

export function getAzureBlobStorageStats(appPath: string): McpToolResult {
  try {
    const infos = buildAzureBlobStorageInfos(appPath);
    let text = `Azure Blob Storage Statistics\n${'='.repeat(40)}\n\n`;
    text += `Package detected:       ${infos.filter((i) => i.type === 'package').length}\n`;
    text += `SAS token issues:       ${infos.filter((i) => i.type === 'sas').length}\n`;
    text += `ACL issues:             ${infos.filter((i) => i.type === 'acl').length}\n`;
    text += `Connection str issues:  ${infos.filter((i) => i.type === 'connection-string').length}\n`;
    text += `Retry policy issues:    ${infos.filter((i) => i.type === 'retry').length}\n`;
    text += `Content-type issues:    ${infos.filter((i) => i.type === 'content-type').length}\n`;
    text += `Total issues:           ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAzureBlobStorageTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_azure_blob_storage',
      description: 'Scan src/**/*.php, composer.json, config/**/*.yaml, .env* for Azure Blob Storage patterns: azure/storage-blob or microsoft/azure-storage-blob in composer.json, SAS token without expiry, container access set to container/blob (public), connection string with AccountKey (masked), missing retry policy (RetryMiddlewareFactory), blob upload without Content-Type header.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_azure_blob_storage_stats',
      description: 'Statistics for Azure Blob Storage: package/sas/acl/connection-string/retry/content-type issue counts.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
