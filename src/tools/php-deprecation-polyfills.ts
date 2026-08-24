// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PolyfillInfo {
  package: string;
  version: string;
  type: 'polyfill' | 'native' | 'missing' | 'redundant';
  issues: string[];
}

const POLYFILL_PACKAGES: Record<string, { minPhp: string; nativeFrom: string; functions: string[] }> = {
  'symfony/polyfill-php72': { minPhp: '7.2', nativeFrom: '7.2', functions: ['spl_object_id', 'stream_isatty'] },
  'symfony/polyfill-php73': { minPhp: '7.3', nativeFrom: '7.3', functions: ['array_key_first', 'array_key_last', 'hrtime'] },
  'symfony/polyfill-php74': { minPhp: '7.4', nativeFrom: '7.4', functions: [] },
  'symfony/polyfill-php80': { minPhp: '8.0', nativeFrom: '8.0', functions: ['str_contains', 'str_starts_with', 'str_ends_with', 'fdiv', 'get_debug_type'] },
  'symfony/polyfill-php81': { minPhp: '8.1', nativeFrom: '8.1', functions: ['array_is_list', 'enum_exists', 'fibers'] },
  'symfony/polyfill-php82': { minPhp: '8.2', nativeFrom: '8.2', functions: ['ini_parse_quantity', 'iterator_*'] },
  'symfony/polyfill-php83': { minPhp: '8.3', nativeFrom: '8.3', functions: ['json_validate', 'mb_str_pad'] },
  'symfony/polyfill-intl-grapheme': { minPhp: '7.1', nativeFrom: '7.1', functions: ['grapheme_*'] },
  'symfony/polyfill-intl-idn': { minPhp: '7.1', nativeFrom: '7.1', functions: ['idn_to_ascii', 'idn_to_utf8'] },
  'symfony/polyfill-intl-normalizer': { minPhp: '7.1', nativeFrom: '7.1', functions: ['Normalizer'] },
  'symfony/polyfill-mbstring': { minPhp: '7.1', nativeFrom: '7.1', functions: ['mb_str_split', 'mb_str_pad'] },
  'symfony/polyfill-ctype': { minPhp: '7.1', nativeFrom: '7.1', functions: ['ctype_*'] },
  'symfony/polyfill-iconv': { minPhp: '7.1', nativeFrom: '7.1', functions: ['iconv_*'] },
};

function buildPolyfillInfos(appPath: string): PolyfillInfo[] {
  const results: PolyfillInfo[] = [];

  const composerJsonPath = path.join(appPath, 'composer.json');
  if (!fs.existsSync(composerJsonPath)) return results;

  let composerJson: Record<string, unknown>;
  try {
    composerJson = JSON.parse(fs.readFileSync(composerJsonPath, 'utf-8')) as Record<string, unknown>;
  } catch { return results; }

  const require = (composerJson['require'] ?? {}) as Record<string, string>;
  const requireDev = (composerJson['require-dev'] ?? {}) as Record<string, string>;
  const phpConstraint = String(require['php'] ?? '');

  let minRequiredPhp = 7.4;
  const phpMatch = /\^?>=?\s*(8\.\d|7\.\d)/.exec(phpConstraint);
  if (phpMatch) minRequiredPhp = parseFloat(phpMatch[1]);

  for (const [pkg, meta] of Object.entries(POLYFILL_PACKAGES)) {
    const installedVer = require[pkg] ?? requireDev[pkg];
    const nativePhp = parseFloat(meta.nativeFrom);

    if (installedVer !== undefined) {
      const issues: string[] = [];

      if (minRequiredPhp >= nativePhp) {
        issues.push(`"${pkg}" is redundant — your PHP constraint (${phpConstraint || 'unknown'}) already requires PHP ${minRequiredPhp}+ which provides these functions natively; remove the polyfill`);
        results.push({ package: pkg, version: String(installedVer), type: 'redundant', issues });
      } else {
        results.push({ package: pkg, version: String(installedVer), type: 'polyfill', issues });
      }
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const polyfillFunctions80 = ['str_contains(', 'str_starts_with(', 'str_ends_with('];
    const polyfillFunctions81 = ['array_is_list('];
    const polyfillFunctions83 = ['json_validate('];

    let content = '';
    try {
      const phpFiles = getAllPhpFilesInDir(srcDir);
      content = phpFiles.map((f) => { try { return fs.readFileSync(f, 'utf-8'); } catch { return ''; } }).join('\n');
    } catch { /* skip */ }

    const uses80 = polyfillFunctions80.some((fn) => content.includes(fn));
    const uses81 = polyfillFunctions81.some((fn) => content.includes(fn));
    const uses83 = polyfillFunctions83.some((fn) => content.includes(fn));

    if (uses80 && !require['symfony/polyfill-php80'] && minRequiredPhp < 8.0) {
      results.push({ package: 'symfony/polyfill-php80', version: 'missing', type: 'missing', issues: ['Code uses str_contains/str_starts_with/str_ends_with but symfony/polyfill-php80 not installed — these fail on PHP < 8.0 without the polyfill'] });
    }
    if (uses81 && !require['symfony/polyfill-php81'] && minRequiredPhp < 8.1) {
      results.push({ package: 'symfony/polyfill-php81', version: 'missing', type: 'missing', issues: ['Code uses array_is_list() but symfony/polyfill-php81 not installed — fails on PHP < 8.1'] });
    }
    if (uses83 && !require['symfony/polyfill-php83'] && minRequiredPhp < 8.3) {
      results.push({ package: 'symfony/polyfill-php83', version: 'missing', type: 'missing', issues: ['Code uses json_validate() but symfony/polyfill-php83 not installed — fails on PHP < 8.3'] });
    }
  }

  return results;
}


function getAllPhpFilesInDir(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFilesInDir(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

export function listPhpDeprecationPolyfills(appPath: string): McpToolResult {
  try {
    const infos = buildPolyfillInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No symfony/polyfill-* packages found in composer.json.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP Polyfill Analysis\n${'='.repeat(50)}\n\nPackages: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.package} ${info.version}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDeprecationPolyfillStats(appPath: string): McpToolResult {
  try {
    const infos = buildPolyfillInfos(appPath);
    let text = `PHP Polyfill Statistics\n${'='.repeat(40)}\n\n`;
    text += `Active polyfills:  ${infos.filter((i) => i.type === 'polyfill').length}\n`;
    text += `Redundant:         ${infos.filter((i) => i.type === 'redundant').length}\n`;
    text += `Missing:           ${infos.filter((i) => i.type === 'missing').length}\n`;
    text += `Issues:            ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDeprecationPolyfillTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_deprecation_polyfills', description: 'Analyze symfony/polyfill-* packages; warns on redundant polyfills when PHP constraint already provides functions natively, missing polyfills when code uses new functions below required PHP version', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_deprecation_polyfill_stats', description: 'Statistics for PHP polyfills: active/redundant/missing count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
