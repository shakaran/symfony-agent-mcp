import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TransformerInfo {
  class: string;
  file: string;
  hasTransform: boolean;
  hasReverseTransform: boolean;
  isImplementer: boolean;
  addedAsModel: number;
  addedAsView: number;
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

function parseTransformer(filePath: string, appPath: string): TransformerInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const isTransformer = content.includes('DataTransformerInterface') || content.includes('addModelTransformer') || content.includes('addViewTransformer');
  if (!isTransformer) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const hasTransform = content.includes('function transform(');
  const hasReverseTransform = content.includes('function reverseTransform(');
  const isImplementer = content.includes('DataTransformerInterface');
  const addedAsModel = [...content.matchAll(/->addModelTransformer\s*\(/g)].length;
  const addedAsView = [...content.matchAll(/->addViewTransformer\s*\(/g)].length;
  const issues: string[] = [];
  if (isImplementer && !hasTransform) issues.push('DataTransformerInterface without transform() method');
  if (isImplementer && !hasReverseTransform) issues.push('DataTransformerInterface without reverseTransform() — form submit will fail');
  if (isImplementer && hasReverseTransform) {
    const revM = /function reverseTransform[^{]*\{([\s\S]{0,400})/.exec(content);
    if (revM && !revM[1].includes('TransformationFailedException') && !revM[1].includes('throw')) {
      issues.push('reverseTransform() without TransformationFailedException on invalid input');
    }
  }
  return { class: classM[1], file: path.relative(appPath, filePath), hasTransform, hasReverseTransform, isImplementer, addedAsModel, addedAsView, issues };
}

export function listFormTransformers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const transformers: TransformerInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const t = parseTransformer(file, appPath);
      if (t) transformers.push(t);
    }
    if (transformers.length === 0) return { content: [{ type: 'text', text: 'No DataTransformerInterface implementations found.' }] };
    const totalIssues = transformers.reduce((s, t) => s + t.issues.length, 0);
    let text = `Form Data Transformers\n${'='.repeat(55)}\n\nTransformers: ${transformers.length}  Issues: ${totalIssues}\n`;
    for (const t of transformers.sort((a, b) => b.issues.length - a.issues.length)) {
      const usage = `model: ${t.addedAsModel}  view: ${t.addedAsView}`;
      text += `\n  ${t.class}  ${usage}  (${t.file})\n`;
      for (const i of t.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFormTransformerStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const transformers: TransformerInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const t = parseTransformer(file, appPath);
        if (t) transformers.push(t);
      }
    }
    let text = `Form Transformer Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transformers: ${transformers.length}\n`;
    text += `  With transform(): ${transformers.filter((t) => t.hasTransform).length}\n`;
    text += `  With reverseTransform(): ${transformers.filter((t) => t.hasReverseTransform).length}\n`;
    text += `  As model transformer: ${transformers.reduce((s, t) => s + t.addedAsModel, 0)}\n`;
    text += `  As view transformer: ${transformers.reduce((s, t) => s + t.addedAsView, 0)}\n`;
    text += `Issues: ${transformers.reduce((s, t) => s + t.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFormTransformerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_form_transformers', description: 'Show DataTransformerInterface implementations: transform()/reverseTransform() presence, addModelTransformer/addViewTransformer usage, missing reverseTransform warning, reverseTransform without TransformationFailedException', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_form_transformer_stats', description: 'Show form transformer statistics: transformer count, transform/reverseTransform adoption, model/view transformer usage counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
