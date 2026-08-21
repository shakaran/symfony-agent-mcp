import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TokenParserInfo {
  class: string;
  file: string;
  tag?: string;
  hasGetTag: boolean;
  hasParse: boolean;
  isRegistered: boolean;
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

function parseTokenParser(filePath: string, appPath: string): TokenParserInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  if (!content.includes('TokenParserInterface') && !content.includes('AbstractTokenParser')) return null;
  if (content.includes('namespace Twig\\') || content.includes('namespace Symfony\\Twig\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const hasGetTag = content.includes('function getTag(');
  const hasParse = content.includes('function parse(');
  const tagM = /getTag\s*\(\s*\)\s*:\s*string[^{]*\{[^}]*return\s*['"]([^'"]+)['"]/s.exec(content);
  const tag = tagM?.[1];
  const isRegistered = content.includes('twig.token_parser') || content.includes('AsTwigTokenParser') || content.includes('getTokenParsers');
  const issues: string[] = [];
  if (!hasGetTag) issues.push('TokenParser without getTag() — Twig cannot identify the custom tag');
  if (!hasParse) issues.push('TokenParser without parse() — token stream will not be consumed');
  if (!isRegistered) issues.push('TokenParser not registered — add to Twig extension getTokenParsers() or tag twig.token_parser');
  return { class: classM[1], file: path.relative(appPath, filePath), tag, hasGetTag, hasParse, isRegistered, issues };
}

export function listTwigTokenParsers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const parsers: TokenParserInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const p = parseTokenParser(file, appPath);
      if (p) parsers.push(p);
    }
    if (parsers.length === 0) return { content: [{ type: 'text', text: 'No custom Twig TokenParserInterface implementations found.\n\nExample:\n  class MarkdownTokenParser extends AbstractTokenParser {\n    public function getTag(): string { return \'markdown\'; }\n    public function parse(Token $token): Node { ... }\n  }' }] };
    const totalIssues = parsers.reduce((s, p) => s + p.issues.length, 0);
    let text = `Twig Token Parsers\n${'='.repeat(55)}\n\nParsers: ${parsers.length}  Issues: ${totalIssues}\n`;
    for (const p of parsers.sort((a, b) => b.issues.length - a.issues.length)) {
      const tagStr = p.tag ? `  tag: {% ${p.tag} %}` : '  tag: unknown';
      const reg = p.isRegistered ? '  ✓ registered' : '  ⚠ not registered';
      text += `\n  ${p.class}${tagStr}${reg}  (${p.file})\n`;
      for (const i of p.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTwigTokenParserStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const parsers: TokenParserInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const p = parseTokenParser(file, appPath);
        if (p) parsers.push(p);
      }
    }
    let text = `Twig Token Parser Statistics\n${'='.repeat(40)}\n\n`;
    text += `Token parsers: ${parsers.length}\n  Registered: ${parsers.filter((p) => p.isRegistered).length}\n  With getTag: ${parsers.filter((p) => p.hasGetTag).length}\n  With parse(): ${parsers.filter((p) => p.hasParse).length}\nIssues: ${parsers.reduce((s, p) => s + p.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTwigTokenParserTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_twig_token_parsers', description: 'Show custom Twig TokenParserInterface implementations: tag name from getTag(), parse() presence, extension registration, missing registration warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_twig_token_parser_stats', description: 'Show Twig token parser statistics: parser count, registered count, getTag/parse coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
