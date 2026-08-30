// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Rate Limiter Policy Inspector
 *
 * Reads config/packages/rate_limiter.yaml and analyzes policy configurations
 * for token_bucket, fixed_window, sliding_window, and no_limit policies.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface RateLimiterPolicyEntry {
  name: string;
  policy: string;
  limit: number;
  interval: string;
  burst: number;
  issues: string[];
}

// ─── Interval parsing ────────────────────────────────────────────────────────

function parseIntervalSeconds(interval: string): number {
  if (!interval) return 0;
  const s = String(interval).toLowerCase();
  const secMatch = /^(\d{1,10})\s*s(?:econd)?s?$/u.exec(s);
  if (secMatch) return parseInt(secMatch[1], 10);
  const minMatch = /^(\d{1,10})\s*m(?:inute)?s?$/u.exec(s);
  if (minMatch) return parseInt(minMatch[1], 10) * 60;
  const hourMatch = /^(\d{1,10})\s*h(?:our)?s?$/u.exec(s);
  if (hourMatch) return parseInt(hourMatch[1], 10) * 3600;
  // ISO 8601 subset
  const ptSec = /PT(\d{1,10})S/ui.exec(s);
  if (ptSec) return parseInt(ptSec[1], 10);
  const ptMin = /PT(\d{1,10})M/ui.exec(s);
  if (ptMin) return parseInt(ptMin[1], 10) * 60;
  const ptHour = /PT(\d{1,10})H/ui.exec(s);
  if (ptHour) return parseInt(ptHour[1], 10) * 3600;
  // Numeric string treated as seconds
  if (/^\d{1,10}$/u.test(s)) return parseInt(s, 10);
  return 0;
}

// ─── Config loading ──────────────────────────────────────────────────────────

function loadRateLimiterPolicies(appPath: string): RateLimiterPolicyEntry[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'rate_limiter.yaml'),
    path.join(appPath, 'config', 'packages', 'rate_limiter.yml'),
    path.join(appPath, 'config', 'rate_limiter.yaml'),
    path.join(appPath, 'config', 'rate_limiter.yml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];

  for (const candidate of candidates) {
    let raw: Record<string, unknown> | null = null;
    try {
      raw = parseYamlFile(candidate) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    if (!raw) continue;

    // Support framework.yaml with rate_limiter key and bare rate_limiter.yaml
    const framework = raw['framework'] as Record<string, unknown> | undefined;
    const section = (framework?.['rate_limiter'] ??
      raw['rate_limiter'] ??
      raw) as Record<string, unknown>;

    if (!section || typeof section !== 'object') continue;

    const results: RateLimiterPolicyEntry[] = [];

    for (const [name, def] of Object.entries(section)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const policy = String(d['policy'] ?? 'unknown');
      const limit = d['limit'] !== undefined ? Number(d['limit']) : 0;

      // interval can be at top level or inside rate: {}
      let interval = '';
      if (d['interval']) {
        interval = String(d['interval']);
      } else if (d['rate'] && typeof d['rate'] === 'object') {
        const rate = d['rate'] as Record<string, unknown>;
        interval = String(rate['interval'] ?? '');
      }

      const burst = d['burst'] !== undefined ? Number(d['burst']) : 0;

      const issues: string[] = [];

      // token_bucket without burst
      if (policy === 'token_bucket' && burst === 0) {
        issues.push(
          'token_bucket policy without burst set — defaults to limit, providing no burst handling for legitimate traffic spikes'
        );
      }

      // fixed_window with very short interval (< 1 second)
      if (policy === 'fixed_window' && interval) {
        const secs = parseIntervalSeconds(interval);
        if (secs > 0 && secs < 1) {
          issues.push(
            `fixed_window with interval "${interval}" (< 1 second) — precision issues in window boundary detection`
          );
        }
      }

      // sliding_window with limit=1
      if (policy === 'sliding_window' && limit === 1) {
        issues.push(
          'sliding_window with limit=1 — allows no parallelism; concurrent requests will all be rate-limited'
        );
      }

      // no_limit policy
      if (policy === 'no_limit') {
        issues.push(
          'no_limit policy configured — if used on authentication endpoints, this is a security risk (brute-force attack vector)'
        );
      }

      // token_bucket rate higher than a reasonable downstream service limit
      if (policy === 'token_bucket' && limit > 10000) {
        issues.push(
          `token_bucket limit=${limit} is very high — verify downstream service capacity can handle this rate`
        );
      }

      results.push({ name, policy, limit, interval, burst, issues });
    }

    if (results.length > 0) return results;
  }

  return [];
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listSymfonyRateLimiterPolicies(appPath: string): McpToolResult {
  try {
    const entries = loadRateLimiterPolicies(appPath);

    if (entries.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No rate limiter configuration found in config/packages/rate_limiter.yaml.',
        }],
      };
    }

    const withIssues = entries.filter((e) => e.issues.length > 0);

    let text = `Symfony Rate Limiter Policies  (${entries.length} limiters)\n${'='.repeat(58)}\n`;

    if (withIssues.length > 0) {
      text += `\n${withIssues.length} limiter(s) with configuration issues.\n`;
    }

    text += `\n  ${'Name'.padEnd(30)} ${'Policy'.padEnd(16)} ${'Limit'.padEnd(8)} ${'Interval'.padEnd(12)} Burst\n`;
    text += `  ${'-'.repeat(78)}\n`;

    for (const e of entries) {
      const issueFlag = e.issues.length > 0 ? '[!]' : '   ';
      text += `${issueFlag} ${e.name.padEnd(30)} ${e.policy.padEnd(16)} ${String(e.limit).padEnd(8)} ${(e.interval || '-').padEnd(12)} ${e.burst || '-'}\n`;
      for (const issue of e.issues) {
        text += `    [!] ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyRateLimiterPolicyStats(appPath: string): McpToolResult {
  try {
    const entries = loadRateLimiterPolicies(appPath);

    const policyCount: Record<string, number> = {};
    for (const e of entries) {
      policyCount[e.policy] = (policyCount[e.policy] ?? 0) + 1;
    }

    const withIssues = entries.filter((e) => e.issues.length > 0);
    const noLimitPolicies = entries.filter((e) => e.policy === 'no_limit');
    const noBurst = entries.filter((e) => e.policy === 'token_bucket' && e.burst === 0);

    let text = `Symfony Rate Limiter Policy Statistics\n${'='.repeat(42)}\n\n`;
    text += `Total limiters:         ${entries.length}\n`;
    text += `Limiters with issues:   ${withIssues.length}\n`;
    text += `no_limit policies:      ${noLimitPolicies.length}\n`;
    text += `token_bucket no burst:  ${noBurst.length}\n`;
    text += `\nPolicy breakdown:\n`;
    for (const [policy, count] of Object.entries(policyCount)) {
      text += `  ${policy.padEnd(20)} ${count}\n`;
    }
    text += `\nTotal issues: ${entries.reduce((s, e) => s + e.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getSymfonyRateLimiterPolicyTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_symfony_rate_limiter_policies',
      description: 'Read and analyze Symfony rate limiter policies from rate_limiter.yaml; warns on token_bucket without burst, fixed_window with sub-second interval, sliding_window limit=1, no_limit on auth endpoints, and excessive token_bucket rates',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_symfony_rate_limiter_policy_stats',
      description: 'Statistics on Symfony rate limiter policies: count by policy type, issues detected, no_limit and token_bucket without burst summary',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
