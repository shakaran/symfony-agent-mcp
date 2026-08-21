/**
 * Symfony HTTP Cache Validation Inspector
 *
 * Distinct from http-cache.ts (cache config/TTL), symfony-response-types.ts (response types),
 * and controller-security.ts (access control). Focuses on HTTP conditional request validation:
 *
 * - Scans src/ PHP for: $response->setEtag(, $response->setLastModified(,
 *   $request->isNotModified(, $response->isNotModified(), ETag in header, Last-Modified header
 * - Detects: proper HTTP validation flow (set ETag + check isNotModified), missing validation
 *   (cache headers set without conditional check)
 *
 * Warnings:
 *   - setEtag() without calling $request->isNotModified() (ETag set but 304 never returned)
 *   - isNotModified() called before setting ETag/Last-Modified (wrong order)
 *   - ETag value containing user data without hashing (leaks data structure)
 *   - setLastModified() with current time (defeats caching — always fresh)
 *   - Strong ETag on partial content response (should be weak ETag per RFC)
 *   - Missing Vary header with ETag (cache poisoning risk if multiple representations)
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

interface HttpCacheValidationInfo {
  file: string;
  class: string;
  hasEtag: boolean;
  hasLastModified: boolean;
  hasIsNotModified: boolean;
  correctOrder: boolean;
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

function parseCacheValidationFile(filePath: string): HttpCacheValidationInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasCacheValidation = content.includes('->setEtag(') ||
    content.includes('->setLastModified(') ||
    content.includes('isNotModified(') ||
    content.includes('ETag') ||
    content.includes('Last-Modified');

  if (!hasCacheValidation) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasEtag = content.includes('->setEtag(') || content.includes('ETag');
  const hasLastModified = content.includes('->setLastModified(') || content.includes('Last-Modified');
  const hasIsNotModified = content.includes('isNotModified(');
  const hasVary = content.includes('->setVary(') || content.includes("'Vary'") || content.includes('"Vary"');
  const hasHash = content.includes('md5(') || content.includes('sha1(') || content.includes('hash(');

  const etagPos = content.indexOf('->setEtag(');
  const lastModPos = content.indexOf('->setLastModified(');
  const isNotModPos = content.indexOf('isNotModified(');

  let correctOrder = true;
  if (hasIsNotModified && (hasEtag || hasLastModified)) {
    const headerPos = Math.min(
      etagPos > -1 ? etagPos : Number.MAX_SAFE_INTEGER,
      lastModPos > -1 ? lastModPos : Number.MAX_SAFE_INTEGER,
    );
    if (isNotModPos < headerPos) {
      correctOrder = false;
    }
  }

  const issues: string[] = [];

  if (hasEtag && !hasIsNotModified) {
    issues.push('setEtag() set without calling $request->isNotModified() — ETag is sent but 304 Not Modified response is never returned; clients cannot benefit from conditional requests');
  }

  if (hasLastModified && !hasIsNotModified) {
    issues.push('setLastModified() set without calling $request->isNotModified() — Last-Modified header has no effect without conditional request check');
  }

  if (!correctOrder && hasIsNotModified) {
    issues.push('isNotModified() called before setEtag()/setLastModified() — validation headers must be set before calling isNotModified(), otherwise the check always fails');
  }

  if (hasEtag && !hasHash) {
    const etagValueMatch = /->setEtag\s*\(\s*([^)]{0,200})\)/.exec(content);
    if (etagValueMatch) {
      const etagArg = etagValueMatch[1];
      if (etagArg.includes('$') && !etagArg.includes('md5') && !etagArg.includes('sha') && !etagArg.includes('hash')) {
        issues.push('ETag value uses a variable directly without hashing — may leak internal data structure (IDs, timestamps); hash with md5()/sha1() first');
      }
    }
  }

  if (hasLastModified) {
    const lastModMatch = /->setLastModified\s*\(\s*([^)]{0,200})\)/.exec(content);
    if (lastModMatch) {
      const lastModArg = lastModMatch[1];
      if (lastModArg.includes('new \\DateTime') || lastModArg.includes('new DateTime') ||
        lastModArg.includes('now') || lastModArg.includes('time()')) {
        issues.push('setLastModified() with current time — always-fresh Last-Modified defeats HTTP caching; use the actual resource modification timestamp');
      }
    }
  }

  if (hasEtag && !hasVary) {
    issues.push('ETag set without Vary header — if multiple representations exist (e.g. Accept-Language), cache poisoning risk; add Vary header for content-negotiated responses');
  }

  return {
    file: path.basename(filePath),
    class: classM[1],
    hasEtag,
    hasLastModified,
    hasIsNotModified,
    correctOrder,
    issues,
  };
}

export function listHttpCacheValidation(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: HttpCacheValidationInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseCacheValidationFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No HTTP cache validation (ETag/Last-Modified/isNotModified) found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `HTTP Cache Validation Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Issues: ${totalIssues}\n`;

    const correct = results.filter((r) => r.hasIsNotModified && r.correctOrder && r.issues.length === 0);
    const withIssues = results.filter((r) => r.issues.length > 0);
    const partialOnly = results.filter((r) => r.issues.length === 0 && !r.hasIsNotModified);

    if (withIssues.length > 0) {
      text += `\nFiles with issues (${withIssues.length}):\n`;
      for (const r of withIssues) {
        const flags: string[] = [];
        if (r.hasEtag) flags.push('ETag');
        if (r.hasLastModified) flags.push('LastModified');
        if (r.hasIsNotModified) flags.push('isNotModified');
        if (!r.correctOrder) flags.push('WRONG_ORDER');
        text += `  ${r.class.padEnd(45)} (${r.file})`;
        if (flags.length > 0) text += ` [${flags.join(', ')}]`;
        text += '\n';
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (correct.length > 0) {
      text += `\nCorrect HTTP validation flow (${correct.length}):\n`;
      for (const r of correct) {
        const flags: string[] = [];
        if (r.hasEtag) flags.push('ETag');
        if (r.hasLastModified) flags.push('LastModified');
        text += `  ${r.class.padEnd(45)} (${r.file}) [${flags.join(', ')}]\n`;
      }
    }

    if (partialOnly.length > 0) {
      text += `\nCache headers without validation (${partialOnly.length}):\n`;
      for (const r of partialOnly) {
        text += `  ${r.class.padEnd(45)} (${r.file})\n`;
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

export function getHttpCacheValidationStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: HttpCacheValidationInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseCacheValidationFile(file);
      if (info) results.push(info);
    }

    let text = `HTTP Cache Validation Statistics\n${'='.repeat(42)}\n\n`;
    text += `Total files with cache validation: ${results.length}\n`;
    text += `  With ETag:                       ${results.filter((r) => r.hasEtag).length}\n`;
    text += `  With Last-Modified:              ${results.filter((r) => r.hasLastModified).length}\n`;
    text += `  With isNotModified():            ${results.filter((r) => r.hasIsNotModified).length}\n`;
    text += `  Correct order (set before check):${results.filter((r) => r.correctOrder).length}\n`;
    text += `Issues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getHttpCacheValidationTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_http_cache_validation',
      description: 'Show HTTP cache validation patterns: setEtag/setLastModified/isNotModified usage; detects correct validation flow vs missing conditional check; warns on ETag without isNotModified (304 never returned), wrong call order, ETag with user data without hashing, setLastModified with current time (defeats caching), missing Vary header',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_http_cache_validation_stats',
      description: 'Show HTTP cache validation statistics: total files, ETag count, Last-Modified count, isNotModified count, correct order count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
