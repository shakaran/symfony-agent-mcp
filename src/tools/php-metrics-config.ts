import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpMetricsInfo {
  configFile: string;
  reportFormat: string;
  excludedDirs: string[];
  version: string;
  issues: string[];
}

function buildMetricsInfos(appPath: string): PhpMetricsInfo[] {
  const results: PhpMetricsInfo[] = [];

  const configCandidates = [
    path.join(appPath, 'phpmetrics.json'),
    path.join(appPath, 'phpmetrics.xml'),
    path.join(appPath, '.phpmetrics.json'),
  ];

  const configFile = configCandidates.find((c) => fs.existsSync(c)) ?? null;

  let composerHasPhpMetrics = false;
  let version = '';
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const require = (composer['require'] ?? {}) as Record<string, string>;
      const requireDev = (composer['require-dev'] ?? {}) as Record<string, string>;
      const v = require['phpmetrics/phpmetrics'] ?? requireDev['phpmetrics/phpmetrics'];
      if (v) { composerHasPhpMetrics = true; version = v; }
    } catch { /* ignore */ }
  }

  const issues: string[] = [];

  if (!composerHasPhpMetrics) {
    issues.push('PHPMetrics (phpmetrics/phpmetrics) not found in composer.json — install for coupling and cohesion metrics');
  }

  if (!configFile) {
    if (composerHasPhpMetrics) {
      issues.push('PHPMetrics installed but no configuration file found (phpmetrics.json or phpmetrics.xml)');
    }
    results.push({ configFile: 'none', reportFormat: '', excludedDirs: [], version, issues });
    return results;
  }

  let reportFormat = '';
  let excludedDirs: string[] = [];

  try {
    const content = fs.readFileSync(configFile, 'utf-8');
    if (configFile.endsWith('.json')) {
      const cfg = JSON.parse(content) as Record<string, unknown>;
      reportFormat = String(cfg['report'] ?? cfg['output'] ?? '');
      const excl = cfg['exclude'] ?? cfg['excluded'] ?? [];
      if (Array.isArray(excl)) excludedDirs = excl as string[];
    } else {
      if (/report\s+format\s*=\s*["']html["']/.test(content)) reportFormat = 'html';
      else if (/report\s+format\s*=\s*["']json["']/.test(content)) reportFormat = 'json';
      const exclMatch = /exclude\s*=\s*["']([^"']{1,500})["']/.exec(content);
      if (exclMatch) excludedDirs = exclMatch[1].split(',').map((s) => s.trim());
    }
  } catch { /* ignore */ }

  if (!excludedDirs.some((d) => d.includes('vendor'))) {
    issues.push('vendor/ not excluded from PHPMetrics analysis — will include vendor code in coupling metrics (false results)');
  }

  const relConfig = path.relative(appPath, configFile);
  const ciFiles = ['.github/workflows', '.gitlab-ci.yml', 'Makefile', 'Jenkinsfile'];
  let ciIntegrated = false;
  for (const ci of ciFiles) {
    const ciPath = path.join(appPath, ci);
    if (fs.existsSync(ciPath)) {
      try {
        const ciContent = fs.readFileSync(ciPath, 'utf-8');
        if (ciContent.includes('phpmetrics')) { ciIntegrated = true; break; }
      } catch { /* ignore */ }
    }
  }
  if (!ciIntegrated) {
    issues.push('PHPMetrics not found in CI configuration — metrics not tracked over time');
  }

  results.push({ configFile: relConfig, reportFormat, excludedDirs, version, issues });
  return results;
}

export function listPhpMetricsConfig(appPath: string): McpToolResult {
  try {
    const infos = buildMetricsInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHPMetrics Configuration Analysis\n${'='.repeat(50)}\n\nIssues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  Config: ${info.configFile}  version: ${info.version || '(not installed)'}\n`;
      text += `    Report format: ${info.reportFormat || '(default)'}  Excluded: ${info.excludedDirs.join(', ') || '(none)'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpMetricsStats(appPath: string): McpToolResult {
  try {
    const infos = buildMetricsInfos(appPath);
    let text = `PHPMetrics Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config files found:   ${infos.filter((i) => i.configFile !== 'none').length}\n`;
    text += `PHPMetrics installed: ${infos.some((i) => i.version !== '') ? 'yes' : 'no'}\n`;
    text += `Total issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpMetricsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_metrics_config', description: 'Analyze PHPMetrics 2 configuration; warns on missing install, no config file, vendor not excluded, no CI integration', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_metrics_stats', description: 'Statistics for PHPMetrics configuration: config files found, install status, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
