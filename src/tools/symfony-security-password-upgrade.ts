// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface PasswordUpgradeInfo {
  file: string;
  class: string;
  hasUpgradePasswordMethod: boolean;
  upgradePasswordHasBody: boolean;
  checksNeedsRehash: boolean;
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

function parsePasswordUpgrader(filePath: string, appPath: string): PasswordUpgradeInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasInterface = content.includes('PasswordUpgraderInterface');
  const hasMigrating = content.includes('MigratingPasswordHasher');
  if (!hasInterface && !hasMigrating) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  // Detect upgradePassword() method
  const upgradeM = /function\s+upgradePassword\s*\([^)]{0,200}\)[^{]{0,50}\{([\s\S]{0,500})\}/.exec(content);
  const hasUpgradePasswordMethod = upgradeM !== null;
  // Check if the body has meaningful content (not just comments/whitespace)
  const upgradeBody = upgradeM ? upgradeM[1].replace(/\/\/[^\n]{0,200}\n/g, '').trim() : '';
  const upgradePasswordHasBody = upgradeBody.length > 10;

  const checksNeedsRehash =
    content.includes('needsRehash(') ||
    content.includes('->needsRehash(');

  const issues: string[] = [];
  if (hasInterface && hasUpgradePasswordMethod && !upgradePasswordHasBody) {
    issues.push('upgradePassword() method appears empty or no-op — password rehash on login is silently skipped');
  }
  if (checksNeedsRehash && !hasUpgradePasswordMethod) {
    issues.push('needsRehash() is checked but upgradePassword() not found — rehash result is never applied');
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM[1],
    hasUpgradePasswordMethod,
    upgradePasswordHasBody,
    checksNeedsRehash,
    issues,
  };
}

function loadAutoRehashSetting(appPath: string): boolean | undefined {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const hashers = (security['password_hashers'] ?? {}) as Record<string, unknown>;
    for (const hasherConfig of Object.values(hashers)) {
      const cfg = (hasherConfig ?? {}) as Record<string, unknown>;
      if (cfg['auto_rehash_on_login'] !== undefined) {
        return cfg['auto_rehash_on_login'] !== false && cfg['auto_rehash_on_login'] !== 'false';
      }
    }
  }
  return undefined;
}

function hasMigratingHasherWithoutUpgrader(appPath: string, upgraders: PasswordUpgradeInfo[]): boolean {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const hashers = (security['password_hashers'] ?? {}) as Record<string, unknown>;
    for (const hasherConfig of Object.values(hashers)) {
      const cfg = (hasherConfig ?? {}) as Record<string, unknown>;
      if (String(cfg['algorithm'] ?? '').toLowerCase().includes('migrating') || cfg['migrate_from']) {
        return upgraders.length === 0;
      }
    }
  }
  return false;
}

export function listPasswordUpgradeConfig(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const upgraders: PasswordUpgradeInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const info = parsePasswordUpgrader(file, appPath);
        if (info) upgraders.push(info);
      }
    }

    const autoRehash = loadAutoRehashSetting(appPath);
    const migratingWithoutUpgrader = hasMigratingHasherWithoutUpgrader(appPath, upgraders);

    const globalIssues: string[] = [];
    if (autoRehash === false) {
      globalIssues.push('auto_rehash_on_login: false — password rehashing on login explicitly disabled');
    }
    if (migratingWithoutUpgrader) {
      globalIssues.push('MigratingPasswordHasher configured but no PasswordUpgraderInterface found in UserProvider — old hashes never upgraded');
    }

    if (upgraders.length === 0 && globalIssues.length === 0) {
      return { content: [{ type: 'text', text: 'No PasswordUpgraderInterface implementations found.\n\nExample:\n  class UserRepository implements PasswordUpgraderInterface {\n    public function upgradePassword(PasswordAuthenticatedUserInterface $user, string $newHashedPassword): void {\n      $user->setPassword($newHashedPassword);\n      $this->getEntityManager()->flush();\n    }\n  }' }] };
    }

    const totalIssues = upgraders.reduce((s, u) => s + u.issues.length, 0) + globalIssues.length;
    let text = `Password Upgrade Configuration\n${'='.repeat(55)}\n\nImplementations: ${upgraders.length}  Issues: ${totalIssues}\n`;

    if (autoRehash !== undefined) {
      text += `auto_rehash_on_login: ${autoRehash}\n`;
    }
    for (const issue of globalIssues) text += `⚠ ${issue}\n`;

    for (const u of upgraders.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${u.class}  (${u.file})\n`;
      text += `    upgradePassword(): ${u.hasUpgradePasswordMethod ? (u.upgradePasswordHasBody ? 'implemented' : 'EMPTY BODY') : 'not found'}\n`;
      text += `    needsRehash check: ${u.checksNeedsRehash ? 'yes' : 'no'}\n`;
      for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPasswordUpgradeStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const upgraders: PasswordUpgradeInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const info = parsePasswordUpgrader(file, appPath);
        if (info) upgraders.push(info);
      }
    }

    let text = `Password Upgrade Statistics\n${'='.repeat(40)}\n\n`;
    text += `Implementations:          ${upgraders.length}\n`;
    text += `  With upgradePassword():  ${upgraders.filter((u) => u.hasUpgradePasswordMethod).length}\n`;
    text += `  With non-empty body:     ${upgraders.filter((u) => u.upgradePasswordHasBody).length}\n`;
    text += `  needsRehash checks:      ${upgraders.filter((u) => u.checksNeedsRehash).length}\n`;
    text += `Issues:                   ${upgraders.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPasswordUpgradeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_password_upgrade',
      description: 'Show PasswordUpgraderInterface implementations: upgradePassword() body presence, needsRehash() usage, MigratingPasswordHasher config; warns on empty upgradePassword(), needsRehash without upgrade call, MigratingPasswordHasher without PasswordUpgraderInterface, auto_rehash_on_login:false',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_security_password_upgrade_stats',
      description: 'Show password upgrade statistics: implementation count, upgradePassword() coverage, non-empty body count, needsRehash usage count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
