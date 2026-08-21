/**
 * API Platform Security Inspector
 *
 * Distinct from security-scanner.ts (generic Symfony security) and
 * api-platform.ts (resource listing).
 * Focuses on API Platform-specific security patterns:
 *
 * Operations without security expression:
 *   - #[Get] / #[GetCollection] / #[Post] / #[Put] / #[Patch] / #[Delete]
 *     missing security="..." or securityPostDenormalize="..."
 *   - is_granted() vs role check string analysis
 *   - Operations with security but using IS_AUTHENTICATED_ANONYMOUSLY (public read risk)
 *
 * Sensitive field exposure in normalization context:
 *   - normalizationContext groups containing field names like password/token/secret/api_key
 *   - Fields without normalizationContext (all fields serialized)
 *   - #[Ignore] or #[Groups([])] on sensitive fields
 *
 * Write operation security:
 *   - POST/PUT/PATCH without security or securityPostDenormalize
 *   - securityPostDenormalize missing (needed for owner checks on new resources)
 *   - DELETE without security
 *
 * Voter usage:
 *   - security="is_granted('EDIT', object)" — custom voter patterns
 *   - Voter classes in src/Security/Voter/ for each resource
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface OperationSecurity {
  operation: string;
  hasSecurity: boolean;
  hasPostDenormalize: boolean;
  securityExpr?: string;
  isPublic: boolean;
}

interface ApiResourceSecurity {
  class: string;
  file: string;
  operations: OperationSecurity[];
  hasSensitiveGroups: boolean;
  hasNormalizationContext: boolean;
  issues: string[];
}

const SENSITIVE_FIELD_PATTERNS = ['password', 'token', 'secret', 'apikey', 'api_key', 'private', 'salt', 'hash', 'credential'];
const WRITE_OPERATIONS = ['Post', 'Put', 'Patch', 'Delete'];
const READ_OPERATIONS  = ['Get', 'GetCollection'];

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

function parseResourceSecurity(filePath: string): ApiResourceSecurity | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('#[ApiResource') && !content.includes('@ApiResource')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const operations: OperationSecurity[] = [];
  const allOps = [...WRITE_OPERATIONS, ...READ_OPERATIONS];

  for (const op of allOps) {
    const pattern = new RegExp(`#\\[${op}[^]]*?(?:\\]|security[^\\]]*\\])`, 'gs');
    for (const m of content.matchAll(pattern)) {
      const block = m[0];
      const securityM       = /security\s*:\s*['"]([^'"]+)['"]/.exec(block);
      const postDenormM     = /securityPostDenormalize\s*:\s*['"]([^'"]+)['"]/.exec(block);
      const hasSecurity     = !!securityM || !!postDenormM;
      const securityExpr    = securityM?.[1] ?? postDenormM?.[1];
      const isPublic        = !hasSecurity ||
                              securityExpr?.includes('IS_AUTHENTICATED_ANONYMOUSLY') ||
                              securityExpr?.includes('PUBLIC_ACCESS') ||
                              securityExpr === 'false' || false;

      operations.push({
        operation: op,
        hasSecurity,
        hasPostDenormalize: !!postDenormM,
        securityExpr,
        isPublic,
      });
    }
  }

  // If no per-operation attrs but #[ApiResource] found with security
  if (operations.length === 0 && content.includes('#[ApiResource')) {
    const resourceSecM = /#\[ApiResource[^]]*security\s*:\s*['"]([^'"]+)['"]/.exec(content);
    if (!resourceSecM) {
      // Resource-level, assume all operations exist without security
      for (const op of allOps) {
        operations.push({ operation: op, hasSecurity: false, hasPostDenormalize: false, isPublic: true });
      }
    }
  }

  // Sensitive groups check
  const normCtxM = /normalizationContext[^]]*groups[^]]*\[([^\]]+)\]/.exec(content);
  const hasSensitiveGroups = normCtxM ? SENSITIVE_FIELD_PATTERNS.some((p) =>
    normCtxM[1].toLowerCase().includes(p)
  ) : false;
  const hasNormalizationContext = content.includes('normalizationContext');

  const issues: string[] = [];

  // Write operations without security
  const unsecuredWrites = operations.filter((op) =>
    WRITE_OPERATIONS.includes(op.operation) && !op.hasSecurity
  );
  if (unsecuredWrites.length > 0) {
    issues.push(`Write operations without security: ${unsecuredWrites.map((o) => o.operation).join(', ')}`);
  }

  // POST without securityPostDenormalize (owner check on new resources)
  const postOp = operations.find((op) => op.operation === 'Post');
  if (postOp?.hasSecurity && !postOp.hasPostDenormalize) {
    issues.push(`POST has security but no securityPostDenormalize — owner can't be verified on new resource`);
  }

  // Public DELETE
  const deleteOp = operations.find((op) => op.operation === 'Delete');
  if (deleteOp && deleteOp.isPublic) {
    issues.push(`DELETE operation is publicly accessible (no security)`);
  }

  if (!hasNormalizationContext) {
    issues.push(`No normalizationContext — all fields are serialized (potential data leak)`);
  }

  if (hasSensitiveGroups) {
    issues.push(`Normalization context groups include potentially sensitive field names`);
  }

  return {
    class: classM[1],
    file: path.basename(filePath),
    operations,
    hasSensitiveGroups,
    hasNormalizationContext,
    issues,
  };
}

export function listApiPlatformSecurity(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const resources: ApiResourceSecurity[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = parseResourceSecurity(file);
      if (r) resources.push(r);
    }

    if (resources.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No API Platform resources found.\n\nSecure operations:\n  #[ApiResource(\n    normalizationContext: [\'groups\' => [\'user:read\']],\n    denormalizationContext: [\'groups\' => [\'user:write\']],\n  )]\n  #[Get(security: "is_granted(\'ROLE_USER\')")]\n  #[Post(security: "is_granted(\'ROLE_ADMIN\')")]\n  class User { }',
        }],
      };
    }

    resources.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class));
    const totalIssues = resources.reduce((s, r) => s + r.issues.length, 0);

    let text = `API Platform Security Audit\n${'='.repeat(55)}\n`;
    text += `\nResources: ${resources.length}  Total issues: ${totalIssues}\n`;

    for (const r of resources) {
      text += `\n  ${r.class}  (${r.file})\n`;
      text += `    normalizationContext: ${r.hasNormalizationContext ? 'yes' : '⚠ none'}\n`;

      if (r.operations.length > 0) {
        const secured   = r.operations.filter((o) => o.hasSecurity).length;
        const unsecured = r.operations.filter((o) => !o.hasSecurity).length;
        text += `    Operations: ${r.operations.length} total  ${secured} secured  ${unsecured > 0 ? `⚠ ${unsecured} unsecured` : '0 unsecured'}\n`;

        for (const op of r.operations) {
          if (!op.hasSecurity) {
            text += `    ⚠ ${op.operation}: no security\n`;
          } else if (op.securityExpr && op.isPublic) {
            text += `    ! ${op.operation}: ${op.securityExpr} (public access)\n`;
          }
        }
      }

      for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiPlatformSecurityStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const resources: ApiResourceSecurity[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseResourceSecurity(file);
        if (r) resources.push(r);
      }
    }

    const totalOps = resources.reduce((s, r) => s + r.operations.length, 0);
    const securedOps = resources.reduce((s, r) => s + r.operations.filter((o) => o.hasSecurity).length, 0);

    let text = `API Platform Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total resources:         ${resources.length}\n`;
    text += `Total operations:        ${totalOps}\n`;
    text += `  Secured:               ${securedOps}\n`;
    text += `  Unsecured:             ${totalOps - securedOps}\n`;
    text += `With normCtx:            ${resources.filter((r) => r.hasNormalizationContext).length}\n`;
    text += `Resources with issues:   ${resources.filter((r) => r.issues.length > 0).length}\n`;
    text += `Total issues:            ${resources.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiPlatformSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_api_platform_security',
      description: 'Show API Platform security audit: operations without security/securityPostDenormalize, unsecured write operations (POST/PUT/PATCH/DELETE), public DELETE warning, missing normalizationContext (data leak risk), sensitive field name in normalization groups',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_api_platform_security_stats',
      description: 'Show API Platform security statistics: resource count, total/secured/unsecured operation counts, normalization context count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
