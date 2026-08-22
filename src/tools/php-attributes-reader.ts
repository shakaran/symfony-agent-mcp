import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface AttributeReaderUsage {
  file: string;
  class?: string;
  getAttributesCount: number;
  newReflectionClassCount: number;
  hasInstanceOfCheck: boolean;
  hasGetArguments: boolean;
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

function parseAttributeReader(filePath: string, appPath: string): AttributeReaderUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('getAttributes') && !content.includes('ReflectionAttribute')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const getAttributesCount = [...content.matchAll(/->getAttributes\s*\(/g)].length;
  const newReflectionClassCount = [...content.matchAll(/new\s+\\?ReflectionClass\s*\(/g)].length;
  if (getAttributesCount + newReflectionClassCount === 0) return null;
  const hasInstanceOfCheck = content.includes('instanceof') && (content.includes('ReflectionAttribute') || content.includes('getAttributes'));
  const hasGetArguments = content.includes('->getArguments(') || content.includes('->newInstance(');
  const issues: string[] = [];
  if (getAttributesCount > 0 && !content.includes('::class') && !content.includes('getAttribute(')) issues.push('getAttributes() without class filter — consider getAttributes(MyAttribute::class) to avoid iterating all attributes');
  if (newReflectionClassCount > 0 && !content.includes('cache') && !content.includes('Cache')) issues.push('ReflectionClass created without caching — reflection is expensive; cache results per class');
  return { file: path.relative(appPath, filePath), class: classM?.[1], getAttributesCount, newReflectionClassCount, hasInstanceOfCheck, hasGetArguments, issues };
}

export function listPhpAttributesReader(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: AttributeReaderUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseAttributeReader(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No runtime ReflectionAttribute reading found.\n\nExample:\n  $attrs = (new \\ReflectionClass($obj))->getAttributes(MyAttr::class);\n  foreach ($attrs as $attr) {\n    $instance = $attr->newInstance();\n  }' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `PHP ReflectionAttribute Reader\n${'='.repeat(55)}\n\nFiles: ${usages.length}  Issues: ${totalIssues}\n`;
    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${u.class ?? '(file)'}  getAttributes: ${u.getAttributesCount}  ReflectionClass: ${u.newReflectionClassCount}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpAttributesReaderStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: AttributeReaderUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseAttributeReader(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `PHP Attributes Reader Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files: ${usages.length}\n  getAttributes() calls: ${usages.reduce((s, u) => s + u.getAttributesCount, 0)}\n  ReflectionClass: ${usages.reduce((s, u) => s + u.newReflectionClassCount, 0)}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpAttributesReaderTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_attributes_reader', description: 'Show runtime PHP ReflectionAttribute reading: getAttributes() usage, ReflectionClass instantiation, missing class filter warning, missing cache warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_attributes_reader_stats', description: 'Show PHP attributes reader statistics: file count, getAttributes/ReflectionClass call counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
