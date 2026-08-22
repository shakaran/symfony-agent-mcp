import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface XdebugConfigInfo {
  file: string;
  setting: string;
  value: string;
  recommendation: string;
}

function collectIniFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectIniFiles(full, base));
    } else if (entry.name.endsWith('.ini')) {
      results.push(full);
    }
  }
  return results;
}

function buildXdebugConfigInfos(appPath: string): XdebugConfigInfo[] {
  const results: XdebugConfigInfo[] = [];

  // Scan composer.json for xdebug dev dependencies
  const composerPath = path.join(appPath, 'composer.json');
  const resolvedComposer = path.resolve(composerPath);
  if (resolvedComposer.startsWith(path.resolve(appPath) + path.sep) || resolvedComposer === path.resolve(appPath)) {
    try {
      const composerContent = fs.readFileSync(composerPath, 'utf-8');
      const composerJson = JSON.parse(composerContent) as Record<string, unknown>;
      const requireDev = (composerJson['require-dev'] ?? {}) as Record<string, string>;
      if ('phpunit/phpunit' in requireDev && !('phpversion/xdebug' in requireDev)) {
        // xdebug commonly needed for coverage but not always listed
      }
      const allDeps = { ...requireDev, ...(composerJson['require'] ?? {}) as Record<string, string> };
      for (const dep of Object.keys(allDeps)) {
        if (dep.toLowerCase().includes('xdebug')) {
          results.push({
            file: 'composer.json',
            setting: `require-dev.${dep}`,
            value: allDeps[dep],
            recommendation: 'Xdebug listed as dependency — ensure it is only in require-dev, never in require',
          });
        }
      }
    } catch { /* skip */ }
  }

  // Scan for ini files under appPath
  const iniFiles = collectIniFiles(appPath, appPath);
  // Also check common locations
  const candidates = [
    path.join(appPath, 'php.ini'),
    path.join(appPath, 'xdebug.ini'),
    path.join(appPath, '.docker', 'php.ini'),
    path.join(appPath, 'docker', 'php.ini'),
    path.join(appPath, 'config', 'php.ini'),
  ];
  for (const c of candidates) {
    const resolved = path.resolve(c);
    if (resolved.startsWith(path.resolve(appPath) + path.sep) || resolved === path.resolve(appPath)) {
      if (!iniFiles.includes(c)) {
        try { fs.statSync(c); iniFiles.push(c); } catch { /* skip */ }
      }
    }
  }

  const xdebugSettings: Record<string, (val: string) => string | null> = {
    'xdebug.mode': (val) => {
      if (val.includes('develop') || val.includes('debug')) {
        return 'xdebug.mode=develop/debug should not be set in production — use off or coverage only';
      }
      return null;
    },
    'xdebug.start_with_request': (val) => {
      if (val === 'yes') {
        return 'xdebug.start_with_request=yes starts Xdebug on every request — use trigger in non-dev environments';
      }
      return null;
    },
    'xdebug.client_host': (val) => {
      if (val === '0.0.0.0' || val === '*') {
        return 'xdebug.client_host should not be 0.0.0.0 — restrict to loopback or specific IP';
      }
      return null;
    },
    'xdebug.log': (val) => {
      if (val && val !== '' && val !== 'false' && val !== '0') {
        return `xdebug.log is enabled (${val}) — disable in production to avoid information disclosure`;
      }
      return null;
    },
  };

  for (const iniFile of iniFiles) {
    let content: string;
    try { content = fs.readFileSync(iniFile, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim().toLowerCase();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/['"]/g, '');
      if (key in xdebugSettings) {
        const rec = xdebugSettings[key](val);
        if (rec) {
          results.push({
            file: path.relative(appPath, iniFile),
            setting: key,
            value: val,
            recommendation: rec,
          });
        } else {
          results.push({
            file: path.relative(appPath, iniFile),
            setting: key,
            value: val,
            recommendation: 'Setting detected — verify it is appropriate for the deployment environment',
          });
        }
      }
    }
  }

  return results;
}

export function listPhpXdebugConfig(appPath: string): McpToolResult {
  try {
    const infos = buildXdebugConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Xdebug configuration issues found.' }] };
    }
    const lines = infos.map(i => `${i.file}\n  Setting: ${i.setting} = ${i.value}\n  Recommendation: ${i.recommendation}`);
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpXdebugConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildXdebugConfigInfos(appPath);
    const stats = {
      total: infos.length,
      byFile: {} as Record<string, number>,
      bySetting: {} as Record<string, number>,
    };
    for (const i of infos) {
      stats.byFile[i.file] = (stats.byFile[i.file] ?? 0) + 1;
      stats.bySetting[i.setting] = (stats.bySetting[i.setting] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpXdebugConfigTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_php_xdebug_config',
      description: 'List Xdebug configuration issues found in ini files and composer.json — flags dangerous settings like xdebug.mode=develop or start_with_request=yes in non-dev contexts.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    },
    {
      name: 'get_php_xdebug_config_stats',
      description: 'Get statistics for Xdebug configuration issues: total findings grouped by file and setting name.',
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
