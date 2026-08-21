import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RedisPubsubPatternInfo {
  file: string;
  line: number;
  fn: string;
  channel: string | null;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

const SENSITIVE_PATTERNS = ['password', 'secret', 'token', 'api_key', 'apikey', 'credential', 'passwd', 'pwd'];

function hasSensitivePayload(line: string): boolean {
  const lower = line.toLowerCase();
  return SENSITIVE_PATTERNS.some((p) => lower.includes(p));
}

function extractChannel(line: string, fn: string): string | null {
  // Match ->publish($channel, ...) or ->subscribe($channel) etc.
  const pattern = new RegExp(`->${fn}\\s*\\(\\s*([^,)]{1,80})`);
  const m = pattern.exec(line);
  if (!m) return null;
  return m[1].trim().replace(/['"]/g, '').slice(0, 80);
}

function isWebRequestFile(content: string): boolean {
  // Heuristics: controllers, actions, Symfony request handlers
  return (
    content.includes('AbstractController') ||
    content.includes('extends Controller') ||
    content.includes('ControllerInterface') ||
    content.includes('Request $request') ||
    content.includes('use Symfony\\Component\\HttpFoundation\\Request') ||
    content.includes('#[Route(') ||
    content.includes('@Route(')
  );
}

function scanPhpFiles(dir: string, base: string, callback: (filePath: string, content: string) => void): void {
  if (!fs.existsSync(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        scanPhpFiles(full, base, callback);
      } else if (entry.isFile() && entry.name.endsWith('.php')) {
        const content = safeRead(full, base);
        if (content) callback(full, content);
      }
    }
  } catch { /* skip */ }
}

function buildRedisPubsubPatternInfos(appPath: string): RedisPubsubPatternInfo[] {
  const results: RedisPubsubPatternInfo[] = [];
  const srcDir = path.join(appPath, 'src');

  const pubsubFns = ['publish', 'subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe'];

  scanPhpFiles(srcDir, appPath, (filePath, content) => {
    // Quick pre-filter
    const hasPubsub = pubsubFns.some((fn) => content.includes(`->${fn}(`));
    if (!hasPubsub) return;

    const relFile = path.relative(appPath, filePath);
    const inWebContext = isWebRequestFile(content);
    const lines = content.split('\n');

    lines.forEach((lineText, idx) => {
      const lineNum = idx + 1;

      for (const fn of pubsubFns) {
        const callPattern = new RegExp(`->\\s*${fn}\\s*\\(`);
        if (!callPattern.test(lineText)) continue;

        const channel = extractChannel(lineText, fn);
        let issue: string | null = null;

        if (fn === 'subscribe' && inWebContext) {
          issue = `->subscribe() called in web request context in "${relFile}" line ${lineNum} — subscribe() is a blocking call that holds the connection open; move to a dedicated CLI worker (Symfony console command or Messenger consumer) to avoid exhausting request pool`;
        } else if (fn === 'psubscribe') {
          // Check for wildcard
          const hasWildcard = channel !== null && channel.includes('*');
          if (hasWildcard) {
            issue = `->psubscribe() with wildcard pattern "${channel}" in "${relFile}" line ${lineNum} — wildcard pattern subscriptions match all channels and generate O(N) overhead on every PUBLISH; use specific channel prefixes or switch to Streams for fan-out`;
          }
        } else if (fn === 'publish') {
          // Channel injection risk — user input in channel name
          const channelHasInput = channel !== null && (
            channel.includes('$_GET') ||
            channel.includes('$_POST') ||
            channel.includes('$request') ||
            channel.includes('getParameter') ||
            channel.includes('->get(') ||
            channel.includes('input') ||
            channel.includes('->query')
          );
          if (channelHasInput) {
            issue = `->publish() channel name "${channel}" in "${relFile}" line ${lineNum} appears to include user input — channel name injection can allow unauthorized pub/sub interception; validate and whitelist channel names`;
          } else if (hasSensitivePayload(lineText)) {
            issue = `->publish() in "${relFile}" line ${lineNum} payload may include sensitive data (password/token/secret) — do not publish raw credentials to Redis channels; encrypt or omit sensitive fields from pub/sub messages`;
          } else {
            // Check for missing error handling
            const surroundingContext = lines.slice(Math.max(0, idx - 5), Math.min(lines.length, idx + 5)).join('\n');
            const hasTryCatch = surroundingContext.includes('try') || surroundingContext.includes('catch');
            if (!hasTryCatch) {
              issue = `->publish() in "${relFile}" line ${lineNum} without surrounding try/catch — Redis connection failures are silent; wrap publish calls in try/catch to handle \\RedisException and Predis\\Connection\\ConnectionException`;
            }
          }
        }

        results.push({ file: relFile, line: lineNum, fn, channel, issue });
      }
    });
  });

  return results;
}

export function listRedisPubsubPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildRedisPubsubPatternInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Redis PUBLISH/SUBSCRIBE patterns found in src/.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Redis PUBLISH/SUBSCRIBE Pattern Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n\n`;
    for (const info of infos) {
      text += `[${info.fn.toUpperCase()}] ${info.file}:${info.line}\n`;
      if (info.channel) text += `  Channel: ${info.channel}\n`;
      if (info.issue) text += `  ISSUE: ${info.issue}\n`;
      text += '\n';
    }
    if (issues.length > 0) {
      text += `Issues Summary (${issues.length}):\n`;
      for (const info of issues) {
        text += `  - [${info.file}:${info.line}] ${info.fn}: ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error scanning Redis pub/sub patterns: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getRedisPubsubPatternsStats(appPath: string): McpToolResult {
  try {
    const infos = buildRedisPubsubPatternInfos(appPath);
    const byFn: Record<string, number> = {};
    for (const i of infos) {
      byFn[i.fn] = (byFn[i.fn] ?? 0) + 1;
    }
    const issues = infos.filter((i) => i.issue !== null);
    const files = new Set(infos.map((i) => i.file));
    const lines = [
      `Redis Pub/Sub Pattern Stats`,
      `===========================`,
      `Total patterns  : ${infos.length}`,
      `Files affected  : ${files.size}`,
      ...Object.entries(byFn).map(([fn, count]) => `  ${fn.padEnd(14)}: ${count}`),
      `Issues          : ${issues.length}`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getRedisPubsubPatternsTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_redis_pubsub_patterns',
      description: 'Scan src/**/*.php for Redis PUBLISH/SUBSCRIBE patterns (Predis or PhpRedis). Detects blocking subscribe() in web request context, wildcard psubscribe() performance risk, channel name injection with user input, sensitive data in payloads, and missing error handling around publish().',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
    {
      name: 'get_redis_pubsub_patterns_stats',
      description: 'Return summary statistics for Redis pub/sub pattern usage: total patterns by function type, files affected, and issue count.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
  ];
}
