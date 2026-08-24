// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface SessionStrategyInfo {
  fixationStrategy: string;
  statelessFirewalls: string[];
  cookieSecure: string | boolean | undefined;
  cookieHttponly: string | boolean | undefined;
  cookieSamesite: string | undefined;
  gcMaxlifetime: number;
  issues: string[];
}

function loadSessionStrategyConfig(appPath: string): SessionStrategyInfo {
  const securityCandidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  const frameworkCandidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];

  let fixationStrategy = 'migrate';
  const statelessFirewalls: string[] = [];

  for (const filePath of securityCandidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const sessionFixation = security['session_fixation_strategy'];
    if (sessionFixation) fixationStrategy = String(sessionFixation);

    const fwsRaw = (security['firewalls'] ?? {}) as Record<string, unknown>;
    for (const [name, fwData] of Object.entries(fwsRaw)) {
      const fw = (fwData ?? {}) as Record<string, unknown>;
      if (fw['stateless'] === true || fw['stateless'] === 'true') {
        statelessFirewalls.push(name);
      }
    }
    break;
  }

  let cookieSecure: string | boolean | undefined;
  let cookieHttponly: string | boolean | undefined;
  let cookieSamesite: string | undefined;
  let gcMaxlifetime = 1440;

  for (const filePath of frameworkCandidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const session = (framework['session'] ?? {}) as Record<string, unknown>;

    if (session['cookie_secure'] !== undefined) {
      const v = session['cookie_secure'];
      cookieSecure = typeof v === 'boolean' ? v : String(v);
    }
    if (session['cookie_httponly'] !== undefined) {
      const v = session['cookie_httponly'];
      cookieHttponly = typeof v === 'boolean' ? v : String(v);
    }
    if (session['cookie_samesite'] !== undefined) {
      cookieSamesite = String(session['cookie_samesite']);
    }
    if (session['gc_maxlifetime'] !== undefined) {
      gcMaxlifetime = parseInt(String(session['gc_maxlifetime']), 10);
    }
    break;
  }

  const issues: string[] = [];
  if (fixationStrategy === 'none') {
    issues.push('session_fixation_strategy: none — vulnerable to session fixation attacks; use "migrate" or "invalidate"');
  }
  if (cookieSecure !== true && cookieSecure !== 'auto') {
    issues.push(`cookie_secure is "${cookieSecure ?? 'not set'}" — session cookie may be sent over HTTP; set to true or auto`);
  }
  if (cookieSamesite !== 'lax' && cookieSamesite !== 'strict') {
    issues.push(`cookie_samesite is "${cookieSamesite ?? 'not set'}" — set to "lax" or "strict" to prevent CSRF via cross-site requests`);
  }
  if (!isNaN(gcMaxlifetime) && gcMaxlifetime > 86400) {
    issues.push(`gc_maxlifetime=${gcMaxlifetime}s (${Math.round(gcMaxlifetime / 3600)}h) exceeds 24 hours — sessions survive for a very long time`);
  }

  return {
    fixationStrategy,
    statelessFirewalls,
    cookieSecure,
    cookieHttponly,
    cookieSamesite,
    gcMaxlifetime,
    issues,
  };
}

export function listSessionStrategyConfig(appPath: string): McpToolResult {
  try {
    const info = loadSessionStrategyConfig(appPath);

    let text = `Session Strategy Configuration\n${'='.repeat(55)}\n\n`;
    text += `session_fixation_strategy: ${info.fixationStrategy}\n`;
    text += `cookie_secure:             ${info.cookieSecure ?? 'not set'}\n`;
    text += `cookie_httponly:           ${info.cookieHttponly ?? 'not set'}\n`;
    text += `cookie_samesite:           ${info.cookieSamesite ?? 'not set'}\n`;
    text += `gc_maxlifetime:            ${info.gcMaxlifetime}s\n`;

    if (info.statelessFirewalls.length > 0) {
      text += `\nStateless firewalls: ${info.statelessFirewalls.join(', ')}\n`;
    }

    if (info.issues.length > 0) {
      text += `\nIssues (${info.issues.length}):\n`;
      for (const issue of info.issues) text += `  ⚠ ${issue}\n`;
    } else {
      text += `\nNo issues detected.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSessionStrategyStats(appPath: string): McpToolResult {
  try {
    const info = loadSessionStrategyConfig(appPath);

    let text = `Session Strategy Statistics\n${'='.repeat(40)}\n\n`;
    text += `fixation_strategy:   ${info.fixationStrategy}\n`;
    text += `stateless firewalls: ${info.statelessFirewalls.length}\n`;
    text += `cookie_secure:       ${info.cookieSecure ?? 'not set'}\n`;
    text += `cookie_samesite:     ${info.cookieSamesite ?? 'not set'}\n`;
    text += `gc_maxlifetime:      ${info.gcMaxlifetime}s\n`;
    text += `Issues:              ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSessionStrategyTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_session_strategy',
      description: 'Show session strategy config: session_fixation_strategy (none/migrate/invalidate), stateless firewalls, cookie_secure/httponly/samesite, gc_maxlifetime; warns on strategy:none, insecure cookie settings, gc_maxlifetime>24h',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_security_session_strategy_stats',
      description: 'Show session strategy statistics: fixation strategy, stateless firewall count, cookie_secure/samesite values, gc_maxlifetime, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
