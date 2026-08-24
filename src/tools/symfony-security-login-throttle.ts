// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface LoginThrottleInfo {
  firewall: string;
  hasLoginThrottling: boolean;
  maxAttempts?: number;
  interval?: number;
  limiterName?: string;
  limiterFound: boolean;
  issues: string[];
}

function parseInterval(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const str = String(value);
  const numMatch = /^(\d{1,10})$/.exec(str);
  if (numMatch) return parseInt(str, 10);
  const minuteMatch = /^(\d{1,6})m$/.exec(str);
  if (minuteMatch) return parseInt(minuteMatch[1], 10) * 60;
  const hourMatch = /^(\d{1,4})h$/.exec(str);
  if (hourMatch) return parseInt(hourMatch[1], 10) * 3600;
  return undefined;
}

function loadRateLimiterNames(appPath: string): Set<string> {
  const names = new Set<string>();
  const candidates = [
    path.join(appPath, 'config', 'packages', 'rate_limiter.yaml'),
    path.join(appPath, 'config', 'packages', 'rate_limiter.yml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const limiters = (framework['rate_limiter'] ?? {}) as Record<string, unknown>;
    for (const name of Object.keys(limiters)) names.add(name);
  }
  return names;
}

function loadLoginThrottleConfig(appPath: string): LoginThrottleInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  const limiterNames = loadRateLimiterNames(appPath);

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const fwsRaw = (security['firewalls'] ?? {}) as Record<string, unknown>;

    const results: LoginThrottleInfo[] = [];
    for (const [name, fwData] of Object.entries(fwsRaw)) {
      const fw = (fwData ?? {}) as Record<string, unknown>;
      const hasFormLogin = fw['form_login'] !== undefined;
      const hasJsonLogin = fw['json_login'] !== undefined;
      const ltRaw = fw['login_throttling'] as Record<string, unknown> | undefined;

      if (!ltRaw) {
        const issues: string[] = [];
        if (hasFormLogin || hasJsonLogin) {
          const loginType = hasFormLogin ? 'form_login' : 'json_login';
          issues.push(`${loginType} firewall without login_throttling — no brute-force protection`);
        }
        results.push({ firewall: name, hasLoginThrottling: false, limiterFound: false, issues });
        continue;
      }

      const maxAttempts = ltRaw['max_attempts'] !== undefined ? parseInt(String(ltRaw['max_attempts']), 10) : undefined;
      const intervalRaw = ltRaw['interval'];
      const interval = parseInterval(intervalRaw);
      const limiterName = ltRaw['limiter'] ? String(ltRaw['limiter']) : undefined;
      const limiterFound = limiterName !== undefined ? limiterNames.has(limiterName) : true;

      const issues: string[] = [];
      if (maxAttempts !== undefined && maxAttempts > 10) {
        issues.push(`max_attempts=${maxAttempts} — high threshold; consider reducing to 5 or fewer`);
      }
      if (interval !== undefined && interval < 60) {
        issues.push(`interval=${interval}s — very short lockout window; consider at least 60 seconds`);
      }
      if (limiterName !== undefined && !limiterFound) {
        issues.push(`limiter "${limiterName}" not found in rate_limiter configuration`);
      }

      results.push({ firewall: name, hasLoginThrottling: true, maxAttempts, interval, limiterName, limiterFound, issues });
    }

    return results;
  }
  return [];
}

export function listLoginThrottleConfig(appPath: string): McpToolResult {
  try {
    const configs = loadLoginThrottleConfig(appPath);
    if (configs.length === 0) {
      return { content: [{ type: 'text', text: 'No security.yaml found or no firewalls configured.' }] };
    }

    const withThrottle = configs.filter((c) => c.hasLoginThrottling);
    const totalIssues = configs.reduce((s, c) => s + c.issues.length, 0);
    let text = `Login Throttle Configuration\n${'='.repeat(55)}\n\nFirewalls: ${configs.length}  With throttling: ${withThrottle.length}  Issues: ${totalIssues}\n`;

    for (const c of configs.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${c.firewall}\n`;
      if (c.hasLoginThrottling) {
        if (c.maxAttempts !== undefined) text += `    max_attempts: ${c.maxAttempts}\n`;
        if (c.interval !== undefined) text += `    interval: ${c.interval}s\n`;
        if (c.limiterName) text += `    limiter: ${c.limiterName} (${c.limiterFound ? 'found' : 'NOT FOUND'})\n`;
      } else {
        text += `    login_throttling: not configured\n`;
      }
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getLoginThrottleStats(appPath: string): McpToolResult {
  try {
    const configs = loadLoginThrottleConfig(appPath);
    const withThrottle = configs.filter((c) => c.hasLoginThrottling);

    let text = `Login Throttle Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total firewalls:       ${configs.length}\n`;
    text += `With login_throttling: ${withThrottle.length}\n`;
    text += `  With custom limiter: ${withThrottle.filter((c) => c.limiterName).length}\n`;
    text += `  Limiter not found:   ${withThrottle.filter((c) => c.limiterName && !c.limiterFound).length}\n`;
    text += `Issues:                ${configs.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getLoginThrottleTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_login_throttle',
      description: 'Show login_throttling config per firewall: max_attempts, interval, limiter; warns on missing throttling on form_login/json_login, max_attempts>10, interval<60s, limiter not found in rate_limiter config',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_security_login_throttle_stats',
      description: 'Show login throttle statistics: firewall count, throttling enabled count, custom limiter count, missing limiter count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
