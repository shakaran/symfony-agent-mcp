import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface GenericAnnotationInfo {
  file: string;
  class?: string;
  templateTags: string[];
  extendsGeneric: string[];
  implementsGeneric: string[];
  returnsGeneric: string[];
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

function parseGenericAnnotations(filePath: string, appPath: string): GenericAnnotationInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('@template') && !content.includes('@extends') && !content.includes('@implements') && !content.includes('@return')) return null;
  if (!content.includes('@template') && !/<[\w\\, ]{1,80}>/.test(content)) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const templateTags: string[] = [];
  const templateRe = /@template\s+(\w{1,60})(?:\s+of\s+([\w\\|]{1,100}))?/g;
  let m: RegExpExecArray | null;
  while ((m = templateRe.exec(content)) !== null) templateTags.push(m[2] ? `${m[1]} of ${m[2]}` : m[1]);
  const extendsGeneric: string[] = [];
  const extendsRe = /@extends\s+([\w\\]{1,100})<([^>]{1,200})>/g;
  while ((m = extendsRe.exec(content)) !== null) extendsGeneric.push(`${m[1]}<${m[2]}>`);
  const implementsGeneric: string[] = [];
  const implementsRe = /@implements\s+([\w\\]{1,100})<([^>]{1,200})>/g;
  while ((m = implementsRe.exec(content)) !== null) implementsGeneric.push(`${m[1]}<${m[2]}>`);
  const returnsGeneric: string[] = [];
  const returnRe = /@return\s+([\w\\]{1,100})<([^>]{1,200})>/g;
  while ((m = returnRe.exec(content)) !== null) returnsGeneric.push(`${m[1]}<${m[2]}>`);
  if (templateTags.length === 0 && extendsGeneric.length === 0 && implementsGeneric.length === 0 && returnsGeneric.length === 0) return null;
  const issues: string[] = [];
  if (templateTags.length > 0 && !content.includes('@psalm-') && !content.includes('@phpstan-')) {
    issues.push('@template without @psalm-template or @phpstan-template — tool-specific annotation ensures analysis engine processes it');
  }
  if (extendsGeneric.length > 0 && templateTags.length === 0) {
    issues.push('@extends with generic type but no @template on this class — type parameter is undefined');
  }
  return { file: path.relative(appPath, filePath), class: classM?.[1], templateTags, extendsGeneric, implementsGeneric, returnsGeneric, issues };
}

export function listPhpGenericAnnotations(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: GenericAnnotationInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseGenericAnnotations(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No generic/template PHPDoc annotations found.\n\nExample:\n  /** @template T @extends Collection<T> */\n  class TypedCollection extends Collection {}' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `PHP Generic Annotations\n${'='.repeat(55)}\n\nFiles: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.templateTags.length - a.templateTags.length)) {
      text += `\n  ${r.class ?? '(file)'}  @template: ${r.templateTags.length}  @extends: ${r.extendsGeneric.length}  @implements: ${r.implementsGeneric.length}  (${r.file})\n`;
      if (r.templateTags.length > 0) text += `    templates: ${r.templateTags.join(', ')}\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpGenericAnnotationStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: GenericAnnotationInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseGenericAnnotations(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `PHP Generic Annotation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with generics: ${results.length}\nTotal @template tags: ${results.reduce((s, r) => s + r.templateTags.length, 0)}\nTotal @extends generic: ${results.reduce((s, r) => s + r.extendsGeneric.length, 0)}\nTotal @implements generic: ${results.reduce((s, r) => s + r.implementsGeneric.length, 0)}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpGenericAnnotationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_generic_annotations', description: 'Detect PHPDoc generic/template annotations: @template T, @extends Collection<T>, @implements Iterator<K,V>, @return Collection<Entity>, missing @psalm/@phpstan-template warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_generic_annotation_stats', description: 'PHP generic annotation statistics: file count, @template/@extends/@implements counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
