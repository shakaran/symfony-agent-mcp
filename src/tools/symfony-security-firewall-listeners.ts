/**
 * Symfony Security Firewall Listeners Inspector
 *
 * Scans src/ PHP for:
 *   - AbstractAuthenticator / AuthenticatorInterface / PassportInterface
 *   - security.event_listener tagged services
 *   - Classes with authenticate() method
 *
 * Detects: custom firewall listeners vs passport authenticators
 *
 * Warns about:
 *   - AbstractAuthenticator without createToken() method
 *   - Authenticator without createPassport() returning Passport with UserBadge
 *   - security.event_listener without kernel.event_subscriber interface (legacy)
 *   - Multiple authenticators without explicit priority
 *   - Authenticator that calls $tokenStorage->setToken() directly (bypass mechanism)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface FirewallListenerInfo {
  file: string;
  class: string;
  type: 'authenticator' | 'listener' | 'passport';
  hasAuthenticate: boolean;
  hasCreatePassport: boolean;
  priority?: number;
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

function detectType(content: string): FirewallListenerInfo['type'] | null {
  if (content.includes('AbstractAuthenticator') || content.includes('AuthenticatorInterface')) {
    return 'authenticator';
  }
  if (content.includes('PassportInterface') || content.includes('new Passport(')) {
    return 'passport';
  }
  if (
    content.includes('security.event_listener') ||
    (content.includes('authenticate(') && content.includes('RequestEvent'))
  ) {
    return 'listener';
  }
  return null;
}

function extractPriority(content: string): number | undefined {
  const m = /priority\s*[=:]\s*(-?\d{1,6})/.exec(content);
  return m ? parseInt(m[1], 10) : undefined;
}

function scanFirewallListeners(appPath: string): FirewallListenerInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: FirewallListenerInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const type = detectType(content);
    if (!type) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    const hasAuthenticate = /function\s+authenticate\s*\(/.test(content);
    const hasCreatePassport = /function\s+createPassport\s*\(/.test(content);
    const hasCreateToken = /function\s+createToken\s*\(/.test(content);
    const hasUserBadge = content.includes('UserBadge');
    const priority = extractPriority(content);
    const hasBypass = /\$tokenStorage\s*->\s*setToken\s*\(/.test(content);
    const hasKernelSubscriber = content.includes('EventSubscriberInterface') || content.includes('kernel.event_subscriber');

    const issues: string[] = [];

    if (type === 'authenticator') {
      if (content.includes('AbstractAuthenticator') && !hasCreateToken) {
        issues.push('AbstractAuthenticator without createToken() method — token creation may fail');
      }
      if (!hasCreatePassport) {
        issues.push('Authenticator without createPassport() — Passport with UserBadge required for authentication');
      } else if (hasCreatePassport && !hasUserBadge) {
        issues.push('createPassport() does not appear to use UserBadge — user resolution may be incomplete');
      }
      if (hasBypass) {
        issues.push('Direct $tokenStorage->setToken() call detected — bypasses Symfony authentication mechanism');
      }
    }

    if (type === 'listener') {
      if (!hasKernelSubscriber) {
        issues.push('security.event_listener without EventSubscriberInterface — legacy pattern, consider using AuthenticatorInterface');
      }
    }

    results.push({ file, class: className, type, hasAuthenticate, hasCreatePassport, priority, issues });
  }

  // Detect multiple authenticators without priority
  const authenticators = results.filter((r) => r.type === 'authenticator' || r.type === 'passport');
  if (authenticators.length > 1) {
    const noPriority = authenticators.filter((r) => r.priority === undefined);
    if (noPriority.length > 1) {
      for (const r of noPriority) {
        r.issues.push('Multiple authenticators without explicit priority — authentication order is undefined');
      }
    }
  }

  return results;
}

export function listFirewallListeners(appPath: string): McpToolResult {
  try {
    const infos = scanFirewallListeners(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No firewall listeners or authenticators found in src/.\n\nExample authenticator:\n  class AppAuthenticator extends AbstractAuthenticator\n  {\n    public function authenticate(Request $request): Passport { ... }\n  }',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Firewall Listeners & Authenticators\n${'='.repeat(55)}\n\n`;
    text += `Total classes: ${infos.length}  Issues: ${totalIssues}\n`;
    text += `  Authenticators: ${infos.filter((i) => i.type === 'authenticator').length}\n`;
    text += `  Passport-based: ${infos.filter((i) => i.type === 'passport').length}\n`;
    text += `  Legacy listeners: ${infos.filter((i) => i.type === 'listener').length}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}  [${info.type}]  (${path.relative(appPath, info.file)})\n`;
      text += `    authenticate(): ${info.hasAuthenticate ? 'yes' : 'no'}  createPassport(): ${info.hasCreatePassport ? 'yes' : 'no'}\n`;
      if (info.priority !== undefined) text += `    priority: ${info.priority}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFirewallListenerStats(appPath: string): McpToolResult {
  try {
    const infos = scanFirewallListeners(appPath);

    let text = `Firewall Listener Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes:          ${infos.length}\n`;
    text += `  Authenticators:       ${infos.filter((i) => i.type === 'authenticator').length}\n`;
    text += `  Passport-based:       ${infos.filter((i) => i.type === 'passport').length}\n`;
    text += `  Legacy listeners:     ${infos.filter((i) => i.type === 'listener').length}\n`;
    text += `  With priority:        ${infos.filter((i) => i.priority !== undefined).length}\n`;
    text += `  With createPassport:  ${infos.filter((i) => i.hasCreatePassport).length}\n`;
    text += `  With authenticate():  ${infos.filter((i) => i.hasAuthenticate).length}\n`;
    text += `Total issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFirewallListenerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_firewall_listeners',
      description: 'Scan src/ for firewall listeners and passport authenticators (AbstractAuthenticator, AuthenticatorInterface, PassportInterface, security.event_listener); warns on missing createToken/createPassport, legacy patterns, priority conflicts, tokenStorage bypass',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_security_firewall_listener_stats',
      description: 'Statistics for firewall listeners: authenticator/passport/legacy counts, priority coverage, createPassport coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
