import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface TimingAttackInfo {
  file: string;
  line: number;
  pattern: string;
  issue: string;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

const SENSITIVE_KEYWORDS = /password|token|secret|hmac|signature|hash|nonce|api_key/i;
const HASH_FUNCTIONS = /hash\s*\(|hash_hmac\s*\(|md5\s*\(|sha1\s*\(/;
const COMPARISON_OPS = /===?/;

function classifyTimingLine(line: string, lineNum: number, relFile: string): TimingAttackInfo | null {
  const trimmed = line.trim();

  // Skip comment lines
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return null;

  // Skip safe functions
  if (trimmed.includes('password_verify(') || trimmed.includes('sodium_crypto_auth_verify(')) return null;

  // Skip already-safe hash_equals usage
  if (trimmed.includes('hash_equals(')) return null;

  // Pattern 1: strcmp/strncmp used for secret comparison (timing-vulnerable)
  if ((trimmed.includes('strcmp(') || trimmed.includes('strncmp(')) && SENSITIVE_KEYWORDS.test(trimmed)) {
    return {
      file: relFile,
      line: lineNum,
      pattern: 'strcmp-secret',
      issue: 'strcmp()/strncmp() used for secret/token/HMAC comparison — these functions are not constant-time and leak length via early exit; use hash_equals() instead',
    };
  }

  // Pattern 2: == or === comparison where one side is a hash/hmac/md5/sha1 call
  if (COMPARISON_OPS.test(trimmed) && SENSITIVE_KEYWORDS.test(trimmed) && HASH_FUNCTIONS.test(trimmed)) {
    return {
      file: relFile,
      line: lineNum,
      pattern: 'hash-comparison',
      issue: 'Direct == / === comparison of hash() / hash_hmac() / md5() / sha1() result — use hash_equals() for constant-time HMAC/digest verification to prevent timing attacks',
    };
  }

  // Pattern 3: == or === comparison involving a variable whose name matches sensitive keywords
  // Look for $varname == or == $varname where varname contains a sensitive word
  if (COMPARISON_OPS.test(trimmed) && SENSITIVE_KEYWORDS.test(trimmed)) {
    return {
      file: relFile,
      line: lineNum,
      pattern: 'secret-comparison',
      issue: 'Direct == / === comparison involving a sensitive variable (password/token/secret/hmac/signature/nonce/api_key) — use hash_equals() for constant-time string comparison',
    };
  }

  return null;
}

function buildTimingAttackInfos(appPath: string): TimingAttackInfo[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);
  const results: TimingAttackInfo[] = [];

  for (const filePath of files) {
    const content = safeRead(filePath, appPath);
    if (content === null) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const info = classifyTimingLine(lines[i], i + 1, relFile);
      if (info !== null) results.push(info);
    }
  }

  return results;
}

export function listPhpTimingAttack(appPath: string): McpToolResult {
  try {
    const infos = buildTimingAttackInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No timing attack vulnerabilities found in src/.' }] };
    }

    let text = `PHP Timing Attack Vulnerability Analysis\n${'='.repeat(55)}\n\n`;
    text += `Total findings: ${infos.length}\n\n`;

    for (const info of infos) {
      text += `  [${info.pattern}] ${info.file}:${info.line}\n`;
      text += `    ${info.issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpTimingAttackStats(appPath: string): McpToolResult {
  try {
    const infos = buildTimingAttackInfos(appPath);

    const byPattern: Record<string, number> = {
      'strcmp-secret': 0,
      'hash-comparison': 0,
      'secret-comparison': 0,
    };
    for (const info of infos) {
      byPattern[info.pattern] = (byPattern[info.pattern] ?? 0) + 1;
    }
    const filesAffected = new Set(infos.map((i) => i.file)).size;

    let text = `PHP Timing Attack Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings:       ${infos.length}\n`;
    text += `Files affected:       ${filesAffected}\n\n`;
    text += `By pattern:\n`;
    text += `  strcmp-secret:      ${byPattern['strcmp-secret']}\n`;
    text += `  hash-comparison:    ${byPattern['hash-comparison']}\n`;
    text += `  secret-comparison:  ${byPattern['secret-comparison']}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpTimingAttackTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_timing_attack',
      description: 'Scan PHP source for timing attack vulnerabilities: non-constant-time comparisons of passwords, tokens, HMAC signatures, and hash digests — flags strcmp/strncmp on secrets and direct == / === on hash() / hash_hmac() / md5() / sha1() results',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_timing_attack_stats',
      description: 'Statistics for PHP timing attack findings: total count, files affected, and breakdown by pattern (strcmp-secret, hash-comparison, secret-comparison)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
