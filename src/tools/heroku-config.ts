import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface HerokuConfigInfo {
  file: string;
  type: 'procfile' | 'app-json' | 'buildpack';
  value: string;
  issues: string[];
}

function safeReadFile(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function parseProcfile(content: string, relPath: string): HerokuConfigInfo[] {
  const results: HerokuConfigInfo[] = [];
  const lines = content.split('\n');

  const dynoTypes: string[] = [];
  let hasWorker = false;
  let hasRelease = false;
  let hasWeb = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const dynoType = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const command = trimmed.slice(colonIdx + 1).trim();

    dynoTypes.push(dynoType);

    if (dynoType === 'web') {
      hasWeb = true;
      results.push({ file: relPath, type: 'procfile', value: `web: ${command}`, issues: [] });
    } else if (dynoType === 'worker') {
      hasWorker = true;
      results.push({ file: relPath, type: 'procfile', value: `worker: ${command}`, issues: [] });
    } else if (dynoType === 'release') {
      hasRelease = true;
      results.push({ file: relPath, type: 'procfile', value: `release: ${command}`, issues: [] });
    } else {
      results.push({ file: relPath, type: 'procfile', value: `${dynoType}: ${command}`, issues: [] });
    }
  }

  if (!hasWeb && dynoTypes.length > 0) {
    results.push({
      file: relPath,
      type: 'procfile',
      value: 'web dyno',
      issues: ['No web dyno defined in Procfile — add "web: vendor/bin/heroku-php-apache2 public/" to serve HTTP requests'],
    });
  }

  if (!hasWorker) {
    results.push({
      file: relPath,
      type: 'procfile',
      value: 'worker dyno',
      issues: ['No worker dyno defined — if using Symfony Messenger, add "worker: php bin/console messenger:consume --time-limit=3600"'],
    });
  }

  if (!hasRelease) {
    results.push({
      file: relPath,
      type: 'procfile',
      value: 'release phase',
      issues: ['No release dyno defined — add "release: php bin/console doctrine:migrations:migrate --no-interaction" to run migrations on deploy'],
    });
  }

  return results;
}

function parseAppJson(content: string, relPath: string): HerokuConfigInfo[] {
  const results: HerokuConfigInfo[] = [];
  let json: Record<string, unknown>;
  try { json = JSON.parse(content) as Record<string, unknown>; } catch {
    return [{ file: relPath, type: 'app-json', value: 'parse-error', issues: ['app.json is not valid JSON'] }];
  }

  // buildpacks
  const buildpacks = json['buildpacks'] as Array<Record<string, string>> | undefined;
  if (buildpacks && buildpacks.length > 0) {
    for (const bp of buildpacks) {
      const url = bp['url'] ?? bp['name'] ?? 'unknown';
      results.push({ file: relPath, type: 'buildpack', value: String(url), issues: [] });
    }
  } else {
    results.push({
      file: relPath,
      type: 'buildpack',
      value: 'missing',
      issues: ['No buildpacks defined in app.json — specify buildpacks array (e.g., heroku/php, heroku/nodejs)'],
    });
  }

  // env vars
  const env = json['env'] as Record<string, unknown> | undefined;
  if (env) {
    for (const [key, val] of Object.entries(env)) {
      const valObj = val as Record<string, unknown>;
      const required = valObj['required'] === true;
      const hasValue = 'value' in valObj && valObj['value'] !== undefined && valObj['value'] !== '';
      const info: HerokuConfigInfo = { file: relPath, type: 'app-json', value: `env.${key}`, issues: [] };
      if (required && !hasValue) {
        info.issues.push(`Required env var "${key}" has no default value in app.json — either provide a "value" or ensure it is set via Heroku config vars`);
      }
      results.push(info);
    }
  }

  // formation (process types)
  const formation = json['formation'] as Record<string, unknown> | undefined;
  if (formation) {
    for (const [proc, cfg] of Object.entries(formation)) {
      const cfgObj = cfg as Record<string, unknown>;
      results.push({
        file: relPath,
        type: 'app-json',
        value: `formation.${proc} quantity=${String(cfgObj['quantity'] ?? 1)} size=${String(cfgObj['size'] ?? 'standard-1x')}`,
        issues: [],
      });
    }
  }

  // addons
  const addons = json['addons'] as Array<unknown> | undefined;
  if (addons) {
    for (const addon of addons) {
      const addonObj = addon as Record<string, unknown>;
      const plan = addonObj['plan'] as string | undefined;
      const addonName = typeof addon === 'string' ? addon : (addonObj['id'] ?? addonObj['name'] ?? 'unknown');
      const info: HerokuConfigInfo = { file: relPath, type: 'app-json', value: `addon: ${String(addonName)}`, issues: [] };
      if (!plan && typeof addon !== 'string') {
        info.issues.push(`Addon "${String(addonName)}" has no plan specified — add a "plan" property to avoid defaulting to the free tier`);
      }
      results.push(info);
    }
  }

  return results;
}

function buildHerokuConfigInfos(appPath: string): HerokuConfigInfo[] {
  const results: HerokuConfigInfo[] = [];

  const procfilePath = path.join(appPath, 'Procfile');
  const procfileContent = safeReadFile(procfilePath, appPath);
  if (procfileContent !== null) {
    results.push(...parseProcfile(procfileContent, 'Procfile'));
  }

  const appJsonPath = path.join(appPath, 'app.json');
  const appJsonContent = safeReadFile(appJsonPath, appPath);
  if (appJsonContent !== null) {
    results.push(...parseAppJson(appJsonContent, 'app.json'));
  }

  return results;
}

export function listHerokuConfig(appPath: string): McpToolResult {
  try {
    const infos = buildHerokuConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Heroku configuration files found (Procfile, app.json).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Heroku Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.value}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHerokuConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildHerokuConfigInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Heroku Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Procfile entries:   ${infos.filter((i) => i.type === 'procfile').length}\n`;
    text += `App.json settings:  ${infos.filter((i) => i.type === 'app-json').length}\n`;
    text += `Buildpacks:         ${infos.filter((i) => i.type === 'buildpack').length}\n`;
    text += `Total issues:       ${totalIssues}\n`;
    text += `  Worker dyno:      ${infos.filter((i) => i.value === 'worker dyno' && i.issues.length > 0).length === 0 ? 'OK' : 'MISSING'}\n`;
    text += `  Release phase:    ${infos.filter((i) => i.value === 'release phase' && i.issues.length > 0).length === 0 ? 'OK' : 'MISSING'}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHerokuConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_heroku_config',
      description: 'Analyse Heroku Procfile and app.json for web/worker/release dyno types, buildpacks, required env vars without values, formation, and addons without plan',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_heroku_config_stats',
      description: 'Statistics for Heroku configuration: counts of Procfile entries, app.json settings, buildpacks, and issues including missing worker/release phases',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
