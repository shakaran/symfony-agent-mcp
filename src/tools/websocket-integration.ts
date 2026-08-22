import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface WebsocketIntegrationInfo {
  source: string;
  type: 'server' | 'auth' | 'origin' | 'rate-limit' | 'mercure';
  pattern: string;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildWebsocketIntegrationInfos(appPath: string): WebsocketIntegrationInfo[] {
  const results: WebsocketIntegrationInfo[] = [];

  // 1. Check composer.json for WebSocket packages
  const composerPath = path.join(appPath, 'composer.json');
  let hasRatchet = false;
  if (fs.existsSync(composerPath)) {
    let content = '';
    try { content = fs.readFileSync(composerPath, 'utf-8'); } catch { /* skip */ }

    if (content.includes('cboden/ratchet')) {
      hasRatchet = true;
      results.push({ source: 'composer.json', type: 'server', pattern: 'cboden/ratchet WebSocket server', issues: [] });
    }

    if (content.includes('react/socket') || content.includes('reactphp/event-loop')) {
      results.push({ source: 'composer.json', type: 'server', pattern: 'ReactPHP socket/event-loop', issues: [] });
    }

    if (content.includes('symfony/mercure')) {
      results.push({ source: 'composer.json', type: 'mercure', pattern: 'symfony/mercure package', issues: [] });
    }
  }

  // 2. Check Ratchet server files in src/
  if (hasRatchet) {
    const srcDir = path.join(appPath, 'src');
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        let content = '';
        try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
        const relPath = path.relative(appPath, file);

        // MessageComponentInterface implementations
        if (/MessageComponentInterface/.test(content)) {
          results.push({ source: relPath, type: 'server', pattern: 'MessageComponentInterface implementation', issues: [] });

          // onOpen without auth check
          const onOpenMatch = content.match(/function\s+onOpen\s*\([^)]*\)[^{]*\{([\s\S]{0,500})/);
          if (onOpenMatch) {
            const onOpenBody = onOpenMatch[1];
            if (!/jwt|token|auth|session|getHeader|cookie/i.test(onOpenBody)) {
              results.push({
                source: relPath,
                type: 'auth',
                pattern: 'onOpen without authentication check',
                issues: ['Ratchet WebSocket onOpen without authentication — verify JWT token or session in onOpen() to prevent unauthorized connections'],
              });
            }

            // No origin check
            if (!/Origin|getHeader\s*\(\s*['"]Origin/i.test(onOpenBody)) {
              results.push({
                source: relPath,
                type: 'origin',
                pattern: 'onOpen without origin validation',
                issues: ["WebSocket server without origin validation — check $conn->httpRequest->getHeader('Origin') against an allowlist to prevent cross-origin WebSocket abuse"],
              });
            }
          }
        }
      }
    }
  }

  // 3. Check Mercure config
  const mercurePaths = [
    path.join(appPath, 'config', 'packages', 'mercure.yaml'),
    path.join(appPath, 'config', 'mercure.yaml'),
  ];
  for (const mPath of mercurePaths) {
    if (!fs.existsSync(mPath)) continue;
    let content = '';
    try { content = fs.readFileSync(mPath, 'utf-8'); } catch { continue; }
    const relPath = path.relative(appPath, mPath);

    results.push({ source: relPath, type: 'mercure', pattern: 'Mercure hub configured', issues: [] });

    // Hardcoded JWT secret
    if (/jwt_secret:\s*['"]\w+['"]/i.test(content) && !/%env\(/.test(content)) {
      results.push({
        source: relPath,
        type: 'mercure',
        pattern: 'Hardcoded Mercure JWT secret',
        issues: ['Mercure JWT secret hardcoded in config — use %env(MERCURE_JWT_SECRET)% to load from environment variable'],
      });
    }

    // Missing subscriber topics restriction
    if (!/subscribe:|allowed_origins:|topics:/i.test(content)) {
      results.push({
        source: relPath,
        type: 'mercure',
        pattern: 'No subscriber topic restriction',
        issues: ['Mercure hub without topic restriction — ensure subscribers can only subscribe to topics they are authorized to access'],
      });
    }
    break;
  }

  // 4. Check nginx.conf for WebSocket proxy
  const nginxPaths = [
    path.join(appPath, 'nginx.conf'),
    path.join(appPath, 'docker', 'nginx.conf'),
    path.join(appPath, 'config', 'nginx.conf'),
  ];
  for (const nPath of nginxPaths) {
    if (!fs.existsSync(nPath)) continue;
    let content = '';
    try { content = fs.readFileSync(nPath, 'utf-8'); } catch { continue; }
    if (/proxy_pass/.test(content) && /Upgrade|websocket/i.test(content)) {
      results.push({
        source: path.relative(appPath, nPath),
        type: 'server',
        pattern: 'Nginx WebSocket proxy configured',
        issues: [],
      });
    }
    break;
  }

  return results;
}

export function listWebsocketIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildWebsocketIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No WebSocket integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `WebSocket Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getWebsocketIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildWebsocketIntegrationInfos(appPath);
    let text = `WebSocket Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Server:     ${infos.filter((i) => i.type === 'server').length}\n`;
    text += `Auth:       ${infos.filter((i) => i.type === 'auth').length}\n`;
    text += `Origin:     ${infos.filter((i) => i.type === 'origin').length}\n`;
    text += `Rate-limit: ${infos.filter((i) => i.type === 'rate-limit').length}\n`;
    text += `Mercure:    ${infos.filter((i) => i.type === 'mercure').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getWebsocketIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_websocket_integration',
      description: 'Analyse WebSocket integration: Ratchet/ReactPHP server setup, missing authentication in onOpen, missing origin validation, Mercure hub JWT secrets and topic restrictions, Nginx WebSocket proxy',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_websocket_integration_stats',
      description: 'Statistics for WebSocket integration: counts by type (server/auth/origin/rate-limit/mercure) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
