import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface IdempotencyInfo {
  file: string;
  type: 'key' | 'storage' | 'replay' | 'middleware';
  pattern: string;
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

function buildIdempotencyInfos(appPath: string): IdempotencyInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: IdempotencyInfo[] = [];

  let hasIdempotencyBundle = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['andreo/symfony-idempotency-bundle'] || req['andreo/idempotency']) hasIdempotencyBundle = true;
    } catch { /* ignore */ }
  }

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    const hasIdempotencyKey = content.includes("'Idempotency-Key'") || content.includes('"Idempotency-Key"') ||
      content.includes("'X-Idempotency-Key'") || content.includes('"X-Idempotency-Key"') ||
      content.includes('idempotency_key') || content.includes('idempotencyKey');

    if (!hasIdempotencyKey) continue;

    const hasStorage = content.includes('$cache') || content.includes('$redis') || content.includes('$repository') ||
      content.includes('IdempotentRequest') || content.includes('->set($idempotency') || content.includes('->set($key');

    const hasReplay = content.includes('if ($cached)') || content.includes('if (null !== $cached)') ||
      content.includes('return $cached') || content.includes('return $response');

    const hasValidation = content.includes('empty(') || content.includes('strlen(') || content.includes('->count()') ||
      content.includes('!$key') || content.includes('assert(');

    if (!hasStorage) {
      issues.push('Idempotency key read but not stored — key not enforced; duplicate requests will be processed again');
    }

    if (hasStorage && !hasReplay) {
      issues.push('Idempotency key stored but no replay logic — stored key is unused; duplicate requests still processed');
    }

    const noTtl = hasStorage && !content.includes('ttl') && !content.includes('TTL') && !content.includes('expiresAt') &&
      !content.includes('expire');
    if (noTtl) {
      issues.push('Idempotency key storage without TTL — keys accumulate forever (use 24h or 7d depending on SLA)');
    }

    if (!hasValidation) {
      issues.push('Idempotency key not validated — empty key string accepted (all empty-key requests share the same idempotency state)');
    }

    const methodCheck = content.includes("'POST'") || content.includes('"POST"') || content.includes("isMethod(");
    if (!methodCheck) {
      issues.push('Idempotency key check without HTTP method filter — GET requests are inherently idempotent and should not use idempotency keys');
    }

    const type = hasStorage && hasReplay ? 'replay' : hasStorage ? 'storage' : 'key';
    results.push({ file: relFile, type, pattern: 'Idempotency-Key header', issues });
  }

  if (!hasIdempotencyBundle && results.length > 0) {
    results.unshift({ file: 'composer.json', type: 'middleware', pattern: 'idempotency library', issues: ['Manual idempotency implementation — consider andreo/symfony-idempotency-bundle for RFC-compliant idempotency'] });
  }

  return results;
}

export function listApiIdempotency(appPath: string): McpToolResult {
  try {
    const infos = buildIdempotencyInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No API idempotency key patterns found (no Idempotency-Key or X-Idempotency-Key header handling).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `API Idempotency Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiIdempotencyStats(appPath: string): McpToolResult {
  try {
    const infos = buildIdempotencyInfos(appPath);
    let text = `Idempotency Statistics\n${'='.repeat(40)}\n\n`;
    text += `Key handlers:  ${infos.filter((i) => i.type === 'key').length}\n`;
    text += `With storage:  ${infos.filter((i) => i.type === 'storage').length}\n`;
    text += `With replay:   ${infos.filter((i) => i.type === 'replay').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiIdempotencyTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_idempotency', description: 'Detect API idempotency key patterns; warns on key read but not stored, storage without replay, no TTL, empty key not validated, key on GET requests', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_idempotency_stats', description: 'Statistics for idempotency: key/storage/replay count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
