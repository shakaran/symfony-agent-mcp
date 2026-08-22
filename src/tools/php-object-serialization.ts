import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ObjectSerializationInfo {
  file: string;
  type: 'serialize' | 'unserialize' | 'json_encode' | 'json_decode';
  issues: string[];
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full, base));
    } else if (entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

function buildObjectSerializationInfos(appPath: string): ObjectSerializationInfo[] {
  const results: ObjectSerializationInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);

  for (const file of files) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasSerialize = content.includes('serialize(');
    const hasUnserialize = content.includes('unserialize(');
    const hasJsonEncode = content.includes('json_encode(');
    const hasJsonDecode = content.includes('json_decode(');
    const hasSleep = content.includes('__sleep') || content.includes('__wakeup');
    const hasSerializeMagic = content.includes('__serialize') || content.includes('__unserialize');
    const hasSerializableInterface = content.includes('implements Serializable') || content.includes('implements \\Serializable');

    if (!hasSerialize && !hasUnserialize && !hasJsonEncode && !hasJsonDecode &&
        !hasSleep && !hasSerializeMagic && !hasSerializableInterface) continue;

    // Check unserialize
    if (hasUnserialize) {
      const issues: string[] = [];
      // Check for user input near unserialize
      const unIdx = content.indexOf('unserialize(');
      if (unIdx !== -1) {
        const surroundingSlice = content.slice(Math.max(0, unIdx - 400), Math.min(content.length, unIdx + 200));
        if (surroundingSlice.includes('$_GET') || surroundingSlice.includes('$_POST') ||
            surroundingSlice.includes('$_REQUEST') || surroundingSlice.includes('$_COOKIE') ||
            surroundingSlice.includes('$request->')) {
          issues.push('CRITICAL: unserialize() with user-supplied data — use json_decode() instead or whitelist allowed_classes');
        } else {
          issues.push('unserialize() detected — ensure data source is trusted; add allowed_classes option to restrict deserialization');
        }
      }
      // Check for allowed_classes option
      if (!content.includes('allowed_classes')) {
        issues.push('unserialize() missing allowed_classes option — add [\'allowed_classes\' => false] or specify allowed class list');
      }
      results.push({ file: path.relative(appPath, file), type: 'unserialize', issues });
    }

    // Check serialize for data storage
    if (hasSerialize && !hasUnserialize) {
      const issues: string[] = [];
      // Heuristic: serialize used without json_encode suggests persistent storage
      if (!hasJsonEncode) {
        issues.push('serialize() used for data storage — prefer json_encode() for portability and readability');
      } else {
        issues.push('serialize() detected — use json_encode() for data exchange; reserve serialize() for PHP-internal caching only');
      }
      results.push({ file: path.relative(appPath, file), type: 'serialize', issues });
    }

    // Check __sleep/__wakeup magic methods
    if (hasSleep) {
      const issues: string[] = [];
      if (content.includes('__sleep')) {
        issues.push('__sleep() magic method — consider migrating to __serialize() (PHP 7.4+) for better control');
      }
      if (content.includes('__wakeup')) {
        issues.push('__wakeup() magic method — consider migrating to __unserialize() (PHP 7.4+)');
      }
      results.push({ file: path.relative(appPath, file), type: 'serialize', issues });
    }

    // Check Serializable interface
    if (hasSerializableInterface) {
      const issues: string[] = [];
      issues.push('Serializable interface is deprecated since PHP 8.1 — implement __serialize()/__unserialize() instead');
      results.push({ file: path.relative(appPath, file), type: 'serialize', issues });
    }

    // Check json_decode without error handling
    if (hasJsonDecode) {
      const issues: string[] = [];
      if (!content.includes('json_last_error') && !content.includes('JSON_THROW_ON_ERROR')) {
        issues.push('json_decode() without JSON_THROW_ON_ERROR or json_last_error() check — add error handling for invalid JSON input');
      }
      results.push({ file: path.relative(appPath, file), type: 'json_decode', issues });
    }
  }

  return results;
}

export function listPhpObjectSerialization(appPath: string): McpToolResult {
  try {
    const infos = buildObjectSerializationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP object serialization patterns found.' }] };
    }
    const lines = infos.map(i =>
      `${i.file} [${i.type}]\n  Issues: ${i.issues.length > 0 ? i.issues.join('; ') : 'none'}`
    );
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpObjectSerializationStats(appPath: string): McpToolResult {
  try {
    const infos = buildObjectSerializationInfos(appPath);
    const stats = {
      total: infos.length,
      byType: {} as Record<string, number>,
      withIssues: infos.filter(i => i.issues.length > 0).length,
      criticalIssues: infos.filter(i => i.issues.some(s => s.startsWith('CRITICAL'))).length,
    };
    for (const i of infos) {
      stats.byType[i.type] = (stats.byType[i.type] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpObjectSerializationTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_php_object_serialization',
      description: 'List PHP object serialization patterns: serialize/unserialize, json_encode/decode, __sleep/__wakeup, Serializable interface — flags unserialize with user input, missing allowed_classes, deprecated Serializable interface.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    },
    {
      name: 'get_php_object_serialization_stats',
      description: 'Get statistics for PHP serialization patterns: total occurrences by type, count with issues, critical security findings.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    }
  ];
}
