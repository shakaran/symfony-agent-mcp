// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DoctrineEncryptionInfo {
  file: string;
  entity: string;
  column: string;
  type: 'attribute' | 'annotation' | 'subscriber';
  algorithm: string;
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

function buildEncryptionInfos(appPath: string): DoctrineEncryptionInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: DoctrineEncryptionInfo[] = [];

  let hasEncryptBundle = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['ambta/doctrine-encrypt-bundle'] || req['halvard/doctrine-encrypt-bundle'] || req['michaelcullum/doctrine-encrypt-bundle']) {
        hasEncryptBundle = true;
      }
    } catch { /* ignore */ }
  }

  let envKeyExposed = false;
  const envFiles = [path.join(appPath, '.env'), path.join(appPath, '.env.local')];
  for (const envFile of envFiles) {
    if (!fs.existsSync(envFile)) continue;
    try {
      const envContent = fs.readFileSync(envFile, 'utf-8');
      if (/ENCRYPT(?:ION)?_KEY\s*=\s*.{8,}/.test(envContent)) envKeyExposed = true;
    } catch { /* ignore */ }
  }

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath) ?? '';
    if (!content) continue;

    const relFile = path.relative(appPath, file);
    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const entity = classMatch ? classMatch[1] : path.basename(file, '.php');

    const hasAttrEncrypt = content.includes('#[Encrypted]') || content.includes('#[DoctrineEncrypt\\Annotation\\Encrypted]');
    const hasAnnotEncrypt = content.includes('@Encrypted') || content.includes('@DoctrineEncrypt\\Encrypted');
    const isEncryptSubscriber = content.includes('DoctrineEncryptSubscriber') || content.includes('onLoad') && content.includes('openssl_encrypt');

    if (!hasAttrEncrypt && !hasAnnotEncrypt && !isEncryptSubscriber) continue;

    const type = hasAttrEncrypt ? 'attribute' : hasAnnotEncrypt ? 'annotation' : 'subscriber';
    const algorithm = content.includes('sodium') ? 'sodium' : content.includes('openssl') ? 'openssl' : 'AES256';
    const issues: string[] = [];

    if (envKeyExposed) {
      issues.push(`Encryption key found in .env file — should be injected from external secret vault (not committed to source control)`);
    }

    const encryptedProps: string[] = [];
    const propMatches = content.matchAll(/#\[Encrypted\][^$]{0,100}\$(\w{1,60})|@Encrypted[^$]{0,100}\$(\w{1,60})/g);
    for (const m of propMatches) encryptedProps.push(m[1] ?? m[2]);

    for (const prop of encryptedProps) {
      const hasIndex = new RegExp(`#\\[ORM\\\\Index[^\\]]{0,200}${prop}|@Index[^)]{0,200}${prop}`).test(content);
      if (hasIndex) {
        issues.push(`Encrypted property "$${prop}" has a database index — indexes on encrypted columns are useless (index stores encrypted values, not searchable)`);
      }
    }

    if (!hasEncryptBundle && (hasAttrEncrypt || hasAnnotEncrypt)) {
      issues.push('Doctrine Encrypted annotation used but no encryption bundle found in composer.json');
    }

    const column = encryptedProps.length > 0 ? encryptedProps.join(', ') : '(subscriber-level)';
    results.push({ file: relFile, entity, column, type, algorithm, issues });
  }

  return results;
}

export function listDoctrineEncryption(appPath: string): McpToolResult {
  try {
    const infos = buildEncryptionInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine column encryption found (#[Encrypted], @Encrypted, DoctrineEncryptSubscriber).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Encryption Analysis\n${'='.repeat(55)}\n\nEntities: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.entity}  columns: ${info.column}  algo: ${info.algorithm}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineEncryptionStats(appPath: string): McpToolResult {
  try {
    const infos = buildEncryptionInfos(appPath);
    let text = `Doctrine Encryption Statistics\n${'='.repeat(40)}\n\n`;
    text += `Entities:       ${infos.length}\n`;
    text += `  Attributes:   ${infos.filter((i) => i.type === 'attribute').length}\n`;
    text += `  Annotations:  ${infos.filter((i) => i.type === 'annotation').length}\n`;
    text += `  Subscribers:  ${infos.filter((i) => i.type === 'subscriber').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineEncryptionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_encryption', description: 'Detect Doctrine encrypted column patterns; warns on encryption key in .env, encrypted column with index (useless), no encryption bundle found', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_encryption_stats', description: 'Statistics for Doctrine encryption: entity count by type (attribute/annotation/subscriber), issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
