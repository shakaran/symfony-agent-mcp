import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface SoapPatternInfo {
  file: string;
  type: 'client' | 'server';
  wsdl: string;
  issues: string[];
}

function sanitizeWsdlUrl(url: string): string {
  return url.replace(/([?&])(password|auth|token|secret|key)=[^&\s]*/gi, '$1$2=***');
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full, base));
    } else if (entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

function buildSoapPatternInfos(appPath: string): SoapPatternInfo[] {
  const results: SoapPatternInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);

  for (const file of files) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasClient = content.includes('new SoapClient');
    const hasServer = content.includes('new SoapServer');
    const hasFault = content.includes('SoapFault');

    if (!hasClient && !hasServer && !hasFault) continue;

    const issues: string[] = [];
    let soapType: 'client' | 'server' = 'client';
    let wsdl = '';

    if (hasClient) {
      soapType = 'client';
      // Extract WSDL URL from new SoapClient('...')
      const wsdlMatch = /new\s+SoapClient\s*\(\s*['"]([^'"]{0,300})['"]/i.exec(content);
      if (wsdlMatch) {
        wsdl = sanitizeWsdlUrl(wsdlMatch[1]);
        if (wsdl.startsWith('http://')) {
          issues.push('Hardcoded HTTP WSDL URL — use HTTPS and move URL to configuration/env var');
        } else if (wsdl.startsWith('https://')) {
          issues.push('Hardcoded HTTPS WSDL URL — move URL to configuration or env var for flexibility');
        }
      } else {
        wsdl = '(dynamic or null)';
      }

      // Check for SSL verification options
      if (!content.includes('verify_peer') && !content.includes('ssl_method') && !content.includes('stream_context')) {
        issues.push('SoapClient without stream_context SSL options — add verify_peer and ca path for HTTPS WSDLs');
      }

      // Check for try/catch around SOAP calls
      const clientBlockStart = content.indexOf('new SoapClient');
      const contextSlice = content.slice(Math.max(0, clientBlockStart - 200), Math.min(content.length, clientBlockStart + 500));
      if (!contextSlice.includes('try') || !contextSlice.includes('catch')) {
        issues.push('SoapClient usage without try/catch — SoapFault exceptions must be caught');
      }
    }

    if (hasServer) {
      soapType = 'server';
      const wsdlMatch = /new\s+SoapServer\s*\(\s*['"]([^'"]{0,300})['"]/i.exec(content);
      wsdl = wsdlMatch ? sanitizeWsdlUrl(wsdlMatch[1]) : '(dynamic or null)';
      issues.push('SoapServer detected — ensure WSDL does not expose internal structure details');
    }

    if (hasFault && !hasClient && !hasServer) {
      issues.push('SoapFault used without SoapClient or SoapServer — verify this is intentional');
    }

    if (issues.length > 0 || hasClient || hasServer) {
      results.push({
        file: path.relative(appPath, file),
        type: soapType,
        wsdl,
        issues,
      });
    }
  }

  return results;
}

export function listPhpSoapPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildSoapPatternInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP SOAP patterns found.' }] };
    }
    const lines = infos.map(i =>
      `${i.file} [${i.type}]\n  WSDL: ${i.wsdl}\n  Issues: ${i.issues.length > 0 ? i.issues.join('; ') : 'none'}`
    );
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpSoapPatternsStats(appPath: string): McpToolResult {
  try {
    const infos = buildSoapPatternInfos(appPath);
    const stats = {
      total: infos.length,
      byType: {} as Record<string, number>,
      withIssues: infos.filter(i => i.issues.length > 0).length,
      hardcodedWsdl: infos.filter(i => i.wsdl.startsWith('http')).length,
    };
    for (const i of infos) {
      stats.byType[i.type] = (stats.byType[i.type] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpSoapPatternsTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_php_soap_patterns',
      description: 'List PHP SOAP usage patterns: SoapClient, SoapServer, SoapFault — flags hardcoded WSDL URLs, missing SSL verification, and missing exception handling.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    },
    {
      name: 'get_php_soap_patterns_stats',
      description: 'Get statistics for PHP SOAP patterns: total usages, breakdown by client/server type, count with issues, hardcoded WSDL URLs.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    }
  ];
}
