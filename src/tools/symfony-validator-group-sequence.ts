/**
 * Symfony Validator GroupSequence Inspector
 *
 * Scans src/ PHP for:
 *   - GroupSequence class usage
 *   - GroupSequenceProviderInterface implementation
 *   - $validator->validate() with GroupSequence
 *   - #[GroupSequenceProvider] attribute on entity
 *
 * Warns about:
 *   - GroupSequenceProvider returning groups not defined on entity constraints
 *   - GroupSequence with single group (use plain group instead)
 *   - GroupSequenceProvider that always returns same sequence
 *   - Entity implementing GroupSequenceProviderInterface but missing #[GroupSequenceProvider]
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface GroupSequenceInfo {
  file: string;
  class: string;
  sequenceGroups: string[];
  isProvider: boolean;
  hasAttribute: boolean;
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

function extractSequenceGroups(content: string): string[] {
  const groups: string[] = [];
  // Match: new GroupSequence(['GroupA', 'GroupB', ...])
  const seqMatch = /new\s+GroupSequence\s*\(\s*\[([^\]]{0,500})\]/.exec(content);
  if (!seqMatch) return groups;

  const inner = seqMatch[1];
  const stringMatches = inner.matchAll(/'([^']{1,80})'|"([^"]{1,80})"/g);
  for (const m of stringMatches) {
    const group = m[1] ?? m[2];
    if (group) groups.push(group);
  }
  return groups;
}

function extractDefinedGroups(content: string): string[] {
  const groups: string[] = [];
  // Extract groups from Assert constraints: groups: ['GroupA']
  const groupsMatches = content.matchAll(/groups\s*[=:>]{1,2}\s*\[([^\]]{0,300})\]/g);
  for (const m of groupsMatches) {
    const inner = m[1];
    const stringMatches = inner.matchAll(/'([^']{1,80})'|"([^"]{1,80})"/g);
    for (const sm of stringMatches) {
      const group = sm[1] ?? sm[2];
      if (group && !groups.includes(group)) groups.push(group);
    }
  }
  return groups;
}

function isAlwaysSameSequence(content: string): boolean {
  // Heuristic: getGroupSequence returns a new GroupSequence with no conditional logic
  const methodMatch = /function\s+getGroupSequence\s*\([^)]{0,50}\)\s*\{([^}]{0,500})\}/.exec(content);
  if (!methodMatch) return false;
  const body = methodMatch[1];
  // If there are no if/switch/match or ternary operators, likely always same
  return !/\bif\b|\bswitch\b|\bmatch\b|\?/.test(body);
}

function scanGroupSequence(appPath: string): GroupSequenceInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: GroupSequenceInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasGroupSequence = content.includes('GroupSequence');
    const isProvider = content.includes('GroupSequenceProviderInterface');

    if (!hasGroupSequence && !isProvider) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    const hasAttribute =
      content.includes('#[GroupSequenceProvider]') ||
      content.includes('GroupSequenceProvider(');
    const sequenceGroups = extractSequenceGroups(content);
    const definedGroups = extractDefinedGroups(content);

    const issues: string[] = [];

    if (sequenceGroups.length === 1) {
      issues.push(`GroupSequence with single group "${sequenceGroups[0]}" — use a plain group string instead`);
    }

    if (isProvider && !hasAttribute) {
      issues.push(`Class implements GroupSequenceProviderInterface but missing #[GroupSequenceProvider] attribute — provider will not be used`);
    }

    if (isProvider && isAlwaysSameSequence(content)) {
      issues.push('GroupSequenceProvider::getGroupSequence() appears to always return the same sequence — static GroupSequence on the class would be simpler');
    }

    // Check for groups in sequence not defined in constraints
    if (sequenceGroups.length > 0 && definedGroups.length > 0) {
      const undefinedGroups = sequenceGroups.filter(
        (g) => g !== 'Default' && !definedGroups.includes(g)
      );
      if (undefinedGroups.length > 0) {
        issues.push(`GroupSequence references groups not found in constraint definitions: ${undefinedGroups.join(', ')} — sequence may never complete`);
      }
    }

    if (hasGroupSequence || isProvider) {
      results.push({
        file,
        class: className,
        sequenceGroups,
        isProvider,
        hasAttribute,
        issues,
      });
    }
  }

  return results;
}

export function listValidatorGroupSequence(appPath: string): McpToolResult {
  try {
    const infos = scanGroupSequence(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No GroupSequence or GroupSequenceProviderInterface usage found in src/.\n\nExample:\n  #[GroupSequenceProvider]\n  class User implements GroupSequenceProviderInterface\n  {\n    public function getGroupSequence(): GroupSequence { ... }\n  }',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Validator GroupSequence Analysis\n${'='.repeat(55)}\n\n`;
    text += `Total classes: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}  (${path.relative(appPath, info.file)})\n`;
      if (info.sequenceGroups.length > 0) {
        text += `    sequence groups: ${info.sequenceGroups.join(' -> ')}\n`;
      }
      text += `    isProvider: ${info.isProvider ? 'yes' : 'no'}  hasAttribute: ${info.hasAttribute ? 'yes' : 'no'}\n`;
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

export function getValidatorGroupSequenceStats(appPath: string): McpToolResult {
  try {
    const infos = scanGroupSequence(appPath);

    let text = `Validator GroupSequence Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes:                ${infos.length}\n`;
    text += `  GroupSequenceProvider:      ${infos.filter((i) => i.isProvider).length}\n`;
    text += `  With #[GroupSequenceProvider] attr: ${infos.filter((i) => i.hasAttribute).length}\n`;
    text += `  Single-group sequences:     ${infos.filter((i) => i.sequenceGroups.length === 1).length}\n`;
    text += `  Multi-group sequences:      ${infos.filter((i) => i.sequenceGroups.length > 1).length}\n`;
    text += `Total issues:                 ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getValidatorGroupSequenceTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_validator_group_sequence',
      description: 'Scan src/ for GroupSequence and GroupSequenceProviderInterface usage; warns on single-group sequences, missing #[GroupSequenceProvider] attribute, static providers, undefined group names in sequences',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_validator_group_sequence_stats',
      description: 'Statistics for GroupSequence usage: class count, provider count, attribute coverage, single vs multi-group sequences, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
