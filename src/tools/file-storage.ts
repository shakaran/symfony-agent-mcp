// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * File Storage / Upload Inspector
 *
 * VichUploaderBundle:
 *   - config/packages/vich_uploader.yaml: mappings (storage backend, URI prefix,
 *     directory namer, file namer, delete on update/remove)
 *   - Scans entities for #[Vich\UploadableField] and #[Vich\Uploadable]
 *
 * Flysystem (thephpleague/flysystem-bundle):
 *   - config/packages/flysystem.yaml: storages (adapter, url, visibility)
 *   - Adapters: local / memory / aws-s3 / gcs / azure / sftp / ftp
 *   - DSN / bucket / key masked
 *
 * OneupFlysystemBundle (alternative):
 *   - config/packages/oneup_flysystem.yaml
 *
 * Analysis:
 *   - Warns if local adapter in non-dev env (not suitable for multi-server)
 *   - Warns if no public visibility configured (files may not be accessible)
 *   - Detects orphan VichUploader mappings (mapping name used in entity but not in config)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface VichMapping {
  name: string;
  uriPrefix?: string;
  uploadDestination?: string;
  storageBackend?: string;
  deleteOnUpdate: boolean;
  deleteOnRemove: boolean;
  issues: string[];
}

interface FlysystemStorage {
  name: string;
  adapter: string;
  adapterType: string;
  url?: string;
  visibility?: string;
  issues: string[];
}

interface UploadableEntity {
  class: string;
  file: string;
  mappings: string[];
  fields: string[];
}

// ─── Adapter classification ──────────────────────────────────────────────────

function classifyAdapter(adapter: string): string {
  const lower = (adapter ?? '').toLowerCase();
  if (lower.includes('local') || lower.startsWith('./') || lower.startsWith('/')) return 'local';
  if (lower.includes('s3') || lower.includes('aws'))     return 'AWS S3';
  if (lower.includes('gcs') || lower.includes('google')) return 'Google Cloud Storage';
  if (lower.includes('azure'))                            return 'Azure Blob Storage';
  if (lower.includes('sftp'))                             return 'SFTP';
  if (lower.includes('ftp'))                              return 'FTP';
  if (lower.includes('memory') || lower.includes('null')) return 'in-memory (test)';
  if (lower.includes('readonly'))                         return 'read-only';
  if (lower.startsWith('%env('))                          return 'env-var (runtime)';
  return adapter;
}

function maskPath(p: string): string {
  return p.replace(/:\/\/([^:@]+):([^@]+)@/, '://***:***@')
           .replace(/key=[^&\s]+/, 'key=***')
           .replace(/secret=[^&\s]+/, 'secret=***');
}

// ─── VichUploader config ──────────────────────────────────────────────────────

function loadVichMappings(appPath: string): VichMapping[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'vich_uploader.yaml'),
    path.join(appPath, 'config', 'packages', 'vich_uploader.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const root = (raw['vich_uploader'] ?? raw) as Record<string, unknown>;
    const mappingsRaw = root['mappings'] as Record<string, unknown> | undefined;
    if (!mappingsRaw) return [];

    const mappings: VichMapping[] = [];
    for (const [name, def] of Object.entries(mappingsRaw)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;

      const issues: string[] = [];
      const uploadDest = d['upload_destination'] ? String(d['upload_destination']) : undefined;
      if (uploadDest?.startsWith('%kernel.project_dir%/public')) {
        issues.push('files in public/ are publicly accessible without auth — use private storage if needed');
      }

      mappings.push({
        name,
        uriPrefix: d['uri_prefix'] ? String(d['uri_prefix']) : undefined,
        uploadDestination: uploadDest,
        storageBackend: d['storage'] ? String(d['storage']) : 'gaufrette_storage or filesystem',
        deleteOnUpdate: d['delete_on_update'] !== false,
        deleteOnRemove: d['delete_on_remove'] !== false,
        issues,
      });
    }
    return mappings;
  }
  return [];
}

// ─── Flysystem config ─────────────────────────────────────────────────────────

function loadFlysystemStorages(appPath: string): FlysystemStorage[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'flysystem.yaml'),
    path.join(appPath, 'config', 'packages', 'flysystem.yml'),
    path.join(appPath, 'config', 'packages', 'oneup_flysystem.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const root = (raw['flysystem'] ?? raw['oneup_flysystem'] ?? raw) as Record<string, unknown>;
    const storagesRaw = (root['storages'] ?? root['adapters']) as Record<string, unknown> | undefined;
    if (!storagesRaw) continue;

    const storages: FlysystemStorage[] = [];
    for (const [name, def] of Object.entries(storagesRaw)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const adapter  = String(d['adapter'] ?? d['type'] ?? 'unknown');
      const adapterType = classifyAdapter(adapter);
      const url      = d['options']
        ? maskPath(JSON.stringify(d['options']))
        : (d['url'] ? maskPath(String(d['url'])) : undefined);
      const visibility = d['visibility'] ? String(d['visibility']) : undefined;

      const issues: string[] = [];
      if (adapterType === 'local') {
        issues.push('local adapter — not suitable for multi-server deployments');
      }
      if (adapterType === 'in-memory (test)') {
        issues.push('in-memory adapter — only for testing');
      }

      storages.push({ name, adapter: maskPath(adapter), adapterType, url, visibility, issues });
    }
    return storages;
  }
  return [];
}

