import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface HealthEndpointSecurityInfo {
  source: string;
  type: 'exposure' | 'auth' | 'info-disclosure' | 'ip-restriction';
  pattern: string;
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

function readFileSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

const HEALTH_PATHS = ['/health', '/_health', '/healthz', '/ping', '/status', '/live', '/ready'];

function buildSymfonyHealthEndpointSecurityInfos(appPath: string): HealthEndpointSecurityInfo[] {
  const results: HealthEndpointSecurityInfo[] = [];
  const foundHealthPaths: string[] = [];

  // Load security.yaml once for access_control checks
  const securityYaml = path.join(appPath, 'config', 'packages', 'security.yaml');
  const securityContent = readFileSafe(securityYaml);

  // Scan routing YAML files for health endpoints
  const routingDirs = [
    path.join(appPath, 'config', 'routes'),
    path.join(appPath, 'config'),
  ];
  for (const dir of routingDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const stat = fs.statSync(dir);
      const files = stat.isDirectory() ? fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).map((f) => path.join(dir, f)) : [dir];
      for (const f of files) {
        const content = readFileSafe(f);
        for (const healthPath of HEALTH_PATHS) {
          if (content.includes(healthPath)) {
            foundHealthPaths.push(healthPath);
            const hasAccessControl = securityContent.includes(healthPath);
            const issues: string[] = [];
            if (!hasAccessControl) {
              issues.push(`Health endpoint ${healthPath} without access_control protection — exposes system health data publicly; restrict to internal IPs or require authentication`);
            }
            results.push({ source: path.relative(appPath, f), type: 'auth', pattern: `route: ${healthPath}`, issues });
          }
        }
      }
    } catch { /* skip */ }
  }

  // Scan PHP controllers for health endpoints and info disclosure
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      const fileName = path.basename(file).toLowerCase();
      const isHealthController = fileName.includes('health') || fileName.includes('ping') || fileName.includes('status');

      const content = readFileSafe(file);
      const rel = path.relative(appPath, file);

      // Either signal identifies a health endpoint: the filename, or a health
      // route declared in an annotation/attribute. The filename check used to
      // `continue` on its own, which made the route check below unreachable.
      const hasHealthRoute = HEALTH_PATHS.some((p) => content.includes(p));
      if (!hasHealthRoute && !isHealthController) continue;

      // Check for info disclosure
      const sensitivePhrases = ['PHP_VERSION', 'APP_ENV', 'DATABASE_URL'];
      for (const phrase of sensitivePhrases) {
        if (content.includes(phrase)) {
          results.push({ source: rel, type: 'info-disclosure', pattern: `exposes ${phrase}`, issues: [`Health endpoint exposes sensitive system information — avoid including PHP version, environment name, or database URLs in health responses accessible externally`] });
          break;
        }
      }

      // Check if health controller route is protected
      const hasAuthCheck = content.includes('IsGranted') || content.includes('denyAccessUnlessGranted') || content.includes('access_control');
      if (!hasAuthCheck) {
        const routeMatch = content.match(/#\[Route\(['"]([^'"]+)['"]/);
        const routePath = routeMatch ? routeMatch[1] : 'health endpoint';
        const alreadyReported = foundHealthPaths.some((p) => content.includes(p));
        if (!alreadyReported) {
          results.push({ source: rel, type: 'exposure', pattern: `unprotected ${routePath}`, issues: [`Health endpoint ${routePath} without access_control protection — exposes system health data publicly; restrict to internal IPs or require authentication`] });
        }
      }
    }
  }

  // Check nginx/apache config for IP restrictions
  const webServerConfigs = [
    path.join(appPath, 'nginx.conf'),
    path.join(appPath, 'docker', 'nginx.conf'),
    path.join(appPath, '.docker', 'nginx.conf'),
    path.join(appPath, 'apache.conf'),
    path.join(appPath, '.htaccess'),
  ];
  for (const cfgFile of webServerConfigs) {
    if (!fs.existsSync(cfgFile)) continue;
    const content = readFileSafe(cfgFile);
    const hasHealthRestriction = HEALTH_PATHS.some((p) => content.includes(p));
    if (hasHealthRestriction && (content.includes('deny') || content.includes('allow') || content.includes('satisfy'))) {
      results.push({ source: path.relative(appPath, cfgFile), type: 'ip-restriction', pattern: 'IP restriction for health paths', issues: [] });
    }
  }

  return results;
}

export function listSymfonyHealthEndpointSecurity(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyHealthEndpointSecurityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No health endpoint security issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Health Endpoint Security Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyHealthEndpointSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyHealthEndpointSecurityInfos(appPath);
    let text = `Symfony Health Endpoint Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `Exposure:        ${infos.filter((i) => i.type === 'exposure').length}\n`;
    text += `Auth:            ${infos.filter((i) => i.type === 'auth').length}\n`;
    text += `Info-disclosure: ${infos.filter((i) => i.type === 'info-disclosure').length}\n`;
    text += `IP-restriction:  ${infos.filter((i) => i.type === 'ip-restriction').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyHealthEndpointSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_health_endpoint_security', description: 'Analyze Symfony health endpoint security: missing access_control, info disclosure (PHP_VERSION/APP_ENV/DATABASE_URL), IP restrictions in nginx/apache', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_health_endpoint_security_stats', description: 'Statistics for health endpoint security: counts by type (exposure/auth/info-disclosure/ip-restriction) and total issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
