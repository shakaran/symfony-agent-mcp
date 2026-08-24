// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Rate Limiter Inspector
 *
 * Reads config/packages/rate_limiter.yaml to discover:
 *   - Named limiters (sliding_window, token_bucket, fixed_window, no_limit)
 *   - Policy, limit, interval/rate for each limiter
 *   - Which controllers/routes inject RateLimiterFactory
 *   - Which endpoints use #[RateLimit] attribute
 *
 * Pure static analysis — no actual rate checking.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface RateLimiter {
  name: string;
  policy: string;
  limit?: number;
  interval?: string;
  rate?: { amount: number; interval: string };
  lockFactory?: string;
  cachePool?: string;
}

interface LimiterUsage {
  class: string;
  file: string;
  limiters: string[];
  hasAttribute: boolean;
}

// ─── Config loading ────────────────────────────────────────────────────────

function loadRateLimiters(appPath: string): RateLimiter[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'rate_limiter.yaml'),
    path.join(appPath, 'config', 'rate_limiter.yaml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const section = framework['rate_limiter'] as Record<string, unknown> | undefined;
    if (!section) continue;

    const limiters: RateLimiter[] = [];

    for (const [name, def] of Object.entries(section)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;

      const limiter: RateLimiter = {
        name,
        policy: String(d['policy'] ?? 'unknown'),
      };

      if (d['limit'] !== undefined) limiter.limit = Number(d['limit']);
      if (d['interval']) limiter.interval = String(d['interval']);
      if (d['lock_factory']) limiter.lockFactory = String(d['lock_factory']);
      if (d['cache_pool']) limiter.cachePool = String(d['cache_pool']);

      const rate = d['rate'] as Record<string, unknown> | undefined;
      if (rate) {
        limiter.rate = {
          amount: Number(rate['amount'] ?? 1),
          interval: String(rate['interval'] ?? '60 seconds'),
        };
      }

      limiters.push(limiter);
    }

    return limiters.sort((a, b) => a.name.localeCompare(b.name));
  }

  return [];
}

// ─── PHP scanning ──────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function scanLimiterUsage(appPath: string, limiterNames: string[]): LimiterUsage[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const usages: LimiterUsage[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, srcDir);
    if (content === null) continue;

    if (!content.includes('RateLimiter') && !content.includes('RateLimit')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const hasAttribute = content.includes('#[RateLimit') ||
                         content.includes('IsGranted') && content.includes('rate');

    const foundLimiters = limiterNames.filter((name) =>
      content.includes(`'${name}'`) ||
      content.includes(`"${name}"`) ||
      content.toLowerCase().includes(name.toLowerCase().replace(/_/g, ''))
    );

    const usesFactory = content.includes('RateLimiterFactory') ||
                        content.includes('AbstractRateLimiter');

    if (usesFactory || hasAttribute || foundLimiters.length > 0) {
      usages.push({
        class: classM[1],
        file: path.basename(file),
        limiters: foundLimiters,
        hasAttribute,
      });
    }
  }

  return usages.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Policy descriptions ───────────────────────────────────────────────────

const POLICY_DESCRIPTIONS: Record<string, string> = {
  sliding_window: 'Sliding window — smoothly distributes requests over the interval',
  token_bucket:   'Token bucket — bursts allowed, refills at configured rate',
  fixed_window:   'Fixed window — resets counter at interval boundary',
  no_limit:       'No limit — tracking only (useful for testing)',
};

function describeLimiter(l: RateLimiter): string {
  if (l.policy === 'token_bucket' && l.rate) {
    return `${l.rate.amount} tokens / ${l.rate.interval}`;
  }
  if (l.limit && l.interval) {
    return `${l.limit} requests / ${l.interval}`;
  }
  if (l.limit) return `${l.limit} max`;
  return l.policy;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listRateLimiters(appPath: string): McpToolResult {
  try {
    const limiters = loadRateLimiters(appPath);

    if (limiters.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No rate limiters configured.\n\nInstall: composer require symfony/rate-limiter\nConfigure in config/packages/rate_limiter.yaml:\n  framework:\n    rate_limiter:\n      anonymous_api:\n        policy: sliding_window\n        limit: 100\n        interval: \'60 minutes\'',
        }],
      };
    }

    const usage = scanLimiterUsage(appPath, limiters.map((l) => l.name));

    let text = `Rate Limiters (${limiters.length})\n${'='.repeat(50)}\n`;

    for (const l of limiters) {
      text += `\n  ${l.name}\n`;
      text += `    Policy:  ${l.policy}  — ${POLICY_DESCRIPTIONS[l.policy] ?? l.policy}\n`;
      text += `    Limit:   ${describeLimiter(l)}\n`;
      if (l.cachePool) text += `    Cache:   ${l.cachePool}\n`;
      if (l.lockFactory) text += `    Lock:    ${l.lockFactory}\n`;

      const users = usage.filter((u) => u.limiters.includes(l.name));
      if (users.length > 0) {
        text += `    Used by: ${users.map((u) => u.class).join(', ')}\n`;
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

export function getRateLimiterUsage(appPath: string): McpToolResult {
  try {
    const limiters = loadRateLimiters(appPath);
    const usage = scanLimiterUsage(appPath, limiters.map((l) => l.name));

    if (usage.length === 0) {
      return {
        content: [{ type: 'text', text: 'No classes found using RateLimiterFactory or #[RateLimit].' }],
      };
    }

    let text = `Rate Limiter Usage (${usage.length} classes)\n${'='.repeat(50)}\n\n`;

    for (const u of usage) {
      text += `  ${u.class}  (${u.file})\n`;
      const info: string[] = [];
      if (u.hasAttribute) info.push('#[RateLimit] attribute');
      if (u.limiters.length > 0) info.push(`limiters: ${u.limiters.join(', ')}`);
      else info.push('RateLimiterFactory injection');
      text += `    ${info.join(' · ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRateLimiterStats(appPath: string): McpToolResult {
  try {
    const limiters = loadRateLimiters(appPath);

    let text = `Rate Limiter Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total limiters:      ${limiters.length}\n`;

    const byPolicy: Record<string, number> = {};
    for (const l of limiters) {
      byPolicy[l.policy] = (byPolicy[l.policy] ?? 0) + 1;
    }

    if (Object.keys(byPolicy).length > 0) {
      text += `\nBy policy:\n`;
      for (const [policy, count] of Object.entries(byPolicy).sort()) {
        text += `  ${policy.padEnd(20)} ${count}  — ${POLICY_DESCRIPTIONS[policy] ?? ''}\n`;
      }
    }

    if (limiters.length === 0) {
      text += '\nNot configured. Install: composer require symfony/rate-limiter\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getRateLimiterTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_rate_limiters',
      description: 'List all Symfony rate limiters from rate_limiter.yaml with policy, limit, interval, and which services use each',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_rate_limiter_usage',
      description: 'Find services and controllers that inject RateLimiterFactory or use #[RateLimit] attribute',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_rate_limiter_stats',
      description: 'Show rate limiter statistics: total count and breakdown by policy (sliding_window, token_bucket, fixed_window)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
