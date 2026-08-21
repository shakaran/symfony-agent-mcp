/**
 * Symfony Rate Limiter Algorithms Inspector
 *
 * Reads config/packages/rate_limiter.yaml for limiter definitions.
 * Parses policy, limit, interval for each limiter.
 * Compares configured limiters across environments.
 *
 * Flags: no_limit policy in prod, very high limits (>10000),
 *        missing burst configuration for token_bucket.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RateLimiterAlgorithmInfo {
  name: string;
  policy: 'fixed_window' | 'sliding_window' | 'token_bucket' | 'no_limit';
  limit: number;
  interval: string;
  issues: string[];
}

function readFileSafe(filePath: string, appPath: string): string {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(appPath) + path.sep) && resolved !== path.resolve(appPath)) return '';
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function parseYamlValue(content: string, key: string): string {
  const m = new RegExp(`${key}:\\s*([^\\n\\r]+)`).exec(content);
  if (m) return m[1].trim().replace(/['"]/g, '');
  return '';
}

function parseLimiterSection(name: string, sectionContent: string): RateLimiterAlgorithmInfo {
  const policyRaw = parseYamlValue(sectionContent, 'policy');
  const limitRaw = parseYamlValue(sectionContent, 'limit');
  const intervalRaw = parseYamlValue(sectionContent, 'interval');
  const rateAmountRaw = parseYamlValue(sectionContent, 'amount');
  const rateIntervalRaw = parseYamlValue(sectionContent, 'interval');

  const validPolicies = ['fixed_window', 'sliding_window', 'token_bucket', 'no_limit'];
  const policy = validPolicies.includes(policyRaw)
    ? (policyRaw as 'fixed_window' | 'sliding_window' | 'token_bucket' | 'no_limit')
    : 'no_limit';

  const limit = limitRaw ? parseInt(limitRaw, 10) : (rateAmountRaw ? parseInt(rateAmountRaw, 10) : 0);
  const interval = intervalRaw || rateIntervalRaw || 'unknown';

  const issues: string[] = [];

  if (policy === 'no_limit') {
    issues.push(`"${name}": no_limit policy — requests are tracked but not restricted; verify this is not used in prod`);
  }

  if (limit > 10000) {
    issues.push(`"${name}": very high limit (${limit}) — verify this is intentional and not a misconfiguration`);
  }

  if (policy === 'token_bucket') {
    const hasBurst = sectionContent.includes('burst') || sectionContent.includes('rate:');
    if (!hasBurst) {
      issues.push(`"${name}": token_bucket policy without burst/rate configuration — add rate: {amount: N, interval: '...'} for burst control`);
    }
  }

  if (policy === 'fixed_window') {
    issues.push(`"${name}": fixed_window policy can cause traffic spikes at window boundaries — consider sliding_window for smoother distribution`);
  }

  if (limit === 0 && policy !== 'no_limit') {
    issues.push(`"${name}": limit is 0 or not set — may allow unlimited requests or cause errors`);
  }

  return { name, policy, limit, interval, issues };
}

function extractLimiterNames(content: string): string[] {
  // Find lines like "  limiter_name:" (2-space indent under rate_limiter:)
  const names: string[] = [];
  const lines = content.split('\n');
  let inRateLimiter = false;

  for (const line of lines) {
    if (/rate_limiter\s*:/.test(line)) { inRateLimiter = true; continue; }
    if (inRateLimiter) {
      // A new top-level key ends the section
      if (/^[a-zA-Z]/.test(line) && !line.startsWith(' ')) { inRateLimiter = false; continue; }
      // 2-space or 4-space indented key with no leading spaces beyond indent
      const m = /^[ ]{2,4}(\w[\w_-]{0,80})\s*:/.exec(line);
      if (m && !['policy', 'limit', 'interval', 'rate', 'amount', 'lock_factory', 'cache_pool', 'burst'].includes(m[1])) {
        names.push(m[1]);
      }
    }
  }

  return names;
}

function extractLimiterSection(content: string, limiterName: string): string {
  const idx = content.indexOf(`  ${limiterName}:`);
  if (idx === -1) return '';
  // Read until next sibling key at same indent level
  const after = content.slice(idx + limiterName.length + 3);
  const nextKeyM = /\n[ ]{2}[a-zA-Z]/.exec(after);
  return nextKeyM ? after.slice(0, nextKeyM.index) : after.slice(0, 500);
}

function buildRateLimiterAlgorithmInfos(appPath: string): RateLimiterAlgorithmInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'rate_limiter.yaml'),
    path.join(appPath, 'config', 'rate_limiter.yaml'),
  ];

  const results: RateLimiterAlgorithmInfo[] = [];

  for (const yamlPath of candidates) {
    const resolved = path.resolve(yamlPath);
    if (!resolved.startsWith(path.resolve(appPath) + path.sep)) continue;
    if (!fs.existsSync(yamlPath)) continue;

    const content = readFileSafe(yamlPath, appPath);
    if (!content) continue;

    // Check if there's a rate_limiter section
    if (!content.includes('rate_limiter')) continue;

    const names = extractLimiterNames(content);
    for (const name of names) {
      const section = extractLimiterSection(content, name);
      const info = parseLimiterSection(name, section);
      results.push(info);
    }

    // Also check for env-specific files
    break; // Use first found file
  }

  // Check prod config overrides
  const prodYaml = path.join(appPath, 'config', 'packages', 'prod', 'rate_limiter.yaml');
  const prodResolved = path.resolve(prodYaml);
  if (prodResolved.startsWith(path.resolve(appPath) + path.sep) && fs.existsSync(prodYaml)) {
    const prodContent = readFileSafe(prodYaml, appPath);
    if (prodContent && prodContent.includes('no_limit')) {
      results.push({
        name: 'prod-override',
        policy: 'no_limit',
        limit: 0,
        interval: 'unknown',
        issues: ['rate_limiter.yaml in prod/ contains no_limit policy — this disables rate limiting in production'],
      });
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export function listSymfonyRateLimiterAlgorithms(appPath: string): McpToolResult {
  try {
    const infos = buildRateLimiterAlgorithmInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No rate limiters found in config/packages/rate_limiter.yaml.\n\nInstall: composer require symfony/rate-limiter\nConfigure in config/packages/rate_limiter.yaml:\n  framework:\n    rate_limiter:\n      anonymous_api:\n        policy: sliding_window\n        limit: 100\n        interval: \'60 minutes\'' }] };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);
    let text = `Symfony Rate Limiter Algorithm Analysis\n${'='.repeat(55)}\n\n`;
    text += `Rate limiters configured: ${infos.length}  (with issues: ${withIssues.length})\n\n`;

    for (const info of infos) {
      text += `  ${info.name}\n`;
      text += `    Policy:   ${info.policy}\n`;
      text += `    Limit:    ${info.limit > 0 ? info.limit : 'not set'}\n`;
      text += `    Interval: ${info.interval}\n`;
      for (const issue of info.issues) {
        text += `    [WARN] ${issue}\n`;
      }
      if (info.issues.length === 0) text += `    OK\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyRateLimiterAlgorithmsStats(appPath: string): McpToolResult {
  try {
    const infos = buildRateLimiterAlgorithmInfos(appPath);

    const byPolicy: Record<string, number> = {};
    for (const info of infos) {
      byPolicy[info.policy] = (byPolicy[info.policy] ?? 0) + 1;
    }

    let text = `Symfony Rate Limiter Algorithm Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total limiters: ${infos.length}\n\n`;
    text += `By policy:\n`;
    for (const [policy, count] of Object.entries(byPolicy).sort()) {
      text += `  ${policy.padEnd(20)}  ${count}\n`;
    }

    text += `\nIssue summary:\n`;
    text += `  no_limit policy:    ${infos.filter((i) => i.policy === 'no_limit').length}\n`;
    text += `  Very high limit:    ${infos.filter((i) => i.limit > 10000).length}\n`;
    text += `  Token bucket/no burst: ${infos.filter((i) => i.issues.some((s) => s.includes('burst'))).length}\n`;
    text += `Total issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyRateLimiterAlgorithmsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_rate_limiter_algorithms',
      description: 'List Symfony rate limiter algorithm configurations: policy (fixed_window/sliding_window/token_bucket/no_limit), limit, interval; flags no_limit in prod, very high limits (>10000), token_bucket without burst config',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_rate_limiter_algorithms_stats',
      description: 'Show Symfony rate limiter algorithm statistics: count by policy type, no_limit count, very high limit count, token_bucket without burst count, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
