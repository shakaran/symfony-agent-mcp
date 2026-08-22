import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DtoOutputInfo {
  file: string;
  class: string;
  outputClass?: string;
  hasOutputTransformer: boolean;
  hasStateProcessor: boolean;
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

function parseDtoOutput(filePath: string, appPath: string): DtoOutputInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('ApiResource') && !content.includes('output:')) return null;
  if (content.includes('namespace ApiPlatform\\')) return null;
  // Check for output: DTO class in ApiResource attribute
  const outputM = /output\s*:\s*([A-Za-z][\w\\]{1,150}::class|'[^']{1,200}'|"[^"]{1,200}")/.exec(content);
  if (!outputM && !content.includes('output: false') && !content.includes('OutputDataTransformerInterface')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;
  let outputClass: string | undefined;
  if (outputM) outputClass = outputM[1].replace('::class', '').trim();
  const hasOutputTransformer = content.includes('OutputDataTransformerInterface') || content.includes('DataTransformerInterface');
  const hasStateProcessor = content.includes('ProcessorInterface') || content.includes('processor:');
  const issues: string[] = [];
  if (outputClass && outputClass !== 'false' && !hasOutputTransformer && !hasStateProcessor) {
    issues.push(`output: ${outputClass} without OutputDataTransformerInterface or state processor — transformation logic not detected`);
  }
  if (content.includes('output: false') && content.includes('normalization_context')) {
    issues.push('output: false with normalization_context — normalization context is ignored when output is false');
  }
  return { file: path.relative(appPath, filePath), class: classM[1], outputClass, hasOutputTransformer, hasStateProcessor, issues };
}

export function listApiDtoOutput(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: DtoOutputInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseDtoOutput(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No API Platform output DTO configuration found.' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `API Platform DTO Output\n${'='.repeat(55)}\n\nResources: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.class}  output: ${r.outputClass ?? '(default)'}  transformer: ${r.hasOutputTransformer ? 'yes' : 'no'}  processor: ${r.hasStateProcessor ? 'yes' : 'no'}  (${r.file})\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiDtoOutputStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DtoOutputInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseDtoOutput(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `API Platform DTO Output Statistics\n${'='.repeat(40)}\n\n`;
    text += `Resources with output config: ${results.length}\n  With explicit output class: ${results.filter(r => r.outputClass && r.outputClass !== 'false').length}\n  output: false: ${results.filter(r => r.outputClass === 'false').length}\n  With transformer: ${results.filter(r => r.hasOutputTransformer).length}\n  With state processor: ${results.filter(r => r.hasStateProcessor).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiDtoOutputTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_platform_dto_output', description: 'Detect API Platform output: DTO classes in #[ApiResource], OutputDataTransformerInterface implementations, output: false with normalization_context warning, missing transformer warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_platform_dto_output_stats', description: 'API Platform DTO output statistics: resource count, explicit output class count, output:false count, transformer/processor coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
