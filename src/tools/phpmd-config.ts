import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpmdInfo {
  configFile: string;
  rulesets: string[];
  excludedPaths: string[];
  issues: string[];
}

const KNOWN_RULESETS = ['cleancode', 'codesize', 'controversial', 'design', 'naming', 'unusedcode'];

function buildPhpmdInfos(appPath: string): PhpmdInfo[] {
  const configCandidates = [
    path.join(appPath, 'phpmd.xml'),
    path.join(appPath, 'phpmd.xml.dist'),
    path.join(appPath, '.phpmd.xml'),
    path.join(appPath, 'ruleset.xml'),
  ];

  const configFile = configCandidates.find((c) => fs.existsSync(c)) ?? null;

  let composerHasPhpmd = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      const dev = (composer['require-dev'] ?? {}) as Record<string, string>;
      if (req['phpmd/phpmd'] || dev['phpmd/phpmd']) composerHasPhpmd = true;
    } catch { /* ignore */ }
  }

  const issues: string[] = [];

  if (!composerHasPhpmd) {
    issues.push('PHPMD (phpmd/phpmd) not found in composer.json — install for mess detection (large classes, dead code, etc.)');
  }

  if (!configFile) {
    if (composerHasPhpmd) {
      issues.push('PHPMD installed but no configuration file (phpmd.xml or phpmd.xml.dist)');
    }
    return [{ configFile: 'none', rulesets: [], excludedPaths: [], issues }];
  }

  let content = '';
  try { content = fs.readFileSync(configFile, 'utf-8'); } catch { /* ignore */ }

  const rulesets: string[] = [];
  for (const rs of KNOWN_RULESETS) {
    if (content.toLowerCase().includes(rs)) rulesets.push(rs);
  }

  const excludedPaths: string[] = [];
  const exclMatches = content.matchAll(/exclude[^>]{0,50}=\s*["']([^"']{1,200})["']/gi);
  for (const m of exclMatches) excludedPaths.push(m[1]);

  if (!rulesets.includes('unusedcode')) {
    issues.push('UnusedCode ruleset not configured — dead code and unused variables will not be detected');
  }
  if (!rulesets.includes('cleancode')) {
    issues.push('CleanCode ruleset not configured — static access and boolean flag parameters not checked');
  }
  if (!excludedPaths.some((p) => p.includes('vendor'))) {
    issues.push('vendor/ not excluded — PHPMD will scan third-party code');
  }

  const ciFiles = ['.github/workflows', '.gitlab-ci.yml', 'Makefile'];
  let ciIntegrated = false;
  for (const ci of ciFiles) {
    const ciPath = path.join(appPath, ci);
    if (fs.existsSync(ciPath)) {
      try {
        if (fs.readFileSync(ciPath, 'utf-8').includes('phpmd')) { ciIntegrated = true; break; }
      } catch { /* ignore */ }
    }
  }
  if (!ciIntegrated) {
    issues.push('PHPMD not found in CI configuration — mess detection not enforced in pipeline');
  }

  return [{ configFile: path.relative(appPath, configFile), rulesets, excludedPaths, issues }];
}

export function listPhpmdConfig(appPath: string): McpToolResult {
  try {
    const infos = buildPhpmdInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHPMD Configuration Analysis\n${'='.repeat(50)}\n\nIssues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  Config: ${info.configFile}\n`;
      text += `    Rulesets: ${info.rulesets.join(', ') || '(none)'}\n`;
      text += `    Excluded: ${info.excludedPaths.join(', ') || '(none)'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpmdStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpmdInfos(appPath);
    let text = `PHPMD Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config files:     ${infos.filter((i) => i.configFile !== 'none').length}\n`;
    text += `Rulesets active:  ${infos.reduce((s, i) => s + i.rulesets.length, 0)}\n`;
    text += `Total issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpmdTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_phpmd_config', description: 'Analyze PHPMD (PHP Mess Detector) configuration; warns on missing install, missing rulesets (UnusedCode/CleanCode), vendor not excluded, no CI integration', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_phpmd_stats', description: 'Statistics for PHPMD: config files found, rulesets active, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
