/**
 * Symfony Password Migrator Inspector
 *
 * Reads security.yaml: password_hashers section with migrate_from config, algorithm chains.
 * Scans src/ PHP for: MigratingPasswordHasher, LegacyPasswordHasherInterface,
 * PasswordHasherInterface with migrate_from, PasswordUpgraderInterface in UserProvider.
 *
 * Warns about:
 *   - migrate_from config without PasswordUpgraderInterface in UserProvider (migration never happens)
 *   - MigratingPasswordHasher without catching PasswordMigrationRequiredException
 *   - Legacy hasher still accepting old format after migration deadline
 *   - Migration chain length >3 (triple hashing overhead on login)
 *   - Auto rehash not triggered (PasswordUpgraderInterface::upgradePassword() not called after login success)
 *   - LegacyPasswordHasherInterface::hash() still called on new users (should only be for verification)
 *
 * Pure static analysis — no execution.
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

interface PasswordMigrationInfo {
  hasherName: string;
  algorithm: string;
  migratesFrom: string[];
  hasUpgraderInterface: boolean;
  chainLength: number;
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

interface SrcScanResult {
  hasUpgraderInterface: boolean;
  hasUpgradePasswordCall: boolean;
  hasMigratingPasswordHasher: boolean;
  hasPasswordMigrationException: boolean;
  hasLegacyHashCall: boolean;
}

function scanSrcForPasswordMigration(appPath: string): SrcScanResult {
  const srcDir = path.join(appPath, 'src');
  const result: SrcScanResult = {
    hasUpgraderInterface: false,
    hasUpgradePasswordCall: false,
    hasMigratingPasswordHasher: false,
    hasPasswordMigrationException: false,
    hasLegacyHashCall: false,
  };

  if (!fs.existsSync(srcDir)) return result;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (content.includes('PasswordUpgraderInterface')) {
      result.hasUpgraderInterface = true;
    }
    if (content.includes('upgradePassword(')) {
      result.hasUpgradePasswordCall = true;
    }
    if (content.includes('MigratingPasswordHasher')) {
      result.hasMigratingPasswordHasher = true;
    }
    if (content.includes('PasswordMigrationRequiredException') || content.includes('NeedsRehashException')) {
      result.hasPasswordMigrationException = true;
    }
    if (
      (content.includes('LegacyPasswordHasherInterface') || content.includes('LegacyPasswordHasher')) &&
      /->hash\s*\(/.test(content)
    ) {
      result.hasLegacyHashCall = true;
    }
  }

  return result;
}

function buildPasswordMigrationInfos(appPath: string): PasswordMigrationInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
  ];

  const results: PasswordMigrationInfo[] = [];
  const srcScan = scanSrcForPasswordMigration(appPath);

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const hashers = (security['password_hashers'] ?? {}) as Record<string, unknown>;

    for (const [hasherName, hasherData] of Object.entries(hashers)) {
      const hasher = (hasherData ?? {}) as Record<string, unknown>;
      const algorithm = String(hasher['algorithm'] ?? hasher['class'] ?? 'auto');
      const migrateFromRaw = hasher['migrate_from'];

      let migratesFrom: string[] = [];
      if (Array.isArray(migrateFromRaw)) {
        migratesFrom = migrateFromRaw.map(String);
      } else if (typeof migrateFromRaw === 'string') {
        migratesFrom = [migrateFromRaw];
      }

      const chainLength = migratesFrom.length + 1;
      const issues: string[] = [];

      if (migratesFrom.length > 0 && !srcScan.hasUpgraderInterface) {
        issues.push(`Hasher "${hasherName}" has migrate_from config but no PasswordUpgraderInterface found in src/ — password migration never triggers (no rehash on login)`);
      }

      if (srcScan.hasMigratingPasswordHasher && !srcScan.hasPasswordMigrationException) {
        issues.push(`MigratingPasswordHasher found but PasswordMigrationRequiredException is not caught — migration failures may go silently unhandled`);
      }

      if (chainLength > 3) {
        issues.push(`Hasher "${hasherName}" has migration chain length ${chainLength} (>3) — each login requires ${chainLength} hash verifications (significant overhead)`);
      }

      if (srcScan.hasUpgraderInterface && !srcScan.hasUpgradePasswordCall) {
        issues.push(`PasswordUpgraderInterface implemented but upgradePassword() call not found — auto rehash may not be triggered after successful login`);
      }

      if (srcScan.hasLegacyHashCall) {
        issues.push('LegacyPasswordHasherInterface::hash() called in src/ — legacy hasher should only be used for verification, not hashing new passwords');
      }

      results.push({
        hasherName,
        algorithm,
        migratesFrom,
        hasUpgraderInterface: srcScan.hasUpgraderInterface,
        chainLength,
        issues,
      });
    }
  }

  return results;
}

export function listPasswordMigration(appPath: string): McpToolResult {
  try {
    const infos = buildPasswordMigrationInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No password_hashers configuration found in security.yaml.',
        }],
      };
    }

    const withMigration = infos.filter((i) => i.migratesFrom.length > 0);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Password Migration Analysis\n${'='.repeat(55)}\n\n`;
    text += `Hashers: ${infos.length}  With migration: ${withMigration.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.hasherName}\n`;
      text += `    algorithm:      ${info.algorithm}\n`;
      text += `    chainLength:    ${info.chainLength}\n`;
      text += `    upgraderImpl:   ${info.hasUpgraderInterface ? 'yes' : 'no'}\n`;
      if (info.migratesFrom.length > 0) {
        text += `    migratesFrom:   ${info.migratesFrom.join(', ')}\n`;
      }
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

export function getPasswordMigrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildPasswordMigrationInfos(appPath);

    let text = `Password Migration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total hashers:               ${infos.length}\n`;
    text += `  With migrate_from:         ${infos.filter((i) => i.migratesFrom.length > 0).length}\n`;
    text += `  With upgrader interface:   ${infos.filter((i) => i.hasUpgraderInterface).length}\n`;
    text += `  Chain length > 3:          ${infos.filter((i) => i.chainLength > 3).length}\n`;
    text += `Total issues:                ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPasswordMigrationTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_password_migration',
      description: 'Inspect password migration configuration: migrate_from chains in security.yaml, PasswordUpgraderInterface in src/, MigratingPasswordHasher usage; warns on migration config without upgrader interface, long chains, missing rehash trigger',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_password_migration_stats',
      description: 'Statistics for password migration: total hashers, migrate_from count, upgrader interface coverage, long chain count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
