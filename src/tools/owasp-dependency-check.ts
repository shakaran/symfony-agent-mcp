// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface OwaspDependencyCheckInfo {
  file: string;
  tool: 'dependency-check' | 'retire-js' | 'npm-audit' | 'composer-audit';
  configured: boolean;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function findCiFiles(appPath: string): Array<{ relFile: string; content: string }> {
  const found: Array<{ relFile: string; content: string }> = [];

  // GitHub Actions
  const ghWorkflowsDir = path.join(appPath, '.github', 'workflows');
  if (fs.existsSync(ghWorkflowsDir)) {
    for (const ymlFile of scanDirRecursive(ghWorkflowsDir, '.yml')) {
      const content = safeRead(ymlFile, appPath);
      if (content) found.push({ relFile: path.relative(appPath, ymlFile), content });
    }
    for (const yamlFile of scanDirRecursive(ghWorkflowsDir, '.yaml')) {
      const content = safeRead(yamlFile, appPath);
      if (content) found.push({ relFile: path.relative(appPath, yamlFile), content });
    }
  }

  // GitLab CI
  const gitlabCiPath = path.join(appPath, '.gitlab-ci.yml');
  const gitlabContent = safeRead(gitlabCiPath, appPath);
  if (gitlabContent) found.push({ relFile: '.gitlab-ci.yml', content: gitlabContent });

  // Jenkinsfile
  const jenkinsfilePath = path.join(appPath, 'Jenkinsfile');
  const jenkinsContent = safeRead(jenkinsfilePath, appPath);
  if (jenkinsContent) found.push({ relFile: 'Jenkinsfile', content: jenkinsContent });

  return found;
}

