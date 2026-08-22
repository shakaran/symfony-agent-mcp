import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface NormalizerInfo {
  file: string;
  class: string;
  isNormalizer: boolean;
  isDenormalizer: boolean;
  hasSupportsNormalization: boolean;
  hasSupportsDenormalization: boolean;
  hasApiPlatformContext: boolean;
  hasCacheableSupports: boolean;
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

function parseNormalizer(filePath: string, appPath: string): NormalizerInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const isNormalizer = content.includes('NormalizerInterface') || content.includes('NormalizerAwareInterface');
  const isDenormalizer = content.includes('DenormalizerInterface') || content.includes('DenormalizerAwareInterface');
  if (!isNormalizer && !isDenormalizer) return null;
  if (content.includes('namespace Symfony\\Component\\Serializer\\') || content.includes('namespace ApiPlatform\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;
  const hasSupportsNormalization = content.includes('supportsNormalization');
  const hasSupportsDenormalization = content.includes('supportsDenormalization');
  const hasApiPlatformContext = content.includes('api_platform') || content.includes('ALREADY_CALLED') || content.includes('normalization_context');
  const hasCacheableSupports = content.includes('hasCacheableSupportsMethod') || content.includes('getSupportedTypes');
  const issues: string[] = [];
  if (isNormalizer && !hasSupportsNormalization) issues.push('NormalizerInterface without supportsNormalization() — normalizer applies to all types');
  if (isDenormalizer && !hasSupportsDenormalization) issues.push('DenormalizerInterface without supportsDenormalization() — denormalizer applies to all types');
  if (!hasCacheableSupports) issues.push('Missing getSupportedTypes() (Symfony 6.3+) or hasCacheableSupportsMethod() — serializer cache disabled for this normalizer');
  if (!hasApiPlatformContext) issues.push('No API Platform context check detected — ensure this normalizer targets the right normalization context');
  return { file: path.relative(appPath, filePath), class: classM[1], isNormalizer, isDenormalizer, hasSupportsNormalization, hasSupportsDenormalization, hasApiPlatformContext, hasCacheableSupports, issues };
}

export function listApiCustomNormalizers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const normalizers: NormalizerInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const n = parseNormalizer(f, appPath);
      if (n) normalizers.push(n);
    }
    if (normalizers.length === 0) return { content: [{ type: 'text', text: 'No custom normalizers/denormalizers found.' }] };
    const totalIssues = normalizers.reduce((s, n) => s + n.issues.length, 0);
    let text = `API Platform Custom Normalizers\n${'='.repeat(55)}\n\nNormalizers: ${normalizers.length}  Issues: ${totalIssues}\n`;
    for (const n of normalizers.sort((a, b) => b.issues.length - a.issues.length)) {
      const role = [n.isNormalizer ? 'normalizer' : '', n.isDenormalizer ? 'denormalizer' : ''].filter(Boolean).join('+');
      text += `\n  ${n.class}  ${role}  cache: ${n.hasCacheableSupports ? 'yes' : 'no'}  (${n.file})\n`;
      for (const i of n.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiCustomNormalizerStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const normalizers: NormalizerInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const n = parseNormalizer(f, appPath);
        if (n) normalizers.push(n);
      }
    }
    let text = `Custom Normalizer Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total: ${normalizers.length}\n  Normalizers: ${normalizers.filter(n => n.isNormalizer).length}\n  Denormalizers: ${normalizers.filter(n => n.isDenormalizer).length}\n  Both: ${normalizers.filter(n => n.isNormalizer && n.isDenormalizer).length}\n  With cacheable supports: ${normalizers.filter(n => n.hasCacheableSupports).length}\nIssues: ${normalizers.reduce((s, n) => s + n.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiCustomNormalizerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_platform_custom_normalizers', description: 'Detect custom NormalizerInterface/DenormalizerInterface: supportsNormalization/supportsDenormalization presence, getSupportedTypes cache method, API Platform context check', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_platform_custom_normalizer_stats', description: 'Custom normalizer statistics: normalizer/denormalizer/both counts, cacheable support coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
