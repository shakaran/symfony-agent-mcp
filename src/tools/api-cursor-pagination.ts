import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface CursorPaginationInfo {
  file: string;
  type: 'offset' | 'cursor' | 'keyset' | 'collection' | 'config';
  pattern: string;
  issues: string[];
}

function buildCursorPaginationInfos(appPath: string): CursorPaginationInfo[] {
  const results: CursorPaginationInfo[] = [];

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

          const hasOffsetPagination = (content.includes('setFirstResult(') || content.includes('OFFSET') || content.includes('page') || content.includes('offset')) &&
            (content.includes('setMaxResults(') || content.includes('LIMIT') || content.includes('perPage') || content.includes('limit'));
          const hasCursorPagination = content.includes('cursor') || content.includes('after=') || content.includes('before=') || content.includes('createdAt >') || content.includes('id >');
          if (!hasOffsetPagination && !hasCursorPagination) return;

          const relFile = path.relative(appPath, full);
          const issues: string[] = [];

          if (hasOffsetPagination && !hasCursorPagination) {
            const hasCountQuery = content.includes('COUNT(') || content.includes('count(') || content.includes('->count()');
            if (hasCountQuery) {
              issues.push(`Offset pagination in "${relFile}" with COUNT query — COUNT on large tables is expensive (full table scan); cursor/keyset pagination eliminates the need for COUNT and is O(1) for large datasets`);
            }

            const hasHighOffset = /setFirstResult\s*\(\s*\$(?:page|offset)\s*[*+]/.test(content);
            if (hasHighOffset) {
              issues.push(`Calculated OFFSET in "${relFile}" — OFFSET N forces database to skip N rows; performance degrades as page number grows (page 100 with 20/page = skip 2000 rows); use keyset/cursor pagination for deep pages`);
            }

            results.push({ file: relFile, type: 'offset', pattern: 'offset pagination', issues });
          } else if (hasCursorPagination) {
            const hasEncodedCursor = content.includes('base64_encode') || content.includes('base64_decode') || content.includes('encode(') || content.includes('opaque');
            if (!hasEncodedCursor) {
              issues.push(`Cursor pagination in "${relFile}" exposes raw field values as cursor — encode cursor with base64 or encrypt to prevent clients from guessing record IDs or timestamps`);
            }

            const hasBothDirections = content.includes('before') && content.includes('after');
            if (!hasBothDirections) {
              issues.push(`Cursor pagination in "${relFile}" without bi-directional support (before/after) — one-directional cursors prevent going back to previous pages; implement both after and before cursor parameters`);
            }

            results.push({ file: relFile, type: 'cursor', pattern: 'cursor pagination', issues });
          }
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  const apiPlatformConfig = path.join(appPath, 'config', 'packages', 'api_platform.yaml');
  if (fs.existsSync(apiPlatformConfig)) {
    let content = '';
    try { content = fs.readFileSync(apiPlatformConfig, 'utf-8'); } catch { /* skip */ }

    const hasPagination = content.includes('pagination_enabled:');
    const hasClientItemsPerPage = content.includes('pagination_client_items_per_page:');
    const hasMaxItemsPerPage = content.includes('pagination_maximum_items_per_page:') || content.includes('pagination_client_items_per_page_max:');
    const issues: string[] = [];

    if (hasPagination && hasClientItemsPerPage && !hasMaxItemsPerPage) {
      issues.push('API Platform pagination_client_items_per_page without maximum — clients can request arbitrarily large pages; add pagination_maximum_items_per_page: 100 to cap response size');
    }

    const hasCursorBased = content.includes('cursor') || content.includes('CursorBasedPagination');
    if (hasPagination && !hasCursorBased) {
      issues.push('API Platform using page-based pagination — for large, frequently-updated collections cursor-based pagination provides stable pages; consider CursorPaginationExtension for real-time feeds');
    }

    results.push({ file: 'config/packages/api_platform.yaml', type: 'config', pattern: 'API Platform pagination', issues });
  }

  return results;
}

export function listApiCursorPagination(appPath: string): McpToolResult {
  try {
    const infos = buildCursorPaginationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No cursor/offset pagination patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `API Cursor Pagination Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiCursorPaginationStats(appPath: string): McpToolResult {
  try {
    const infos = buildCursorPaginationInfos(appPath);
    let text = `API Cursor Pagination Statistics\n${'='.repeat(40)}\n\n`;
    text += `Offset-based:  ${infos.filter((i) => i.type === 'offset').length}\n`;
    text += `Cursor-based:  ${infos.filter((i) => i.type === 'cursor').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiCursorPaginationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_cursor_pagination', description: 'Analyze API pagination implementation; warns on offset pagination with expensive COUNT, high OFFSET performance degradation, cursor without encoding, one-directional cursor, API Platform without max items per page, page-based instead of cursor for large collections', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_cursor_pagination_stats', description: 'Statistics for API pagination: offset/cursor count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
