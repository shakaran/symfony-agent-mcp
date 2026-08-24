// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface AuditLogInfo {
  file: string;
  type: 'missing-log' | 'incomplete-log' | 'log-injection' | 'config' | 'sensitive-data';
  pattern: string;
  issues: string[];
}

function buildAuditLogInfos(appPath: string): AuditLogInfo[] {
  const results: AuditLogInfo[] = [];

  const monologYaml = path.join(appPath, 'config', 'packages', 'monolog.yaml');
  if (fs.existsSync(monologYaml)) {
    let content = '';
    try { content = fs.readFileSync(monologYaml, 'utf-8'); } catch { /* skip */ }

    const hasSecurityChannel = content.includes('security') || content.includes('channel: security') || content.includes('channels: [security]');
    if (!hasSecurityChannel) {
      results.push({ file: 'config/packages/monolog.yaml', type: 'config', pattern: 'monolog security channel', issues: ['monolog.yaml without dedicated security channel — security events (login, logout, access denied) should be logged to a separate channel/handler for audit trails; add channels: [security] to a persistent handler'] });
    }

    const hasAuditHandler = content.includes('audit') || (content.includes('fingers_crossed:') && content.includes('action_level: warning'));
    if (!hasAuditHandler) {
      results.push({ file: 'config/packages/monolog.yaml', type: 'config', pattern: 'no audit handler', issues: ['No dedicated audit log handler — sensitive security events should be written to a tamper-evident log store (separate file, syslog, or external SIEM); add a dedicated "audit" handler with stream type'] });
    }
  }

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

          const isSecuritySensitive = content.includes('denyAccessUnlessGranted') || content.includes('IsGranted') || content.includes('deleteUser') || content.includes('changePassword') || content.includes('AdminController') || content.includes('login_check');
          if (!isSecuritySensitive) return;

          const issues: string[] = [];
          const hasLogging = content.includes('$this->logger') || content.includes('LoggerInterface') || content.includes('$logger->');
          if (!hasLogging) {
            issues.push(`Security-sensitive class "${relFile}" without logging — admin actions, authentication events, and access control decisions should be logged for security audit; inject LoggerInterface and log critical security events`);
          }

          const hasUserContextInLog = content.includes('getUser()') && content.includes('$this->logger');
          if (!hasUserContextInLog && hasLogging) {
            issues.push(`Logger in "${relFile}" without user context — security logs should include the authenticated user identity (user ID, email) for forensic investigation; include $this->getUser()->getId() in log context array`);
          }

          const hasLogInjection = /\$(?:request|input|body|message)\b/.test(content) && content.includes('$this->logger');
          if (hasLogInjection) {
            issues.push(`Possible log injection in "${relFile}" — if user-controlled strings are interpolated into log messages, attackers can inject fake log entries; sanitize user data or pass as structured context array, not in message string`);
          }

          if (issues.length > 0) {
            results.push({ file: relFile, type: 'missing-log', pattern: 'security-sensitive code without audit log', issues });
          }
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  return results;
}

export function listSecurityAuditLog(appPath: string): McpToolResult {
  try {
    const infos = buildAuditLogInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No security audit log issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Security Audit Log Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSecurityAuditLogStats(appPath: string): McpToolResult {
  try {
    const infos = buildAuditLogInfos(appPath);
    let text = `Security Audit Log Statistics\n${'='.repeat(40)}\n\n`;
    text += `Missing logs:  ${infos.filter((i) => i.type === 'missing-log').length}\n`;
    text += `Config issues: ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSecurityAuditLogTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_security_audit_log', description: 'Analyze security audit logging completeness; warns on no security Monolog channel, no dedicated audit handler, security-sensitive classes without logging, logs without user context, potential log injection via user-controlled strings', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_security_audit_log_stats', description: 'Statistics for security audit log: missing/config count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
