import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface VersionedEntityInfo {
  file: string;
  type: 'versioned' | 'unversioned' | 'config' | 'strategy';
  pattern: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function buildVersionedEntityInfos(appPath: string): VersionedEntityInfo[] {
  const results: VersionedEntityInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  const checkFiles = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) checkFiles(full);
        else if (e.name.endsWith('.php')) {
          let content = '';
          try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
          if (!content.includes('@ORM\\') && !content.includes('#[ORM\\') && !content.includes('use Doctrine\\ORM\\Mapping')) return;

          const relFile = path.relative(appPath, full);
          const isEntity = content.includes('@ORM\\Entity') || content.includes('#[ORM\\Entity');
          if (!isEntity) return;

          const hasVersion = content.includes('@ORM\\Version') || content.includes('#[ORM\\Version');
          const hasCreatedAt = content.includes('createdAt') || content.includes('created_at');
          const hasUpdatedAt = content.includes('updatedAt') || content.includes('updated_at');
          const hasSoftDelete = content.includes('deletedAt') || content.includes('deleted_at') || content.includes('SoftDeleteable');
          const hasLoggable = content.includes('@Gedmo\\Loggable') || content.includes('Loggable') || content.includes('LogEntry');
          const isMutable = !content.includes('readonly class');

          const issues: string[] = [];

          if (hasVersion) {
            const hasOptimisticLock = content.includes('OPTIMISTIC') || content.includes('optimistic') || content.includes('lockMode');
            if (!hasOptimisticLock) {
              issues.push(`Versioned entity "${relFile}" without optimistic locking — @ORM\\Version column is defined but Lock::OPTIMISTIC is not passed to EntityManager::lock(); concurrent updates may overwrite silently`);
            }
            results.push({ file: relFile, type: 'versioned', pattern: '@ORM\\Version field', issues });
          } else if (isMutable && (hasCreatedAt || hasUpdatedAt)) {
            const hasAuditTrail = hasLoggable || content.includes('EntityListener') || content.includes('PostPersist') || content.includes('PreUpdate');
            if (!hasAuditTrail) {
              issues.push(`Entity "${relFile}" tracks timestamps but has no version/audit trail — consider @Gedmo\\Loggable or @ORM\\Version to track changes and support concurrent edit detection`);
            }
            results.push({ file: relFile, type: 'unversioned', pattern: 'mutable entity without version', issues });
          }

          if (hasSoftDelete && !content.includes('deletedAt') && content.includes('SoftDeleteable')) {
            issues.push(`SoftDeleteable in "${relFile}" without deletedAt field — the Gedmo SoftDeleteable extension requires a nullable DateTime deletedAt column`);
          }
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  const doctrineYaml = path.join(appPath, 'config', 'packages', 'doctrine.yaml');
  if (fs.existsSync(doctrineYaml)) {
    let content = '';
    try { content = fs.readFileSync(doctrineYaml, 'utf-8'); } catch { /* skip */ }
    if (content.includes('loggable') || content.includes('Loggable')) {
      results.push({ file: 'config/packages/doctrine.yaml', type: 'config', pattern: 'Gedmo Loggable extension', issues: [] });
    }
  }

  return results;
}

export function listDoctrineVersionedEntities(appPath: string): McpToolResult {
  try {
    const infos = buildVersionedEntityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No versioned entity patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Versioned Entities Analysis\n${'='.repeat(55)}\n\nEntities: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineVersionedEntitiesStats(appPath: string): McpToolResult {
  try {
    const infos = buildVersionedEntityInfos(appPath);
    let text = `Doctrine Versioned Entities Statistics\n${'='.repeat(40)}\n\n`;
    text += `Versioned:    ${infos.filter((i) => i.type === 'versioned').length}\n`;
    text += `Unversioned:  ${infos.filter((i) => i.type === 'unversioned').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineVersionedEntitiesTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_versioned_entities', description: 'Analyze Doctrine entity versioning; warns on @ORM\\Version without optimistic locking, mutable entities without audit trail, SoftDeleteable without deletedAt field, missing Gedmo Loggable config', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_versioned_entities_stats', description: 'Statistics for versioned entities: versioned/unversioned count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
