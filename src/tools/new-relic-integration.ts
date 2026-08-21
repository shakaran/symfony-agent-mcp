import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface NewRelicIntegrationInfo {
  file: string;
  type: 'config' | 'instrumentation' | 'transaction' | 'security' | 'custom-metric';
  directive: string;
  value: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function buildNewRelicIntegrationInfos(appPath: string): NewRelicIntegrationInfo[] {
  const results: NewRelicIntegrationInfo[] = [];

  const newrelicIniPaths = [
    path.join(appPath, 'config', 'newrelic.ini'),
    path.join(appPath, 'newrelic.ini'),
    path.join(appPath, 'docker', 'newrelic.ini'),
    path.join(appPath, 'infrastructure', 'newrelic', 'newrelic.cfg'),
  ];

  for (const iniPath of newrelicIniPaths) {
    if (!fs.existsSync(iniPath)) continue;
    let content = '';
    try { content = fs.readFileSync(iniPath, 'utf-8'); } catch { continue; }
    const relFile = path.relative(appPath, iniPath);
    const issues: string[] = [];

    const hasLicenseKey = /newrelic\.license\s*=\s*([^\n]+)/.exec(content);
    if (hasLicenseKey) {
      const key = hasLicenseKey[1].trim();
      if (key.length > 0 && !key.startsWith('%env') && !key.startsWith('${') && key !== 'REPLACE_WITH_KEY') {
        issues.push(`New Relic license key hardcoded in "${relFile}" — license keys should be injected via environment variable (newrelic.license = ${String.fromCharCode(36)}{NEW_RELIC_LICENSE_KEY}) not stored in config files`);
      }
    }

    const hasCaptureParams = content.includes('capture_params') && content.includes('true');
    if (hasCaptureParams) {
      issues.push(`newrelic.capture_params=true in "${relFile}" — this sends all request parameters to New Relic, potentially including passwords and sensitive PII; disable or configure newrelic.ignored_params to exclude sensitive fields`);
    }

    const hasHighSecurityMode = content.includes('high_security') && content.includes('true');
    if (!hasHighSecurityMode) {
      issues.push(`New Relic high security mode not enabled in "${relFile}" — newrelic.high_security=true prevents custom attributes that could leak sensitive data and enforces secure defaults`);
    }

    results.push({ file: relFile, type: 'config', directive: 'newrelic.ini', value: path.basename(iniPath), issues });
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            if (!content.includes('newrelic_') && !content.includes('NewRelic') && !content.includes('new_relic')) return;

            const relFile = path.relative(appPath, full);
            const issues: string[] = [];

            const hasCustomAttribute = content.includes('newrelic_add_custom_parameter') || content.includes('newrelic_add_custom_span_parameter');
            if (hasCustomAttribute) {
              const hasSensitiveAttr = content.includes('password') || content.includes('secret') || content.includes('token') || content.includes('ssn') || content.includes('credit');
              if (hasSensitiveAttr) {
                issues.push(`Potentially sensitive data in New Relic custom attribute in "${relFile}" — avoid sending passwords, tokens, or PII as custom attributes; New Relic data is accessible to all APM users`);
              }
            }

            const hasTransactionName = content.includes('newrelic_name_transaction(');
            if (!hasTransactionName && (content.includes('AbstractController') || content.includes('#[Route'))) {
              issues.push(`Controller "${relFile}" without newrelic_name_transaction() — default Symfony route names may appear as "uri" transaction names in New Relic; set descriptive names for meaningful APM grouping`);
            }

            const hasNoticeError = content.includes('newrelic_notice_error(');
            const hasTryCatch = content.includes('catch (');
            if (hasTryCatch && !hasNoticeError) {
              issues.push(`Exception handling in "${relFile}" without newrelic_notice_error() — caught exceptions are not reported to New Relic unless explicitly notified; call newrelic_notice_error($e->getMessage(), $e) in catch blocks`);
            }

            results.push({ file: relFile, type: 'instrumentation', directive: 'New Relic call', value: 'PHP code', issues });
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listNewRelicIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildNewRelicIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No New Relic integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `New Relic Integration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNewRelicIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildNewRelicIntegrationInfos(appPath);
    let text = `New Relic Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config:           ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Instrumentation:  ${infos.filter((i) => i.type === 'instrumentation').length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNewRelicIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_new_relic_integration', description: 'Analyze New Relic APM integration; warns on hardcoded license key, capture_params=true sending PII, high_security mode disabled, sensitive data in custom attributes, controllers without transaction naming, caught exceptions not reported to New Relic', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_new_relic_integration_stats', description: 'Statistics for New Relic integration: config/instrumentation count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
