/**
 * Doctrine Entity Lock Inspector
 *
 * Scans src/ PHP for LockMode::PESSIMISTIC_WRITE, LockMode::PESSIMISTIC_READ,
 *   LockMode::OPTIMISTIC, $em->lock(), #[Version], @Version.
 * Detects try/catch around lock() calls (OptimisticLockException handling).
 *
 * Warns on:
 *   - PESSIMISTIC lock across HTTP request boundary (long-held lock)
 *   - OPTIMISTIC without @Version property (silently does nothing)
 *   - lock() without OptimisticLockException catch (uncaught 500)
 *   - Multi-entity locking in different order (deadlock risk)
 *   - #[Version] on wrong type (must be int or DateTime)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface EntityLockInfo {
  file: string;
  className: string;
  lockType: string;
  hasVersionProp: boolean;
  hasTryCatch: boolean;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function detectLockType(content: string): string {
  if (content.includes('LockMode::PESSIMISTIC_WRITE')) return 'PESSIMISTIC_WRITE';
  if (content.includes('LockMode::PESSIMISTIC_READ')) return 'PESSIMISTIC_READ';
  if (content.includes('LockMode::OPTIMISTIC')) return 'OPTIMISTIC';
  if (content.includes('->lock(')) return 'lock()';
  return 'none';
}

function checkVersionProp(content: string): { hasVersion: boolean; wrongType: boolean } {
  const hasAttrVersion = content.includes('#[Version]') ||
    content.includes('#[ORM\\Version]') ||
    content.includes('@Version') ||
    content.includes('@ORM\\Version');

  if (!hasAttrVersion) return { hasVersion: false, wrongType: false };

  // Check if the property type is valid (int or DateTime)
  // Look for #[Version] followed by property declaration
  const versionPropRe = /#\[(?:ORM\\)?Version\][^\n]{0,100}\n(?:[^\n]{0,100}\n){0,3}[^\n]*(?:private|protected|public)[^\n]*\$[a-zA-Z_][a-zA-Z0-9_]{0,50}/;
  const versionMatch = versionPropRe.exec(content);

  let wrongType = false;
  if (versionMatch) {
    const block = versionMatch[0];
    // Wrong types: string, float, array, bool — must be int or DateTime/DateTimeImmutable
    if (
      /:\s*string\b/.test(block) ||
      /:\s*float\b/.test(block) ||
      /:\s*array\b/.test(block) ||
      /:\s*bool\b/.test(block)
    ) {
      wrongType = true;
    }
  }

  // Also check annotation-style @Version property
  if (!versionMatch) {
    const annotVre = /@(?:ORM\\)?Version[^\n]{0,100}\n(?:[^\n]{0,100}\n){0,3}[^\n]*(?:private|protected|public)[^\n]*\$[a-zA-Z_][a-zA-Z0-9_]{0,50}/;
    const annotMatch = annotVre.exec(content);
    if (annotMatch) {
      const block = annotMatch[0];
      if (
        /:\s*string\b/.test(block) ||
        /:\s*float\b/.test(block) ||
        /:\s*array\b/.test(block)
      ) {
        wrongType = true;
      }
    }
  }

  return { hasVersion: true, wrongType };
}

function checkTryCatch(content: string): { hasTryCatch: boolean; catchesOptimisticLock: boolean } {
  const hasTryCatch = content.includes('try {') || content.includes('try{');
  const catchesOptimisticLock = content.includes('OptimisticLockException') ||
    content.includes('LockException');
  return { hasTryCatch, catchesOptimisticLock };
}

function detectMultiEntityLock(content: string): boolean {
  // Heuristic: multiple ->lock( calls in same file
  const lockMatches = content.match(/->lock\s*\([^)]{0,200}\)/g) ?? [];
  return lockMatches.length > 1;
}

function isInHttpHandler(filePath: string, content: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return normalizedPath.includes('/Controller/') ||
    normalizedPath.includes('Controller.php') ||
    content.includes('AbstractController') ||
    content.includes('extends AbstractController') ||
    content.includes('#[Route(') ||
    content.includes('@Route(');
}

function parseEntityLockFile(filePath: string, appPath: string): EntityLockInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasLockCode = content.includes('LockMode::') ||
    content.includes('->lock(') ||
    content.includes('#[Version]') ||
    content.includes('@Version');

  if (!hasLockCode) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const lockType = detectLockType(content);
  const versionInfo = checkVersionProp(content);
  const tryCatchInfo = checkTryCatch(content);
  const hasMultiEntityLock = detectMultiEntityLock(content);
  const inHttpHandler = isInHttpHandler(filePath, content);

  const issues: string[] = [];

  // PESSIMISTIC lock in HTTP handler = long-held DB lock
  if ((lockType === 'PESSIMISTIC_WRITE' || lockType === 'PESSIMISTIC_READ') && inHttpHandler) {
    issues.push(`${lockType} lock used in HTTP request handler — pessimistic locks are held until transaction ends; long request = long DB lock, high contention risk`);
  }

  // OPTIMISTIC without @Version = lock silently does nothing
  if ((lockType === 'OPTIMISTIC' || content.includes('LockMode::OPTIMISTIC')) && !versionInfo.hasVersion) {
    issues.push('LockMode::OPTIMISTIC used but no #[Version] / @Version property found — optimistic locking silently does nothing without a version field');
  }

  // lock() without OptimisticLockException catch
  if (content.includes('->lock(') &&
      content.includes('LockMode::OPTIMISTIC') &&
      !tryCatchInfo.catchesOptimisticLock) {
    issues.push('OPTIMISTIC lock() called without catching OptimisticLockException — concurrent modification will cause an uncaught 500 error');
  }

  // Multi-entity locking = deadlock risk
  if (hasMultiEntityLock) {
    issues.push('Multiple ->lock() calls in same class — locking entities in inconsistent order across concurrent requests causes deadlocks; establish a fixed lock ordering');
  }

  // #[Version] on wrong PHP type
  if (versionInfo.wrongType) {
    issues.push('#[Version] property has incompatible type — Doctrine version field must be int or DateTime/DateTimeImmutable');
  }

  return {
    file: path.relative(appPath, filePath),
    className: classM[1],
    lockType,
    hasVersionProp: versionInfo.hasVersion,
    hasTryCatch: tryCatchInfo.catchesOptimisticLock,
    issues,
  };
}

export function listDoctrineEntityLocks(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const results: EntityLockInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseEntityLockFile(file, appPath);
      if (info) results.push(info);
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine entity lock usage (LockMode, @Version) found in src/.' }] };
    }

    results.sort((a, b) => b.issues.length - a.issues.length);
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `Doctrine Entity Lock Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles with lock usage: ${results.length}  Issues: ${totalIssues}\n`;

    for (const r of results) {
      text += `\n  ${r.className}  (${r.file})\n`;
      text += `    Lock type:    ${r.lockType}\n`;
      text += `    @Version:     ${r.hasVersionProp ? 'yes' : 'no'}\n`;
      text += `    Try/catch:    ${r.hasTryCatch ? 'yes (catches OptimisticLockException)' : 'no'}\n`;
      for (const issue of r.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineEntityLockStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: EntityLockInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const info = parseEntityLockFile(file, appPath);
        if (info) results.push(info);
      }
    }

    const byType: Record<string, number> = {};
    for (const r of results) {
      byType[r.lockType] = (byType[r.lockType] ?? 0) + 1;
    }

    let text = `Doctrine Entity Lock Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total files with lock usage:   ${results.length}\n`;
    text += `  PESSIMISTIC_WRITE:           ${byType['PESSIMISTIC_WRITE'] ?? 0}\n`;
    text += `  PESSIMISTIC_READ:            ${byType['PESSIMISTIC_READ'] ?? 0}\n`;
    text += `  OPTIMISTIC:                  ${byType['OPTIMISTIC'] ?? 0}\n`;
    text += `  Other lock():                ${byType['lock()'] ?? 0}\n`;
    text += `With @Version property:        ${results.filter((r) => r.hasVersionProp).length}\n`;
    text += `With OptimisticLockException:  ${results.filter((r) => r.hasTryCatch).length}\n`;
    text += `Total issues:                  ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineEntityLockTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_entity_locks',
      description: 'Inspect Doctrine entity locking: LockMode::PESSIMISTIC_WRITE/READ/OPTIMISTIC, $em->lock(), #[Version]/@Version; warns on pessimistic locks in HTTP handlers, OPTIMISTIC without version field, missing OptimisticLockException catch, multi-entity deadlock risk, wrong @Version type',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_entity_lock_stats',
      description: 'Statistics for Doctrine entity locks: total files, lock type breakdown, @Version coverage, OptimisticLockException catch coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
