import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface AccessDecisionInfo {
  strategy: string;
  allowIfAllAbstain: boolean;
  allowIfEqualGrantedDenied: boolean;
  voterCount: number;
  hasCustomManager: boolean;
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

function scanVoters(appPath: string): { voterCount: number; hasCustomManager: boolean } {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { voterCount: 0, hasCustomManager: false };

  let voterCount = 0;
  let hasCustomManager = false;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    if (content.includes('VoterInterface') || content.includes('extends Voter') || content.includes('AbstractVoter')) {
      voterCount++;
    }
    if (content.includes('AccessDecisionManagerInterface') && content.includes('implements')) {
      hasCustomManager = true;
    }
  }

  return { voterCount, hasCustomManager };
}

function loadAccessDecisionConfig(appPath: string): AccessDecisionInfo {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const admRaw = (security['access_decision_manager'] ?? {}) as Record<string, unknown>;

    const strategy = admRaw['strategy'] ? String(admRaw['strategy']) : 'affirmative';
    const allowIfAllAbstain = admRaw['allow_if_all_abstain'] === true || admRaw['allow_if_all_abstain'] === 'true';
    const allowIfEqualGrantedDenied = admRaw['allow_if_equal_granted_denied'] !== false;

    const { voterCount, hasCustomManager } = scanVoters(appPath);

    const issues: string[] = [];
    if (strategy === 'unanimous' && voterCount > 5) {
      issues.push(`unanimous strategy with ${voterCount} voters — any voter abstaining can cause unexpected denials`);
    }
    if (strategy === 'affirmative') {
      issues.push('affirmative strategy: first granting voter wins — verify no permissive voters run before security-critical ones');
    }
    if (strategy === 'consensus' && voterCount > 10) {
      issues.push(`consensus strategy with ${voterCount} voters — may have performance impact on each authorization check`);
    }
    if (allowIfAllAbstain) {
      issues.push('allow_if_all_abstain: true — access granted when all voters abstain; risky default for security-sensitive resources');
    }

    return { strategy, allowIfAllAbstain, allowIfEqualGrantedDenied, voterCount, hasCustomManager, issues };
  }

  const { voterCount, hasCustomManager } = scanVoters(appPath);
  return {
    strategy: 'affirmative',
    allowIfAllAbstain: false,
    allowIfEqualGrantedDenied: true,
    voterCount,
    hasCustomManager,
    issues: [],
  };
}

export function listAccessDecisionConfig(appPath: string): McpToolResult {
  try {
    const info = loadAccessDecisionConfig(appPath);

    let text = `Access Decision Manager Configuration\n${'='.repeat(55)}\n\n`;
    text += `Strategy:                    ${info.strategy}\n`;
    text += `allow_if_all_abstain:        ${info.allowIfAllAbstain}\n`;
    text += `allow_if_equal_granted_denied: ${info.allowIfEqualGrantedDenied}\n`;
    text += `Custom voters detected:      ${info.voterCount}\n`;
    text += `Custom ADM implementation:   ${info.hasCustomManager ? 'yes' : 'no'}\n`;

    if (info.issues.length > 0) {
      text += `\nIssues (${info.issues.length}):\n`;
      for (const issue of info.issues) text += `  ⚠ ${issue}\n`;
    } else {
      text += `\nNo issues detected.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAccessDecisionStats(appPath: string): McpToolResult {
  try {
    const info = loadAccessDecisionConfig(appPath);

    let text = `Access Decision Statistics\n${'='.repeat(40)}\n\n`;
    text += `Strategy:               ${info.strategy}\n`;
    text += `Voter count:            ${info.voterCount}\n`;
    text += `Custom manager:         ${info.hasCustomManager ? 'yes' : 'no'}\n`;
    text += `allow_if_all_abstain:   ${info.allowIfAllAbstain}\n`;
    text += `Issues:                 ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAccessDecisionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_access_decision',
      description: 'Show access_decision_manager config: strategy (affirmative/consensus/unanimous/priority), allow_if_all_abstain, allow_if_equal_granted_denied; warns on unanimous with many voters, affirmative first-grant risk, consensus performance, allow_if_all_abstain:true',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_security_access_decision_stats',
      description: 'Show access decision statistics: strategy, voter count, custom manager presence, allow_if_all_abstain setting, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
