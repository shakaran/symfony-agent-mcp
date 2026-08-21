import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface GdprComplianceInfo {
  file: string;
  type: 'pii-field' | 'data-export' | 'data-deletion' | 'consent' | 'logging' | 'retention';
  pattern: string;
  issues: string[];
}

function buildGdprComplianceInfos(appPath: string): GdprComplianceInfo[] {
  const results: GdprComplianceInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  const checkFiles = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) checkFiles(full);
        else if (e.name.endsWith('.php')) {
          let content = '';
          try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }

          const relFile = path.relative(appPath, full);

          const hasPiiFields = content.includes('email') || content.includes('phone') || content.includes('dateOfBirth') || content.includes('date_of_birth') || content.includes('personalData') || content.includes('firstName') || content.includes('lastName');
          const isEntity = content.includes('@ORM\\Entity') || content.includes('#[ORM\\Entity');

          if (isEntity && hasPiiFields) {
            const issues: string[] = [];
            const hasPseudonymization = content.includes('@Encrypted') || content.includes('encrypted') || content.includes('Anonymize') || content.includes('pseudonym');
            if (!hasPseudonymization) {
              issues.push(`Entity "${relFile}" stores PII fields (email/phone/name/dob) without encryption annotation — consider using @Encrypted (DoctrineEncryptBundle) or a custom encryption mechanism for sensitive PII data to satisfy GDPR data protection requirements`);
            }

            const hasDeletion = content.includes('anonymize') || content.includes('erase') || content.includes('gdpr') || content.includes('forgetUser');
            if (!hasDeletion) {
              issues.push(`Entity "${relFile}" has PII fields without right-to-erasure support — implement an anonymization method that nullifies or replaces PII fields when a user requests deletion (GDPR Art. 17)`);
            }

            const hasRetentionPolicy = content.includes('expiresAt') || content.includes('retentionDate') || content.includes('deletedAt') || content.includes('purge');
            if (!hasRetentionPolicy) {
              issues.push(`Entity "${relFile}" stores PII without retention date field — GDPR requires data is not kept longer than necessary; add a retentionDate or expiresAt field and purge records past their retention period`);
            }

            results.push({ file: relFile, type: 'pii-field', pattern: 'PII entity', issues });
          }

          const hasDataExport = content.includes('export') && (content.includes('User') || content.includes('Personal') || content.includes('Profile'));
          if (hasDataExport) {
            const hasAllFields = content.includes('toArray') || content.includes('serialize') || content.includes('json_encode');
            if (hasAllFields) {
              results.push({ file: relFile, type: 'data-export', pattern: 'data export method', issues: [] });
            }
          }

          const hasConsentField = content.includes('consent') || content.includes('marketingOptIn') || content.includes('gdprAccepted') || content.includes('terms_accepted');
          if (hasConsentField) {
            const hasTimestamp = content.includes('consentAt') || content.includes('consent_at') || content.includes('acceptedAt') || content.includes('timestamp');
            if (!hasTimestamp) {
              results.push({ file: relFile, type: 'consent', pattern: 'consent without timestamp', issues: [`Consent field in "${relFile}" without timestamp — GDPR requires proof of consent including when consent was given (Art. 7); add consentAt: DateTime field alongside the consent boolean`] });
            }
          }
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  const monologYaml = path.join(appPath, 'config', 'packages', 'monolog.yaml');
  if (fs.existsSync(monologYaml)) {
    let content = '';
    try { content = fs.readFileSync(monologYaml, 'utf-8'); } catch { /* skip */ }
    const issues: string[] = [];

    const hasProcessor = content.includes('processor') || content.includes('Processor');
    if (!hasProcessor) {
      issues.push('monolog.yaml without PII scrubbing processor — log entries may contain email addresses, IP addresses, or personal data; add a Monolog processor that masks or removes PII fields from log context');
    }

    const hasRetention = content.includes('max_files:') || content.includes('days:') || content.includes('rotating');
    if (!hasRetention) {
      issues.push('monolog.yaml without log rotation configuration — log files grow indefinitely and may contain PII; configure max_files or rotating_file handler to enforce log retention limits');
    }

    results.push({ file: 'config/packages/monolog.yaml', type: 'logging', pattern: 'monolog config', issues });
  }

  return results;
}

export function listGdprCompliance(appPath: string): McpToolResult {
  try {
    const infos = buildGdprComplianceInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No GDPR compliance patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `GDPR Compliance Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGdprComplianceStats(appPath: string): McpToolResult {
  try {
    const infos = buildGdprComplianceInfos(appPath);
    let text = `GDPR Compliance Statistics\n${'='.repeat(40)}\n\n`;
    text += `PII entities:  ${infos.filter((i) => i.type === 'pii-field').length}\n`;
    text += `Consent:       ${infos.filter((i) => i.type === 'consent').length}\n`;
    text += `Logging:       ${infos.filter((i) => i.type === 'logging').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGdprComplianceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_gdpr_compliance', description: 'Analyze GDPR compliance patterns; warns on PII entities without encryption/anonymization/retention, right-to-erasure not implemented, consent without timestamp (Art. 7), log files without PII scrubbing or rotation', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_gdpr_compliance_stats', description: 'Statistics for GDPR compliance: PII/consent/logging count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
