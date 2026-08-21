import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ConsulServiceDiscoveryInfo {
  source: string;
  type: 'health' | 'acl' | 'deregister' | 'connect' | 'port' | 'tags';
  detail: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function analyzeConsulJsonContent(content: string, source: string): ConsulServiceDiscoveryInfo[] {
  const results: ConsulServiceDiscoveryInfo[] = [];

  // Service registration without health check
  const hasService = content.includes('"service"') || content.includes('"services"') || content.includes('"name"');
  const hasChecks = content.includes('"checks"') || content.includes('"check"');
  if (hasService && !hasChecks) {
    results.push({
      source,
      type: 'health',
      detail: 'Service registration without health check',
      issue: `${source} registers a Consul service without a checks: block — services without health checks are always considered healthy; add HTTP/TCP/gRPC health checks so failed services are removed from routing`,
    });
  } else if (hasService && hasChecks) {
    results.push({ source, type: 'health', detail: 'Service registration with health check', issue: null });
  }

  // deregister_critical_service_after not set
  if (hasChecks && !content.includes('deregister_critical_service_after') && !content.includes('DeregisterCriticalServiceAfter')) {
    results.push({
      source,
      type: 'deregister',
      detail: 'deregister_critical_service_after not configured',
      issue: `${source} does not set deregister_critical_service_after — failed services remain registered indefinitely; add "deregister_critical_service_after": "30m" to auto-deregister dead instances`,
    });
  }

  // Missing ACL token for service registration
  const hasToken = content.includes('"token"') || content.includes('"Token"');
  if (hasService && !hasToken) {
    results.push({
      source,
      type: 'acl',
      detail: 'Service registration without ACL token',
      issue: `${source} registers service without an ACL token — in production, all Consul API calls should use ACL tokens to prevent unauthorized service registration and discovery`,
    });
  }

  // connect: native_integration: true without sidecar proxy
  if ((content.includes('"native_integration"') || content.includes('"native"')) && content.includes('true')) {
    const hasSidecar = content.includes('sidecar') || content.includes('proxy') || content.includes('connect-proxy');
    if (!hasSidecar) {
      results.push({
        source,
        type: 'connect',
        detail: 'connect native_integration without sidecar proxy',
        issue: `${source} enables Consul Connect native integration without a sidecar proxy config — native integration requires application-level mTLS support; configure sidecar_service or use Envoy proxy`,
      });
    }
  }

  // Service port hardcoded to 0
  if (/"port"\s*:\s*0/.test(content)) {
    results.push({
      source,
      type: 'port',
      detail: 'Service port set to 0 (random)',
      issue: `${source} sets service port to 0 — random ports require dynamic service discovery on every restart; use a fixed port or configure proper service discovery to handle dynamic port assignment`,
    });
  }

  // Missing tags for environment distinction
  const hasTags = content.includes('"tags"') || content.includes('"Tags"');
  if (hasService && !hasTags) {
    results.push({
      source,
      type: 'tags',
      detail: 'Service registration without tags',
      issue: `${source} registers service without tags — add environment tags (e.g., "prod", "staging") to distinguish services across environments and enable tag-based routing`,
    });
  }

  return results;
}

function analyzeYamlConsulContent(content: string, source: string): ConsulServiceDiscoveryInfo[] {
  const results: ConsulServiceDiscoveryInfo[] = [];

  const hasConsulConfig = content.includes('consul') || content.includes('Consul') || content.includes('service_name') || content.includes('discovery');
  if (!hasConsulConfig) return results;

  // Missing health check in YAML service config
  const hasChecks = content.includes('checks:') || content.includes('check:') || content.includes('healthcheck:');
  if (!hasChecks && (content.includes('service:') || content.includes('consul:'))) {
    results.push({
      source,
      type: 'health',
      detail: 'YAML service config without health check',
      issue: `${source} configures a Consul service without health checks — add checks: block with HTTP/TCP endpoint to enable proper health monitoring`,
    });
  }

  // Missing ACL token reference in YAML
  const hasToken = content.includes('CONSUL_TOKEN') || content.includes('consul_token') || content.includes('acl_token');
  if (!hasToken && (content.includes('service:') || content.includes('consul:'))) {
    results.push({
      source,
      type: 'acl',
      detail: 'YAML Consul config without ACL token reference',
      issue: `${source} references Consul service without ACL token — ensure CONSUL_TOKEN env var is configured for production deployments`,
    });
  }

  return results;
}

function buildConsulServiceDiscoveryInfos(appPath: string): ConsulServiceDiscoveryInfo[] {
  const results: ConsulServiceDiscoveryInfo[] = [];

  // Scan root-level consul.json
  const consulJsonPath = path.join(appPath, 'consul.json');
  const consulJsonContent = safeRead(consulJsonPath, appPath);
  if (consulJsonContent) {
    results.push(...analyzeConsulJsonContent(consulJsonContent, 'consul.json'));
  }

  // Scan consul.hcl
  const consulHclPath = path.join(appPath, 'consul.hcl');
  const consulHclContent = safeRead(consulHclPath, appPath);
  if (consulHclContent) {
    const hasService = consulHclContent.includes('service {') || consulHclContent.includes('service{');
    const hasChecks = consulHclContent.includes('checks {') || consulHclContent.includes('check {');
    const hasTags = consulHclContent.includes('tags =');
    const hasToken = consulHclContent.includes('token =');
    const hasDeregister = consulHclContent.includes('deregister_critical_service_after');

    if (hasService && !hasChecks) {
      results.push({
        source: 'consul.hcl',
        type: 'health',
        detail: 'HCL service registration without health check',
        issue: 'consul.hcl registers a service without checks block — add check { } with http, tcp, or grpc health check endpoint',
      });
    }
    if (hasService && !hasTags) {
      results.push({
        source: 'consul.hcl',
        type: 'tags',
        detail: 'HCL service registration without tags',
        issue: 'consul.hcl service missing tags — add tags = ["prod"] or ["staging"] to distinguish services across environments',
      });
    }
    if (hasChecks && !hasDeregister) {
      results.push({
        source: 'consul.hcl',
        type: 'deregister',
        detail: 'deregister_critical_service_after not set in HCL',
        issue: 'consul.hcl checks block missing deregister_critical_service_after — failed services will stay registered forever; add deregister_critical_service_after = "30m"',
      });
    }
    if (hasService && !hasToken) {
      results.push({
        source: 'consul.hcl',
        type: 'acl',
        detail: 'HCL service registration without ACL token',
        issue: 'consul.hcl does not set token — in production ACLs must be enabled and each service should have its own policy token',
      });
    }
  }

  // Scan docker-compose files for Consul service labels
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'docker-compose.prod.yml', 'docker-compose.prod.yaml'];
  for (const fname of composeFiles) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;
    if (!content.includes('consul')) continue;
    results.push(...analyzeYamlConsulContent(content, fname));
  }

  // Scan config/**/*.yaml for Consul service discovery settings
  const configDir = path.join(appPath, 'config');
  if (fs.existsSync(configDir)) {
    const configFiles = [
      ...scanDirRecursive(configDir, '.yaml'),
      ...scanDirRecursive(configDir, '.yml'),
    ];
    for (const fpath of configFiles) {
      const content = safeRead(fpath, appPath);
      if (!content) continue;
      if (!content.includes('consul') && !content.includes('Consul')) continue;
      const relFile = path.relative(appPath, fpath);
      results.push(...analyzeYamlConsulContent(content, relFile));
    }
  }

  return results;
}

