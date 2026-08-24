// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony String, Slugger and Unicode Usage Inspector
 *
 * Distinct from translations-inspector.ts (i18n) and all others.
 * Focuses on Symfony's string manipulation utilities:
 *
 * SluggerInterface:
 *   - AsciiSlugger (built-in, locale-aware)
 *   - $slugger->slug($string) — returns UnicodeString
 *   - $slugger->slug($string)->lower()->toString()
 *   - Injection: SluggerInterface $slugger in constructor
 *
 * Unicode string helpers (Symfony\Component\String):
 *   - u() / UnicodeString — UTF-8 safe, grapheme-based
 *   - b() / ByteString — raw bytes
 *   - s() / AbstractString — auto-detect
 *   - Methods: ->camel(), ->snake(), ->title(), ->truncate(), ->wrap(), ->padStart()
 *
 * Manual slug antipatterns:
 *   - preg_replace('/[^a-z0-9]+/i', '-', strtolower($str)) — loses Unicode chars
 *   - str_replace(' ', '-', strtolower($str)) — naive, breaks multibyte
 *   - iconv('UTF-8', 'ASCII//TRANSLIT', $str) — iconv not always available
 *
 * Analysis:
 *   - Manual slug implementation detected (should use SluggerInterface)
 *   - str_replace for slugging (insufficient normalization)
 *   - UnicodeString / ByteString mixed in same code path (encoding confusion)
 *   - SluggerInterface not injected (using static AsciiSlugger::new() directly)
 *   - iconv transliteration (portability risk)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface StringUsageInfo {
  file: string;
  hasSluggerInterface: boolean;
  hasUnicodeString: boolean;
  hasByteString: boolean;
  hasManualSlug: boolean;
  hasIconvSlug: boolean;
  issues: string[];
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

const MANUAL_SLUG_PATTERNS: RegExp[] = [
  /str_replace\s*\(\s*['"]\s+['"]\s*,\s*['"][-_]?['"]/,
  /preg_replace\s*\(\s*['"].*[a-z0-9].*['"].*\s*,\s*['"][-_]['"]/,
  /strtolower.*str_replace/,
];

function parseStringUsage(filePath: string, appPath: string): StringUsageInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasSluggerInterface = content.includes('SluggerInterface') || content.includes('->slug(');
  const hasUnicodeString    = content.includes('UnicodeString') || /\bu\s*\(/.test(content);
  const hasByteString       = content.includes('ByteString') || /\bb\s*\(/.test(content);
  const hasIconvSlug        = content.includes('iconv(') && content.includes('TRANSLIT');
  const hasManualSlug       = MANUAL_SLUG_PATTERNS.some((re) => re.test(content));

  if (!hasSluggerInterface && !hasUnicodeString && !hasByteString && !hasIconvSlug && !hasManualSlug) {
    return null;
  }

  const issues: string[] = [];
  if (hasManualSlug && !hasSluggerInterface) {
    issues.push('Manual slug implementation detected — use SluggerInterface for proper Unicode transliteration');
  }
  if (hasIconvSlug) {
    issues.push('iconv UTF-8 TRANSLIT for slugging — portability risk, use SluggerInterface instead');
  }
  if (hasUnicodeString && hasByteString) {
    issues.push('UnicodeString and ByteString mixed in same file — potential encoding confusion');
  }
  if (content.includes('AsciiSlugger::new(') && !content.includes('SluggerInterface')) {
    issues.push('Direct AsciiSlugger::new() — inject SluggerInterface instead for testability and locale support');
  }

  return {
    file: path.relative(appPath, filePath),
    hasSluggerInterface,
    hasUnicodeString,
    hasByteString,
    hasManualSlug,
    hasIconvSlug,
    issues,
  };
}

export function listStringUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const usages: StringUsageInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseStringUsage(file, appPath);
      if (u) usages.push(u);
    }

    if (usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony String / SluggerInterface usage found in src/.\n\nInstall: composer require symfony/string\n\nUsage example:\n  use Symfony\\Component\\String\\Slugger\\SluggerInterface;\n\n  public function __construct(private readonly SluggerInterface $slugger) {}\n\n  public function makeSlug(string $title): string {\n    return $this->slugger->slug($title)->lower()->toString();\n  }',
        }],
      };
    }

    const totalIssues    = usages.reduce((s, u) => s + u.issues.length, 0);
    const withIssues     = usages.filter((u) => u.issues.length > 0);
    const sluggerFiles   = usages.filter((u) => u.hasSluggerInterface);
    const unicodeFiles   = usages.filter((u) => u.hasUnicodeString);
    const manualSlugFiles = usages.filter((u) => u.hasManualSlug);

    let text = `Symfony String & Slugger Usage\n${'='.repeat(55)}\n`;
    text += `\nFiles using SluggerInterface:  ${sluggerFiles.length}\n`;
    text += `Files using UnicodeString u(): ${unicodeFiles.length}\n`;
    text += `Manual slug patterns:          ${manualSlugFiles.length}\n`;
    text += `Issues:                        ${totalIssues}\n`;

    if (withIssues.length > 0) {
      text += `\nFiles with issues:\n`;
      for (const u of withIssues) {
        text += `  ${u.file}\n`;
        for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (sluggerFiles.length > 0) {
      text += `\nSluggerInterface usage:\n`;
      for (const u of sluggerFiles.slice(0, 8)) {
        text += `  ${u.file}\n`;
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

export function getStringStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: StringUsageInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseStringUsage(file, appPath);
        if (u) usages.push(u);
      }
    }

    let text = `String & Slugger Statistics\n${'='.repeat(40)}\n\n`;
    text += `SluggerInterface files: ${usages.filter((u) => u.hasSluggerInterface).length}\n`;
    text += `UnicodeString files:    ${usages.filter((u) => u.hasUnicodeString).length}\n`;
    text += `ByteString files:       ${usages.filter((u) => u.hasByteString).length}\n`;
    text += `Manual slug patterns:   ${usages.filter((u) => u.hasManualSlug).length}\n`;
    text += `iconv transliteration:  ${usages.filter((u) => u.hasIconvSlug).length}\n`;
    text += `Issues:                 ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getStringSluggerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_string_usage',
      description: 'Show Symfony String component usage: SluggerInterface injection, UnicodeString u()/ByteString b() helper usage, manual slug antipattern detection (preg_replace/str_replace for slugging), iconv TRANSLIT detection, AsciiSlugger::new() static use warning, UnicodeString+ByteString mixing',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_string_stats',
      description: 'Show string component statistics: SluggerInterface file count, UnicodeString/ByteString file counts, manual slug pattern count, iconv count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
