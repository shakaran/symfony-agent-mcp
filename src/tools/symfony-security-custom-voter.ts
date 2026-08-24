// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Security Custom Voter Inspector
 *
 * Scans src/**\/*.php for Symfony custom voter coverage issues:
 *   - Voter not covering all attributes in supportsAttribute()
 *   - supports() returning true for attribute not handled in voteOnAttribute()
 *   - Voter returning ACCESS_ABSTAIN on all paths (useless voter)
 *   - Missing #[AsVoter] attribute or security.voter service tag
 *   - access_control referencing attributes not in any voter
 *   - Case-sensitive === string comparison for class constants
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface VoterInfo {
  file: string;
  className: string;
  supportedAttributes: string[];
  handledAttributes: string[];
  alwaysAbstains: boolean;
  hasAsVoterAttr: boolean;
  hasServiceTag: boolean;
  usesCaseSensitiveCompare: boolean;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...getAllPhpFiles(full));
      } else if (entry.name.endsWith('.php')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

function extractAttributeList(block: string): string[] {
  const attrs: string[] = [];

  // Match array of strings: ['VIEW', 'EDIT', ...]
  const arrayMatch = /\[([^\]]+)]/m.exec(block);
  if (arrayMatch) {
    const items = arrayMatch[1].split(',');
    for (const item of items) {
      const clean = item.trim().replace(/['"]/g, '');
      if (clean.length > 0) attrs.push(clean);
    }
    return attrs;
  }

  // Match single string: 'VIEW' or "VIEW"
  const singleMatch = /['"]([A-Z_][A-Z_0-9]*)['"]/.exec(block);
  if (singleMatch) attrs.push(singleMatch[1]);

  // Match class constants: self::VIEW, static::EDIT
  const constRegex = /(?:self|static)::([A-Z_][A-Z_0-9]*)/g;
  let m: RegExpExecArray | null;
  while ((m = constRegex.exec(block)) !== null) {
    if (!attrs.includes(m[1])) attrs.push(m[1]);
  }

  return attrs;
}

function extractSupportedAttributes(content: string): string[] {
  // supportsAttribute() method body
  const supportsAttrMethod = /function\s+supportsAttribute[^{]*\{([^}]+)}/m.exec(content);
  if (supportsAttrMethod) {
    return extractAttributeList(supportsAttrMethod[1]);
  }

  // supports() method — first arg is attribute
  const supportsMethod = /function\s+supports[^{]*\{([^}]+)}/m.exec(content);
  if (supportsMethod) {
    return extractAttributeList(supportsMethod[1]);
  }

  // SUPPORTED_ATTRIBUTES constant
  const constMatch = /SUPPORTED_ATTRIBUTES\s*=\s*\[([^\]]+)]/m.exec(content);
  if (constMatch) {
    return extractAttributeList('[' + constMatch[1] + ']');
  }

  return [];
}

function extractHandledAttributes(content: string): string[] {
  const attrs: string[] = [];

  // voteOnAttribute() — look for case/if branches with string literals or constants
  const voteMethod = /function\s+voteOnAttribute[^{]*\{([\s\S]+?)(?=\n\s{4}(?:public|protected|private|function)|\n})/m.exec(content);
  if (!voteMethod) return attrs;

  const body = voteMethod[1];

  // switch/match on $attribute
  const caseRegex = /case\s+['"]([A-Z_][A-Z_0-9]*)['"]|case\s+(?:self|static)::([A-Z_][A-Z_0-9]*)/g;
  let m: RegExpExecArray | null;
  while ((m = caseRegex.exec(body)) !== null) {
    const attr = m[1] ?? m[2];
    if (attr && !attrs.includes(attr)) attrs.push(attr);
  }

  // if ($attribute === 'VIEW') or if ($attribute === self::VIEW)
  const ifRegex = /\$attribute\s*===?\s*(?:'([A-Z_][A-Z_0-9]*)'|"([A-Z_][A-Z_0-9]*)"|(?:self|static)::([A-Z_][A-Z_0-9]*))/g;
  while ((m = ifRegex.exec(body)) !== null) {
    const attr = m[1] ?? m[2] ?? m[3];
    if (attr && !attrs.includes(attr)) attrs.push(attr);
  }

  return attrs;
}

function checkAlwaysAbstains(content: string): boolean {
  const voteMethod = /function\s+voteOnAttribute[^{]*\{([\s\S]+?)(?=\n\s{4}(?:public|protected|private|function)|\n})/m.exec(content);
  if (!voteMethod) return false;

  const body = voteMethod[1];
  const hasGrant = body.includes('ACCESS_GRANTED') || body.includes('return true');
  const hasDeny = body.includes('ACCESS_DENIED') || body.includes('return false');

  return !hasGrant && !hasDeny;
}

function scanVoters(appPath: string): VoterInfo[] {
  const resolvedBase = path.resolve(appPath);
  const srcDir = path.join(resolvedBase, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: VoterInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    if (!path.resolve(file).startsWith(resolvedBase + path.sep)) continue;

    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isVoter = content.includes('extends Voter') ||
                    content.includes('implements VoterInterface') ||
                    content.includes('VoterInterface') && content.includes('vote(');

    if (!isVoter) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    if (!classMatch) continue;
    const className = classMatch[1];

    const supportedAttributes = extractSupportedAttributes(content);
    const handledAttributes = extractHandledAttributes(content);
    const alwaysAbstains = checkAlwaysAbstains(content);
    const hasAsVoterAttr = content.includes('#[AsVoter') || content.includes('[AsVoter]');
    const hasServiceTag = content.includes('security.voter') || content.includes('@security.voter');

    // Case-sensitive comparison: === with a string that's also a class constant
    const usesCaseSensitiveCompare = /\$attribute\s*===\s*(?:self|static)::[A-Z_]+/.test(content) &&
                                     /class\s+\w+.*extends\s+Voter/.test(content);

    const issues: string[] = [];

    if (!hasAsVoterAttr && !hasServiceTag) {
      issues.push('Voter has neither #[AsVoter] attribute nor security.voter service tag — it may not be registered');
    }

    if (alwaysAbstains) {
      issues.push('voteOnAttribute() never returns ACCESS_GRANTED or ACCESS_DENIED — voter always abstains and is effectively useless');
    }

    // Supported but not handled
    for (const attr of supportedAttributes) {
      if (handledAttributes.length > 0 && !handledAttributes.includes(attr)) {
        issues.push(`Attribute "${attr}" is declared in supports() but not handled in voteOnAttribute() — falls through to ACCESS_ABSTAIN`);
      }
    }

    // Handled but not declared in supports
    for (const attr of handledAttributes) {
      if (supportedAttributes.length > 0 && !supportedAttributes.includes(attr)) {
        issues.push(`Attribute "${attr}" is handled in voteOnAttribute() but not listed in supports() — unreachable code`);
      }
    }

    results.push({
      file: path.relative(appPath, file),
      className,
      supportedAttributes,
      handledAttributes,
      alwaysAbstains,
      hasAsVoterAttr,
      hasServiceTag,
      usesCaseSensitiveCompare,
      issues,
    });
  }

  return results;
}

function getAccessControlAttributes(appPath: string): string[] {
  const resolvedBase = path.resolve(appPath);
  const securityYaml = path.join(resolvedBase, 'config', 'packages', 'security.yaml');
  const attrs: string[] = [];

  let content = '';
  try { content = fs.readFileSync(securityYaml, 'utf-8'); } catch { return attrs; }

  // Look for access_control: - { path: ..., roles: ['IS_AUTHENTICATED', 'CUSTOM_ATTR'] }
  const attrRegex = /['"]([A-Z][A-Z_0-9]{2,})['"]/g;
  let m: RegExpExecArray | null;
  const accessControlSection = /access_control:([\s\S]+?)(?=\n\w|\n$)/m.exec(content);
  if (!accessControlSection) return attrs;

  while ((m = attrRegex.exec(accessControlSection[1])) !== null) {
    const val = m[1];
    // Filter out Symfony built-ins
    if (!val.startsWith('ROLE_') && !val.startsWith('IS_AUTHENTICATED') && !val.startsWith('PUBLIC_ACCESS')) {
      if (!attrs.includes(val)) attrs.push(val);
    }
  }

  return attrs;
}

function buildAnalysis(appPath: string): { voters: VoterInfo[]; accessControlAttrs: string[]; orphanAttrs: string[] } {
  const voters = scanVoters(appPath);
  const accessControlAttrs = getAccessControlAttributes(appPath);

  const allVoterAttrs = new Set<string>();
  for (const v of voters) {
    for (const a of v.supportedAttributes) allVoterAttrs.add(a);
    for (const a of v.handledAttributes) allVoterAttrs.add(a);
  }

  const orphanAttrs = accessControlAttrs.filter((a) => !allVoterAttrs.has(a));

  return { voters, accessControlAttrs, orphanAttrs };
}

export function listSymfonySecurityCustomVoter(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { voters, accessControlAttrs, orphanAttrs } = buildAnalysis(appPath);

    if (voters.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony security voters found in src/.\n\nVoters extend Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter\nor implement VoterInterface.\nUse #[AsVoter] attribute or security.voter service tag.',
        }],
      };
    }

    let text = `Symfony Security Custom Voter Audit\n${'='.repeat(55)}\n\n`;

    for (const voter of voters) {
      text += `  ${voter.className}  (${voter.file})\n`;
      text += `    Supports:  [${voter.supportedAttributes.join(', ') || 'none detected'}]\n`;
      text += `    Handles:   [${voter.handledAttributes.join(', ') || 'none detected'}]\n`;
      text += `    Registered: ${voter.hasAsVoterAttr ? '#[AsVoter]' : voter.hasServiceTag ? 'security.voter tag' : 'NOT REGISTERED'}\n`;

      if (voter.alwaysAbstains) {
        text += `    [WARNING] Voter always abstains — never grants or denies\n`;
      }
      if (voter.usesCaseSensitiveCompare) {
        text += `    [NOTE] Uses === for class constant comparison (case-sensitive, likely fine)\n`;
      }
      for (const issue of voter.issues) {
        text += `    - ${issue}\n`;
      }
      text += '\n';
    }

    if (accessControlAttrs.length > 0) {
      text += `Attributes in access_control: [${accessControlAttrs.join(', ')}]\n`;
    }

    if (orphanAttrs.length > 0) {
      text += `Attributes in access_control not covered by any voter (${orphanAttrs.length}):\n`;
      for (const a of orphanAttrs) {
        text += `  - ${a}\n`;
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

export function getSymfonySecurityCustomVoterStats(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { voters, accessControlAttrs, orphanAttrs } = buildAnalysis(appPath);

    let text = `Symfony Security Custom Voter Stats\n${'='.repeat(40)}\n\n`;
    text += `Total voters:                  ${voters.length}\n`;
    text += `Registered (#[AsVoter]/tag):   ${voters.filter((v) => v.hasAsVoterAttr || v.hasServiceTag).length}\n`;
    text += `Unregistered:                  ${voters.filter((v) => !v.hasAsVoterAttr && !v.hasServiceTag).length}\n`;
    text += `Always-abstaining:             ${voters.filter((v) => v.alwaysAbstains).length}\n`;
    text += `Voters with issues:            ${voters.filter((v) => v.issues.length > 0).length}\n`;
    text += `access_control custom attrs:   ${accessControlAttrs.length}\n`;
    text += `Orphan attrs (no voter):       ${orphanAttrs.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonySecurityCustomVoterTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_security_custom_voter',
      description: 'Audit Symfony custom security voters: attribute coverage gaps (supports vs voteOnAttribute), always-abstaining voters, missing registration (#[AsVoter]/security.voter tag), access_control attributes not covered by any voter',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_security_custom_voter_stats',
      description: 'Statistics for Symfony security voters: total count, registered, unregistered, always-abstaining, voters with issues, orphan access_control attributes',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
