import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SegmentAnalyticsInfo {
  file: string;
  type: 'identify' | 'track' | 'flush' | 'pii' | 'config';
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

/**
 * Returns true if the event name uses snake_case or camelCase instead of Title Case.
 * Title Case words start with uppercase and contain no underscores.
 * Examples of bad: "order_completed", "orderCompleted"
 * Examples of good: "Order Completed"
 */
function isNonTitleCase(eventName: string): boolean {
  if (eventName.includes('_')) return true;
  // camelCase: lowercase first char with uppercase somewhere in middle
  if (/^[a-z][a-zA-Z0-9]* [A-Z]/.test(eventName)) return false;
  if (/^[a-z]/.test(eventName)) return true;
  return false;
}

function buildSegmentAnalyticsInfos(appPath: string): SegmentAnalyticsInfo[] {
  const results: SegmentAnalyticsInfo[] = [];

  // Check composer.json for Segment package
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (composerContent.includes('segmentio/analytics-php')) {
      results.push({ file: 'composer.json', type: 'config', issues: ['segmentio/analytics-php detected'] });
    }
  }

  // Scan src/**/*.php for Segment usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('->identify(') &&
      !content.includes('->track(') &&
      !content.includes('->flush(') &&
      !content.includes('Analytics::init(')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const fileIssues: SegmentAnalyticsInfo[] = [];

    // Hardcoded write key in Analytics::init() instead of env var
    if (content.includes('Analytics::init(')) {
      const initMatches = [...content.matchAll(/Analytics::init\s*\(\s*['"]([^'"]{8,})['"]/g)];
      for (const match of initMatches) {
        const rawKey = match[1];
        // If it looks like a real key (not an env var reference)
        if (
          !rawKey.startsWith('getenv') &&
          !rawKey.startsWith('%env(') &&
          rawKey.length >= 8
        ) {
          results.push({
            file: relFile,
            type: 'config',
            issues: [
              `Hardcoded Segment write key in ${relFile}: Analytics::init('***') — use getenv('SEGMENT_WRITE_KEY') or env var instead`,
            ],
          });
          break;
        }
      }
      // Also check for getenv usage as safe pattern — no issue
      if (!content.includes('getenv') && !content.includes('$_ENV') && !content.includes('%env(')) {
        if (!initMatches.length) {
          // Analytics::init() found but no string literal match — still flag if no env usage
          results.push({
            file: relFile,
            type: 'config',
            issues: [
              `Analytics::init() in ${relFile} does not use getenv/env var — ensure write key is injected via environment, not hardcoded`,
            ],
          });
        }
      }
    }

    // identify() without anonymousId or userId
    if (content.includes('->identify([')) {
      const identifyMatches = [...content.matchAll(/->identify\s*\(\s*\[/g)];
      for (const match of identifyMatches) {
        const after = content.slice(match.index ?? 0, (match.index ?? 0) + 600);
        if (!after.includes('anonymousId') && !after.includes('userId')) {
          fileIssues.push({
            file: relFile,
            type: 'identify',
            issues: [
              `identify() call in ${relFile} missing 'anonymousId' or 'userId' — Segment spec requires at least one; calls without either are dropped`,
            ],
          });
          break;
        }
      }
    }

    // PII in properties array: detect keys like email, phone, ssn, credit_card
    const piiKeys = ['email', 'phone', 'ssn', 'credit_card', 'creditCard', 'social_security', 'dob', 'date_of_birth'];
    const propertiesMatches = [...content.matchAll(/['"]properties['"]\s*=>\s*\[([^]]{0,800})/g)];
    for (const pMatch of propertiesMatches) {
      const propBlock = pMatch[1];
      const foundPii = piiKeys.filter((k) => propBlock.includes(`'${k}'`) || propBlock.includes(`"${k}"`));
      if (foundPii.length > 0) {
        fileIssues.push({
          file: relFile,
          type: 'pii',
          issues: [
            `PII key(s) in properties in ${relFile}: ${foundPii.join(', ')} — avoid sending PII to Segment; use pseudonymized identifiers and scrub sensitive fields`,
          ],
        });
        break;
      }
    }

    // track() event name not in Title Case
    if (content.includes('->track(')) {
      const trackMatches = [...content.matchAll(/->track\s*\(\s*\[\s*['"]event['"]\s*=>\s*['"]([^'"]+)['"]/g)];
      for (const match of trackMatches) {
        const eventName = match[1];
        if (isNonTitleCase(eventName)) {
          fileIssues.push({
            file: relFile,
            type: 'track',
            issues: [
              `track() event name '${eventName}' in ${relFile} is not Title Case — Segment convention is 'Object Action' e.g. 'Order Completed', 'User Signed Up'`,
            ],
          });
          break;
        }
      }
    }

    // Missing flush() in files that use track()/identify()
    if ((content.includes('->track(') || content.includes('->identify(')) && !content.includes('->flush(')) {
      fileIssues.push({
        file: relFile,
        type: 'flush',
        issues: [
          `No ->flush() call in ${relFile} — track()/identify() events are queued; call ->flush() in a shutdown handler or end of request to ensure delivery`,
        ],
      });
    }

    results.push(...fileIssues);
  }

  return results;
}

export function listSegmentAnalytics(appPath: string): McpToolResult {
  try {
    const infos = buildSegmentAnalyticsInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Segment analytics integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Segment Analytics Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSegmentAnalyticsStats(appPath: string): McpToolResult {
  try {
    const infos = buildSegmentAnalyticsInfos(appPath);
    let text = `Segment Analytics Statistics\n${'='.repeat(40)}\n\n`;
    text += `Identify patterns: ${infos.filter((i) => i.type === 'identify').length}\n`;
    text += `Track patterns:    ${infos.filter((i) => i.type === 'track').length}\n`;
    text += `Flush patterns:    ${infos.filter((i) => i.type === 'flush').length}\n`;
    text += `PII patterns:      ${infos.filter((i) => i.type === 'pii').length}\n`;
    text += `Config patterns:   ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Total issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSegmentAnalyticsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_segment_analytics',
      description: 'Analyze Segment analytics integration: detect segmentio/analytics-php in composer.json, identify() missing anonymousId/userId, PII keys (email/phone/ssn/credit_card) in properties, missing flush() in files using track/identify, track() event names not in Title Case, hardcoded write key in Analytics::init() (key value masked)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_segment_analytics_stats',
      description: 'Statistics for Segment analytics: identify/track/flush/pii/config pattern counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