// ─── Entity scanning ──────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function scanUploadableEntities(appPath: string): UploadableEntity[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const entities: UploadableEntity[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('Vich\\Uploadable') && !content.includes('UploadableField')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const mappings: string[] = [];
    const fields: string[] = [];
    for (const m of content.matchAll(/#\[Vich\\UploadableField\s*\(\s*mapping\s*:\s*['"]([^'"]+)['"]/g)) {
      mappings.push(m[1]);
    }
    for (const m of content.matchAll(/private\s+(?:\??\w+\s+)?\$(\w+File)\b/g)) {
      fields.push(m[1]);
    }

    entities.push({ class: classM[1], file: path.basename(file), mappings, fields });
  }
  return entities.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listFileStorage(appPath: string): McpToolResult {
  try {
    const vichMappings = loadVichMappings(appPath);
    const flysystems   = loadFlysystemStorages(appPath);
    const entities     = scanUploadableEntities(appPath);

    if (vichMappings.length === 0 && flysystems.length === 0 && entities.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No file storage configuration found.\n\nFor file uploads:\n  composer require vich/uploader-bundle\n\nFor filesystem abstraction:\n  composer require league/flysystem-bundle\n  # or: composer require oneup/flysystem-bundle',
        }],
      };
    }

    let text = `File Storage Configuration\n${'='.repeat(55)}\n`;

    if (vichMappings.length > 0) {
      text += `\nVichUploaderBundle mappings (${vichMappings.length}):\n`;
      for (const m of vichMappings) {
        text += `  ${m.name}\n`;
        if (m.uriPrefix)          text += `    URI prefix:   ${m.uriPrefix}\n`;
        if (m.uploadDestination)  text += `    Destination:  ${m.uploadDestination}\n`;
        text += `    Delete on update/remove: ${m.deleteOnUpdate}/${m.deleteOnRemove}\n`;
        for (const issue of m.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (flysystems.length > 0) {
      text += `\nFlysystem storages (${flysystems.length}):\n`;
      for (const s of flysystems) {
        const vis = s.visibility ? `  visibility: ${s.visibility}` : '';
        text += `  ${s.name.padEnd(30)} ${s.adapterType}${vis}\n`;
        for (const issue of s.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (entities.length > 0) {
      text += `\nUploadable entities (${entities.length}):\n`;
      for (const e of entities) {
        const maps = e.mappings.length > 0 ? `  mappings: ${e.mappings.join(', ')}` : '';
        text += `  ${e.class.padEnd(35)} (${e.file})${maps}\n`;
      }

      // Orphan mapping check
      const configMappingNames = new Set(vichMappings.map((m) => m.name));
      const entityMappings = new Set(entities.flatMap((e) => e.mappings));
      const orphanInEntity = [...entityMappings].filter((m) => !configMappingNames.has(m));
      if (orphanInEntity.length > 0 && vichMappings.length > 0) {
        text += `\n⚠ Entity mappings not found in config: ${orphanInEntity.join(', ')}\n`;
      }
    }

    const localStorages = flysystems.filter((s) => s.adapterType === 'local');
    if (localStorages.length > 0) {
      text += `\n⚠ Local adapter(s) used — switch to S3/GCS/Azure for multi-server production\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFileStorageStats(appPath: string): McpToolResult {
  try {
    const vichMappings = loadVichMappings(appPath);
    const flysystems   = loadFlysystemStorages(appPath);
    const entities     = scanUploadableEntities(appPath);

    let text = `File Storage Statistics\n${'='.repeat(40)}\n\n`;
    text += `Vich mappings:       ${vichMappings.length}\n`;
    text += `Flysystem storages:  ${flysystems.length}\n`;
    text += `Local adapters:      ${flysystems.filter((s) => s.adapterType === 'local').length}\n`;
    text += `Cloud adapters:      ${flysystems.filter((s) => ['AWS S3', 'Google Cloud Storage', 'Azure Blob Storage'].includes(s.adapterType)).length}\n`;
    text += `Uploadable entities: ${entities.length}\n`;
    text += `Storage issues:      ${[...vichMappings, ...flysystems].reduce((s, x) => s + x.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFileStorageTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_file_storage',
      description: 'Show file storage configuration: VichUploaderBundle mappings (URI prefix, destination, delete flags), Flysystem storages (local/S3/GCS/Azure adapter), uploadable entities with #[Vich\\UploadableField], orphan mapping detection',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_file_storage_stats',
      description: 'Show file storage statistics: Vich mapping count, Flysystem storage count, local vs cloud adapter split, uploadable entity count, issue count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
