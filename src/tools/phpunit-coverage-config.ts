import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CoverageConfig {
  driver?: string;
  hasSource: boolean;
  includePaths: string[];
  excludePaths: string[];
  hasMinCoverage: boolean;
  minLine?: number;
  minMethod?: number;
  minClass?: number;
  minBranch?: number;
  hasHtmlReport: boolean;
  hasCoberturaReport: boolean;
  issues: string[];
}

function loadCoverageConfig(appPath: string): CoverageConfig | null {
  const candidates = [
    path.join(appPath, 'phpunit.xml'),
    path.join(appPath, 'phpunit.xml.dist'),
    path.join(appPath, 'phpunit.dist.xml'),
  ];
  for (const filePath of candidates) {
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    if (!content.includes('<coverage') && !content.includes('<source') && !content.includes('requireCoverageMetadata')) continue;
    const hasSource = content.includes('<source') || content.includes('<include>');
    const includePaths: string[] = [];
    const includeRe = /<directory[^>]{0,100}>([^<]{1,200})<\/directory>/g;
    let m: RegExpExecArray | null;
    while ((m = includeRe.exec(content)) !== null) includePaths.push(m[1].trim());
    const excludePaths: string[] = [];
    const excludeSection = content.split('<exclude>')[1]?.split('</exclude>')[0] ?? '';
    if (excludeSection) {
      const exRe = /<directory[^>]{0,100}>([^<]{1,200})<\/directory>/g;
      while ((m = exRe.exec(excludeSection)) !== null) excludePaths.push(m[1].trim());
    }
    const driverM = /cacheDirectory|XDEBUG_MODE|pcov\.enabled|driver="(\w+)"/.exec(content);
    const driver = content.includes('pcov') ? 'pcov' : (content.includes('xdebug') || content.includes('XDEBUG') ? 'xdebug' : driverM?.[1] ?? 'auto');
    const hasMinCoverage = content.includes('<require') || content.includes('minPercentage') || content.includes('coverageThreshold');
    const minLineM = /<lines[^>]{0,100}minPercentage="(\d+(?:\.\d+)?)"/.exec(content);
    const minMethodM = /<methods[^>]{0,100}minPercentage="(\d+(?:\.\d+)?)"/.exec(content);
    const minClassM = /<classes[^>]{0,100}minPercentage="(\d+(?:\.\d+)?)"/.exec(content);
    const minBranchM = /<branches[^>]{0,100}minPercentage="(\d+(?:\.\d+)?)"/.exec(content);
    const hasHtmlReport = content.includes('<html ') || content.includes("html ");
    const hasCoberturaReport = content.includes('cobertura') || content.includes('clover');
    const issues: string[] = [];
    if (!hasSource) issues.push('No <source> include paths — PHPUnit 11+ requires explicit source paths for coverage');
    if (!hasMinCoverage) issues.push('No minimum coverage threshold configured — coverage can silently drop');
    if (driver === 'xdebug') issues.push('XDebug coverage driver is slow — consider PCOV for CI/CD (composer require pcov/clobber)');
    if (!hasCoberturaReport) issues.push('No Cobertura/Clover XML coverage report — CI tools (GitHub, GitLab) need XML for coverage visualization');
    return { driver, hasSource, includePaths, excludePaths, hasMinCoverage, minLine: minLineM ? parseFloat(minLineM[1]) : undefined, minMethod: minMethodM ? parseFloat(minMethodM[1]) : undefined, minClass: minClassM ? parseFloat(minClassM[1]) : undefined, minBranch: minBranchM ? parseFloat(minBranchM[1]) : undefined, hasHtmlReport, hasCoberturaReport, issues };
  }
  return null;
}

export function listPhpUnitCoverageConfig(appPath: string): McpToolResult {
  try {
    const config = loadCoverageConfig(appPath);
    if (!config) return { content: [{ type: 'text', text: 'No PHPUnit coverage configuration found.\n\nAdd to phpunit.xml:\n  <coverage>\n    <report><html outputDirectory="coverage"/></report>\n    <source><include><directory>src/</directory></include></source>\n  </coverage>' }] };
    let text = `PHPUnit Coverage Configuration\n${'='.repeat(55)}\n\nDriver: ${config.driver ?? 'auto'}  Issues: ${config.issues.length}\n`;
    text += `\nSource include paths: ${config.includePaths.length > 0 ? config.includePaths.join(', ') : 'none'}\n`;
    text += `Excluded paths: ${config.excludePaths.length > 0 ? config.excludePaths.join(', ') : 'none'}\n`;
    text += `Reports: ${[config.hasHtmlReport ? 'HTML' : '', config.hasCoberturaReport ? 'Cobertura/Clover' : ''].filter(Boolean).join(', ') || 'none'}\n`;
    if (config.hasMinCoverage) {
      text += `Thresholds: lines ${config.minLine ?? '?'}%  methods ${config.minMethod ?? '?'}%  classes ${config.minClass ?? '?'}%\n`;
    } else {
      text += `Thresholds: none configured\n`;
    }
    for (const i of config.issues) text += `\n⚠ ${i}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpUnitCoverageStats(appPath: string): McpToolResult {
  try {
    const config = loadCoverageConfig(appPath);
    let text = `PHPUnit Coverage Statistics\n${'='.repeat(40)}\n\n`;
    if (!config) { text += 'No coverage config found.\n'; }
    else {
      text += `Coverage configured: yes\nDriver: ${config.driver ?? 'auto'}\nHas source paths: ${config.hasSource ? 'yes' : 'no'}\nHas thresholds: ${config.hasMinCoverage ? 'yes' : 'no'}\nHas HTML report: ${config.hasHtmlReport ? 'yes' : 'no'}\nHas Cobertura/Clover: ${config.hasCoberturaReport ? 'yes' : 'no'}\nIssues: ${config.issues.length}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpUnitCoverageTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_phpunit_coverage_config', description: 'Analyze PHPUnit coverage config from phpunit.xml: source include/exclude paths, coverage driver (Xdebug/PCOV), minimum percentage thresholds (line/method/class/branch), HTML/Cobertura/Clover reports', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_phpunit_coverage_stats', description: 'PHPUnit coverage statistics: configured, driver, source paths, thresholds, report types, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
