/**
 * Symfony Twig Cache Configuration Inspector
 *
 * Scans config/packages/twig.yaml and environment-specific overrides
 * (prod/twig.yaml, dev/twig.yaml) for cache and auto_reload settings.
 * Warns when cache is disabled in prod, auto_reload is enabled in prod,
 * or cache is not explicitly configured for prod.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface TwigCacheInfo {
  setting: string;
  value: string;
  environment: string;
  recommendation: string;
}

function readFileSafe(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function extractTwigValue(content: string, key: string): string | null {
  const pattern = new RegExp(`\\b${key}\\s*:\\s*(\\S+)`);
  const m = pattern.exec(content);
  return m ? m[1].trim() : null;
}

function buildTwigCacheInfos(appPath: string): TwigCacheInfo[] {
  const infos: TwigCacheInfo[] = [];

  const configCandidates: Array<{ file: string; env: string }> = [
    { file: path.join(appPath, 'config', 'packages', 'twig.yaml'), env: 'all' },
    { file: path.join(appPath, 'config', 'packages', 'prod', 'twig.yaml'), env: 'prod' },
    { file: path.join(appPath, 'config', 'packages', 'dev', 'twig.yaml'), env: 'dev' },
    { file: path.join(appPath, 'config', 'packages', 'test', 'twig.yaml'), env: 'test' },
  ];

  let foundProdCacheConfig = false;

  for (const { file, env } of configCandidates) {
    const content = readFileSafe(file, appPath);
    if (!content) continue;

    const relFile = path.relative(appPath, file);

    // Check cache setting
    const cacheVal = extractTwigValue(content, 'cache');
    if (cacheVal !== null) {
      let recommendation = '';
      if (env === 'prod' || env === 'all') {
        foundProdCacheConfig = true;
        if (cacheVal === 'false' || cacheVal === '~' || cacheVal === 'null') {
          recommendation = 'CRITICAL: Twig cache disabled in prod — enable cache for performance (set to "%kernel.cache_dir%/twig")';
        } else if (cacheVal === 'true') {
          recommendation = 'Cache enabled (boolean true) — specify a cache directory path for clarity';
        } else {
          recommendation = 'Cache path configured correctly';
        }
      } else if (env === 'dev') {
        if (cacheVal !== 'false') {
          recommendation = 'Consider disabling Twig cache in dev for easier template debugging';
        } else {
          recommendation = 'Cache disabled in dev — correct for development';
        }
      }
      infos.push({ setting: `${relFile}: cache`, value: cacheVal, environment: env, recommendation });
    }

    // Check auto_reload setting
    const autoReloadVal = extractTwigValue(content, 'auto_reload');
    if (autoReloadVal !== null) {
      let recommendation = '';
      if (env === 'prod' || env === 'all') {
        if (autoReloadVal === 'true') {
          recommendation = 'PERF: auto_reload enabled in prod — disables template compilation cache, severe performance impact';
        } else {
          recommendation = 'auto_reload disabled in prod — correct';
        }
      } else if (env === 'dev') {
        if (autoReloadVal !== 'true') {
          recommendation = 'Consider enabling auto_reload in dev for automatic template recompilation';
        } else {
          recommendation = 'auto_reload enabled in dev — correct';
        }
      }
      infos.push({ setting: `${relFile}: auto_reload`, value: autoReloadVal, environment: env, recommendation });
    }

    // Check debug setting
    const debugVal = extractTwigValue(content, 'debug');
    if (debugVal !== null) {
      let recommendation = '';
      if (env === 'prod' && debugVal === 'true') {
        recommendation = 'WARN: Twig debug enabled in prod — exposes template structure and slows rendering';
      } else if (env === 'dev' && debugVal !== 'true') {
        recommendation = 'Consider enabling debug in dev for dump() and other debug helpers';
      } else {
        recommendation = 'Debug setting appropriate for environment';
      }
      infos.push({ setting: `${relFile}: debug`, value: debugVal, environment: env, recommendation });
    }

    // Check strict_variables
    const strictVal = extractTwigValue(content, 'strict_variables');
    if (strictVal !== null && (env === 'prod' || env === 'all')) {
      if (strictVal === 'false') {
        infos.push({
          setting: `${relFile}: strict_variables`,
          value: strictVal,
          environment: env,
          recommendation: 'WARN: strict_variables disabled — undefined variables silently return null, masking bugs',
        });
      }
    }
  }

  // If no prod cache config found, warn
  if (!foundProdCacheConfig) {
    infos.push({
      setting: 'config/packages/prod/twig.yaml: cache',
      value: 'not set',
      environment: 'prod',
      recommendation: 'WARN: No explicit cache config for prod environment — ensure framework default enables Twig cache in prod',
    });
  }

  // Check framework.cache pool for Twig integration
  const frameworkCacheFile = path.join(appPath, 'config', 'packages', 'cache.yaml');
  const frameworkContent = readFileSafe(frameworkCacheFile, appPath);
  if (frameworkContent && frameworkContent.includes('twig')) {
    infos.push({
      setting: path.relative(appPath, frameworkCacheFile) + ': twig cache pool',
      value: 'configured',
      environment: 'all',
      recommendation: 'Twig cache pool configured in framework cache — ensure pool adapter is appropriate for production load',
    });
  }

  return infos;
}

export function listSymfonyTwigCacheConfig(appPath: string): McpToolResult {
  try {
    const infos = buildTwigCacheInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Twig configuration files found (config/packages/twig.yaml).' }] };
    }

    const critical = infos.filter(i => i.recommendation.startsWith('CRITICAL')).length;
    const perf = infos.filter(i => i.recommendation.startsWith('PERF')).length;
    const warns = infos.filter(i => i.recommendation.startsWith('WARN')).length;

    let text = `Symfony Twig Cache Configuration\n${'='.repeat(55)}\n\n`;
    text += `Settings found: ${infos.length}  (critical:${critical} perf:${perf} warn:${warns})\n\n`;

    for (const info of infos) {
      const severity = info.recommendation.startsWith('CRITICAL') ? '[CRITICAL]'
        : info.recommendation.startsWith('PERF') ? '[PERF]'
        : info.recommendation.startsWith('WARN') ? '[WARN]'
        : '[OK]';
      text += `  ${severity} ${info.setting} = ${info.value}  (env: ${info.environment})\n`;
      text += `    ${info.recommendation}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyTwigCacheConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildTwigCacheInfos(appPath);
    const critical = infos.filter(i => i.recommendation.startsWith('CRITICAL')).length;
    const perf = infos.filter(i => i.recommendation.startsWith('PERF')).length;
    const warns = infos.filter(i => i.recommendation.startsWith('WARN')).length;
    const ok = infos.filter(i => i.recommendation.startsWith('Cache') || i.recommendation.includes('correct')).length;
    const prodEntries = infos.filter(i => i.environment === 'prod').length;
    const devEntries = infos.filter(i => i.environment === 'dev').length;

    let text = `Symfony Twig Cache Config Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total settings found: ${infos.length}\n`;
    text += `  Critical issues:    ${critical}\n`;
    text += `  Perf warnings:      ${perf}\n`;
    text += `  Warnings:           ${warns}\n`;
    text += `  OK:                 ${ok}\n`;
    text += `  Prod settings:      ${prodEntries}\n`;
    text += `  Dev settings:       ${devEntries}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyTwigCacheConfigTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_twig_cache_config',
      description: 'List Symfony Twig cache configuration across environments: cache path, auto_reload, debug, strict_variables settings with severity-tagged recommendations',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_twig_cache_config_stats',
      description: 'Get Symfony Twig cache config statistics: counts of critical issues, perf warnings, general warnings, and OK settings by environment',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
