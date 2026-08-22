import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface SerializationContextInfo {
  class: string;
  file: string;
  normalizationGroups: string[][];
  denormalizationGroups: string[][];
  hasCustomNormalizer: boolean;
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

function parseSerializationContext(filePath: string, appPath: string): SerializationContextInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('normalizationContext') && !content.includes('denormalizationContext')) return null;
  if (!content.includes('ApiResource') && !content.includes('GetCollection') && !content.includes('Post') && !content.includes('Put')) return null;
  if (content.includes('namespace ApiPlatform\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const normPattern = /normalizationContext\s*:\s*\[[^\]]{0,400}\]/g;
  const normalizationGroups: string[][] = [];
  let m: RegExpExecArray | null;
  while ((m = normPattern.exec(content)) !== null) {
    const groupsM = /groups\s*:\s*\[([^\]]{0,300})\]/i.exec(m[0]);
    if (groupsM) {
      const groups = groupsM[1].replace(/['"]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      normalizationGroups.push(groups);
    }
  }
  const denormPattern = /denormalizationContext\s*:\s*\[[^\]]{0,400}\]/g;
  const denormalizationGroups: string[][] = [];
  while ((m = denormPattern.exec(content)) !== null) {
    const groupsM = /groups\s*:\s*\[([^\]]{0,300})\]/i.exec(m[0]);
    if (groupsM) {
      const groups = groupsM[1].replace(/['"]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      denormalizationGroups.push(groups);
    }
  }
  const hasCustomNormalizer = content.includes('NormalizerInterface') || content.includes('DenormalizerInterface');
  const issues: string[] = [];
  const allNormGroups = normalizationGroups.flat();
  const allDenormGroups = denormalizationGroups.flat();
  if (allNormGroups.length === 0 && normalizationGroups.length > 0) issues.push('normalizationContext without groups — all properties serialized; define groups to control output shape');
  if (allDenormGroups.length === 0 && denormalizationGroups.length > 0) issues.push('denormalizationContext without groups — all properties writable; define groups to prevent mass assignment');
  return { class: classM[1], file: path.relative(appPath, filePath), normalizationGroups, denormalizationGroups, hasCustomNormalizer, issues };
}

export function listApiPlatformSerializationContexts(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const resources: SerializationContextInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = parseSerializationContext(file, appPath);
      if (r) resources.push(r);
    }
    if (resources.length === 0) return { content: [{ type: 'text', text: 'No API Platform normalizationContext/denormalizationContext found.' }] };
    const totalIssues = resources.reduce((s, r) => s + r.issues.length, 0);
    let text = `API Platform Serialization Context\n${'='.repeat(55)}\n\nResources: ${resources.length}  Issues: ${totalIssues}\n`;
    for (const r of resources.sort((a, b) => b.issues.length - a.issues.length)) {
      const normGroups = r.normalizationGroups.flat();
      const denGroups = r.denormalizationGroups.flat();
      text += `\n  ${r.class}  norm groups: ${normGroups.length}  denorm groups: ${denGroups.length}  (${r.file})\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiPlatformSerializationContextStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const resources: SerializationContextInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseSerializationContext(file, appPath);
        if (r) resources.push(r);
      }
    }
    let text = `API Platform Serialization Context Statistics\n${'='.repeat(40)}\n\n`;
    text += `Resources: ${resources.length}\n  With normalizationContext: ${resources.filter((r) => r.normalizationGroups.length > 0).length}\n  With denormalizationContext: ${resources.filter((r) => r.denormalizationGroups.length > 0).length}\nIssues: ${resources.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiPlatformSerializationContextTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_platform_serialization_contexts', description: 'Show API Platform normalizationContext/denormalizationContext: serialization groups per operation, missing groups warning (all-properties serialized/writable)', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_platform_serialization_context_stats', description: 'Show API Platform serialization context statistics: resource count, normalization/denormalization context coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
