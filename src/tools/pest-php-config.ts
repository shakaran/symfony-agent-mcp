import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PestConfig {
  hasPestPhp: boolean;
  hasPestPlugin: boolean;
  pestVersion?: string;
  architectureTests: number;
  mutationTests: number;
  usesExpectApi: number;
  datasetCount: number;
  issues: string[];
}

function getPestVersion(appPath: string): string | undefined {
  const lockPath = path.join(appPath, 'composer.lock');
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { 'packages-dev'?: Array<{ name: string; version: string }> };
    const pest = (lock['packages-dev'] ?? []).find((p) => p.name === 'pestphp/pest');
    return pest?.version;
  } catch { return undefined; }
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

function analyzePest(appPath: string): PestConfig {
  const hasPestPhp = fs.existsSync(path.join(appPath, 'pest.php'));
  const composerJson = path.join(appPath, 'composer.json');
  let hasPestPlugin = false;
  try {
    const cj = JSON.parse(fs.readFileSync(composerJson, 'utf-8')) as Record<string, unknown>;
    const requireDev = (cj['require-dev'] ?? {}) as Record<string, unknown>;
    hasPestPlugin = !!requireDev['pestphp/pest'];
  } catch { /* skip */ }
  const pestVersion = getPestVersion(appPath);
  let architectureTests = 0;
  let mutationTests = 0;
  let usesExpectApi = 0;
  let datasetCount = 0;
  const testDir = path.join(appPath, 'tests');
  if (fs.existsSync(testDir)) {
    for (const file of getAllPhpFiles(testDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      if (!content.includes('pest') && !content.includes('it(') && !content.includes('test(') && !content.includes('describe(') && !content.includes('expect(')) continue;
      architectureTests += [...content.matchAll(/arch\s*\(/g)].length;
      mutationTests += [...content.matchAll(/mutates\s*\(/g)].length;
      usesExpectApi += [...content.matchAll(/expect\s*\(/g)].length;
      datasetCount += [...content.matchAll(/dataset\s*\(/g)].length;
    }
  }
  const issues: string[] = [];
  if (hasPestPlugin && !hasPestPhp) issues.push('Pest installed but no pest.php config found — run vendor/bin/pest --init to generate config');
  if (!hasPestPlugin) issues.push('Pest PHP not detected in composer.json require-dev — install with composer require --dev pestphp/pest');
  return { hasPestPhp, hasPestPlugin, pestVersion, architectureTests, mutationTests, usesExpectApi, datasetCount, issues };
}

export function listPestPhpConfig(appPath: string): McpToolResult {
  try {
    const config = analyzePest(appPath);
    let text = `Pest PHP Configuration\n${'='.repeat(55)}\n\n`;
    text += `Installed: ${config.hasPestPlugin ? `yes (${config.pestVersion ?? 'unknown version'})` : 'no'}\n`;
    text += `Config file (pest.php): ${config.hasPestPhp ? 'yes' : 'no'}\n`;
    text += `Architecture tests: ${config.architectureTests}\nMutation tests: ${config.mutationTests}\nExpect API usage: ${config.usesExpectApi}\nDatasets: ${config.datasetCount}\n`;
    if (config.issues.length > 0) {
      text += `\nIssues:\n`;
      for (const i of config.issues) text += `  ⚠ ${i}\n`;
    }
    if (config.hasPestPhp) {
      try {
        const pestPhpContent = fs.readFileSync(path.join(appPath, 'pest.php'), 'utf-8');
        text += `\nPest.php configuration:\n  ${pestPhpContent.split('\n').slice(0, 20).join('\n  ')}\n`;
      } catch { /* skip */ }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPestPhpStats(appPath: string): McpToolResult {
  try {
    const config = analyzePest(appPath);
    let text = `Pest PHP Statistics\n${'='.repeat(40)}\n\n`;
    text += `Installed: ${config.hasPestPlugin ? 'yes' : 'no'}\nVersion: ${config.pestVersion ?? 'not installed'}\nConfig: ${config.hasPestPhp ? 'yes' : 'no'}\nArchitecture tests: ${config.architectureTests}\nMutation tests: ${config.mutationTests}\nDatasets: ${config.datasetCount}\nIssues: ${config.issues.length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPestPhpTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_pest_php_config', description: 'Show Pest PHP configuration: installed version, pest.php config, architecture/mutation test counts, dataset count, missing config warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_pest_php_stats', description: 'Show Pest PHP statistics: installation status, version, architecture/mutation/dataset counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
