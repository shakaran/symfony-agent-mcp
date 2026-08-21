import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface DbalPoolConfig {
  connectionName: string;
  driver: string;
  persistent: boolean;
  poolSize?: number;
  connectTimeout?: number;
  driverOptions: Record<string, unknown>;
  issues: string[];
}

function loadDbalPoolConfigs(appPath: string): DbalPoolConfig[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'doctrine.yaml'),
  ];
  const configs: DbalPoolConfig[] = [];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
    const dbal = (doctrine['dbal'] ?? {}) as Record<string, unknown>;
    const processConn = (name: string, d: Record<string, unknown>): void => {
      const driver = String(d['driver'] ?? d['url'] ?? 'unknown');
      const driverOptions = (d['options'] ?? d['driverOptions'] ?? {}) as Record<string, unknown>;
      const persistent = Boolean(driverOptions[20] ?? driverOptions['PDO::ATTR_PERSISTENT'] ?? driverOptions['persistent'] ?? false);
      const connectTimeout = typeof driverOptions['connect_timeout'] !== 'undefined' ? Number(driverOptions['connect_timeout']) : undefined;
      const issues: string[] = [];
      if (persistent) issues.push('PDO::ATTR_PERSISTENT=true — persistent connections can cause connection leaks in PHP-FPM environments');
      if (!connectTimeout) issues.push('No connect_timeout configured — slow DB server may hang workers indefinitely');
      const dsn = String(d['url'] ?? d['dsn'] ?? '');
      if (dsn.includes('poolSize=') || dsn.includes('pool_size=')) {
        const poolSizeM = /pool[_]?size=(\d+)/i.exec(dsn);
        const poolSize = poolSizeM ? parseInt(poolSizeM[1], 10) : undefined;
        configs.push({ connectionName: name, driver, persistent, poolSize, connectTimeout, driverOptions, issues });
      } else {
        configs.push({ connectionName: name, driver, persistent, connectTimeout, driverOptions, issues });
      }
    };
    if (dbal['connections']) {
      const conns = (dbal['connections'] ?? {}) as Record<string, unknown>;
      for (const [name, def] of Object.entries(conns)) {
        processConn(name, (def ?? {}) as Record<string, unknown>);
      }
    } else {
      processConn('default', dbal);
    }
  }
  return configs;
}

export function listDbalConnectionPool(appPath: string): McpToolResult {
  try {
    const configs = loadDbalPoolConfigs(appPath);
    if (configs.length === 0) return { content: [{ type: 'text', text: 'No DBAL connection configuration found.' }] };
    const totalIssues = configs.reduce((s, c) => s + c.issues.length, 0);
    let text = `DBAL Connection Pool\n${'='.repeat(55)}\n\nConnections: ${configs.length}  Issues: ${totalIssues}\n`;
    for (const c of configs.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${c.connectionName}  driver: ${c.driver}  persistent: ${c.persistent ? 'YES' : 'no'}  timeout: ${c.connectTimeout ?? 'none'}s\n`;
      const opts = Object.keys(c.driverOptions);
      if (opts.length > 0) text += `    driverOptions: ${opts.slice(0, 5).join(', ')}${opts.length > 5 ? ` +${opts.length - 5} more` : ''}\n`;
      for (const i of c.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDbalConnectionPoolStats(appPath: string): McpToolResult {
  try {
    const configs = loadDbalPoolConfigs(appPath);
    let text = `DBAL Connection Statistics\n${'='.repeat(40)}\n\n`;
    text += `Connections: ${configs.length}\n  Persistent: ${configs.filter(c => c.persistent).length}\n  With connect_timeout: ${configs.filter(c => c.connectTimeout).length}\n  With pool_size: ${configs.filter(c => c.poolSize).length}\nIssues: ${configs.reduce((s, c) => s + c.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDbalConnectionPoolTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_dbal_connection_pool', description: 'Analyze DBAL connection options: PDO::ATTR_PERSISTENT (PHP-FPM leak risk), connect_timeout, pool_size, driver options from doctrine.yaml', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_dbal_connection_pool_stats', description: 'DBAL connection statistics: connection count, persistent count, timeout/pool_size coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
