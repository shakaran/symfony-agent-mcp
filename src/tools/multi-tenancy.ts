/**
 * Multi-Tenancy Pattern Detector
 *
 * Detects common multi-tenant patterns in Symfony applications:
 *
 * Doctrine-based isolation:
 *   - Discriminator columns / inheritance (@InheritanceType / #[InheritanceType])
 *   - Doctrine Filters (classes implementing SQLFilter) — often used for tenant scoping
 *   - Multiple DBAL connections in doctrine.yaml (tenant-per-DB approach)
 *   - SoftDeleteable + tenant scoping from stof/doctrine-extensions
 *
 * Tenant entity detection:
 *   - Entity named Tenant / Organisation / Organization / Company / Account
 *   - ManyToOne/ManyToMany to Tenant from other entities
 *
 * Middleware / request handling:
 *   - EventListener/Subscriber setting tenant context from Host header or JWT claim
 *   - Classes containing 'Tenant', 'Middleware' in name + RequestEvent handling
 *
 * Config per tenant:
 *   - Multiple .env files by tenant (e.g. .env.tenant-*)
 *   - Multiple doctrine connections by tenant prefix in doctrine.yaml
 *
 * Risks:
 *   - Entities referencing tenant but no Doctrine Filter found (data leakage risk)
 *   - Single DB with no filter (shared schema without row-level isolation)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface TenantEntity {
  class: string;
  file: string;
  isTenantRoot: boolean;
  hasTenantRelation: boolean;
}

interface DoctrineFilter {
  class: string;
  file: string;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

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

const TENANT_NAMES = ['Tenant', 'Organisation', 'Organization', 'Company', 'Account', 'Workspace', 'Team'];

function scanTenantEntities(appPath: string): TenantEntity[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: TenantEntity[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('#[ORM\\Entity') && !content.includes('@ORM\\Entity')) continue;
    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;
    const className = classM[1];

    const isTenantRoot = TENANT_NAMES.some((n) => className === n || className.endsWith(n));
    const hasTenantRelation = TENANT_NAMES.some((n) =>
      new RegExp(`@ORM\\\\ManyToOne.*${n}|#\\[ORM\\\\ManyToOne[^]]*${n}|\\$tenant\\b|\\$organisation\\b|\\$organization\\b`, 'i').test(content)
    );

    if (isTenantRoot || hasTenantRelation) {
      results.push({ class: className, file: path.basename(file), isTenantRoot, hasTenantRelation });
    }
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

function scanDoctrineFilters(appPath: string): DoctrineFilter[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: DoctrineFilter[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('SQLFilter') && !content.includes('AbstractFilter')) continue;
    const classM = /class\s+(\w+)/.exec(content);
    if (classM) results.push({ class: classM[1], file: path.basename(file) });
  }
  return results;
}

function scanTenantListeners(appPath: string): string[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const listeners: string[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const lower = content.toLowerCase();
    if (
      (lower.includes('tenant') || lower.includes('organisation') || lower.includes('organization')) &&
      (content.includes('RequestEvent') || content.includes('onKernelRequest') || content.includes('EventSubscriberInterface'))
    ) {
      const classM = /class\s+(\w+)/.exec(content);
      if (classM) listeners.push(classM[1]);
    }
  }
  return listeners.sort();
}

function countDoctrineConnections(appPath: string): number {
  const candidates = ['config/packages/doctrine.yaml', 'config/packages/doctrine.yml'];
  for (const fname of candidates) {
    const raw = parseYamlFile(path.join(appPath, fname)) as Record<string, unknown> | null;
    if (!raw) continue;
    const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
    const dbal = doctrine['dbal'] as Record<string, unknown> | undefined;
    if (!dbal) return 0;
    const connections = dbal['connections'] as Record<string, unknown> | undefined;
    return connections ? Object.keys(connections).length : 1;
  }
  return 0;
}

function detectTenantEnvFiles(appPath: string): string[] {
  try {
    return fs.readdirSync(appPath)
      .filter((f) => /^\.env\.(tenant|org|company|workspace)/.test(f));
  } catch { return []; }
}

export function listMultitenancyConfig(appPath: string): McpToolResult {
  try {
    const entities    = scanTenantEntities(appPath);
    const filters     = scanDoctrineFilters(appPath);
    const listeners   = scanTenantListeners(appPath);
    const connections = countDoctrineConnections(appPath);
    const envFiles    = detectTenantEnvFiles(appPath);

    if (entities.length === 0 && filters.length === 0 && listeners.length === 0 && envFiles.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No multi-tenancy patterns detected.\n\nCommon approaches:\n  - Doctrine Filters (row-level isolation)\n  - Multiple DBAL connections (DB-per-tenant)\n  - Tenant entity with ManyToOne on all other entities',
        }],
      };
    }

    let text = `Multi-Tenancy Configuration\n${'='.repeat(55)}\n`;

    if (connections > 1) {
      text += `\nDoctrine connections: ${connections} (DB-per-tenant pattern likely)\n`;
    }

    if (entities.length > 0) {
      const roots    = entities.filter((e) => e.isTenantRoot);
      const related  = entities.filter((e) => !e.isTenantRoot && e.hasTenantRelation);
      if (roots.length > 0) {
        text += `\nTenant root entities (${roots.length}):\n`;
        for (const e of roots) text += `  ${e.class}  (${e.file})\n`;
      }
      if (related.length > 0) {
        text += `\nEntities with tenant relation (${related.length}):\n`;
        for (const e of related) text += `  ${e.class}  (${e.file})\n`;
      }
    }

    if (filters.length > 0) {
      text += `\nDoctrine SQL Filters (${filters.length}) — row-level isolation:\n`;
      for (const f of filters) text += `  ${f.class}  (${f.file})\n`;
    }

    if (listeners.length > 0) {
      text += `\nTenant context listeners/subscribers (${listeners.length}):\n`;
      for (const l of listeners) text += `  ${l}\n`;
    }

    if (envFiles.length > 0) {
      text += `\nTenant-specific env files (${envFiles.length}):\n`;
      for (const f of envFiles) text += `  ${f}\n`;
    }

    // Risk analysis
    if (entities.filter((e) => e.hasTenantRelation).length > 0 && filters.length === 0 && connections <= 1) {
      text += `\n⚠ Tenant-related entities found but no Doctrine Filter detected — verify row-level isolation is enforced\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMultitenancyStats(appPath: string): McpToolResult {
  try {
    const entities    = scanTenantEntities(appPath);
    const filters     = scanDoctrineFilters(appPath);
    const listeners   = scanTenantListeners(appPath);
    const connections = countDoctrineConnections(appPath);
    const envFiles    = detectTenantEnvFiles(appPath);

    let text = `Multi-Tenancy Statistics\n${'='.repeat(40)}\n\n`;
    text += `Tenant root entities:   ${entities.filter((e) => e.isTenantRoot).length}\n`;
    text += `Tenant-related entities: ${entities.filter((e) => e.hasTenantRelation).length}\n`;
    text += `Doctrine SQL filters:   ${filters.length}\n`;
    text += `Tenant listeners:       ${listeners.length}\n`;
    text += `DBAL connections:       ${connections || 'unknown'}\n`;
    text += `Tenant env files:       ${envFiles.length}\n`;
    const approach = connections > 1 ? 'DB-per-tenant'
      : filters.length > 0 ? 'row-level isolation (Doctrine Filter)'
      : entities.length > 0 ? 'entity-based (verify isolation)'
      : 'not detected';
    text += `Approach detected:      ${approach}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMultiTenancyTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_multitenancy_config',
      description: 'Show multi-tenancy patterns: tenant root entities (Tenant/Organization/Company), Doctrine SQL filters for row-level isolation, tenant context listeners, multiple DBAL connections, tenant env files, isolation risk if no filter found',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_multitenancy_stats',
      description: 'Show multi-tenancy statistics: tenant entity count, Doctrine filter count, listener count, DBAL connection count, detected approach (DB-per-tenant vs row-level vs entity-based)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
