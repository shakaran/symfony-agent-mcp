/**
 * Symfony Serializer NameConverter Inspector
 *
 * Detects NameConverterInterface implementations, CamelCaseToSnakeCaseNameConverter,
 * MetadataAwareNameConverter usage, and related configuration issues.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import * as fs from 'fs';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface NameConverterEntry {
  file: string;
  className: string;
  converterType: string;
  hasNormalize: boolean;
  hasDenormalize: boolean;
  issues: string[];
}

// ─── PHP scanning ────────────────────────────────────────────────────────────

function collectPhpFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

function detectConverterType(content: string): string {
  if (/CamelCaseToSnakeCaseNameConverter/u.test(content)) return 'CamelCaseToSnakeCaseNameConverter';
  if (/MetadataAwareNameConverter/u.test(content)) return 'MetadataAwareNameConverter';
  if (/implements\s+NameConverterInterface/u.test(content)) return 'custom';
  return 'unknown';
}

function extractClassName(content: string, file: string): string {
  const m = /class\s+(\w{1,120})/u.exec(content);
  return m ? m[1] : path.basename(file, '.php');
}

function scanPhpForNameConverters(appPath: string): NameConverterEntry[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir);
  const results: NameConverterEntry[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const isNameConverter =
      /implements\s+NameConverterInterface/u.test(content) ||
      /CamelCaseToSnakeCaseNameConverter/u.test(content) ||
      /MetadataAwareNameConverter/u.test(content) ||
      /use\s+Symfony\\Component\\Serializer\\NameConverter/u.test(content);

    if (!isNameConverter) continue;

    const className = extractClassName(content, file);
    const converterType = detectConverterType(content);
    const hasNormalize = /function\s+normalize\s*\(/u.test(content);
    const hasDenormalize = /function\s+denormalize\s*\(/u.test(content);

    const issues: string[] = [];

    if (converterType === 'custom') {
      if (!hasNormalize || !hasDenormalize) {
        issues.push(
          'NameConverter does not implement both normalize() and denormalize() — breaks round-trip serialization'
        );
      }
    }

    results.push({
      file: path.relative(appPath, file),
      className,
      converterType,
      hasNormalize,
      hasDenormalize,
      issues,
    });
  }

  return results;
}

// ─── services.yaml scanning ──────────────────────────────────────────────────

interface ServicesNameConverterInfo {
  registeredConverters: string[];
  hasDefaultContextConverter: boolean;
  hasBothCamelAndMetadata: boolean;
}

function scanServicesForNameConverters(appPath: string): ServicesNameConverterInfo {
  const candidates = [
    path.join(appPath, 'config', 'services.yaml'),
    path.join(appPath, 'config', 'services_test.yaml'),
  ];

  const registeredConverters: string[] = [];
  let hasDefaultContextConverter = false;
  let hasCamelCase = false;
  let hasMetadata = false;

  for (const candidate of candidates) {
    let raw: Record<string, unknown> | null = null;
    try {
      raw = parseYamlFile(candidate) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    if (!raw) continue;

    const text = ((): string => {
      try {
        return fs.readFileSync(candidate, 'utf8');
      } catch {
        return '';
      }
    })();

    if (/serializer\.name_converter/u.test(text)) {
      registeredConverters.push('serializer.name_converter (services.yaml)');
    }
    if (/NAME_CONVERTER/u.test(text) || /name_converter/u.test(text)) {
      hasDefaultContextConverter = true;
    }
    if (/CamelCaseToSnakeCaseNameConverter/u.test(text)) hasCamelCase = true;
    if (/MetadataAwareNameConverter/u.test(text)) hasMetadata = true;
  }

  return {
    registeredConverters,
    hasDefaultContextConverter,
    hasBothCamelAndMetadata: hasCamelCase && hasMetadata,
  };
}

// ─── Cross-reference warnings ────────────────────────────────────────────────

function applyServiceIssues(
  entries: NameConverterEntry[],
  info: ServicesNameConverterInfo
): void {
  if (info.hasBothCamelAndMetadata) {
    for (const e of entries) {
      if (
        e.converterType === 'CamelCaseToSnakeCaseNameConverter' ||
        e.converterType === 'MetadataAwareNameConverter'
      ) {
        e.issues.push(
          'CamelCaseToSnakeCaseNameConverter and MetadataAwareNameConverter are both used — they conflict; MetadataAwareNameConverter already handles camelCase conversion'
        );
      }
    }
  }

  for (const e of entries) {
    if (e.converterType === 'custom' && info.registeredConverters.length === 0) {
      e.issues.push(
        'Custom NameConverter appears not registered under serializer.name_converter in services.yaml — denormalization context may not apply it'
      );
    }
  }
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listSymfonySerializerNameConverters(appPath: string): McpToolResult {
  try {
    const entries = scanPhpForNameConverters(appPath);
    const info = scanServicesForNameConverters(appPath);
    applyServiceIssues(entries, info);

    if (entries.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony Serializer NameConverter implementations found in src/.',
        }],
      };
    }

    let text = `Symfony Serializer NameConverters  (${entries.length} found)\n${'='.repeat(60)}\n`;

    if (info.registeredConverters.length > 0) {
      text += `\nRegistered in services: ${info.registeredConverters.join(', ')}\n`;
    }
    if (info.hasDefaultContextConverter) {
      text += `Default context NAME_CONVERTER: yes\n`;
    }
    if (info.hasBothCamelAndMetadata) {
      text += `[!] Both CamelCase and MetadataAware converters detected — potential conflict\n`;
    }

    text += `\n`;

    for (const e of entries) {
      text += `  ${e.className}  [${e.converterType}]\n`;
      text += `    File:          ${e.file}\n`;
      text += `    normalize():   ${e.hasNormalize ? 'yes' : 'NO'}\n`;
      text += `    denormalize(): ${e.hasDenormalize ? 'yes' : 'NO'}\n`;
      if (e.issues.length > 0) {
        for (const issue of e.issues) {
          text += `    [!] ${issue}\n`;
        }
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

export function getSymfonySerializerNameConverterStats(appPath: string): McpToolResult {
  try {
    const entries = scanPhpForNameConverters(appPath);
    const info = scanServicesForNameConverters(appPath);
    applyServiceIssues(entries, info);

    const withIssues = entries.filter((e) => e.issues.length > 0);
    const partialImpl = entries.filter((e) => !e.hasNormalize || !e.hasDenormalize);

    let text = `Symfony Serializer NameConverter Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total converters found:  ${entries.length}\n`;
    text += `Custom implementations:  ${entries.filter((e) => e.converterType === 'custom').length}\n`;
    text += `CamelCaseToSnakeCase:    ${entries.filter((e) => e.converterType === 'CamelCaseToSnakeCaseNameConverter').length}\n`;
    text += `MetadataAware:           ${entries.filter((e) => e.converterType === 'MetadataAwareNameConverter').length}\n`;
    text += `Partial implementations: ${partialImpl.length}\n`;
    text += `Converters with issues:  ${withIssues.length}\n`;
    text += `Registered in services:  ${info.registeredConverters.length > 0 ? 'yes' : 'no'}\n`;
    text += `Conflict (camel+meta):   ${info.hasBothCamelAndMetadata ? 'YES [!]' : 'no'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getSymfonySerializerNameConverterTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_symfony_serializer_name_converters',
      description: 'Detect Symfony Serializer NameConverter implementations, check for partial implementations (missing normalize/denormalize) and conflicts between CamelCaseToSnakeCaseNameConverter and MetadataAwareNameConverter',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_symfony_serializer_name_converter_stats',
      description: 'Statistics on Symfony NameConverter implementations: count by type, partial implementations, service registration status, conflicts',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