export function listConsulServiceDiscovery(appPath: string): McpToolResult {
  try {
    const infos = buildConsulServiceDiscoveryInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Consul service discovery configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Consul Service Discovery Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
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

export function getConsulServiceDiscoveryStats(appPath: string): McpToolResult {
  try {
    const infos = buildConsulServiceDiscoveryInfos(appPath);
    let text = `Consul Service Discovery Statistics\n${'='.repeat(40)}\n\n`;
    text += `Health check issues: ${infos.filter((i) => i.type === 'health').length}\n`;
    text += `ACL issues:          ${infos.filter((i) => i.type === 'acl').length}\n`;
    text += `Deregister issues:   ${infos.filter((i) => i.type === 'deregister').length}\n`;
    text += `Connect issues:      ${infos.filter((i) => i.type === 'connect').length}\n`;
    text += `Port issues:         ${infos.filter((i) => i.type === 'port').length}\n`;
    text += `Tag issues:          ${infos.filter((i) => i.type === 'tags').length}\n`;
    text += `Total issues:        ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getConsulServiceDiscoveryTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_consul_service_discovery',
      description: 'Scan consul.json, consul.hcl, docker-compose.yml, config/**/*.yaml for Consul service discovery issues: service registration without health check, missing deregister_critical_service_after, no ACL token for service registration, connect native_integration without sidecar proxy, port hardcoded to 0, missing environment tags.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_consul_service_discovery_stats',
      description: 'Statistics for Consul service discovery: health/acl/deregister/connect/port/tags issue counts.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
