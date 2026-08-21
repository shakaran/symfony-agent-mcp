import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface AnsiblePlaybookInfo {
  source: string;
  type: 'injection' | 'privilege' | 'secret' | 'nolog' | 'facts' | 'errors';
  detail: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecrets(value: string): string {
  return value.replace(/(password|secret|token|key|passwd|pwd|pass|auth|credential|api_key|private_key|cert)\s*:\s*\S+/gi, '$1: ***');
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function analyzePlaybookContent(content: string, source: string, _appPath: string): AnsiblePlaybookInfo[] {
  const results: AnsiblePlaybookInfo[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const ref = `${source}:${lineNum}`;

    // shell: or command: with hostvars/vars variables without | quote filter (injection risk)
    if (/^\s*(shell|command)\s*:/.test(line)) {
      const contextEnd = Math.min(lines.length - 1, i + 5);
      const context = lines.slice(i, contextEnd + 1).join('\n');
      const hasVarRef = /\{\{[^}]*(?:hostvars|vars|item|inventory_hostname)[^}]*\}\}/.test(context);
      const hasQuoteFilter = /\|\s*quote/.test(context);
      if (hasVarRef && !hasQuoteFilter) {
        results.push({
          source: ref,
          type: 'injection',
          detail: `Shell/command task uses variable reference without | quote filter`,
          issue: `shell/command task at ${ref} uses {{ hostvars/vars }} variable without | quote filter — unquoted variables allow shell injection; add | quote to all variable references in shell/command tasks`,
        });
      } else {
        results.push({ source: ref, type: 'injection', detail: 'shell/command task detected', issue: null });
      }
    }

    // become: true tasks without become_user specified
    if (/^\s*become\s*:\s*(?:yes|true)/.test(line)) {
      const contextStart = Math.max(0, i - 5);
      const contextEnd = Math.min(lines.length - 1, i + 5);
      const context = lines.slice(contextStart, contextEnd + 1).join('\n');
      const hasBecomeUser = /become_user\s*:/.test(context);
      results.push({
        source: ref,
        type: 'privilege',
        detail: `become: true at ${ref}`,
        issue: hasBecomeUser ? null : `become: true at ${ref} without become_user — defaults to root; specify become_user to run as a least-privilege user instead`,
      });
    }

    // Secrets/passwords in vars: section — mask values
    if (/^\s*vars\s*:/.test(line)) {
      const contextEnd = Math.min(lines.length - 1, i + 30);
      for (let j = i + 1; j <= contextEnd; j++) {
        const varLine = lines[j];
        if (/^\s*(password|secret|token|key|passwd|pwd|pass|auth|credential|api_key|private_key|cert)\s*:/i.test(varLine) && !/vault_/.test(varLine)) {
          const masked = maskSecrets(varLine.trim());
          results.push({
            source: `${source}:${j + 1}`,
            type: 'secret',
            detail: `Plaintext secret in vars: — ${masked}`,
            issue: `Secret variable found in vars: block at ${source}:${j + 1} — store secrets in Ansible Vault (ansible-vault encrypt_string) and reference via vault_ prefixed vars, not plaintext`,
          });
        }
        if (/^\s*(?:\w+\s*:|[- ]+name)/.test(varLine) && j > i + 1) break;
      }
    }

    // Missing no_log: true on tasks that print credentials
    if (/^\s*name\s*:.*(?:password|secret|token|credential|auth|login)/i.test(line)) {
      const contextEnd = Math.min(lines.length - 1, i + 15);
      const context = lines.slice(i, contextEnd + 1).join('\n');
      const hasNoLog = /no_log\s*:\s*(?:yes|true)/.test(context);
      if (!hasNoLog) {
        results.push({
          source: ref,
          type: 'nolog',
          detail: `Task handling credentials at ${ref}`,
          issue: `Task "${line.trim()}" at ${ref} handles credentials but lacks no_log: true — add no_log: true to prevent credential values from appearing in Ansible output logs`,
        });
      }
    }

    // gather_facts: true on tasks that don't need facts
    if (/^\s*gather_facts\s*:\s*(?:yes|true)/.test(line)) {
      results.push({
        source: ref,
        type: 'facts',
        detail: `gather_facts: true at ${ref}`,
        issue: `gather_facts: true at ${ref} — if this play doesn't use ansible_facts variables, set gather_facts: false to avoid performance overhead and reduce information disclosure in logs`,
      });
    }

    // ignore_errors: true on critical tasks
    if (/^\s*ignore_errors\s*:\s*(?:yes|true)/.test(line)) {
      results.push({
        source: ref,
        type: 'errors',
        detail: `ignore_errors: true at ${ref}`,
        issue: `ignore_errors: true at ${ref} — silently ignoring errors on tasks can hide critical failures; use failed_when with explicit conditions or block/rescue instead`,
      });
    }
  }

  return results;
}

function buildAnsiblePlaybookConfigInfos(appPath: string): AnsiblePlaybookInfo[] {
  const results: AnsiblePlaybookInfo[] = [];
  const searchDirs: string[] = [appPath];

  // Add playbooks/ and ansible/ subdirectories
  for (const subdir of ['playbooks', 'ansible', 'deploy', 'provision']) {
    const d = path.join(appPath, subdir);
    if (fs.existsSync(d)) searchDirs.push(d);
  }

  for (const dir of searchDirs) {
    const yamlFiles = [
      ...scanDirRecursive(dir, '.yml'),
      ...scanDirRecursive(dir, '.yaml'),
    ];
    for (const fpath of yamlFiles) {
      const content = safeRead(fpath, appPath);
      if (!content) continue;
      // Only analyze files that look like Ansible playbooks/tasks
      if (
        !content.includes('hosts:') &&
        !content.includes('tasks:') &&
        !content.includes('become:') &&
        !content.includes('gather_facts:') &&
        !content.includes('- name:')
      ) continue;
      const relFile = path.relative(appPath, fpath);
      results.push(...analyzePlaybookContent(content, relFile, appPath));
    }
  }

  return results;
}

export function listAnsiblePlaybookConfig(appPath: string): McpToolResult {
  try {
    const infos = buildAnsiblePlaybookConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Ansible playbook configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Ansible Playbook Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  ${info.source}\n`;
      text += `    ${info.detail}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAnsiblePlaybookConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildAnsiblePlaybookConfigInfos(appPath);
    let text = `Ansible Playbook Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Injection risks:  ${infos.filter((i) => i.type === 'injection').length}\n`;
    text += `Privilege issues: ${infos.filter((i) => i.type === 'privilege').length}\n`;
    text += `Secret exposure:  ${infos.filter((i) => i.type === 'secret').length}\n`;
    text += `Missing no_log:   ${infos.filter((i) => i.type === 'nolog').length}\n`;
    text += `Facts overhead:   ${infos.filter((i) => i.type === 'facts').length}\n`;
    text += `Error ignoring:   ${infos.filter((i) => i.type === 'errors').length}\n`;
    text += `Total issues:     ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAnsiblePlaybookConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_ansible_playbook_config',
      description: 'Scan *.yml/*.yaml, playbooks/, ansible/ for Ansible playbook security issues: shell/command tasks with hostvars/vars variables missing | quote filter (injection), become: true without become_user (defaults to root), plaintext secrets in vars: block (masked), missing no_log: true on credential tasks, gather_facts: true unnecessarily, ignore_errors: true on critical tasks.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_ansible_playbook_config_stats',
      description: 'Statistics for Ansible playbook configuration: injection/privilege/secret/nolog/facts/errors issue counts.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
