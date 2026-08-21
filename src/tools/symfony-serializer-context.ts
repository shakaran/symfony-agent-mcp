import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface SerializerContextInfo {
  file: string;
  class?: string;
  hasContextAttribute: boolean;
  hasContextBuilder: boolean;
  hasDefaultContext: boolean;
  contextKeys: string[];
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

function parseContextUsage(filePath: string, appPath: string): SerializerContextInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  const hasContextAttr = content.includes('#[Context(') || content.includes('use Symfony\\Component\\Serializer\\Attribute\\Context') || content.includes('use Symfony\\Component\\Serializer\\Annotation\\Context');
  const hasContextBuilder = content.includes('ContextBuilderInterface') || content.includes('implements ContextBuilder');
  const hasDefaultContext = content.includes('default_context') || content.includes('defaultContext');
  if (!hasContextAttr && !hasContextBuilder && !hasDefaultContext) return null;
  if (content.includes('namespace Symfony\\Component\\Serializer')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const contextKeys: string[] = [];
  const keyRe = /['"](?:groups|enable_max_depth|circular_reference_handler|object_to_populate|json_decode_associative|skip_null_values|preserve_empty_objects)['"](?:\s*=>|\s*:)/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(content)) !== null) {
    const key = m[0].replace(/['"]\s*(?:=>|:)/, '').replace(/['"]/g, '').trim();
    if (!contextKeys.includes(key)) contextKeys.push(key);
  }
  const issues: string[] = [];
  if (hasContextAttr && !content.includes('normalizationContext') && !content.includes('denormalizationContext')) {
    issues.push('#[Context] attribute found — ensure normalizationContext/denormalizationContext are specified to avoid applying to both');
  }
  if (hasContextBuilder && !content.includes('createNormalizationContext') && !content.includes('createDenormalizationContext')) {
    issues.push('ContextBuilderInterface without createNormalizationContext/createDenormalizationContext — interface not fully implemented');
  }
  return { file: path.relative(appPath, filePath), class: classM?.[1], hasContextAttribute: hasContextAttr, hasContextBuilder, hasDefaultContext, contextKeys, issues };
}

export function listSerializerContextBuilders(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: SerializerContextInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseContextUsage(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No Symfony Serializer #[Context] attributes or ContextBuilder found.\n\nExample:\n  use Symfony\\Component\\Serializer\\Attribute\\Context;\n  class Product {\n    #[Context(normalizationContext: [\'groups\' => [\'product:read\']])]\n    public string $name;\n  }' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Symfony Serializer Context\n${'='.repeat(55)}\n\nFiles: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [r.hasContextAttribute ? '#[Context]' : '', r.hasContextBuilder ? 'ContextBuilder' : '', r.hasDefaultContext ? 'default_context' : ''].filter(Boolean).join('  ');
      text += `\n  ${r.class ?? '(file)'}  ${flags}  (${r.file})\n`;
      if (r.contextKeys.length > 0) text += `    context keys: ${r.contextKeys.join(', ')}\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSerializerContextStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: SerializerContextInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseContextUsage(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `Serializer Context Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with context config: ${results.length}\n  #[Context] attribute: ${results.filter(r => r.hasContextAttribute).length}\n  ContextBuilderInterface: ${results.filter(r => r.hasContextBuilder).length}\n  default_context: ${results.filter(r => r.hasDefaultContext).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSerializerContextTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_serializer_context', description: 'Detect Symfony Serializer #[Context] attribute on properties, ContextBuilderInterface implementations, default_context config, normalization/denormalization context keys', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_serializer_context_stats', description: 'Serializer context statistics: file count, #[Context]/ContextBuilder/default_context counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
