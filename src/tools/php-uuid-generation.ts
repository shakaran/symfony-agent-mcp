import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface UuidGenerationInfo {
  file: string;
  library: 'ramsey/uuid' | 'symfony/uid' | 'native' | 'custom';
  version: string;
  usage: string;
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full, base));
    } else if (entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

function getComposerLibraryVersion(composerJson: Record<string, unknown>, packageName: string): string {
  const require = (composerJson['require'] ?? {}) as Record<string, string>;
  const requireDev = (composerJson['require-dev'] ?? {}) as Record<string, string>;
  return require[packageName] ?? requireDev[packageName] ?? '';
}

function buildUuidGenerationInfos(appPath: string): UuidGenerationInfo[] {
  const results: UuidGenerationInfo[] = [];

  // Read composer.json for library detection
  const composerPath = path.join(appPath, 'composer.json');
  const resolvedComposer = path.resolve(composerPath);
  let composerJson: Record<string, unknown> = {};
  if (resolvedComposer.startsWith(path.resolve(appPath) + path.sep) || resolvedComposer === path.resolve(appPath)) {
    try {
      const raw = fs.readFileSync(composerPath, 'utf-8');
      composerJson = JSON.parse(raw) as Record<string, unknown>;
    } catch { /* skip */ }
  }

  const ramseyVersion = getComposerLibraryVersion(composerJson, 'ramsey/uuid');
  const symfonyUidVersion = getComposerLibraryVersion(composerJson, 'symfony/uid');

  // Composer-level findings
  if (ramseyVersion) {
    results.push({
      file: 'composer.json',
      library: 'ramsey/uuid',
      version: ramseyVersion,
      usage: `ramsey/uuid ${ramseyVersion} installed — ensure UuidInterface type hints are used for DI compatibility`,
    });
  }
  if (symfonyUidVersion) {
    results.push({
      file: 'composer.json',
      library: 'symfony/uid',
      version: symfonyUidVersion,
      usage: `symfony/uid ${symfonyUidVersion} installed — prefer Uuid::v7() for time-ordered UUIDs or Ulid for sortable IDs`,
    });
  }

  // Scan PHP source files
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);

  for (const file of files) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    // ramsey/uuid patterns
    if (content.includes('Uuid::uuid4()') || content.includes('Uuid::uuid1()') || content.includes('Uuid::uuid6()')) {
      const match = /Uuid::(uuid\d)\(\)/.exec(content);
      const ver = match ? match[1] : 'uuid4';
      results.push({
        file: path.relative(appPath, file),
        library: 'ramsey/uuid',
        version: ramseyVersion || 'unknown',
        usage: `Ramsey ${ver}() used — prefer uuid7() for time-ordered IDs if ramsey/uuid >=4.x`,
      });
    }

    // symfony/uid patterns
    if (content.includes('Uuid::v4()') || content.includes('Uuid::v6()') || content.includes('Uuid::v7()')) {
      const match = /Uuid::(v\d)\(\)/.exec(content);
      const ver = match ? match[1] : 'v4';
      results.push({
        file: path.relative(appPath, file),
        library: 'symfony/uid',
        version: symfonyUidVersion || 'unknown',
        usage: `Symfony Uid ${ver}() used${ver === 'v4' ? ' — consider v7() for time-ordered sortable UUIDs' : ''}`,
      });
    }

    // Ulid
    if (content.includes('Ulid::generate()') || content.includes('new Ulid(')) {
      results.push({
        file: path.relative(appPath, file),
        library: 'symfony/uid',
        version: symfonyUidVersion || 'unknown',
        usage: 'Ulid used — good choice for sortable, URL-safe unique IDs; ensure monotonic generation in high-throughput scenarios',
      });
    }

    // Native PHP uuid functions
    if (content.includes('uuid_create(')) {
      results.push({
        file: path.relative(appPath, file),
        library: 'native',
        version: 'ext-uuid',
        usage: 'uuid_create() from ext-uuid — requires ext-uuid extension; prefer symfony/uid or ramsey/uuid for portability',
      });
    }

    // COM/Windows GUID
    if (content.includes('com_create_guid(')) {
      results.push({
        file: path.relative(appPath, file),
        library: 'native',
        version: 'ext-com_dotnet',
        usage: 'com_create_guid() — Windows-only; replace with symfony/uid or ramsey/uuid for cross-platform compatibility',
      });
    }

    // Custom sprintf UUID
    if (content.includes("sprintf('%04x") || content.includes('sprintf("%04x') ||
        content.includes("sprintf('%08x") || content.includes('sprintf("%08x')) {
      results.push({
        file: path.relative(appPath, file),
        library: 'custom',
        version: 'none',
        usage: 'Custom sprintf-based UUID generation detected — use a proper UUID library; custom implementations may have entropy or format issues',
      });
    }
  }

  return results;
}

export function listPhpUuidGeneration(appPath: string): McpToolResult {
  try {
    const infos = buildUuidGenerationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP UUID generation patterns found.' }] };
    }
    const lines = infos.map(i =>
      `${i.file} [${i.library} ${i.version}]\n  ${i.usage}`
    );
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpUuidGenerationStats(appPath: string): McpToolResult {
  try {
    const infos = buildUuidGenerationInfos(appPath);
    const stats = {
      total: infos.length,
      byLibrary: {} as Record<string, number>,
    };
    for (const i of infos) {
      stats.byLibrary[i.library] = (stats.byLibrary[i.library] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpUuidGenerationTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_php_uuid_generation',
      description: 'List PHP UUID generation patterns: ramsey/uuid, symfony/uid, native ext-uuid, com_create_guid, and custom sprintf implementations — flags suboptimal UUID versions and portability issues.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    },
    {
      name: 'get_php_uuid_generation_stats',
      description: 'Get statistics for PHP UUID generation: total occurrences grouped by library (ramsey/uuid, symfony/uid, native, custom).',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    }
  ];
}
