/**
 * Symfony 6.3+ Access Token Authentication Inspector
 *
 * Detects Symfony 6.3+ Access Token authentication implementation.
 * Scans security.yaml for: access_token, token_handler, TokenHandlerInterface.
 * Scans src/ PHP for: implements AccessTokenHandlerInterface, getUserBadgeFrom(),
 *   TokenHandlerInterface, BearerTokenExtractor, HeaderTokenExtractor,
 *   QueryStringTokenExtractor.
 *
 * Warns on:
 *   - AccessTokenHandler not caching token lookup (every request hits database)
 *   - token handler not throwing BadCredentialsException on invalid token (returns null)
 *   - extractor using query string for tokens (tokens leak in logs)
 *   - token handler with no expiry check
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';
import { parseYamlFile } from '../utils/symfony-parser.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface AccessTokenInfo {
  file: string;
  className: string;
  extractorType: string;
  cacheEnabled: boolean;
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

interface SecurityAccessTokenConfig {
  hasAccessToken: boolean;
  tokenHandler: string | null;
  extractors: string[];
}

function readSecurityYaml(appPath: string): SecurityAccessTokenConfig {
  const result: SecurityAccessTokenConfig = {
    hasAccessToken: false,
    tokenHandler: null,
    extractors: [],
  };
  const configPath = path.join(appPath, 'config', 'packages', 'security.yaml');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    result.hasAccessToken = raw.includes('access_token') || raw.includes('token_handler');
    const handlerM = /token_handler\s*:\s*(\S{1,200})/.exec(raw);
    if (handlerM) result.tokenHandler = handlerM[1];
    const extractorM = /token_extractors\s*:\s*\[([^\]]{0,500})\]/.exec(raw);
    if (extractorM) {
      result.extractors = extractorM[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
    } else {
      const extractorLines = raw.match(/token_extractors[\s\S]{0,200}?(?=\n\w|\n\n|$)/);
      if (extractorLines) {
        if (raw.includes('query_string')) result.extractors.push('query_string');
        if (raw.includes('header')) result.extractors.push('header');
        if (raw.includes('bearer')) result.extractors.push('bearer');
      }
    }
    parseYamlFile(configPath);
  } catch { /* skip */ }
  return result;
}

function parseAccessTokenFile(filePath: string, appPath: string): AccessTokenInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  const isHandler =
    content.includes('AccessTokenHandlerInterface') ||
    content.includes('getUserBadgeFrom(') ||
    content.includes('TokenHandlerInterface');

  const isExtractor =
    content.includes('BearerTokenExtractor') ||
    content.includes('HeaderTokenExtractor') ||
    content.includes('QueryStringTokenExtractor') ||
    content.includes('TokenExtractorInterface');

  if (!isHandler && !isExtractor) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;

  const className = classM[1];
  const issues: string[] = [];

  // Determine extractor type
  let extractorType = 'handler';
  if (content.includes('QueryStringTokenExtractor')) {
    extractorType = 'query-string';
  } else if (content.includes('BearerTokenExtractor') || content.includes('HeaderTokenExtractor')) {
    extractorType = 'header/bearer';
  } else if (content.includes('TokenExtractorInterface')) {
    extractorType = 'custom-extractor';
  }

  // Check for caching
  const cacheEnabled =
    content.includes('CacheInterface') ||
    content.includes('CacheItemPoolInterface') ||
    content.includes('$this->cache') ||
    content.includes('->getItem(') ||
    content.includes('->get(') ||
    content.includes('static $') ||
    content.includes('memoize');

  if (isHandler && !cacheEnabled) {
    issues.push('AccessTokenHandler has no cache — every authenticated request will hit the database for token validation');
  }

  // Check for BadCredentialsException on invalid token
  if (isHandler && !content.includes('BadCredentialsException') && !content.includes('throw ')) {
    issues.push('Token handler does not throw BadCredentialsException on invalid token — returning null breaks the security contract and may cause unexpected behavior');
  }

  // Check for expiry check
  if (isHandler) {
    const hasExpiryCheck =
      content.includes('expiresAt') ||
      content.includes('expires_at') ||
      content.includes('expiresIn') ||
      content.includes('isExpired') ||
      content.includes('getExpiry') ||
      content.includes('timestamp') ||
      content.includes('strtotime') ||
      content.includes('DateTimeInterface') ||
      content.includes('new DateTime');
    if (!hasExpiryCheck) {
      issues.push('Token handler does not check token expiry — expired tokens will continue to be accepted');
    }
  }

  // Warn on query string extractor (token in URL leaks to logs)
  if (extractorType === 'query-string') {
    issues.push('QueryStringTokenExtractor used — tokens appear in URLs and leak into access logs, proxy logs, and browser history');
  }

  return { file: filePath, className, extractorType, cacheEnabled, issues };
}

function loadAccessTokenInfos(appPath: string): AccessTokenInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: AccessTokenInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseAccessTokenFile(f, appPath);
    if (r) {
      r.file = path.relative(appPath, r.file);
      results.push(r);
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listSymfonySecurityAccessTokens(appPath: string): McpToolResult {
  try {
    const infos = loadAccessTokenInfos(appPath);
    const secConfig = readSecurityYaml(appPath);

    if (infos.length === 0 && !secConfig.hasAccessToken) {
      return { content: [{ type: 'text', text: 'No Access Token authentication implementation found.' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Security Access Token Inspector (${infos.length} handlers/extractors)\n${'='.repeat(60)}\n`;
    text += `security.yaml access_token: ${secConfig.hasAccessToken ? 'configured' : 'not found'}\n`;
    if (secConfig.tokenHandler) text += `token_handler: ${secConfig.tokenHandler}\n`;
    if (secConfig.extractors.length > 0) {
      text += `extractors: [${secConfig.extractors.join(', ')}]\n`;
      if (secConfig.extractors.includes('query_string')) {
        text += `WARN: query_string extractor configured in security.yaml — tokens leak into logs\n`;
      }
    }
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}  [${info.className}]\n`;
      text += `    extractor: ${info.extractorType}  cache: ${info.cacheEnabled ? 'yes' : 'MISSING'}\n`;
      for (const issue of info.issues) text += `    WARN: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonySecurityAccessTokenStats(appPath: string): McpToolResult {
  try {
    const infos = loadAccessTokenInfos(appPath);
    const secConfig = readSecurityYaml(appPath);

    let text = `Security Access Token Statistics\n${'='.repeat(40)}\n\n`;
    text += `security.yaml configured:       ${secConfig.hasAccessToken ? 'yes' : 'no'}\n`;
    text += `Handlers/extractors found:      ${infos.length}\n`;
    text += `  With cache:                   ${infos.filter((i) => i.cacheEnabled).length}\n`;
    text += `  Without cache:                ${infos.filter((i) => !i.cacheEnabled).length}\n`;
    text += `  Query string extractors:      ${infos.filter((i) => i.extractorType === 'query-string').length}\n`;
    text += `  Header/bearer extractors:     ${infos.filter((i) => i.extractorType === 'header/bearer').length}\n`;
    text += `Issues:                         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSecurityAccessTokenTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_security_access_tokens',
      description: 'List Symfony 6.3+ Access Token authentication handlers and extractors: detects caching, BadCredentialsException throwing, expiry checks, query string extractor usage; warns on missing cache (DB hit per request), missing exception, no expiry check, tokens in URL',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_security_access_token_stats',
      description: 'Show access token statistics: total handlers/extractors, cache coverage, extractor types, security.yaml configuration, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
