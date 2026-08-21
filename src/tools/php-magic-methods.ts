/**
 * PHP Magic Method Inspector
 *
 * Scans src/ PHP for magic method declarations:
 *   __get, __set, __isset, __unset, __call, __callStatic, __invoke,
 *   __clone, __serialize, __unserialize, __debugInfo, __toString,
 *   __sleep, __wakeup
 *
 * Detects:
 *   - Classes with __get/__set (dynamic properties)
 *   - __call/__callStatic (dynamic dispatch)
 *   - __sleep/__wakeup vs __serialize/__unserialize (old vs new serialization)
 *
 * Warns:
 *   - __get without __isset (is_null() returns wrong result)
 *   - __set without __get (write-only magic property)
 *   - __call without whitelist check
 *   - __sleep deprecated in favor of __serialize (PHP 8+)
 *   - __toString that can throw exception (PHP < 8 fatal error)
 *   - __serialize and __sleep both defined (__sleep ignored but confusing)
 *   - __debugInfo exposing sensitive data
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface PhpMagicMethodInfo {
  file: string;
  class: string;
  magicMethods: string[];
  hasDynamicProperties: boolean;
  hasDynamicDispatch: boolean;
  usesLegacySerialization: boolean;
  issues: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── Magic method constants ───────────────────────────────────────────────────

const ALL_MAGIC = [
  '__get', '__set', '__isset', '__unset',
  '__call', '__callStatic',
  '__invoke', '__clone',
  '__serialize', '__unserialize',
  '__sleep', '__wakeup',
  '__debugInfo', '__toString',
  '__construct', '__destruct',
] as const;

type MagicName = typeof ALL_MAGIC[number];

// ─── Sensitive keywords for __debugInfo ──────────────────────────────────────

const SENSITIVE_PATTERNS = ['password', 'secret', 'token', 'key', 'credential', 'auth', 'api_key'];

// ─── File analysis ────────────────────────────────────────────────────────────

function extractMagicMethods(content: string): MagicName[] {
  return ALL_MAGIC.filter((m) => {
    const re = new RegExp(`function\\s+\\${m}\\s*\\(`);
    return re.test(content);
  });
}

function extractMethodBody(content: string, methodName: string): string {
  const re = new RegExp(
    `function\\s+\\${methodName}\\s*\\([^)]{0,300}\\)[^{]{0,80}\\{([\\s\\S]{0,2000}?)\\}`,
  );
  const m = re.exec(content);
  return m ? m[1] : '';
}

function analyzeFile(filePath: string): PhpMagicMethodInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('function __')) return null;
  const classM = /\bclass\s+(\w{1,80})/.exec(content);
  if (!classM) return null;

  const magicMethods = extractMagicMethods(content);
  if (magicMethods.length === 0) return null;

  const issues: string[] = [];
  const className = classM[1];

  // __get without __isset
  if (magicMethods.includes('__get') && !magicMethods.includes('__isset')) {
    issues.push(
      `${className}::__get() defined without __isset(). ` +
      `Calls to isset($obj->prop) or is_null() on magic properties return incorrect results.`,
    );
  }

  // __set without __get
  if (magicMethods.includes('__set') && !magicMethods.includes('__get')) {
    issues.push(
      `${className}::__set() defined without __get(). ` +
      `Write-only magic properties are inaccessible — likely a bug.`,
    );
  }

  // __call without whitelist
  if (magicMethods.includes('__call')) {
    const callBody = extractMethodBody(content, '__call');
    if (!callBody.includes('match') && !callBody.includes('switch') && !callBody.includes('in_array') && !callBody.includes('array_key_exists')) {
      issues.push(
        `${className}::__call() has no apparent whitelist check (no match/switch/in_array). ` +
        `Any method name will be dispatched — consider adding a whitelist.`,
      );
    }
  }

  // __sleep deprecated in PHP 8+ in favor of __serialize
  if (magicMethods.includes('__sleep') && !magicMethods.includes('__serialize')) {
    issues.push(
      `${className}::__sleep() is deprecated in PHP 8+ in favor of __serialize(). ` +
      `Migrate to __serialize()/__unserialize() for cleaner serialization control.`,
    );
  }

  // Both __serialize and __sleep defined
  if (magicMethods.includes('__serialize') && magicMethods.includes('__sleep')) {
    issues.push(
      `${className} defines both __serialize() and __sleep(). ` +
      `PHP 8+ uses only __serialize() — __sleep() is silently ignored, which is confusing.`,
    );
  }

  // __toString that may throw
  if (magicMethods.includes('__toString')) {
    const toStringBody = extractMethodBody(content, '__toString');
    if (toStringBody.includes('throw ')) {
      issues.push(
        `${className}::__toString() may throw an exception. ` +
        `In PHP < 8 this causes a fatal error. PHP 8+ allows it but it can still be surprising.`,
      );
    }
  }

  // __debugInfo with sensitive data exposure
  if (magicMethods.includes('__debugInfo')) {
    const debugBody = extractMethodBody(content, '__debugInfo');
    const sensitiveFound = SENSITIVE_PATTERNS.filter((p) =>
      new RegExp(p, 'i').test(debugBody),
    );
    if (sensitiveFound.length > 0) {
      issues.push(
        `${className}::__debugInfo() may expose sensitive data (found: ${sensitiveFound.join(', ')}). ` +
        `Ensure credentials/tokens are masked in debug output.`,
      );
    }
  }

  const hasDynamicProperties = magicMethods.includes('__get') || magicMethods.includes('__set');
  const hasDynamicDispatch   = magicMethods.includes('__call') || magicMethods.includes('__callStatic');
  const usesLegacySerialization = magicMethods.includes('__sleep') || magicMethods.includes('__wakeup');

  return {
    file: path.basename(filePath),
    class: className,
    magicMethods: magicMethods as string[],
    hasDynamicProperties,
    hasDynamicDispatch,
    usesLegacySerialization,
    issues,
  };
}

function loadAll(appPath: string): PhpMagicMethodInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: PhpMagicMethodInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = analyzeFile(file);
    if (info) results.push(info);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpMagicMethods(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHP magic methods found in src/.\n\n' +
            'Magic methods like __get, __set, __call add dynamic behavior but can hide bugs.',
        }],
      };
    }

    const withIssues   = items.filter((i) => i.issues.length > 0);
    const dynProps     = items.filter((i) => i.hasDynamicProperties);
    const dynDispatch  = items.filter((i) => i.hasDynamicDispatch);
    const legacySerial = items.filter((i) => i.usesLegacySerialization);

    let text = `PHP Magic Method Analysis\n${'='.repeat(55)}\n`;
    text += `  Classes with magic methods: ${items.length}\n`;
    text += `  Dynamic properties:         ${dynProps.length}\n`;
    text += `  Dynamic dispatch:           ${dynDispatch.length}\n`;
    text += `  Legacy serialization:       ${legacySerial.length}\n`;
    text += `  With issues:                ${withIssues.length}\n\n`;

    for (const item of items) {
      text += `${item.class} [${item.file}]\n`;
      text += `  magic methods: ${item.magicMethods.join(', ')}\n`;
      if (item.hasDynamicProperties) text += `  [dynamic-properties]`;
      if (item.hasDynamicDispatch)   text += `  [dynamic-dispatch]`;
      if (item.usesLegacySerialization) text += `  [legacy-serialization]`;
      if (item.hasDynamicProperties || item.hasDynamicDispatch || item.usesLegacySerialization) text += '\n';
      for (const issue of item.issues) {
        text += `  WARN: ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpMagicMethodStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    let text = `PHP Magic Method Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with magic methods: ${items.length}\n`;
    text += `Dynamic properties:         ${items.filter((i) => i.hasDynamicProperties).length}\n`;
    text += `Dynamic dispatch:           ${items.filter((i) => i.hasDynamicDispatch).length}\n`;
    text += `Legacy serialization:       ${items.filter((i) => i.usesLegacySerialization).length}\n`;
    text += `Uses __invoke:              ${items.filter((i) => i.magicMethods.includes('__invoke')).length}\n`;
    text += `Uses __toString:            ${items.filter((i) => i.magicMethods.includes('__toString')).length}\n`;
    text += `Uses __debugInfo:           ${items.filter((i) => i.magicMethods.includes('__debugInfo')).length}\n`;
    text += `With issues:                ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpMagicMethodTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_php_magic_methods',
      description: 'List PHP magic method usage: __get/__set/__call/__serialize detection, missing __isset warnings, legacy serialization, __toString exception risk',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_php_magic_method_stats',
      description: 'Show PHP magic method statistics: dynamic properties/dispatch counts, legacy serialization, __invoke/__toString/__debugInfo usage, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
