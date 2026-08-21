import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskDsn(dsn: string): string {
  return dsn
    .replace(/:\/\/[^@\s]{1,200}@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret|key)=[^&\s]*/gi, '$1$2=***');
}

interface ReadReplicaInfo {
  source: string;
  type: 'connection' | 'usage' | 'config';
  directive: string;
  value: string;
  issues: string[];
}

function buildReadReplicaInfos(appPath: string): ReadReplicaInfo[] {
  const results: ReadReplicaInfo[] = [];

  const doctrineYaml = path.join(appPath, 'config', 'packages', 'doctrine.yaml');
  if (fs.existsSync(doctrineYaml)) {
    const cfg = parseYamlFile(doctrineYaml) as Record<string, unknown> | null;
    if (cfg) {
      const doctrine = (cfg['doctrine'] ?? {}) as Record<string, unknown>;
      const dbal = (doctrine['dbal'] ?? {}) as Record<string, unknown>;
      const connections = (dbal['connections'] ?? {}) as Record<string, unknown>;
      const defaultConn = (dbal['default_connection'] ?? 'default') as string;

      for (const [connName, connCfg] of Object.entries(connections)) {
        const conn = connCfg as Record<string, unknown>;
        const hasSlaves = conn['slaves'] || conn['replicas'] || conn['read'] || conn['replica'];
        const hasMaster = conn['master'] || conn['primary'] || conn['write'];
        const url = String(conn['url'] ?? conn['dsn'] ?? '');
        const issues: string[] = [];

        if (hasSlaves || hasMaster) {
          const replicaCfg = (conn['slaves'] ?? conn['replicas'] ?? conn['replica'] ?? {}) as Record<string, unknown>;
          const replicaCount = Object.keys(replicaCfg).length;

          if (replicaCount === 0) {
            issues.push(`Connection "${connName}" has replica config key but no replicas defined — add at least one slave/replica entry or remove the empty configuration`);
          }

          const keepSlave = conn['keep_slave'] ?? conn['keep_replica'];
          if (!keepSlave) {
            issues.push(`Connection "${connName}" with replicas: keep_slave/keep_replica not set — Doctrine may re-pick a different replica per query; set keep_slave: true for sticky read connections`);
          }

          results.push({ source: 'doctrine.yaml', type: 'connection', directive: `${connName} replica config`, value: `${replicaCount} replicas`, issues });
        } else if (connName === defaultConn && url && !url.includes('localhost')) {
          issues.push(`Connection "${connName}" uses single host without read replica setup — for high-read workloads, configure Doctrine DBAL replica connections to distribute SELECT queries to read replicas`);
          results.push({ source: 'doctrine.yaml', type: 'connection', directive: `${connName} single host`, value: 'no replica', issues });
        }
      }

      const defaultDsn = String(dbal['url'] ?? dbal['dsn'] ?? '');
      if (Object.keys(connections).length === 0 && defaultDsn) {
        results.push({ source: 'doctrine.yaml', type: 'config', directive: 'dbal.url single connection', value: maskDsn(defaultDsn).substring(0, 40), issues: ['Single DBAL connection without replica configuration — consider adding slaves/replicas for read scalability'] });
      }
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            if (!content.includes('getConnection') && !content.includes('createQueryBuilder')) return;

            const relFile = path.relative(appPath, full);
            const hasForceMaster = content.includes('getWrappedConnection') || content.includes('connect(') || content.includes('forceConnect');
            if (hasForceMaster) {
              results.push({ source: relFile, type: 'usage', directive: 'forced master connection', value: 'force connect', issues: ['Forced master connection in "' + relFile + '" — this bypasses replica routing; ensure this is intentional (writes) and not used for reads'] });
            }
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listDoctrineReadReplica(appPath: string): McpToolResult {
  try {
    const infos = buildReadReplicaInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No read replica configuration patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Read Replica Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineReadReplicaStats(appPath: string): McpToolResult {
  try {
    const infos = buildReadReplicaInfos(appPath);
    let text = `Doctrine Read Replica Statistics\n${'='.repeat(40)}\n\n`;
    text += `Connections: ${infos.filter((i) => i.type === 'connection').length}\n`;
    text += `Usage sites: ${infos.filter((i) => i.type === 'usage').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineReadReplicaTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_read_replica', description: 'Analyze Doctrine DBAL read replica configuration; warns on empty replica config, missing keep_slave/keep_replica, single connection without replicas for high-read workloads, forced master connections for reads', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_read_replica_stats', description: 'Statistics for read replica config: connection/usage count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
