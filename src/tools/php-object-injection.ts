/**
 * PHP Object Injection Scanner
 *
 * Scans src/**\/*.php for PHP object injection vectors (injection points, not gadget chains):
 *   - unserialize() with data from $_COOKIE, HTTP headers, base64_decode($_GET[...]), base64_decode($_POST[...])
 *   - unserialize() in session handlers with externally-controlled session data
 *   - json_decode(..., false) (object mode) combined with instanceof
 *   - __PHP_Incomplete_Class patterns signaling deserialization of unknown classes
 *   - igbinary_unserialize() / msgpack_unpack() with user data
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ObjectInjectionInfo {
  file: string;
  line: number;
  pattern: string;
  issue: string;
  severity: 'critical' | 'high' | 'medium';
}

// ─── File helpers ─────────────────────────────────────────────────────────────

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

// ─── Pattern analysis ─────────────────────────────────────────────────────────

function analyzeFile(filePath: string, base: string): ObjectInjectionInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: ObjectInjectionInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

    // Pattern 1: unserialize() with cookie data
    if (/\bunserialize\s*\(/.test(line)) {
      const contextWindow = lines.slice(Math.max(0, i - 3), i + 2).join('\n');

      const hasCookieInput = /\$_COOKIE/.test(line) || /\$_COOKIE/.test(contextWindow);
      const hasHeaderInput = /getallheaders\s*\(|apache_request_headers\s*\(|\$_SERVER\s*\[\s*['"]HTTP_/.test(line) ||
        /getallheaders\s*\(|apache_request_headers\s*\(|\$_SERVER\s*\[\s*['"]HTTP_/.test(contextWindow);
      const hasBase64UserInput = /base64_decode\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)/.test(line) ||
        /base64_decode\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)/.test(contextWindow);
      const hasDirectUserInput = /\$_(GET|POST|REQUEST)/.test(line) ||
        /\$_(GET|POST|REQUEST)/.test(contextWindow);
      const hasSessionInput = /\$_SESSION/.test(line);

      if (hasCookieInput) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'unserialize-cookie',
          issue: 'unserialize() with $_COOKIE data — cookie values are attacker-controlled and can contain crafted serialized PHP objects triggering gadget chains; use JSON (json_decode) or a signed token instead',
          severity: 'critical',
        });
      } else if (hasBase64UserInput) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'unserialize-base64-user',
          issue: 'unserialize(base64_decode($_GET/$_POST/...)) — base64 encoding is not a security boundary; attacker can craft any serialized PHP object; replace with json_decode() or validate with a HMAC signature before deserializing',
          severity: 'critical',
        });
      } else if (hasHeaderInput) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'unserialize-header',
          issue: 'unserialize() with data from HTTP request headers — headers are attacker-controlled; crafted serialized objects can trigger PHP object injection / RCE via gadget chains',
          severity: 'critical',
        });
      } else if (hasDirectUserInput) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'unserialize-user-input',
          issue: 'unserialize() with direct user input ($_GET/$_POST/$_REQUEST) — allows PHP object injection; never deserialize user-supplied data with unserialize()',
          severity: 'critical',
        });
      } else if (hasSessionInput) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'unserialize-session',
          issue: 'unserialize() with $_SESSION data — if session storage is externally accessible (Redis, database) or the session ID is predictable, this could allow object injection; consider using a safe serializer or PHP session handlers with allowed_classes',
          severity: 'high',
        });
      } else {
        // General unserialize — flag for review
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'unserialize-general',
          issue: 'unserialize() detected — verify the data source is never user-controlled; if deserializing objects, pass allowed_classes parameter: unserialize($data, [\'allowed_classes\' => [MyClass::class]])',
          severity: 'medium',
        });
      }
    }

    // Pattern 2: igbinary_unserialize() with user data
    if (/\bigbinary_unserialize\s*\(/.test(line)) {
      const contextWindow = lines.slice(Math.max(0, i - 3), i + 2).join('\n');
      const hasUserInput = /\$_(GET|POST|REQUEST|COOKIE)/.test(line) ||
        /\$_(GET|POST|REQUEST|COOKIE)/.test(contextWindow);
      if (hasUserInput) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'igbinary-unserialize-user',
          issue: 'igbinary_unserialize() with user-controlled data — igbinary deserializes PHP objects and is equally vulnerable to gadget chain attacks as unserialize(); never use with user-supplied data',
          severity: 'critical',
        });
      }
    }

    // Pattern 3: msgpack_unpack() with user data
    if (/\bmsgpack_unpack\s*\(/.test(line)) {
      const contextWindow = lines.slice(Math.max(0, i - 3), i + 2).join('\n');
      const hasUserInput = /\$_(GET|POST|REQUEST|COOKIE)/.test(line) ||
        /\$_(GET|POST|REQUEST|COOKIE)/.test(contextWindow);
      if (hasUserInput) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'msgpack-unpack-user',
          issue: 'msgpack_unpack() with user-controlled data — if the MessagePack data can contain PHP object representations, this may trigger object injection',
          severity: 'high',
        });
      }
    }

    // Pattern 4: json_decode in object mode (false) combined with instanceof
    if (/\bjson_decode\s*\([^,)]{0,100},\s*false\s*[),]/.test(line) ||
        /\bjson_decode\s*\([^,)]{0,100},\s*0\s*[),]/.test(line)) {
      // Check if instanceof appears nearby
      const contextWindow = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
      if (/\binstanceof\b/.test(contextWindow)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'json-decode-object-instanceof',
          issue: 'json_decode(..., false) returns stdClass objects and instanceof is used nearby — json_decode object mode is generally safe (no custom classes) but the instanceof check will always fail for stdClass; use json_decode(..., true) for arrays or cast explicitly',
          severity: 'medium',
        });
      }
    }

    // Pattern 5: __PHP_Incomplete_Class pattern
    if (/__PHP_Incomplete_Class/.test(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'incomplete-class',
        issue: '__PHP_Incomplete_Class detected — this indicates deserialization of an object whose class was not loaded; signals that unserialize() is being called before the relevant class autoloader runs, or that unknown serialized data is being processed',
        severity: 'medium',
      });
    }
  }

  return results;
}

function loadAll(appPath: string): ObjectInjectionInfo[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);
  const results: ObjectInjectionInfo[] = [];
  for (const f of files) results.push(...analyzeFile(f, appPath));
  return results.sort((a, b) => {
    const sev: Record<string, number> = { critical: 0, high: 1, medium: 2 };
    return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3) || a.file.localeCompare(b.file) || a.line - b.line;
  });
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listPhpObjectInjection(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);
    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHP object injection vectors found in src/.\n\n' +
            'Checked: unserialize() with cookies/headers/base64 user input/session, ' +
            'igbinary_unserialize/msgpack_unpack with user data, json_decode object mode + instanceof, ' +
            '__PHP_Incomplete_Class patterns.',
        }],
      };
    }

    const critical = items.filter((i) => i.severity === 'critical');
    const high = items.filter((i) => i.severity === 'high');
    const medium = items.filter((i) => i.severity === 'medium');

    let text = `PHP Object Injection Analysis\n${'='.repeat(55)}\n\n`;
    text += `  Total findings:  ${items.length}\n`;
    text += `  Critical:        ${critical.length}\n`;
    text += `  High:            ${high.length}\n`;
    text += `  Medium:          ${medium.length}\n`;
    text += `  Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;

    for (const item of items) {
      text += `[${item.severity.toUpperCase()}] ${item.file}:${item.line}  [${item.pattern}]\n`;
      text += `  ${item.issue}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpObjectInjectionStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    const byPattern: Record<string, number> = {};
    for (const item of items) {
      byPattern[item.pattern] = (byPattern[item.pattern] ?? 0) + 1;
    }

    let text = `PHP Object Injection Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total:     ${items.length}\n`;
    text += `Critical:  ${items.filter((i) => i.severity === 'critical').length}\n`;
    text += `High:      ${items.filter((i) => i.severity === 'high').length}\n`;
    text += `Medium:    ${items.filter((i) => i.severity === 'medium').length}\n`;
    text += `Files:     ${new Set(items.map((i) => i.file)).size}\n\n`;
    text += `By pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) {
      text += `  ${pat}: ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function getPhpObjectInjectionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_object_injection',
      description: 'Scan src/**/*.php for PHP object injection vectors: unserialize() with cookie/header/base64-user-input/session data, igbinary_unserialize/msgpack_unpack with user data, json_decode object mode + instanceof, __PHP_Incomplete_Class patterns',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_object_injection_stats',
      description: 'Statistics for PHP object injection findings: total count, breakdown by severity (critical/high/medium) and pattern, files affected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
