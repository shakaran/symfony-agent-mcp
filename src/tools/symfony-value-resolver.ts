import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ValueResolverInfo {
  class: string;
  file: string;
  type: 'ValueResolverInterface' | 'ParamConverterInterface' | 'unknown';
  hasSupports: boolean;
  hasResolve: boolean;
  hasApply: boolean;
  attributeName?: string;
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

function parseValueResolver(filePath: string, appPath: string): ValueResolverInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const isValueResolver = content.includes('ValueResolverInterface');
  const isParamConverter = content.includes('ParamConverterInterface') || content.includes('ParamConverter');
  if (!isValueResolver && !isParamConverter) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const type: ValueResolverInfo['type'] = isValueResolver ? 'ValueResolverInterface' : isParamConverter ? 'ParamConverterInterface' : 'unknown';
  const hasSupports = content.includes('function supports(');
  const hasResolve = content.includes('function resolve(');
  const hasApply = content.includes('function apply(');
  const attrM = /#\[ValueResolver\s*\(\s*['"]([^'"]+)['"]/  .exec(content);
  const issues: string[] = [];
  if (type === 'ParamConverterInterface') issues.push('ParamConverterInterface is deprecated since Symfony 6.3 — migrate to ValueResolverInterface');
  if (isValueResolver && !hasSupports) issues.push('ValueResolverInterface without supports() — resolver runs for all arguments (performance)');
  if (isValueResolver && !hasResolve) issues.push('ValueResolverInterface without resolve() method');
  return { class: classM[1], file: path.relative(appPath, filePath), type, hasSupports, hasResolve, hasApply, attributeName: attrM?.[1], issues };
}

export function listValueResolvers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const resolvers: ValueResolverInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = parseValueResolver(file, appPath);
      if (r) resolvers.push(r);
    }
    if (resolvers.length === 0) return { content: [{ type: 'text', text: 'No ValueResolverInterface or ParamConverterInterface found.\n\nExample (Symfony 6.2+):\n  #[ValueResolver(\'user_resolver\')]\n  class UserValueResolver implements ValueResolverInterface {\n    public function supports(Request $request, ArgumentMetadata $argument): bool { ... }\n    public function resolve(Request $request, ArgumentMetadata $argument): iterable { ... }\n  }' }] };
    const totalIssues = resolvers.reduce((s, r) => s + r.issues.length, 0);
    let text = `Value Resolvers\n${'='.repeat(55)}\n\nResolvers: ${resolvers.length}  Issues: ${totalIssues}\n`;
    for (const r of resolvers.sort((a, b) => b.issues.length - a.issues.length)) {
      const attr = r.attributeName ? `  #[ValueResolver("${r.attributeName}")]` : '';
      text += `\n  ${r.class}  ${r.type}${attr}  (${r.file})\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getValueResolverStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const resolvers: ValueResolverInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseValueResolver(file, appPath);
        if (r) resolvers.push(r);
      }
    }
    let text = `Value Resolver Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total resolvers: ${resolvers.length}\n  ValueResolverInterface: ${resolvers.filter((r) => r.type === 'ValueResolverInterface').length}\n  ParamConverterInterface (deprecated): ${resolvers.filter((r) => r.type === 'ParamConverterInterface').length}\nIssues: ${resolvers.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getValueResolverTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_value_resolvers', description: 'Show ValueResolverInterface/#[ValueResolver] and legacy ParamConverterInterface implementations: supports()/resolve()/apply() method presence, deprecated ParamConverter warning, missing supports() warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_value_resolver_stats', description: 'Show value resolver statistics: resolver count, ValueResolverInterface vs deprecated ParamConverterInterface split, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
