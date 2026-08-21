/**
 * PHP Deserialization Gadget Chain Inspector
 *
 * Scans src/**\/*.php for PHP deserialization gadget chain risks:
 * 1. unserialize() called with user-controlled data (HIGH)
 * 2. unserialize() without allowed_classes parameter (MEDIUM)
 * 3. Magic methods __wakeup/__destruct/__toString/__call with dangerous sinks (HIGH)
 * 4. serialize() output stored in cookie without HMAC (MEDIUM)
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DeserializationGadgetInfo {
  file: string;
  line: number;
  pattern: string;
  severity: 'high' | 'medium' | 'low';
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

function analyseDeserializationFile(content: string, relFile: string): DeserializationGadgetInfo[] {
  const infos: DeserializationGadgetInfo[] = [];
  const lines = content.split('\n');

  // Pattern 1: unserialize() with user-controlled data (HIGH)
  const userSources = [
    '$_GET',
    '$_POST',
    '$_COOKIE',
    '$_SESSION',
    'file_get_contents',
    'base64_decode',
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bunserialize\s*\(/.test(line)) {
      for (const source of userSources) {
        if (line.includes(source)) {
          infos.push({
            file: relFile,
            line: i + 1,
            pattern: 'unserialize-user-data',
            severity: 'high',
            issue: `unserialize() called with ${source} — user-controlled data fed to unserialize() enables arbitrary object injection and gadget chain exploitation`,
          });
          break;
        }
      }
      // Also look back a few lines for variable assigned from user sources
      const priorBlock = lines.slice(Math.max(0, i - 6), i).join('\n');
      const unserializeMatch = /\bunserialize\s*\(\s*(\$\w+)/.exec(line);
      if (unserializeMatch) {
        const varName = unserializeMatch[1];
        for (const source of userSources) {
          if (priorBlock.includes(source) && priorBlock.includes(varName)) {
            const alreadyReported = infos.some((inf) => inf.file === relFile && inf.line === i + 1 && inf.pattern === 'unserialize-user-data');
            if (!alreadyReported) {
              infos.push({
                file: relFile,
                line: i + 1,
                pattern: 'unserialize-user-data',
                severity: 'high',
                issue: `unserialize() called with variable assigned from ${source} — user-controlled data enables gadget chain exploitation`,
              });
            }
            break;
          }
        }
      }
    }
  }

  // Pattern 2: unserialize() without allowed_classes parameter (MEDIUM)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bunserialize\s*\(/.test(line)) {
      // Check if second argument with allowed_classes is absent
      const hasAllowedClasses = line.includes('allowed_classes') || line.includes("'allowed_classes'") || line.includes('"allowed_classes"');
      // Also check if there is a second argument at all (simple heuristic: comma inside the unserialize call)
      const unserializeCallMatch = /\bunserialize\s*\(([^)]*)\)/.exec(line);
      const hasSecondArg = unserializeCallMatch
        ? (unserializeCallMatch[1].includes(',') || hasAllowedClasses)
        : false;
      if (!hasAllowedClasses && !hasSecondArg) {
        const alreadyReported = infos.some((inf) => inf.file === relFile && inf.line === i + 1 && inf.pattern === 'unserialize-no-allowed-classes');
        if (!alreadyReported) {
          infos.push({
            file: relFile,
            line: i + 1,
            pattern: 'unserialize-no-allowed-classes',
            severity: 'medium',
            issue: 'unserialize() called without allowed_classes option (PHP 7.0+) — pass [\'allowed_classes\' => false] or a whitelist to restrict object instantiation',
          });
        }
      }
    }
  }

  // Pattern 3: Magic methods with dangerous sinks (HIGH)
  const magicMethods = ['__wakeup', '__destruct', '__toString', '__call'];
  const dangerousSinks = ['unlink', 'exec', 'system', 'file_put_contents', 'shell_exec', 'passthru', 'popen', 'proc_open', 'eval'];

  let inMagicMethod = false;
  let currentMagicMethod = '';
  let braceDepth = 0;
  let methodStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inMagicMethod) {
      for (const magic of magicMethods) {
        if (line.includes(`function ${magic}`)) {
          inMagicMethod = true;
          currentMagicMethod = magic;
          braceDepth = 0;
          methodStartLine = i + 1;
          break;
        }
      }
    }

    if (inMagicMethod) {
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }

      for (const sink of dangerousSinks) {
        if (line.includes(`${sink}(`) || line.includes(`${sink} (`)) {
          infos.push({
            file: relFile,
            line: i + 1,
            pattern: 'magic-method-gadget-sink',
            severity: 'high',
            issue: `${currentMagicMethod}() (starting line ${methodStartLine}) contains dangerous sink ${sink}() — this magic method can be exploited as a gadget chain endpoint via deserialization`,
          });
        }
      }

      if (braceDepth <= 0 && line.includes('}')) {
        inMagicMethod = false;
        currentMagicMethod = '';
      }
    }
  }

  // Pattern 4: serialize() output stored in cookie without HMAC (MEDIUM)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bserialize\s*\(/.test(line)) {
      // Look ahead and behind for setcookie near serialize
      const windowStart = Math.max(0, i - 5);
      const windowEnd = Math.min(lines.length - 1, i + 10);
      const window = lines.slice(windowStart, windowEnd + 1).join('\n');

      if (window.includes('setcookie')) {
        // Check if HMAC/signature is present
        const hasHmac = /hmac|hash_hmac|hash\s*\(|sha[0-9]|signature|sign/.test(window);
        if (!hasHmac) {
          infos.push({
            file: relFile,
            line: i + 1,
            pattern: 'serialize-cookie-no-hmac',
            severity: 'medium',
            issue: 'serialize() output stored in cookie without HMAC signature — attacker can forge serialized data; use hash_hmac() to sign before storing in cookie',
          });
        }
      }
    }
  }

  return infos;
}

function buildDeserializationGadgetInfos(appPath: string): DeserializationGadgetInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: DeserializationGadgetInfo[] = [];
  const files = collectPhpFiles(srcDir, appPath);
  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    const infos = analyseDeserializationFile(content, path.relative(appPath, file));
    results.push(...infos);
  }
  return results;
}

export function listPhpDeserializationGadget(appPath: string): McpToolResult {
  try {
    const infos = buildDeserializationGadgetInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP deserialization gadget chain risks found in src/.' }] };
    }
    let text = `PHP Deserialization Gadget Chain Risks\n${'='.repeat(50)}\n\nTotal: ${infos.length}\n\n`;
    for (const info of infos) {
      text += `  [${info.severity.toUpperCase()}] [${info.pattern}] ${info.file}:${info.line}\n`;
      text += `    ${info.issue}\n\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDeserializationGadgetStats(appPath: string): McpToolResult {
  try {
    const infos = buildDeserializationGadgetInfos(appPath);
    const stats = {
      total: infos.length,
      filesAffected: new Set(infos.map((i) => i.file)).size,
      bySeverity: { high: 0, medium: 0, low: 0 } as Record<string, number>,
      byPattern: {} as Record<string, number>,
    };
    for (const i of infos) {
      stats.bySeverity[i.severity] = (stats.bySeverity[i.severity] ?? 0) + 1;
      stats.byPattern[i.pattern] = (stats.byPattern[i.pattern] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpDeserializationGadgetTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Absolute path to the Symfony application root' } };
  return [
    {
      name: 'list_php_deserialization_gadget',
      description: 'Scan PHP source files for deserialization gadget chain risks: unserialize() with user-controlled data (HIGH), missing allowed_classes option (MEDIUM), magic methods with dangerous sinks (HIGH), serialize() in cookies without HMAC (MEDIUM)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_deserialization_gadget_stats',
      description: 'Statistics for PHP deserialization gadget chain risks: total findings, files affected, counts by severity and by pattern name',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
