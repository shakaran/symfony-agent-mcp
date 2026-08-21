/**
 * PHP Error Handling Inspector
 *
 * Scans src/ PHP files for error handling patterns:
 *   - set_error_handler(), set_exception_handler(), register_shutdown_function()
 *   - error_reporting() calls
 *   - @ operator (error suppression) usage
 *   - trigger_error() calls
 *   - try/catch(Exception $e) {} (empty catch — swallowed exception)
 *   - catching Throwable without logging
 *
 * Warns about:
 *   - @ error suppression operator (silences errors)
 *   - empty catch block (exception swallowed)
 *   - catching Throwable without at least logging
 *   - register_shutdown_function in service (called on every request)
 *   - error_reporting(0) (all errors silenced)
 *   - set_error_handler that doesn't chain to previous handler
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ErrorHandlingInfo {
  file: string;
  hasSetErrorHandler: boolean;
  hasSetExceptionHandler: boolean;
  hasShutdownFunction: boolean;
  suppressionCount: number;
  emptyCatchCount: number;
  silentThrowableCount: number;
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

function countMatches(content: string, pattern: RegExp): number {
  return (content.match(pattern) ?? []).length;
}

function countEmptyCatches(content: string): number {
  // Match catch(...) { } with only whitespace/comments inside
  let count = 0;
  const catchPattern = /\bcatch\s*\([^)]{1,200}\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = catchPattern.exec(content)) !== null) {
    const start = m.index + m[0].length;
    const end = Math.min(content.length, start + 500);
    const body = content.substring(start, end);
    const closeIdx = body.indexOf('}');
    if (closeIdx === -1) continue;
    const innerBody = body.substring(0, closeIdx).trim();
    // Remove single-line comments
    const stripped = innerBody.replace(/\/\/[^\n]{0,200}/g, '').replace(/\/\*[\s\S]{0,200}\*\//g, '').trim();
    if (stripped === '') count++;
  }
  return count;
}

function countSilentThrowable(content: string): number {
  // Match: catch (Throwable $e) { ... } without log/error/dump call
  let count = 0;
  const throwablePattern = /\bcatch\s*\(\s*Throwable\s+\$\w{1,80}\s*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = throwablePattern.exec(content)) !== null) {
    let depth = 0;
    let idx = m.index + m[0].length - 1;
    const end = Math.min(content.length, idx + 2000);
    let body = '';
    for (; idx < end; idx++) {
      if (content[idx] === '{') depth++;
      else if (content[idx] === '}') {
        depth--;
        if (depth === 0) { body = content.substring(m.index + m[0].length, idx); break; }
      }
    }
    const hasLogging = /\b(?:log|logger|error|exception|dump|syslog|error_log|throw)\b/i.test(body);
    if (!hasLogging) count++;
  }
  return count;
}

function analyzeFile(filePath: string): ErrorHandlingInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasSetErrorHandler = /\bset_error_handler\s*\(/.test(content);
  const hasSetExceptionHandler = /\bset_exception_handler\s*\(/.test(content);
  const hasShutdownFunction = /\bregister_shutdown_function\s*\(/.test(content);
  const hasTriggerError = /\btrigger_error\s*\(/.test(content);
  const hasErrorReporting = /\berror_reporting\s*\(/.test(content);

  if (!hasSetErrorHandler && !hasSetExceptionHandler && !hasShutdownFunction &&
      !hasTriggerError && !hasErrorReporting &&
      !content.includes('@') && !content.includes('catch')) {
    return null;
  }

  // Count @ suppression operator (not inside strings — heuristic)
  const suppressionCount = countMatches(content, /(?<!['"=!<>])@[a-zA-Z_\\$]/g);

  const emptyCatchCount = countEmptyCatches(content);
  const silentThrowableCount = countSilentThrowable(content);

  const issues: string[] = [];
  const relPath = path.basename(filePath);

  if (suppressionCount > 0) {
    issues.push(`${relPath}: ${suppressionCount} @ error suppression operator(s) — silences PHP errors including notices`);
  }
  if (emptyCatchCount > 0) {
    issues.push(`${relPath}: ${emptyCatchCount} empty catch block(s) — exception(s) silently swallowed`);
  }
  if (silentThrowableCount > 0) {
    issues.push(`${relPath}: ${silentThrowableCount} Throwable caught without logging`);
  }
  if (hasShutdownFunction) {
    // Warn if it appears to be inside a class method (service context)
    if (/\bfunction\s+\w{1,80}\s*\([^)]{0,200}\)[^{]{0,50}\{[\s\S]{0,2000}register_shutdown_function/.test(content)) {
      issues.push(`${relPath}: register_shutdown_function() inside a class method — may register repeatedly for each instantiation`);
    }
  }
  if (hasErrorReporting && /\berror_reporting\s*\(\s*0\s*\)/.test(content)) {
    issues.push(`${relPath}: error_reporting(0) — all PHP errors silenced`);
  }
  if (hasSetErrorHandler) {
    // Check if the handler calls the previous handler
    const handlerBody = /set_error_handler\s*\(\s*(?:function\s*\([^)]{0,200}\)|[^,)]{1,100})([\s\S]{0,1000})/.exec(content);
    if (handlerBody && !handlerBody[1].includes('$previous') && !handlerBody[1].includes('call_user_func')) {
      issues.push(`${relPath}: set_error_handler() — handler may not chain to previous handler`);
    }
  }

  if (!hasSetErrorHandler && !hasSetExceptionHandler && !hasShutdownFunction &&
      !hasTriggerError && !hasErrorReporting &&
      suppressionCount === 0 && emptyCatchCount === 0 && silentThrowableCount === 0) {
    return null;
  }

  return {
    file: relPath,
    hasSetErrorHandler,
    hasSetExceptionHandler,
    hasShutdownFunction,
    suppressionCount,
    emptyCatchCount,
    silentThrowableCount,
    issues,
  };
}

function scanErrorHandling(appPath: string): ErrorHandlingInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: ErrorHandlingInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = analyzeFile(file);
    if (info) results.push(info);
  }
  return results.sort((a, b) => b.issues.length - a.issues.length);
}

export function listPhpErrorHandling(appPath: string): McpToolResult {
  try {
    const infos = scanErrorHandling(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No notable error handling patterns detected in src/.\n\nBest practices:\n  - Avoid @ error suppression operator\n  - Always log in catch(Throwable) blocks\n  - Register shutdown functions only at bootstrap level',
        }],
      };
    }

    let text = `PHP Error Handling Analysis\n${'='.repeat(55)}\n`;
    let totalIssues = 0;

    for (const info of infos) {
      const flags: string[] = [];
      if (info.hasSetErrorHandler) flags.push('set_error_handler');
      if (info.hasSetExceptionHandler) flags.push('set_exception_handler');
      if (info.hasShutdownFunction) flags.push('shutdown_function');
      if (info.suppressionCount > 0) flags.push(`${info.suppressionCount}x@`);
      if (info.emptyCatchCount > 0) flags.push(`${info.emptyCatchCount}x empty_catch`);
      if (info.silentThrowableCount > 0) flags.push(`${info.silentThrowableCount}x silent_throwable`);

      text += `\n${info.file}\n`;
      text += `  Patterns: ${flags.join(', ')}\n`;
      for (const issue of info.issues) {
        text += `  WARNING: ${issue}\n`;
        totalIssues++;
      }
    }

    text += `\nTotal warnings: ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpErrorHandlingStats(appPath: string): McpToolResult {
  try {
    const infos = scanErrorHandling(appPath);

    let text = `PHP Error Handling Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files analyzed:               ${infos.length}\n`;
    text += `  set_error_handler:          ${infos.filter((i) => i.hasSetErrorHandler).length}\n`;
    text += `  set_exception_handler:      ${infos.filter((i) => i.hasSetExceptionHandler).length}\n`;
    text += `  register_shutdown_function: ${infos.filter((i) => i.hasShutdownFunction).length}\n`;
    text += `Total @ suppressions:         ${infos.reduce((s, i) => s + i.suppressionCount, 0)}\n`;
    text += `Total empty catches:          ${infos.reduce((s, i) => s + i.emptyCatchCount, 0)}\n`;
    text += `Silent Throwable catches:     ${infos.reduce((s, i) => s + i.silentThrowableCount, 0)}\n`;
    text += `Total warnings:               ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpErrorHandlingTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_error_handling',
      description: 'Analyze PHP error handling in src/: detect @ suppression operator, empty catch blocks (swallowed exceptions), Throwable caught without logging, register_shutdown_function in services, error_reporting(0), set_error_handler not chaining to previous handler',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_error_handling_stats',
      description: 'Statistics for PHP error handling: file count, set_error_handler/set_exception_handler/shutdown_function usage, total @ suppressions, empty catches, silent Throwable catches, total warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
