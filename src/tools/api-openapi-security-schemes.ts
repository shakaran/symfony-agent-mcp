import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface OpenApiSecuritySchemeInfo {
  type: 'bearer' | 'apiKey' | 'oauth2' | 'openIdConnect' | 'basic';
  name: string;
  location: string;
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

function buildSecuritySchemeInfos(appPath: string): OpenApiSecuritySchemeInfo[] {
  const results: OpenApiSecuritySchemeInfo[] = [];

  const nelmioYaml = path.join(appPath, 'config', 'packages', 'nelmio_api_doc.yaml');
  if (fs.existsSync(nelmioYaml)) {
    const cfg = parseYamlFile(nelmioYaml) as Record<string, unknown> | null;
    if (cfg) {
      const nelmio = (cfg['nelmio_api_doc'] ?? {}) as Record<string, unknown>;
      const documentation = (nelmio['documentation'] ?? {}) as Record<string, unknown>;
      const components = (documentation['components'] ?? {}) as Record<string, unknown>;
      const securitySchemes = (components['securitySchemes'] ?? {}) as Record<string, unknown>;

      for (const [schemeName, schemeCfg] of Object.entries(securitySchemes)) {
        const scheme = schemeCfg as Record<string, unknown>;
        const schemeType = String(scheme['type'] ?? '').toLowerCase();
        const location = String(scheme['in'] ?? '');
        const issues: string[] = [];

        if (schemeType === 'apikey' && location === 'query') {
          issues.push(`ApiKey scheme "${schemeName}" in query parameter — leaks API key in server logs, browser history, and referrer headers`);
        }
        if (schemeType === 'oauth2') {
          const flows = (scheme['flows'] ?? {}) as Record<string, unknown>;
          if (flows['implicit']) {
            issues.push(`OAuth2 implicit flow used in "${schemeName}" — implicit flow deprecated in OAuth 2.1; use authorization_code with PKCE`);
          }
          if (!flows['authorizationCode'] && !flows['clientCredentials']) {
            issues.push(`OAuth2 scheme "${schemeName}" has no standard flow configured`);
          }
        }
        if (schemeType === 'openidconnect') {
          if (!scheme['openIdConnectUrl']) {
            issues.push(`OpenID Connect scheme "${schemeName}" missing openIdConnectUrl — clients cannot discover endpoints`);
          }
        }
        if (schemeType === 'http' && String(scheme['scheme'] ?? '').toLowerCase() === 'bearer') {
          if (!scheme['bearerFormat']) {
            issues.push(`Bearer scheme "${schemeName}" missing bearerFormat — specify "JWT" or "opaque" for documentation clarity`);
          }
          const type = 'bearer' as const;
          results.push({ type, name: schemeName, location: 'Authorization header', issues });
          continue;
        }

        const type: OpenApiSecuritySchemeInfo['type'] = schemeType === 'apikey' ? 'apiKey' :
          schemeType === 'oauth2' ? 'oauth2' : schemeType === 'openidconnect' ? 'openIdConnect' :
          schemeType === 'http' ? 'basic' : 'bearer';
        results.push({ type, name: schemeName, location, issues });
      }
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      if (content.includes('OpenApiFactoryInterface') || content.includes('openapi_context') || content.includes('securitySchemes')) {
        const relFile = path.relative(appPath, file);
        const issues: string[] = [];

        const hasSecurityApplied = content.includes("'security'") || content.includes('"security"');
        const hasSchemesDefined = content.includes('securitySchemes') || content.includes("'type' => 'http'") || content.includes('"type": "http"');

        if (hasSchemesDefined && !hasSecurityApplied) {
          issues.push(`OpenAPI factory "${relFile}" defines security schemes but does not apply them to routes — all routes appear public in the spec`);
        }
        if (issues.length > 0) {
          results.push({ type: 'bearer', name: relFile, location: 'custom factory', issues });
        }
      }
    }
  }

  return results;
}

export function listApiOpenApiSecuritySchemes(appPath: string): McpToolResult {
  try {
    const infos = buildSecuritySchemeInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No OpenAPI security scheme definitions found (no nelmio_api_doc.yaml securitySchemes or OpenApiFactoryInterface).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `OpenAPI Security Schemes Analysis\n${'='.repeat(55)}\n\nSchemes: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.name}  location: ${info.location || '(header)'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiOpenApiSecuritySchemesStats(appPath: string): McpToolResult {
  try {
    const infos = buildSecuritySchemeInfos(appPath);
    let text = `OpenAPI Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `Bearer:       ${infos.filter((i) => i.type === 'bearer').length}\n`;
    text += `ApiKey:       ${infos.filter((i) => i.type === 'apiKey').length}\n`;
    text += `OAuth2:       ${infos.filter((i) => i.type === 'oauth2').length}\n`;
    text += `OpenIDConn:   ${infos.filter((i) => i.type === 'openIdConnect').length}\n`;
    text += `Basic:        ${infos.filter((i) => i.type === 'basic').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiOpenApiSecuritySchemesTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_openapi_security_schemes', description: 'Analyze OpenAPI security scheme definitions; warns on ApiKey in query param, OAuth2 implicit flow (deprecated), missing bearerFormat, openIdConnect without discovery URL, schemes defined but not applied', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_openapi_security_schemes_stats', description: 'Statistics for OpenAPI security schemes: bearer/apiKey/oauth2/openIdConnect/basic count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
