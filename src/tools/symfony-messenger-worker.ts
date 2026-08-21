import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface WorkerConfigInfo {
  file: string;
  type: 'supervisor' | 'systemd' | 'docker' | 'procfile' | 'makefile';
  transport: string;
  hasMemoryLimit: boolean;
  hasTimeLimit: boolean;
  hasLimit: boolean;
  memoryLimit?: string;
  issues: string[];
}

function readFileSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function extractTransportFromCommand(cmd: string): string {
  // messenger:consume transport1 transport2 --option
  const m = /messenger:consume\s+([\w\s]{1,200})(?:--|$)/.exec(cmd);
  if (!m) return 'unknown';
  const transports = m[1].trim().split(/\s{1,20}/).filter((t) => t.length > 0 && !t.startsWith('-'));
  return transports.join(', ') || 'unknown';
}

function buildWorkerIssues(
  hasMemoryLimit: boolean,
  hasTimeLimit: boolean,
  hasLimit: boolean,
  transport: string,
  allTransports: string[]
): string[] {
  const issues: string[] = [];
  if (!hasMemoryLimit) {
    issues.push(`No --memory-limit on worker consuming "${transport}" — PHP memory leak risk in long-lived worker`);
  }
  if (!hasTimeLimit) {
    issues.push(`No --time-limit on worker consuming "${transport}" — process accumulates memory indefinitely`);
  }
  if (hasLimit && !hasMemoryLimit) {
    issues.push(`--limit used without --memory-limit on "${transport}" — worker may exhaust memory before reaching limit`);
  }
  // Check for duplicate transport consumption
  const transportList = transport.split(',').map((t) => t.trim());
  for (const t of transportList) {
    if (allTransports.filter((at) => at.includes(t)).length > 1) {
      issues.push(`Transport "${t}" consumed by multiple worker definitions — check for message double-processing`);
      break;
    }
  }
  return issues;
}

function parseSupervisorFile(filePath: string, appPath: string): WorkerConfigInfo[] {
  const content = readFileSafe(filePath);
  if (!content.includes('messenger:consume')) return [];

  const results: WorkerConfigInfo[] = [];
  const lines = content.split('\n');
  let currentCmd = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^command\s*=/.test(trimmed)) {
      currentCmd = trimmed.replace(/^command\s*=\s*/, '');
    }
    if (currentCmd && currentCmd.includes('messenger:consume')) {
      const hasMemoryLimit = /--memory-limit/.test(currentCmd);
      const hasTimeLimit = /--time-limit/.test(currentCmd);
      const hasLimit = /(?:^|\s)--limit(?:\s|=)/.test(currentCmd);
      const memoryLimitM = /--memory-limit[=\s]([\w]{1,20})/.exec(currentCmd);
      const transport = extractTransportFromCommand(currentCmd);

      results.push({
        file: path.relative(appPath, filePath),
        type: 'supervisor',
        transport,
        hasMemoryLimit,
        hasTimeLimit,
        hasLimit,
        memoryLimit: memoryLimitM ? memoryLimitM[1] : undefined,
        issues: [],
      });
      currentCmd = '';
    }
  }
  return results;
}

function parseSystemdFile(filePath: string, appPath: string): WorkerConfigInfo[] {
  const content = readFileSafe(filePath);
  if (!content.includes('messenger:consume')) return [];

  const results: WorkerConfigInfo[] = [];
  const execStartM = /ExecStart[^=]{0,10}=(.{0,500})/.exec(content);
  if (!execStartM) return results;

  const cmd = execStartM[1].trim();
  const hasMemoryLimit = /--memory-limit/.test(cmd);
  const hasTimeLimit = /--time-limit/.test(cmd);
  const hasLimit = /(?:^|\s)--limit(?:\s|=)/.test(cmd);
  const memoryLimitM = /--memory-limit[=\s]([\w]{1,20})/.exec(cmd);
  const transport = extractTransportFromCommand(cmd);

  results.push({
    file: path.relative(appPath, filePath),
    type: 'systemd',
    transport,
    hasMemoryLimit,
    hasTimeLimit,
    hasLimit,
    memoryLimit: memoryLimitM ? memoryLimitM[1] : undefined,
    issues: [],
  });
  return results;
}

