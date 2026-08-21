/**
 * Symfony HttpFoundation ParameterBag Inspector
 *
 * Distinct from symfony-response-types.ts (response), controller-security.ts (access control),
 * and input-dto.ts (DTO validation). Focuses on Request parameter bag usage patterns:
 *
 * - Scans src/ PHP for: $request->attributes->get(, $request->query->get(,
 *   $request->request->get(, $request->headers->get(, $request->server->get(,
 *   $request->files->get(, new ParameterBag(, new HeaderBag(, new FileBag(
 * - Detects: direct bag access vs method shortcuts ($request->get() vs bag),
 *   bag modification ($request->attributes->set(), $request->query->remove())
 *
 * Warnings:
 *   - $request->request->get() on GET request context (request bag empty for GET)
 *   - $request->get() without type hint (returns null|string|array — unsafe)
 *   - $request->headers->get() on case-sensitive name (HeaderBag is case-insensitive)
 *   - $request->server->get('REMOTE_ADDR') without trusted proxy config (can be spoofed)
 *   - Modifying $request->query on a shared request (shared mutation)
 *   - $request->request->all() without filtering (dump of entire POST data)
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

interface BagUsage {
  bag: string;
  method: string;
  hasTypeHint: boolean;
  issues: string[];
}

interface ParameterBagInfo {
  file: string;
  usages: BagUsage[];
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

const BAG_PATTERNS: Array<{ bag: string; pattern: string }> = [
  { bag: 'attributes', pattern: '->attributes->' },
  { bag: 'query', pattern: '->query->' },
  { bag: 'request', pattern: '->request->' },
  { bag: 'headers', pattern: '->headers->' },
  { bag: 'server', pattern: '->server->' },
  { bag: 'files', pattern: '->files->' },
];

function parseParameterBagFile(filePath: string): ParameterBagInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasBagCode = BAG_PATTERNS.some((p) => content.includes(p.pattern)) ||
    content.includes('new ParameterBag(') ||
    content.includes('new HeaderBag(') ||
    content.includes('new FileBag(') ||
    content.includes('$request->get(');

  if (!hasBagCode) return null;
  if (!content.includes('class ')) return null;

  const usages: BagUsage[] = [];
  const fileIssues: string[] = [];

  for (const { bag, pattern } of BAG_PATTERNS) {
    if (!content.includes(pattern)) continue;

    const methodRe = new RegExp(`->(?:${bag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*->\\s*(\\w{1,50})\\s*\\(`, 'g');
    let methodMatch: RegExpExecArray | null;

    while ((methodMatch = methodRe.exec(content)) !== null) {
      const method = methodMatch[1] ?? 'get';
      const usageIssues: string[] = [];

      const contextStart = Math.max(0, methodMatch.index - 200);
      const contextEnd = Math.min(content.length, methodMatch.index + 300);
      const context = content.substring(contextStart, contextEnd);

      const hasTypeHint = context.includes('(int)') || context.includes('(string)') ||
        context.includes('(bool)') || context.includes('(float)') ||
        context.includes('->getInt(') || context.includes('->getString(') ||
        context.includes('->getBoolean(') || context.includes('->getAlnum(');

      if (bag === 'request' && method === 'get' && !hasTypeHint) {
        usageIssues.push('$request->request->get() without type casting — returns null|string|array; use ->getInt(), ->getString(), or cast explicitly');
      }

      if (bag === 'query' && method === 'get' && !hasTypeHint) {
        usageIssues.push('$request->query->get() without type hint — query string values are always strings; use ->getInt() or validate before use');
      }

      if (bag === 'request' && method === 'all') {
        usageIssues.push('$request->request->all() without key filtering — exposes entire POST body; use ->all([\'key1\', \'key2\']) to whitelist fields');
      }

      if (bag === 'server' && method === 'get') {
        const argMatch = /->server\s*->\s*get\s*\(\s*['"]([^'"]{1,80})['"]/.exec(context);
        if (argMatch && (argMatch[1] === 'REMOTE_ADDR' || argMatch[1] === 'HTTP_X_FORWARDED_FOR')) {
          usageIssues.push(`$request->server->get('${argMatch[1]}') — can be spoofed without trusted proxy config; use $request->getClientIp() after configuring trusted proxies`);
        }
      }

      if (bag === 'query' && (method === 'set' || method === 'remove' || method === 'replace')) {
        usageIssues.push('$request->query modified (set/remove/replace) — mutation of a shared request object may affect other parts of the request lifecycle unexpectedly');
      }

      if (bag === 'headers' && method === 'get') {
        const argMatch = /->headers\s*->\s*get\s*\(\s*['"]([^'"]{1,80})['"]/.exec(context);
        if (argMatch) {
          const headerName = argMatch[1];
          if (headerName !== headerName.toLowerCase() && headerName !== headerName.toUpperCase()) {
            usageIssues.push(`$request->headers->get('${headerName}') — HeaderBag is case-insensitive but mixed-case looks like a typo; use lowercase header names`);
          }
        }
      }

      usages.push({ bag, method, hasTypeHint, issues: usageIssues });
      fileIssues.push(...usageIssues);
    }
  }

  if (content.includes('$request->get(') && !content.includes('->query->') && !content.includes('->request->')) {
    const hasTyped = content.includes('->getInt(') || content.includes('->getString(');
    if (!hasTyped) {
      fileIssues.push('$request->get() shortcut used — returns from query, request, and attributes bags; prefer explicit bag access for clarity');
    }
  }

  if (usages.length === 0 && fileIssues.length === 0) return null;

  return {
    file: path.basename(filePath),
    usages,
    issues: fileIssues,
  };
}

export function listParameterBagUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: ParameterBagInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseParameterBagFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.file.localeCompare(b.file));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No HttpFoundation ParameterBag usage found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `HttpFoundation ParameterBag Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Issues: ${totalIssues}\n`;

    const withIssues = results.filter((r) => r.issues.length > 0);
    const clean = results.filter((r) => r.issues.length === 0);

    if (withIssues.length > 0) {
      text += `\nFiles with issues (${withIssues.length}):\n`;
      for (const r of withIssues) {
        text += `  ${r.file}\n`;
        const bagCounts = new Map<string, number>();
        for (const u of r.usages) {
          bagCounts.set(u.bag, (bagCounts.get(u.bag) ?? 0) + 1);
        }
        const bagSummary = [...bagCounts.entries()].map(([b, c]) => `${b}(${c})`).join(', ');
        if (bagSummary) text += `    bags: ${bagSummary}\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (clean.length > 0) {
      text += `\nClean bag usage (${clean.length}):\n`;
      for (const r of clean) {
        const bagNames = [...new Set(r.usages.map((u) => u.bag))].join(', ');
        text += `  ${r.file}`;
        if (bagNames) text += ` [${bagNames}]`;
        text += '\n';
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getParameterBagStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: ParameterBagInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseParameterBagFile(file);
      if (info) results.push(info);
    }

    const bagCounts: Record<string, number> = {};
    for (const r of results) {
      for (const u of r.usages) {
        bagCounts[u.bag] = (bagCounts[u.bag] ?? 0) + 1;
      }
    }

    let text = `HttpFoundation ParameterBag Statistics\n${'='.repeat(42)}\n\n`;
    text += `Total files with bag usage:  ${results.length}\n`;

    if (Object.keys(bagCounts).length > 0) {
      text += `\nBag access counts:\n`;
      for (const [bag, count] of Object.entries(bagCounts).sort(([, a], [, b]) => b - a)) {
        text += `  $request->${bag}->*()   ${count}\n`;
      }
    }

    const withTypeHint = results.reduce((s, r) => s + r.usages.filter((u) => u.hasTypeHint).length, 0);
    const withoutTypeHint = results.reduce((s, r) => s + r.usages.filter((u) => !u.hasTypeHint).length, 0);
    text += `\nTyped accesses (getInt/getString/etc): ${withTypeHint}\n`;
    text += `Untyped accesses:                      ${withoutTypeHint}\n`;
    text += `Issues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getParameterBagTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_parameter_bag_usage',
      description: 'Show HttpFoundation ParameterBag usage: query/request/attributes/headers/server/files bag access patterns; warns on untyped get() (returns null|string|array), request->all() without key filter, server->get(REMOTE_ADDR) without trusted proxy config, query bag mutation (shared mutation risk), mixed-case header names',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_parameter_bag_stats',
      description: 'Show ParameterBag statistics: total files, per-bag access counts, typed vs untyped access counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
