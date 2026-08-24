// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface IntlPatternInfo {
  file: string;
  function: string;
  line: number;
  pattern: string;
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

const INTL_PATTERNS: Array<{ fn: string; pattern: RegExp; message: string }> = [
  {
    fn: 'NumberFormatter',
    pattern: /new\s+NumberFormatter\s*\(/,
    message: 'NumberFormatter instantiation — verify locale parameter is dynamic, not hardcoded',
  },
  {
    fn: 'MessageFormatter',
    pattern: /new\s+MessageFormatter\s*\(/,
    message: 'MessageFormatter instantiation — verify locale parameter is passed from request/session',
  },
  {
    fn: 'Collator',
    pattern: /new\s+Collator\s*\(/,
    message: 'Collator instantiation — ensure locale is not hardcoded',
  },
  {
    fn: 'IntlDateFormatter',
    pattern: /new\s+IntlDateFormatter\s*\(/,
    message: 'IntlDateFormatter instantiation — verify locale and timezone parameters',
  },
  {
    fn: 'intl_error_name',
    pattern: /intl_error_name\s*\(/,
    message: 'intl_error_name used — ensure intl errors are logged, not exposed to users',
  },
  {
    fn: 'locale_accept_from_http',
    pattern: /locale_accept_from_http\s*\(/,
    message: 'locale_accept_from_http used — validate and sanitize locale before use',
  },
  {
    fn: 'locale_set_default',
    pattern: /locale_set_default\s*\(/,
    message: 'locale_set_default called — prefer per-request locale over global default',
  },
  {
    fn: 'locale_get_default',
    pattern: /locale_get_default\s*\(/,
    message: 'locale_get_default called — consider using Symfony LocaleListener instead',
  },
  {
    fn: 'hardcoded_locale',
    pattern: /(?:new\s+(?:NumberFormatter|MessageFormatter|Collator|IntlDateFormatter))\s*\(\s*['"](?:en|fr|de|es|it|pt|ru|zh|ja|ko)[_-]/,
    message: 'Hardcoded locale string detected — locale should come from request or configuration',
  },
];

function buildIntlPatternInfos(appPath: string): IntlPatternInfo[] {
  const results: IntlPatternInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);

  for (const file of files) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      for (const pat of INTL_PATTERNS) {
        if (pat.pattern.test(line)) {
          results.push({
            file: path.relative(appPath, file),
            function: pat.fn,
            line: lineIdx + 1,
            pattern: pat.message,
          });
        }
      }
    }
  }

  return results;
}

export function listPhpIntlPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildIntlPatternInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP intl extension patterns found.' }] };
    }
    const lines = infos.map(i => `${i.file}:${i.line}\n  Function: ${i.function}\n  Issue: ${i.pattern}`);
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpIntlPatternsStats(appPath: string): McpToolResult {
  try {
    const infos = buildIntlPatternInfos(appPath);
    const stats = {
      total: infos.length,
      byFunction: {} as Record<string, number>,
      byFile: {} as Record<string, number>,
    };
    for (const i of infos) {
      stats.byFunction[i.function] = (stats.byFunction[i.function] ?? 0) + 1;
      stats.byFile[i.file] = (stats.byFile[i.file] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpIntlPatternsTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_php_intl_patterns',
      description: 'List PHP intl extension usage patterns: NumberFormatter, MessageFormatter, Collator, IntlDateFormatter, locale_* functions — flags hardcoded locales and missing locale parameters.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    },
    {
      name: 'get_php_intl_patterns_stats',
      description: 'Get statistics for PHP intl extension usage grouped by function name and file.',
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
