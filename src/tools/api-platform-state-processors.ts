import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface StateProcessorInfo {
  class: string;
  file: string;
  handledTypes: string[];
  hasPersist: boolean;
  hasRemove: boolean;
  hasTransactionManagement: boolean;
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

function parseStateProcessor(filePath: string, appPath: string): StateProcessorInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('ProcessorInterface') && !content.includes('StateProcessorInterface')) return null;
  if (!content.includes('ApiPlatform') && !content.includes('api_platform')) return null;
  if (content.includes('namespace ApiPlatform\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const typePattern = /Process\s+Data\s+if\s+\$data\s+instanceof\s+(\w+)|instanceof\s+(\w+)/g;
  const handledTypes: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = typePattern.exec(content)) !== null) {
    const t = m[1] ?? m[2];
    if (t && !['array', 'string', 'int', 'bool'].includes(t)) handledTypes.push(t);
  }
  const hasPersist = content.includes('->persist(') || content.includes('->flush(');
  const hasRemove = content.includes('->remove(');
  const hasTransactionManagement = content.includes('beginTransaction') || content.includes('->commit(') || content.includes('->rollback(');
  const issues: string[] = [];
  if (hasPersist && !content.includes('->flush(')) issues.push('persist() without flush() — entity will not be saved to database');
  if (!content.includes('function process(')) issues.push('Missing process() method — StateProcessorInterface requires process(mixed $data, Operation $operation, array $uriVariables, array $context): void|mixed');
  return { class: classM[1], file: path.relative(appPath, filePath), handledTypes: [...new Set(handledTypes)], hasPersist, hasRemove, hasTransactionManagement, issues };
}

export function listApiPlatformStateProcessors(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const processors: StateProcessorInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const p = parseStateProcessor(file, appPath);
      if (p) processors.push(p);
    }
    if (processors.length === 0) return { content: [{ type: 'text', text: 'No API Platform StateProcessorInterface implementations found.\n\nExample:\n  class CreateBookProcessor implements ProcessorInterface {\n    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): Book {\n      $this->em->persist($data); $this->em->flush();\n      return $data;\n    }\n  }' }] };
    const totalIssues = processors.reduce((s, p) => s + p.issues.length, 0);
    let text = `API Platform State Processors\n${'='.repeat(55)}\n\nProcessors: ${processors.length}  Issues: ${totalIssues}\n`;
    for (const p of processors.sort((a, b) => b.issues.length - a.issues.length)) {
      const ops = [p.hasPersist ? 'persist+flush' : '', p.hasRemove ? 'remove' : '', p.hasTransactionManagement ? 'tx' : ''].filter(Boolean).join('  ');
      text += `\n  ${p.class}  ${ops || 'no persistence'}  (${p.file})\n`;
      for (const i of p.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiPlatformStateProcessorStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const processors: StateProcessorInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const p = parseStateProcessor(file, appPath);
        if (p) processors.push(p);
      }
    }
    let text = `API Platform State Processor Statistics\n${'='.repeat(40)}\n\n`;
    text += `Processors: ${processors.length}\n  With persist+flush: ${processors.filter((p) => p.hasPersist).length}\n  With remove: ${processors.filter((p) => p.hasRemove).length}\n  With transactions: ${processors.filter((p) => p.hasTransactionManagement).length}\nIssues: ${processors.reduce((s, p) => s + p.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiPlatformStateProcessorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_platform_state_processors', description: 'Show API Platform StateProcessorInterface implementations: persist/flush/remove detection, transaction management, missing process() warning, persist without flush warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_platform_state_processor_stats', description: 'Show API Platform state processor statistics: processor count, persist/remove/transaction counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
