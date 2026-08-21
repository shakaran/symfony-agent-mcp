import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface GraphqlSecurityInfo {
  source: string;
  type: 'introspection' | 'depth-limit' | 'complexity' | 'n+1' | 'auth' | 'subscription';
  pattern: string;
  issues: string[];
}

function buildApiGraphqlSecurityInfos(appPath: string): GraphqlSecurityInfo[] {
  const results: GraphqlSecurityInfo[] = [];

  const apiPlatformConfig = path.join(appPath, 'config', 'packages', 'api_platform.yaml');
  if (fs.existsSync(apiPlatformConfig)) {
    let content = '';
    try { content = fs.readFileSync(apiPlatformConfig, 'utf-8'); } catch { /* skip */ }

    const hasGraphql = content.includes('graphql:') || content.includes('graphql_enabled') || content.includes('enable_graphql');
    if (hasGraphql) {
      const introspectionDisabled = content.includes('introspection: false') || content.includes('introspection:false');
      if (!introspectionDisabled) {
        results.push({
          source: 'config/packages/api_platform.yaml',
          type: 'introspection',
          pattern: 'GraphQL introspection possibly enabled',
          issues: [
            'GraphQL introspection enabled in production — exposes your full schema to attackers; disable with graphql: introspection: false in prod',
          ],
        });
      }

      const hasDepthLimit = content.includes('depth_limit') || content.includes('max_depth');
      if (!hasDepthLimit) {
        results.push({
          source: 'config/packages/api_platform.yaml',
          type: 'depth-limit',
          pattern: 'GraphQL without depth limiting',
          issues: [
            'No GraphQL query depth limiting — nested queries can cause exponential DB load; add depth_limit configuration',
          ],
        });
      }

      const hasComplexity = content.includes('max_complexity') || content.includes('complexity');
      if (!hasComplexity) {
        results.push({
          source: 'config/packages/api_platform.yaml',
          type: 'complexity',
          pattern: 'GraphQL without complexity limiting',
          issues: [
            'No GraphQL query complexity limiting — complex queries can DoS your API; add max_complexity configuration',
          ],
        });
      }
    }
  }

  const composerJson = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerJson)) {
    let content = '';
    try { content = fs.readFileSync(composerJson, 'utf-8'); } catch { /* skip */ }

    const hasGraphqlDep = content.includes('webonyx/graphql-php') || content.includes('api-platform/graphql');
    if (hasGraphqlDep) {
      let hasSecurityConfig = false;
      try {
        const apiPlatformContent = fs.existsSync(apiPlatformConfig)
          ? fs.readFileSync(apiPlatformConfig, 'utf-8')
          : '';
        hasSecurityConfig = apiPlatformContent.includes('graphql:') &&
          (apiPlatformContent.includes('security') || apiPlatformContent.includes('introspection'));
      } catch { /* skip */ }

      if (!hasSecurityConfig) {
        results.push({
          source: 'composer.json',
          type: 'introspection',
          pattern: 'GraphQL dependency without security configuration',
          issues: [
            'GraphQL package installed but no security configuration found in api_platform.yaml — configure introspection, depth limiting, and complexity limits',
          ],
        });
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
            const content = safeRead(full, appPath);
            if (content === null) return;

            const relFile = path.relative(appPath, full);

            if (content.includes('DataLoader') || content.includes('BatchLoader') || content.includes('BatchCollectionLoader')) {
              results.push({
                source: relFile,
                type: 'n+1',
                pattern: 'DataLoader pattern in GraphQL resolver',
                issues: [],
              });
            } else if (
              (content.includes('Resolver') || content.includes('resolver')) &&
              (content.includes('->findBy(') || content.includes('->find(') || content.includes('->getRepository(')) &&
              !content.includes('join(') && !content.includes('JOIN')
            ) {
              results.push({
                source: relFile,
                type: 'n+1',
                pattern: 'direct ORM query in GraphQL resolver',
                issues: [
                  "GraphQL resolver with direct ORM query — each field resolved individually causes N+1 queries; use DataLoader pattern or Doctrine's join fetching",
                ],
              });
            }

            if (
              content.includes('#[ApiResource') &&
              (content.includes('mutation') || content.includes('Mutation')) &&
              !content.includes('security:') && !content.includes('security =')
            ) {
              results.push({
                source: relFile,
                type: 'auth',
                pattern: 'GraphQL mutation without security attribute',
                issues: [
                  "GraphQL mutation without security attribute — add security: 'is_granted(\"ROLE_USER\")' to restrict mutations to authenticated users",
                ],
              });
            }
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listApiGraphqlSecurity(appPath: string): McpToolResult {
  try {
    const infos = buildApiGraphqlSecurityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No GraphQL security patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `GraphQL Security Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiGraphqlSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = buildApiGraphqlSecurityInfos(appPath);
    let text = `GraphQL Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `Introspection: ${infos.filter((i) => i.type === 'introspection').length}\n`;
    text += `Depth-limit:   ${infos.filter((i) => i.type === 'depth-limit').length}\n`;
    text += `Complexity:    ${infos.filter((i) => i.type === 'complexity').length}\n`;
    text += `N+1:           ${infos.filter((i) => i.type === 'n+1').length}\n`;
    text += `Auth:          ${infos.filter((i) => i.type === 'auth').length}\n`;
    text += `Subscription:  ${infos.filter((i) => i.type === 'subscription').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiGraphqlSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_graphql_security', description: 'Analyze GraphQL security; warns on introspection enabled in prod, missing depth/complexity limits, N+1 resolver queries without DataLoader, mutations without security attributes', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_graphql_security_stats', description: 'Statistics for GraphQL security: counts by type, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
