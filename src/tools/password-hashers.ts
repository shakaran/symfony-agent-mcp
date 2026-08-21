/**
 * Password Hasher Security Audit
 *
 * Reads security.password_hashers from config/packages/security.yaml:
 *   - Algorithm per user class (argon2id/bcrypt/auto/native/md5/sha1/plaintext)
 *   - cost (bcrypt), memory_cost / time_cost / threads (argon2)
 *   - migrate_from (legacy hasher migration chains)
 *
 * Security audit:
 *   - CRITICAL: plaintext, md5, sha1, sha256 — never use for passwords
 *   - WARNING:  bcrypt with cost < 12 (too fast)
 *   - WARNING:  sodium/argon2i without memory_cost set
 *   - INFO:     auto (inherits PHP defaults — good choice)
 *   - INFO:     migrate_from present (active migration — monitor)
 *
 * Pure static analysis.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

type HasherSeverity = 'critical' | 'warning' | 'info' | 'ok';

interface HasherConfig {
  entity: string;
  algorithm: string;
  cost?: number;
  memoryCost?: number;
  timeCost?: number;
  threads?: number;
  migrateFrom: string[];
  severity: HasherSeverity;
  issues: string[];
}

// ─── Algorithm classification ────────────────────────────────────────────────

const INSECURE_ALGORITHMS = ['plaintext', 'md5', 'sha1', 'sha256', 'sha512', 'md4'];
const MODERN_ALGORITHMS   = ['argon2id', 'auto', 'native', 'sodium'];

function classifyAlgorithm(algo: string): HasherSeverity {
  const lower = algo.toLowerCase();
  if (INSECURE_ALGORITHMS.includes(lower)) return 'critical';
  if (lower === 'bcrypt') return 'warning';
  if (MODERN_ALGORITHMS.some((m) => lower.includes(m))) return 'ok';
  return 'info';
}

function auditHasher(entity: string, raw: Record<string, unknown>): HasherConfig {
  const algorithm = raw['algorithm'] ? String(raw['algorithm']) : 'auto';
  const cost        = raw['cost']         !== undefined ? Number(raw['cost'])         : undefined;
  const memoryCost  = raw['memory_cost']  !== undefined ? Number(raw['memory_cost'])  : undefined;
  const timeCost    = raw['time_cost']    !== undefined ? Number(raw['time_cost'])     : undefined;
  const threads     = raw['threads']      !== undefined ? Number(raw['threads'])       : undefined;
  const migrateFrom = raw['migrate_from']
    ? (Array.isArray(raw['migrate_from']) ? raw['migrate_from'].map(String) : [String(raw['migrate_from'])])
    : [];

  const issues: string[] = [];
  let severity = classifyAlgorithm(algorithm);

  const lower = algorithm.toLowerCase();

  if (INSECURE_ALGORITHMS.includes(lower)) {
    issues.push(`${algorithm} is not a password hashing algorithm — never store passwords with it`);
  }
  if (lower === 'bcrypt' && cost !== undefined && cost < 12) {
    issues.push(`bcrypt cost=${cost} is too low (≥12 recommended for 2024)`);
    severity = 'warning';
  }
  if (lower === 'bcrypt' && cost === undefined) {
    issues.push('bcrypt: no cost set — defaults to Symfony\'s default (check PHP version)');
    severity = 'warning';
  }
  if (migrateFrom.length > 0) {
    issues.push(`Active migration from: ${migrateFrom.join(', ')} — users rehashed on next login`);
    if (severity === 'ok') severity = 'info';
  }
  if ((lower === 'argon2i' || lower === 'argon2id') && memoryCost === undefined) {
    issues.push('argon2: no memory_cost set — using PHP defaults (consider tuning for your server)');
    if (severity === 'ok') severity = 'info';
  }

  return { entity, algorithm, cost, memoryCost, timeCost, threads, migrateFrom, severity, issues };
}

function loadHashers(appPath: string): HasherConfig[] {
  const secFile = path.join(appPath, 'config', 'packages', 'security.yaml');
  const raw = parseYamlFile(secFile) as Record<string, unknown> | null;
  if (!raw) return [];

  const security = (raw['security'] ?? raw) as Record<string, unknown>;
  const hashersRaw = security['password_hashers'] as Record<string, unknown> | undefined;
  if (!hashersRaw) return [];

  const hashers: HasherConfig[] = [];
  for (const [entity, def] of Object.entries(hashersRaw)) {
    if (!def || typeof def !== 'object') {
      // Shorthand: just a string algorithm
      hashers.push(auditHasher(entity, { algorithm: String(def ?? 'auto') }));
      continue;
    }
    hashers.push(auditHasher(entity, def as Record<string, unknown>));
  }
  return hashers;
}

// ─── Tool functions ────────────────────────────────────────────────────────

const ALGO_LABEL: Record<string, string> = {
  auto:       'auto (PHP best available — recommended)',
  native:     'native (alias for auto)',
  argon2id:   'argon2id (modern, recommended)',
  argon2i:    'argon2i (older argon variant)',
  bcrypt:     'bcrypt (solid, watch cost)',
  sodium:     'sodium/libsodium (modern)',
  plaintext:  '⛔ PLAINTEXT — never use',
  md5:        '⛔ MD5 — cryptographically broken',
  sha1:       '⛔ SHA-1 — broken for passwords',
  sha256:     '⛔ SHA-256 — not a KDF',
  sha512:     '⛔ SHA-512 — not a KDF',
};

export function listPasswordHashers(appPath: string): McpToolResult {
  try {
    const hashers = loadHashers(appPath);

    if (hashers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'security.password_hashers not found in config/packages/security.yaml.\n\nAdd:\n  security:\n    password_hashers:\n      App\\Entity\\User:\n        algorithm: auto',
        }],
      };
    }

    const critical = hashers.filter((h) => h.severity === 'critical');
    const warnings = hashers.filter((h) => h.severity === 'warning');

    let text = `Password Hasher Configuration (${hashers.length})\n${'='.repeat(60)}\n`;

    for (const h of hashers) {
      const icon = h.severity === 'critical' ? '⛔' : h.severity === 'warning' ? '⚠' : '✓';
      const label = ALGO_LABEL[h.algorithm.toLowerCase()] ?? h.algorithm;
      text += `\n${icon} ${h.entity.split('\\').pop() ?? h.entity}\n`;
      text += `   Algorithm:  ${label}\n`;
      if (h.cost        !== undefined) text += `   cost:        ${h.cost}\n`;
      if (h.memoryCost  !== undefined) text += `   memory_cost: ${h.memoryCost} KB\n`;
      if (h.timeCost    !== undefined) text += `   time_cost:   ${h.timeCost}\n`;
      if (h.threads     !== undefined) text += `   threads:     ${h.threads}\n`;
      if (h.migrateFrom.length > 0)   text += `   migrate_from: ${h.migrateFrom.join(', ')}\n`;
      for (const issue of h.issues) {
        text += `   → ${issue}\n`;
      }
    }

    if (critical.length > 0) {
      text += `\n${'─'.repeat(60)}\n`;
      text += `⛔ CRITICAL: ${critical.length} insecure hasher(s) — immediate action required:\n`;
      for (const h of critical) text += `   ${h.entity} uses ${h.algorithm}\n`;
    }
    if (warnings.length > 0) {
      text += `\n⚠ WARNINGS: ${warnings.length} hasher(s) need attention\n`;
    }
    if (critical.length === 0 && warnings.length === 0) {
      text += `\n✓ All hashers are using secure algorithms.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPasswordHasherStats(appPath: string): McpToolResult {
  try {
    const hashers = loadHashers(appPath);

    let text = `Password Hasher Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total hashers:     ${hashers.length}\n`;
    text += `Critical:          ${hashers.filter((h) => h.severity === 'critical').length}\n`;
    text += `Warnings:          ${hashers.filter((h) => h.severity === 'warning').length}\n`;
    text += `With migration:    ${hashers.filter((h) => h.migrateFrom.length > 0).length}\n`;

    const algos = [...new Set(hashers.map((h) => h.algorithm))];
    text += `Algorithms:        ${algos.join(', ')}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPasswordHasherTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_password_hashers',
      description: 'Audit password hashers: algorithm per entity, cost settings, security classification (critical/warning for plaintext/md5/weak bcrypt), migrate_from chains',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_password_hasher_stats',
      description: 'Show password hasher statistics: total hashers, critical/warning count, algorithms used, hashers with active migration',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
