// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Security Post-Authentication Inspector
 *
 * Scans src/ PHP for:
 *   - Subscribers to LoginSuccessEvent, LoginFailureEvent, LogoutEvent,
 *     CheckPassportEvent, AuthenticationTokenCreatedEvent, InteractiveLoginEvent
 *   - AuthenticationSuccessHandlerInterface / AuthenticationFailureHandlerInterface
 *
 * Warns about:
 *   - No LoginSuccessEvent subscriber (no audit log on login)
 *   - No LoginFailureEvent subscriber (no brute-force detection)
 *   - InteractiveLoginEvent usage (deprecated, use LoginSuccessEvent)
 *   - AuthenticationSuccessHandler without logging
 *   - Multiple handlers for same event without priority
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface SecurityPostAuthInfo {
  file: string;
  class: string;
  events: string[];
  hasAuditLog: boolean;
  isLegacyEvent: boolean;
  issues: string[];
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

const POST_AUTH_EVENTS = [
  'LoginSuccessEvent',
  'LoginFailureEvent',
  'LogoutEvent',
  'CheckPassportEvent',
  'AuthenticationTokenCreatedEvent',
  'InteractiveLoginEvent',
];

const HANDLER_INTERFACES = [
  'AuthenticationSuccessHandlerInterface',
  'AuthenticationFailureHandlerInterface',
];

function scanPostAuthClasses(appPath: string): SecurityPostAuthInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: SecurityPostAuthInfo[] = [];
  const eventSubscriberCounts: Record<string, number> = {};

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const subscribedEvents = POST_AUTH_EVENTS.filter((ev) => content.includes(ev));
    const handlerInterfaces = HANDLER_INTERFACES.filter((iface) => content.includes(iface));

    if (subscribedEvents.length === 0 && handlerInterfaces.length === 0) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    const allEvents = [...subscribedEvents, ...handlerInterfaces];
    for (const ev of allEvents) {
      eventSubscriberCounts[ev] = (eventSubscriberCounts[ev] ?? 0) + 1;
    }

    const isLegacyEvent = subscribedEvents.includes('InteractiveLoginEvent');
    const hasAuditLog = /\blog(ger|ging|Info|Warning|Error|Debug|Critical)?\s*[(-]/i.test(content) ||
      content.includes('$this->logger') ||
      content.includes('LoggerInterface');

    const issues: string[] = [];
    if (isLegacyEvent) {
      issues.push('InteractiveLoginEvent is deprecated since Symfony 5.4 — use LoginSuccessEvent instead');
    }
    if (handlerInterfaces.includes('AuthenticationSuccessHandlerInterface') && !hasAuditLog) {
      issues.push('AuthenticationSuccessHandlerInterface implementation without logging — exception context not captured');
    }

    results.push({ file, class: className, events: allEvents, hasAuditLog, isLegacyEvent, issues });
  }

  // Check for missing subscribers
  const allIssues: string[] = [];
  if (!eventSubscriberCounts['LoginSuccessEvent'] && !eventSubscriberCounts['AuthenticationSuccessHandlerInterface']) {
    allIssues.push('No LoginSuccessEvent subscriber found — no audit log on successful login');
  }
  if (!eventSubscriberCounts['LoginFailureEvent'] && !eventSubscriberCounts['AuthenticationFailureHandlerInterface']) {
    allIssues.push('No LoginFailureEvent subscriber found — no brute-force detection');
  }

  // Detect multiple handlers without priority
  for (const [ev, count] of Object.entries(eventSubscriberCounts)) {
    if (count > 1) {
      // Check if any has explicit priority
      const hasPriority = results.some(
        (r) => r.events.includes(ev) && /getSubscribedEvents|priority\s*=>/i.test(
          ((): string => { try { return fs.readFileSync(r.file, 'utf-8'); } catch { return ''; } })()
        )
      );
      if (!hasPriority) {
        allIssues.push(`Multiple handlers for ${ev} (${count}) without explicit priority — execution order undefined`);
      }
    }
  }

  // Attach global issues to first result or create sentinel
  if (allIssues.length > 0) {
    if (results.length > 0) {
      results[0].issues.push(...allIssues);
    } else {
      results.push({
        file: '',
        class: '(global)',
        events: [],
        hasAuditLog: false,
        isLegacyEvent: false,
        issues: allIssues,
      });
    }
  }

  return results;
}

export function listSecurityPostAuth(appPath: string): McpToolResult {
  try {
    const infos = scanPostAuthClasses(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No post-authentication event subscribers or handlers found in src/.\n\nConsider adding:\n  - LoginSuccessEvent subscriber for audit logging\n  - LoginFailureEvent subscriber for brute-force protection',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Security Post-Authentication Subscribers\n${'='.repeat(55)}\n\n`;
    text += `Total classes: ${infos.filter((i) => i.file !== '').length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      if (info.file === '') continue;
      text += `\n  ${info.class}  (${path.relative(appPath, info.file)})\n`;
      text += `    events: ${info.events.join(', ')}\n`;
      text += `    auditLog: ${info.hasAuditLog ? 'yes' : 'no'}  legacy: ${info.isLegacyEvent ? 'yes' : 'no'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    // Global issues
    const globalEntry = infos.find((i) => i.file === '');
    if (globalEntry) {
      text += '\nGlobal issues:\n';
      for (const issue of globalEntry.issues) text += `  WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSecurityPostAuthStats(appPath: string): McpToolResult {
  try {
    const infos = scanPostAuthClasses(appPath);
    const real = infos.filter((i) => i.file !== '');

    let text = `Security Post-Auth Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total subscriber/handler classes: ${real.length}\n`;
    text += `  With audit logging:             ${real.filter((i) => i.hasAuditLog).length}\n`;
    text += `  Using legacy InteractiveLogin:  ${real.filter((i) => i.isLegacyEvent).length}\n`;
    text += `  LoginSuccessEvent:              ${real.filter((i) => i.events.includes('LoginSuccessEvent')).length}\n`;
    text += `  LoginFailureEvent:              ${real.filter((i) => i.events.includes('LoginFailureEvent')).length}\n`;
    text += `  LogoutEvent:                    ${real.filter((i) => i.events.includes('LogoutEvent')).length}\n`;
    text += `Total issues:                     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSecurityPostAuthTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_post_auth',
      description: 'Scan src/ for post-authentication event subscribers (LoginSuccessEvent, LoginFailureEvent, LogoutEvent, CheckPassportEvent, InteractiveLoginEvent) and handler interfaces; warns on missing audit log, missing brute-force protection, deprecated events, priority conflicts',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_security_post_auth_stats',
      description: 'Statistics for post-auth subscribers: class count, audit log coverage, legacy event usage, per-event subscriber counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