function parseDockerComposeFile(filePath: string, appPath: string): WorkerConfigInfo[] {
  const content = readFileSafe(filePath);
  if (!content.includes('messenger:consume')) return [];

  const results: WorkerConfigInfo[] = [];
  // Match command lines that contain messenger:consume
  const cmdRegex = /command\s*:\s*([^\n]{1,500})/g;
  let m: RegExpExecArray | null;
  while ((m = cmdRegex.exec(content)) !== null) {
    const cmd = m[1];
    if (!cmd.includes('messenger:consume')) continue;

    const hasMemoryLimit = /--memory-limit/.test(cmd);
    const hasTimeLimit = /--time-limit/.test(cmd);
    const hasLimit = /(?:^|\s)--limit(?:\s|=)/.test(cmd);
    const memoryLimitM = /--memory-limit[=\s]([\w]{1,20})/.exec(cmd);
    const transport = extractTransportFromCommand(cmd);

    results.push({
      file: path.relative(appPath, filePath),
      type: 'docker',
      transport,
      hasMemoryLimit,
      hasTimeLimit,
      hasLimit,
      memoryLimit: memoryLimitM ? memoryLimitM[1] : undefined,
      issues: [],
    });
  }
  return results;
}

function parseProcfile(filePath: string, appPath: string): WorkerConfigInfo[] {
  const content = readFileSafe(filePath);
  if (!content.includes('messenger:consume')) return [];

  const results: WorkerConfigInfo[] = [];
  for (const line of content.split('\n')) {
    if (!line.includes('messenger:consume')) continue;
    const cmd = line.replace(/^[\w]+:\s*/, '');
    const hasMemoryLimit = /--memory-limit/.test(cmd);
    const hasTimeLimit = /--time-limit/.test(cmd);
    const hasLimit = /(?:^|\s)--limit(?:\s|=)/.test(cmd);
    const memoryLimitM = /--memory-limit[=\s]([\w]{1,20})/.exec(cmd);
    const transport = extractTransportFromCommand(cmd);

    results.push({
      file: path.relative(appPath, filePath),
      type: 'procfile',
      transport,
      hasMemoryLimit,
      hasTimeLimit,
      hasLimit,
      memoryLimit: memoryLimitM ? memoryLimitM[1] : undefined,
      issues: [],
    });
  }
  return results;
}

function parseMakefile(filePath: string, appPath: string): WorkerConfigInfo[] {
  const content = readFileSafe(filePath);
  if (!content.includes('messenger:consume')) return [];

  const results: WorkerConfigInfo[] = [];
  for (const line of content.split('\n')) {
    if (!line.includes('messenger:consume')) continue;
    const hasMemoryLimit = /--memory-limit/.test(line);
    const hasTimeLimit = /--time-limit/.test(line);
    const hasLimit = /(?:^|\s)--limit(?:\s|=)/.test(line);
    const memoryLimitM = /--memory-limit[=\s]([\w]{1,20})/.exec(line);
    const transport = extractTransportFromCommand(line);

    results.push({
      file: path.relative(appPath, filePath),
      type: 'makefile',
      transport,
      hasMemoryLimit,
      hasTimeLimit,
      hasLimit,
      memoryLimit: memoryLimitM ? memoryLimitM[1] : undefined,
      issues: [],
    });
  }
  return results;
}

