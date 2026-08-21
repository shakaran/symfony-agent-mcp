/**
 * Symfony Security Firewalls Inspector
 *
 * Distinct from security-voters.ts (voter logic), controller-security.ts (route security),
 * custom-authenticators.ts (authenticator classes), and security-scanner.ts (vulnerability scan).
 * Focuses on the firewall configuration structure in security.yaml:
 *
 *   security.firewalls:
 *     dev: { pattern: ^/(_(profiler|wdt)|css|images|js)/, security: false }
 *     main:
 *       lazy: true
 *       provider: app_user_provider
 *       stateless: false
 *       custom_authenticators: [...]
 *       remember_me: { secret, lifetime, path }
 *       logout: { path, target, invalidate_session }
 *       access_denied_handler: App\Security\AccessDeniedHandler
 *
 * Analysis:
 *   - Firewalls without a pattern (catch-all — order matters)
 *   - Non-dev firewalls with security: false
 *   - Stateless firewall with session-based remember_me (contradiction)
 *   - Logout without invalidate_session: true (session fixation risk)
 *   - No main firewall found (highly unusual)
 *   - access_decision_manager strategy (affirmative/consensus/unanimous/priority)
 *
 * Pure static analysis — reads security.yaml only.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface FirewallConfig {
  name: string;
  pattern?: string;
  securityDisabled: boolean;
  lazy: boolean;
  stateless: boolean;
  provider?: string;
  authenticators: string[];
  hasRememberMe: boolean;
  rememberMeLifetime?: number;
  hasLogout: boolean;
  logoutInvalidatesSession: boolean;
  accessDeniedHandler?: string;
  issues: string[];
}

function loadFirewalls(appPath: string): { firewalls: FirewallConfig[]; strategy?: string } {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const security  = (raw['security'] ?? raw) as Record<string, unknown>;
    const fwsRaw    = (security['firewalls'] ?? {}) as Record<string, unknown>;
    const admRaw    = (security['access_decision_manager'] ?? {}) as Record<string, unknown>;
    const strategy  = admRaw['strategy'] ? String(admRaw['strategy']) : undefined;

    const firewalls: FirewallConfig[] = [];

    for (const [name, fwData] of Object.entries(fwsRaw)) {
      const fw = (fwData ?? {}) as Record<string, unknown>;

      const securityDisabled = fw['security'] === false || fw['security'] === 'false';
      const lazy             = fw['lazy'] === true || fw['lazy'] === 'true';
      const stateless        = fw['stateless'] === true || fw['stateless'] === 'true';
      const provider         = fw['provider'] ? String(fw['provider']) : undefined;

      const authRaw     = fw['custom_authenticators'];
      const authenticators = Array.isArray(authRaw) ? authRaw.map(String) : [];

      const rmRaw       = fw['remember_me'] as Record<string, unknown> | undefined;
      const hasRememberMe    = !!rmRaw;
      const rememberMeLifetime = rmRaw?.['lifetime'] ? parseInt(String(rmRaw['lifetime']), 10) : undefined;

      const logoutRaw = fw['logout'] as Record<string, unknown> | undefined;
      const hasLogout            = !!logoutRaw;
      const logoutInvalidatesSession = logoutRaw?.['invalidate_session'] !== false;

      const accessDeniedHandler = fw['access_denied_handler'] ? String(fw['access_denied_handler']) : undefined;

      const issues: string[] = [];
      if (!securityDisabled && !fw['pattern'] && name !== 'dev') {
        issues.push('No pattern defined — catch-all firewall; order in security.yaml matters');
      }
      if (!name.startsWith('dev') && securityDisabled && fw['pattern']) {
        issues.push('security: false on non-dev firewall — requests pass without authentication');
      }
      if (stateless && hasRememberMe) {
        issues.push('stateless: true with remember_me — contradiction (session not maintained)');
      }
      if (hasLogout && !logoutInvalidatesSession) {
        issues.push('logout.invalidate_session: false — old session ID remains valid (session fixation risk)');
      }
      if (rememberMeLifetime && rememberMeLifetime > 86400 * 90) {
        issues.push(`remember_me lifetime ${Math.round(rememberMeLifetime / 86400)}d — very long, increases hijack window`);
      }

      firewalls.push({
        name, pattern: fw['pattern'] ? String(fw['pattern']) : undefined,
        securityDisabled, lazy, stateless, provider,
        authenticators, hasRememberMe, rememberMeLifetime,
        hasLogout, logoutInvalidatesSession,
        accessDeniedHandler, issues,
      });
    }

    return { firewalls, strategy };
  }
  return { firewalls: [] };
}

export function listSecurityFirewalls(appPath: string): McpToolResult {
  try {
    const { firewalls, strategy } = loadFirewalls(appPath);

    if (firewalls.length === 0) {
      return { content: [{ type: 'text', text: 'No firewalls found in security.yaml.' }] };
    }

    const totalIssues = firewalls.reduce((s, f) => s + f.issues.length, 0);

    let text = `Security Firewalls\n${'='.repeat(55)}\n`;
    text += `\nFirewalls: ${firewalls.length}  Issues: ${totalIssues}\n`;
    if (strategy) text += `Access decision manager: ${strategy}\n`;
    if (!firewalls.some((f) => f.name === 'main')) text += `⚠ No "main" firewall found\n`;

    for (const fw of firewalls) {
      const flags = [
        fw.securityDisabled ? 'security:false' : '',
        fw.lazy ? 'lazy' : '',
        fw.stateless ? 'stateless' : '',
        fw.hasRememberMe ? 'remember_me' : '',
        fw.hasLogout ? 'logout' : '',
      ].filter(Boolean).join(', ');

      text += `\n  ${fw.name}\n`;
      if (fw.pattern) text += `    pattern: ${fw.pattern}\n`;
      if (fw.provider) text += `    provider: ${fw.provider}\n`;
      if (flags) text += `    flags: [${flags}]\n`;
      if (fw.authenticators.length > 0) {
        const shortNames = fw.authenticators.map((a) => a.split('\\').pop() ?? a);
        text += `    authenticators: ${shortNames.join(', ')}\n`;
      }
      if (fw.accessDeniedHandler) text += `    access_denied_handler: ${fw.accessDeniedHandler.split('\\').pop()}\n`;
      for (const issue of fw.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFirewallStats(appPath: string): McpToolResult {
  try {
    const { firewalls, strategy } = loadFirewalls(appPath);

    let text = `Firewall Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total firewalls:     ${firewalls.length}\n`;
    text += `  Stateless:         ${firewalls.filter((f) => f.stateless).length}\n`;
    text += `  With remember_me:  ${firewalls.filter((f) => f.hasRememberMe).length}\n`;
    text += `  With logout:       ${firewalls.filter((f) => f.hasLogout).length}\n`;
    text += `  Security disabled: ${firewalls.filter((f) => f.securityDisabled).length}\n`;
    text += `Decision strategy:   ${strategy ?? 'affirmative (default)'}\n`;
    text += `Issues:              ${firewalls.reduce((s, f) => s + f.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSecurityFirewallTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_firewalls',
      description: 'Show security firewall configuration: pattern, lazy, stateless, provider, authenticators, remember_me, logout, access_denied_handler per firewall; stateless+remember_me contradiction, logout without invalidate_session, non-dev security:false warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_firewall_stats',
      description: 'Show firewall statistics: total count, stateless/remember_me/logout/disabled counts, access decision strategy',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
