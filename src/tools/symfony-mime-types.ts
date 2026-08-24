// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony MimeTypes Inspector
 *
 * Scans src/ PHP for MimeTypes usage:
 *   - MimeTypes::getDefault(), new MimeTypes(), guessMimeType(), getExtensions(), getMimeTypes()
 *   - MimeTypeGuesserInterface implementations
 *   - finfo_file() native PHP usage, mime_content_type() (deprecated)
 *   - pathinfo(..., PATHINFO_EXTENSION) without MIME check
 *
 * Warns about:
 *   - guessMimeType() without null check
 *   - Using finfo_file() when MimeTypes component is available
 *   - Relying only on file extension for MIME detection (spoofable)
 *   - Missing fallback when MimeTypes returns empty array
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface MimeTypeUsage {
  method: string;
  hasNullCheck: boolean;
  issues: string[];
}

interface MimeTypeInfo {
  file: string;
  class?: string;
  usages: MimeTypeUsage[];
  hasCustomGuesser: boolean;
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

function parseMimeTypeFile(filePath: string, appPath: string): MimeTypeInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasMimeTypes = content.includes('MimeTypes') || content.includes('guessMimeType') ||
    content.includes('finfo_file') || content.includes('mime_content_type') ||
    content.includes('PATHINFO_EXTENSION') || content.includes('MimeTypeGuesserInterface');

  if (!hasMimeTypes) return null;
  if (content.includes('namespace Symfony\\Component\\Mime')) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  const usages: MimeTypeUsage[] = [];
  const fileIssues: string[] = [];

  const hasCustomGuesser = content.includes('MimeTypeGuesserInterface') &&
    content.includes('implements') &&
    /implements[^{]{0,200}MimeTypeGuesserInterface/.test(content);

  // Check guessMimeType usage
  if (content.includes('guessMimeType(')) {
    const issues: string[] = [];
    // Look for null check pattern after guessMimeType
    const guessM = /guessMimeType\([^)]{0,200}\)/.exec(content);
    const idx = guessM ? content.indexOf(guessM[0]) : -1;
    const snippet = idx >= 0 ? content.slice(idx, idx + 300) : '';
    const hasNullCheck = snippet.includes('=== null') || snippet.includes('!== null') ||
      snippet.includes('?? ') || snippet.includes('is_null') || snippet.includes('if (');
    if (!hasNullCheck) {
      issues.push('guessMimeType() result used without null check — returns null for unknown types');
    }
    usages.push({ method: 'guessMimeType', hasNullCheck, issues });
  }

  // Check getExtensions usage
  if (/->getExtensions\(/.test(content)) {
    const issues: string[] = [];
    const extM = /->getExtensions\([^)]{0,200}\)/.exec(content);
    const idx = extM ? content.indexOf(extM[0]) : -1;
    const snippet = idx >= 0 ? content.slice(idx, idx + 200) : '';
    const hasNullCheck = snippet.includes('empty(') || snippet.includes('count(') || snippet.includes('[]');
    if (!hasNullCheck) {
      issues.push('getExtensions() may return empty array — add fallback for unknown MIME types');
    }
    usages.push({ method: 'getExtensions', hasNullCheck, issues });
  }

  // Check getMimeTypes usage
  if (/->getMimeTypes\(/.test(content)) {
    const issues: string[] = [];
    const mimeM = /->getMimeTypes\([^)]{0,200}\)/.exec(content);
    const idx = mimeM ? content.indexOf(mimeM[0]) : -1;
    const snippet = idx >= 0 ? content.slice(idx, idx + 200) : '';
    const hasNullCheck = snippet.includes('empty(') || snippet.includes('count(') || snippet.includes('[]');
    if (!hasNullCheck) {
      issues.push('getMimeTypes() may return empty array — add fallback when no MIME type found');
    }
    usages.push({ method: 'getMimeTypes', hasNullCheck, issues });
  }

  // Check MimeTypes::getDefault()
  if (content.includes('MimeTypes::getDefault(')) {
    usages.push({ method: 'MimeTypes::getDefault', hasNullCheck: true, issues: [] });
  }

  // Check new MimeTypes()
  if (content.includes('new MimeTypes(')) {
    usages.push({ method: 'new MimeTypes()', hasNullCheck: true, issues: [] });
  }