function loadWorkerConfigs(appPath: string): WorkerConfigInfo[] {
  const workers: WorkerConfigInfo[] = [];

  // Scan project root for config files
  let rootEntries: fs.Dirent[] = [];
  try { rootEntries = fs.readdirSync(appPath, { withFileTypes: true }); } catch { /* skip */ }

  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    const full = path.join(appPath, entry.name);
    const name = entry.name.toLowerCase();

    if (name.endsWith('.conf') || name === 'supervisord.conf') {
      workers.push(...parseSupervisorFile(full, appPath));
    } else if (name.endsWith('.service')) {
      workers.push(...parseSystemdFile(full, appPath));
    } else if (name === 'docker-compose.yml' || name === 'docker-compose.yaml') {
      workers.push(...parseDockerComposeFile(full, appPath));
    } else if (name === 'procfile') {
      workers.push(...parseProcfile(full, appPath));
    } else if (name === 'makefile') {
      workers.push(...parseMakefile(full, appPath));
    }
  }

  // Also scan common subdirectories for supervisor/systemd configs
  const configDirs = ['docker', 'config', '.deploy', 'deploy', 'infra'];
  for (const dir of configDirs) {
    const dirPath = path.join(appPath, dir);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(dirPath, entry.name);
      const name = entry.name.toLowerCase();

      if (name.endsWith('.conf') || name.endsWith('.service')) {
        const content = readFileSafe(full);
        if (!content.includes('messenger:consume')) continue;
        if (name.endsWith('.conf')) workers.push(...parseSupervisorFile(full, appPath));
        else workers.push(...parseSystemdFile(full, appPath));
      }
    }
  }

  // Add issues with duplicate transport awareness
  const allTransports = workers.map((w) => w.transport);
  for (const worker of workers) {
    worker.issues = buildWorkerIssues(
      worker.hasMemoryLimit,
      worker.hasTimeLimit,
      worker.hasLimit,
      worker.transport,
      allTransports
    );
  }

  return workers;
}

export function listMessengerWorkerConfig(appPath: string): McpToolResult {
  try {
    const workers = loadWorkerConfigs(appPath);
    if (workers.length === 0) {
      return { content: [{ type: 'text', text: 'No messenger:consume worker configurations found.\n\nChecked: *.conf, supervisord.conf, *.service, docker-compose.yml, Procfile, Makefile in project root and docker/config/deploy directories.' }] };
    }

    const totalIssues = workers.reduce((s, w) => s + w.issues.length, 0);
    let text = `Messenger Worker Configurations\n${'='.repeat(55)}\n\nWorkers: ${workers.length}  Issues: ${totalIssues}\n`;

    for (const w of workers.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [
        w.hasMemoryLimit ? `--memory-limit${w.memoryLimit ? `=${w.memoryLimit}` : ''}` : '',
        w.hasTimeLimit ? '--time-limit' : '',
        w.hasLimit ? '--limit' : '',
      ].filter(Boolean).join(', ');

      text += `\n  ${w.file}  [${w.type}]\n`;
      text += `    transport: ${w.transport}\n`;
      text += `    flags: ${flags || 'none'}\n`;
      for (const issue of w.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerWorkerStats(appPath: string): McpToolResult {
  try {
    const workers = loadWorkerConfigs(appPath);

    const byType = new Map<string, number>();
    for (const w of workers) byType.set(w.type, (byType.get(w.type) ?? 0) + 1);

    let text = `Messenger Worker Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total workers:         ${workers.length}\n`;
    for (const [type, count] of byType.entries()) text += `  ${type}: ${count}\n`;
    text += `With --memory-limit:   ${workers.filter((w) => w.hasMemoryLimit).length}\n`;
    text += `With --time-limit:     ${workers.filter((w) => w.hasTimeLimit).length}\n`;
    text += `With --limit only:     ${workers.filter((w) => w.hasLimit && !w.hasMemoryLimit).length}\n`;
    text += `Issues:                ${workers.reduce((s, w) => s + w.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerWorkerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_messenger_worker_config',
      description: 'Show messenger:consume worker configs from supervisor/systemd/docker-compose/Procfile/Makefile: transport, --memory-limit, --time-limit, --limit flags; warns on missing --memory-limit, missing --time-limit, --limit without --memory-limit, duplicate transport consumption',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_messenger_worker_stats',
      description: 'Show messenger worker statistics: total workers, count by type (supervisor/systemd/docker/procfile/makefile), memory-limit/time-limit coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
