import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface StringEncodingInfo {
  file: string;
  type: 'unicode' | 'byte' | 'ascii';
  method: string;
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

function buildStringEncodingInfos(appPath: string): StringEncodingInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: StringEncodingInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);

    const hasUnicode = content.includes('UnicodeString') || /\bu\(/.test(content) || content.includes('->normalize(');
    const hasByte = content.includes('ByteString') || /\bb\(/.test(content);
    const hasAscii = content.includes('AsciiString') || /\ba\(/.test(content);

    if (hasUnicode) {
      const issues: string[] = [];
      const toByteNoEnc = /->toByteString\(\s*\)/.test(content);
      if (toByteNoEnc) {
        issues.push('->toByteString() called without encoding argument — defaults to UTF-8 but should be explicit for non-UTF-8 contexts');
      }
      results.push({ file: relFile, type: 'unicode', method: 'UnicodeString', issues });
    }

    if (hasByte) {
      const toByteThenUnicode = content.includes('ByteString') && content.includes('->toUnicodeString(');
      if (toByteThenUnicode) {
        const issues: string[] = [];
        const noEncodingCheck = !/->toUnicodeString\(\s*['"][^'"]{1,20}['"]/.test(content);
        if (noEncodingCheck) {
          issues.push('ByteString->toUnicodeString() without explicit encoding — may fail silently on non-UTF-8 binary data');
        }
        results.push({ file: relFile, type: 'byte', method: 'ByteString->toUnicodeString()', issues });
      }
    }

    if (!hasUnicode && !hasByte) {
      const issues: string[] = [];
      let hasIssue = false;

      if (/\bstrlen\s*\(/.test(content) && (content.includes('utf-8') || content.includes('UTF-8') || content.includes('mb_'))) {
        issues.push('strlen() used alongside multibyte context — use mb_strlen() or UnicodeString for character count (strlen returns bytes, not chars)');
        hasIssue = true;
      }

      if (/\bsubstr\s*\(/.test(content) && (content.includes('utf-8') || content.includes('UTF-8') || content.includes('mb_'))) {
        issues.push('substr() used alongside multibyte context — use mb_substr() or UnicodeString->slice() to avoid splitting multibyte characters');
        hasIssue = true;
      }

      if (hasIssue) {
        results.push({ file: relFile, type: 'unicode', method: 'strlen/substr on multibyte', issues });
      }
    }

    if (hasAscii) {
      results.push({ file: relFile, type: 'ascii', method: 'AsciiString', issues: [] });
    }
  }

  return results;
}

export function listSymfonyStringEncoding(appPath: string): McpToolResult {
  try {
    const infos = buildStringEncodingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony String encoding patterns found (no UnicodeString/ByteString/AsciiString).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony String Encoding Analysis\n${'='.repeat(55)}\n\nUsages: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.method}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyStringEncodingStats(appPath: string): McpToolResult {
  try {
    const infos = buildStringEncodingInfos(appPath);
    let text = `String Encoding Statistics\n${'='.repeat(40)}\n\n`;
    text += `Unicode usages: ${infos.filter((i) => i.type === 'unicode').length}\n`;
    text += `Byte usages:    ${infos.filter((i) => i.type === 'byte').length}\n`;
    text += `ASCII usages:   ${infos.filter((i) => i.type === 'ascii').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyStringEncodingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_string_encoding', description: 'Analyze Symfony String component usage (UnicodeString/ByteString/AsciiString); warns on toByteString without encoding, ByteString to Unicode conversion issues, strlen/substr on multibyte strings', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_string_encoding_stats', description: 'Statistics for Symfony String encoding: unicode/byte/ascii usage count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
