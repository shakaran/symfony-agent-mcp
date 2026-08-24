// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SonarqubeConfigInfo {
  file: string;
  type: 'project-key' | 'sources' | 'coverage' | 'exclusions' | 'quality-gate' | 'ci';
  directive: string;
  value: string;
  issues: string[];
}

function buildSonarqubeConfigInfos(appPath: string): SonarqubeConfigInfo[] {
  const results: SonarqubeConfigInfo[] = [];

  const sonarFiles = [
    path.join(appPath, 'sonar-project.properties'),
    path.join(appPath, '.sonarcloud.properties'),
    path.join(appPath, 'sonar.properties'),
  ];

  for (const sonarFile of sonarFiles) {
    if (!fs.existsSync(sonarFile)) continue;
    let content = '';
    try { content = fs.readFileSync(sonarFile, 'utf-8'); } catch { continue; }
    const relFile = path.relative(appPath, sonarFile);

    const hasProjectKey = content.includes('sonar.projectKey=');
    if (!hasProjectKey) {
      results.push({ file: relFile, type: 'project-key', directive: 'sonar.projectKey', value: '(missing)', issues: ['sonar.projectKey not set — SonarQube requires a unique project key; without it scans may create duplicate projects or fail'] });
    }

    const hasSources = content.includes('sonar.sources=');
    if (!hasSources) {
      results.push({ file: relFile, type: 'sources', directive: 'sonar.sources', value: '(missing)', issues: ['sonar.sources not configured — SonarQube will scan the entire project directory; set sonar.sources=src to limit scope and speed up analysis'] });
    }

    const hasCoverage = content.includes('sonar.php.coverage') || content.includes('sonar.coverage') || content.includes('coverage.reportPaths');
    if (!hasCoverage) {
      results.push({ file: relFile, type: 'coverage', directive: 'sonar.php.coverage.reportPaths', value: '(missing)', issues: ['Coverage report not configured in SonarQube — SonarQube will report 0% coverage; set sonar.php.coverage.reportPaths=coverage.xml and generate PHPUnit XML coverage report in CI'] });
    }

    const hasExclusions = content.includes('sonar.exclusions=');
    if (!hasExclusions) {
      results.push({ file: relFile, type: 'exclusions', directive: 'sonar.exclusions', value: '(missing)', issues: ['sonar.exclusions not configured — SonarQube will analyze vendor/, migrations, and test fixtures; add sonar.exclusions=vendor/**,**/migrations/**,**/fixtures/** to reduce noise'] });
    }

    const hasEncoding = content.includes('sonar.sourceEncoding=');
    if (!hasEncoding) {
      results.push({ file: relFile, type: 'sources', directive: 'sonar.sourceEncoding', value: '(default)', issues: ['sonar.sourceEncoding not set — defaults to platform encoding; set sonar.sourceEncoding=UTF-8 for consistent multi-platform analysis'] });
    }

    const hasDupExclusions = content.includes('sonar.cpd.exclusions=');
    if (!hasDupExclusions) {
      results.push({ file: relFile, type: 'exclusions', directive: 'sonar.cpd.exclusions', value: '(missing)', issues: ['sonar.cpd.exclusions not set — copy-paste detection will flag migrations and auto-generated code as duplicates; exclude these paths to reduce false positives'] });
    }
  }

  const ciFiles = [
    path.join(appPath, '.github', 'workflows'),
    path.join(appPath, '.gitlab-ci.yml'),
    path.join(appPath, '.circleci', 'config.yml'),
    path.join(appPath, 'Jenkinsfile'),
  ];

  let hasCiSonar = false;
  for (const ciPath of ciFiles) {
    if (!fs.existsSync(ciPath)) continue;
    let ciContent = '';
    try {
      if (fs.statSync(ciPath).isDirectory()) {
        const entries = fs.readdirSync(ciPath, { withFileTypes: true }).filter((f) => !f.isSymbolicLink() && (f.name.endsWith('.yml') || f.name.endsWith('.yaml')));
        for (const f of entries) {
          try { ciContent += fs.readFileSync(path.join(ciPath, f.name), 'utf-8'); } catch { /* skip */ }
        }
      } else {
        ciContent = fs.readFileSync(ciPath, 'utf-8');
      }
    } catch { continue; }

    if (ciContent.includes('sonar') || ciContent.includes('SonarQube') || ciContent.includes('sonarcloud')) {
      hasCiSonar = true;
      const hasQualityGate = ciContent.includes('qualitygate') || ciContent.includes('quality-gate') || ciContent.includes('wait');
      if (!hasQualityGate) {
        results.push({ file: path.relative(appPath, typeof ciPath === 'string' ? ciPath : ciPath), type: 'quality-gate', directive: 'quality gate wait', value: '(missing)', issues: ['SonarQube in CI without quality gate wait — CI passes even if SonarQube quality gate fails; add sonarqube-quality-gate-action or sonar.qualitygate.wait=true'] });
      }
    }
  }

  if (!hasCiSonar && sonarFiles.some((f) => fs.existsSync(f))) {
    results.push({ file: 'CI', type: 'ci', directive: 'sonar in CI', value: '(not found)', issues: ['SonarQube config found but no CI integration detected — SonarQube analysis should run automatically in CI; integrate sonar-scanner into your CI pipeline'] });
  }

  return results;
}

export function listSonarqubeConfig(appPath: string): McpToolResult {
  try {
    const infos = buildSonarqubeConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No SonarQube configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `SonarQube Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSonarqubeConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildSonarqubeConfigInfos(appPath);
    let text = `SonarQube Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Project config: ${infos.filter((i) => i.type === 'project-key' || i.type === 'sources').length}\n`;
    text += `Coverage:       ${infos.filter((i) => i.type === 'coverage').length}\n`;
    text += `CI integration: ${infos.filter((i) => i.type === 'ci' || i.type === 'quality-gate').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSonarqubeConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_sonarqube_config', description: 'Analyze SonarQube project configuration; warns on missing projectKey, sources, coverage.reportPaths, exclusions for vendor/migrations, sourceEncoding, cpd.exclusions, CI without quality gate wait', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_sonarqube_config_stats', description: 'Statistics for SonarQube config: project/coverage/CI entry count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