function buildOwaspDependencyCheckInfos(appPath: string): OwaspDependencyCheckInfo[] {
  const results: OwaspDependencyCheckInfo[] = [];

  // Check for dependency-check report/config files
  const dcXmlPath = path.join(appPath, 'dependency-check.xml');
  if (fs.existsSync(dcXmlPath)) {
    const content = safeRead(dcXmlPath, appPath);
    const issues: string[] = [];
    if (content) {
      // Check report date freshness (look for reportDate or generated attribute)
      const dateM = /reportDate['":\s]+([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(content);
      if (dateM) {
        const reportDate = new Date(dateM[1]);
        const now = new Date();
        const diffDays = (now.getTime() - reportDate.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays > 30) {
          issues.push(`dependency-check.xml report is ${Math.floor(diffDays)} days old — regenerate with updated NVD data to catch recent CVEs`);
        }
      }
    }
    results.push({ file: 'dependency-check.xml', tool: 'dependency-check', configured: true, issues });
  }

  const dcDir = path.join(appPath, '.dependency-check');
  if (fs.existsSync(dcDir)) {
    results.push({ file: '.dependency-check/', tool: 'dependency-check', configured: true, issues: [] });
  }

  const odcDir = path.join(appPath, 'odc-reports');
  if (fs.existsSync(odcDir)) {
    results.push({ file: 'odc-reports/', tool: 'dependency-check', configured: true, issues: [] });
  }

  // Check composer.json scripts for security-checker or audit
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  let composerAuditFound = false;
  if (composerContent) {
    const hasAudit = composerContent.includes('composer audit') || composerContent.includes('security-checker') || composerContent.includes('local-php-security-checker');
    composerAuditFound = hasAudit;
    if (hasAudit) {
      results.push({ file: 'composer.json', tool: 'composer-audit', configured: true, issues: [] });
    }
  }

  // Scan CI files
  const ciFiles = findCiFiles(appPath);
  const toolsFoundInCi = new Set<string>();

  for (const { relFile, content } of ciFiles) {
    const hasDependencyCheck = content.includes('dependency-check') || content.includes('owasp');
    const hasRetireJs = content.includes('retire') || content.includes('retire.js');
    const hasNpmAudit = content.includes('npm audit');
    const hasComposerAudit = content.includes('composer audit') || content.includes('security-checker');

    if (hasDependencyCheck) {
      toolsFoundInCi.add('dependency-check');
      const issues: string[] = [];
      if (content.includes('continue-on-error: true') || content.includes('allow_failure: true')) {
        issues.push(`dependency-check in ${relFile} with continue-on-error/allow_failure — scan results are being ignored; fail the build on HIGH/CRITICAL CVEs`);
      }
      results.push({ file: relFile, tool: 'dependency-check', configured: true, issues });
    }

    if (hasRetireJs) {
      toolsFoundInCi.add('retire-js');
      results.push({ file: relFile, tool: 'retire-js', configured: true, issues: [] });
    }

    if (hasNpmAudit) {
      toolsFoundInCi.add('npm-audit');
      const issues: string[] = [];
      if (content.includes('npm audit') && content.includes('--audit-level=none')) {
        issues.push(`npm audit in ${relFile} with --audit-level=none — this suppresses all vulnerability failures; set --audit-level=high or --audit-level=critical`);
      }
      results.push({ file: relFile, tool: 'npm-audit', configured: true, issues });
    }

    if (hasComposerAudit) {
      toolsFoundInCi.add('composer-audit');
      results.push({ file: relFile, tool: 'composer-audit', configured: true, issues: [] });
    }
  }

  // Warn if no dependency scan in CI at all
  if (toolsFoundInCi.size === 0 && ciFiles.length > 0) {
    results.push({
      file: ciFiles[0].relFile,
      tool: 'dependency-check',
      configured: false,
      issues: ['No dependency security scanning found in CI — add OWASP dependency-check, npm audit, or composer audit to detect vulnerable dependencies before deployment'],
    });
  } else if (ciFiles.length === 0) {
    results.push({
      file: 'CI',
      tool: 'dependency-check',
      configured: false,
      issues: ['No CI configuration files found — add a CI pipeline with dependency scanning (OWASP dependency-check, composer audit, npm audit) to detect vulnerable packages'],
    });
  }

  // Warn if composer audit not in CI
  if (!toolsFoundInCi.has('composer-audit') && !composerAuditFound && composerContent) {
    results.push({
      file: 'composer.json',
      tool: 'composer-audit',
      configured: false,
      issues: ['composer audit not found in CI or composer.json scripts — add `composer audit` to CI pipeline to detect PHP dependencies with known CVEs'],
    });
  }

  return results;
}

export function listOwaspDependencyCheck(appPath: string): McpToolResult {
  try {
    const infos = buildOwaspDependencyCheckInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No OWASP dependency check configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `OWASP Dependency Check Analysis\n${'='.repeat(55)}\n\nFindings: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      const status = info.configured ? 'CONFIGURED' : 'MISSING';
      text += `\n  [${info.tool.toUpperCase()}] [${status}]  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getOwaspDependencyCheckStats(appPath: string): McpToolResult {
  try {
    const infos = buildOwaspDependencyCheckInfos(appPath);
    const configured = infos.filter((i) => i.configured);
    let text = `OWASP Dependency Check Statistics\n${'='.repeat(40)}\n\n`;
    text += `dependency-check: ${infos.filter((i) => i.tool === 'dependency-check' && i.configured).length > 0 ? 'configured' : 'missing'}\n`;
    text += `retire-js:        ${infos.filter((i) => i.tool === 'retire-js' && i.configured).length > 0 ? 'configured' : 'missing'}\n`;
    text += `npm-audit:        ${infos.filter((i) => i.tool === 'npm-audit' && i.configured).length > 0 ? 'configured' : 'missing'}\n`;
    text += `composer-audit:   ${infos.filter((i) => i.tool === 'composer-audit' && i.configured).length > 0 ? 'configured' : 'missing'}\n`;
    text += `Tools configured: ${configured.length}/${infos.length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getOwaspDependencyCheckTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_owasp_dependency_check',
      description: 'Analyze OWASP dependency scanning: check for dependency-check.xml/.dependency-check/odc-reports, CI files (GitHub Actions/GitLab/Jenkinsfile) for dependency-check/retire.js/npm audit/composer audit, composer.json scripts, flag missing scan in CI, ignored results, outdated NVD data',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_owasp_dependency_check_stats',
      description: 'Statistics for OWASP dependency scanning: configured/missing status for each tool (dependency-check, retire-js, npm-audit, composer-audit) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