  // finfo_file usage
  if (content.includes('finfo_file(')) {
    const issues: string[] = [];
    if (content.includes('MimeTypes') || content.includes('guessMimeType')) {
      issues.push('finfo_file() used alongside MimeTypes — prefer Symfony MimeTypes component for consistency');
    } else {
      issues.push('finfo_file() used — consider using Symfony MimeTypes component (symfony/mime) instead');
    }
    usages.push({ method: 'finfo_file', hasNullCheck: content.includes('finfo_file(') && content.includes('false'), issues });
  }

  // mime_content_type usage
  if (content.includes('mime_content_type(')) {
    usages.push({
      method: 'mime_content_type',
      hasNullCheck: false,
      issues: ['mime_content_type() is deprecated — use finfo_file() or Symfony MimeTypes component'],
    });
  }

  // PATHINFO_EXTENSION without MIME check
  if (content.includes('PATHINFO_EXTENSION') && !content.includes('guessMimeType') &&
    !content.includes('MimeTypes') && !content.includes('finfo_file')) {
    fileIssues.push('pathinfo(..., PATHINFO_EXTENSION) used for type detection without MIME check — file extensions are spoofable');
  }

  if (usages.length === 0 && fileIssues.length === 0 && !hasCustomGuesser) return null;

  return {
    file: path.relative(appPath, filePath),
    class: classM?.[1],
    usages,
    hasCustomGuesser,
    issues: fileIssues,
  };
}

function loadMimeTypeInfos(appPath: string): MimeTypeInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: MimeTypeInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseMimeTypeFile(f, appPath);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listMimeTypeUsage(appPath: string): McpToolResult {
  try {
    const infos = loadMimeTypeInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No MimeTypes usage found in src/.\n\nUse Symfony MimeTypes component:\n  use Symfony\\Component\\Mime\\MimeTypes;\n\n  $mimeTypes = MimeTypes::getDefault();\n  $mime = $mimeTypes->guessMimeType($filePath);\n  if ($mime === null) {\n    throw new \\RuntimeException("Cannot determine MIME type");\n  }',
        }],
      };
    }

    const withIssues = infos.filter(
      (i) => i.issues.length > 0 || i.usages.some((u) => u.issues.length > 0)
    );
    const customGuessers = infos.filter((i) => i.hasCustomGuesser);

    let text = `Symfony MimeTypes Usage (${infos.length} files)\n${'='.repeat(55)}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}`;
      if (info.class) text += `  [${info.class}]`;
      if (info.hasCustomGuesser) text += '  [custom guesser]';
      text += '\n';
      for (const u of info.usages) {
        const nullTag = u.hasNullCheck ? '' : ' [no null check]';
        text += `    ${u.method}${nullTag}\n`;
        for (const issue of u.issues) {
          text += `      WARN: ${issue}\n`;
        }
      }
      for (const issue of info.issues) {
        text += `    WARN: ${issue}\n`;
      }
    }

    if (customGuessers.length > 0) {
      text += `\nCustom MimeTypeGuesser implementations (${customGuessers.length}):\n`;
      for (const g of customGuessers) {
        text += `  ${g.class ?? g.file}  (${g.file})\n`;
      }
    }

    if (withIssues.length > 0) {
      text += `\nFiles with issues: ${withIssues.length}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMimeTypeStats(appPath: string): McpToolResult {
  try {
    const infos = loadMimeTypeInfos(appPath);

    let text = `MimeTypes Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using MimeTypes:      ${infos.length}\n`;
    text += `Custom MimeTypeGuessers:    ${infos.filter((i) => i.hasCustomGuesser).length}\n`;

    const allUsages = infos.flatMap((i) => i.usages);
    text += `Total method calls:         ${allUsages.length}\n`;
    text += `  guessMimeType calls:      ${allUsages.filter((u) => u.method === 'guessMimeType').length}\n`;
    text += `  finfo_file calls:         ${allUsages.filter((u) => u.method === 'finfo_file').length}\n`;
    text += `  mime_content_type calls:  ${allUsages.filter((u) => u.method === 'mime_content_type').length}\n`;
    text += `Without null check:         ${allUsages.filter((u) => !u.hasNullCheck).length}\n`;
    text += `Files with issues:          ${infos.filter((i) => i.issues.length > 0 || i.usages.some((u) => u.issues.length > 0)).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMimeTypeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_mime_type_usage',
      description: 'List Symfony MimeTypes usage: MimeTypes::getDefault(), guessMimeType(), finfo_file(), mime_content_type(), custom MimeTypeGuesserInterface implementations, null-check warnings, deprecated function detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_mime_type_stats',
      description: 'Show MimeTypes statistics: file count, method call breakdown, missing null checks, custom guesser count, files with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
