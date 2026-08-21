/**
 * Symfony Serializer Encoders Inspector
 *
 * Scans src/ PHP for classes implementing EncoderInterface, DecoderInterface, or both.
 * Checks supportsEncoding()/supportsDecoding() signatures.
 * Scans for context key usage: json_encode_options, xml_root_node_name, csv_delimiter, etc.
 *
 * Warns about:
 *   - EncoderInterface without corresponding DecoderInterface (asymmetric codec)
 *   - supportsEncoding() always returning true (overrides built-in encoders)
 *   - Encoder not registered with serializer.encoder tag
 *   - json_encode_options without JSON_THROW_ON_ERROR (silent errors)
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

interface EncoderInfo {
  file: string;
  class: string;
  supportsEncoding: boolean;
  supportsDecoding: boolean;
  formats: string[];
  hasSerializerTag: boolean;
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

const CONTEXT_KEYS = [
  'json_encode_options',
  'xml_root_node_name',
  'xml_encoding',
  'csv_delimiter',
  'yaml_inline',
  'yaml_indent',
];

function parseEncoderFile(filePath: string, appPath: string): EncoderInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  const hasEncoder = content.includes('EncoderInterface');
  const hasDecoder = content.includes('DecoderInterface');
  if (!hasEncoder && !hasDecoder) return null;
  if (content.includes('namespace Symfony\\Component\\Serializer')) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;

  const supportsEncoding = hasEncoder && content.includes('supportsEncoding(');
  const supportsDecoding = hasDecoder && content.includes('supportsDecoding(');
  const issues: string[] = [];

  // Check asymmetric codec
  if (hasEncoder && !hasDecoder) {
    issues.push('Implements EncoderInterface without DecoderInterface — asymmetric codec may cause serializer inconsistencies');
  }
  if (hasDecoder && !hasEncoder) {
    issues.push('Implements DecoderInterface without EncoderInterface — asymmetric codec (decoder-only)');
  }

  // Check supportsEncoding always returning true
  const supEncodingBlock = /function\s+supportsEncoding\s*\([^)]{0,100}\)[^{]{0,50}\{([^}]{0,300})\}/.exec(content);
  if (supEncodingBlock && /return\s+true\s*;/.test(supEncodingBlock[1])) {
    issues.push('supportsEncoding() always returns true — this overrides all built-in encoders and may break JSON/XML/CSV serialization');
  }

  // Check serializer.encoder tag
  const hasSerializerTag = content.includes('serializer.encoder') ||
    content.includes('#[AsTaggedItem') ||
    content.includes("tag: 'serializer.encoder'") ||
    content.includes('tag: serializer.encoder');

  if (!hasSerializerTag) {
    issues.push('Encoder not tagged as serializer.encoder — must be registered via attribute or services.yaml for auto-registration');
  }

  // Detect formats from supportsEncoding
  const formats: string[] = [];
  const formatRe = /supportsEncoding[^{]{0,100}\{[^}]{0,300}['"]([a-z]{1,20})['"]/g;
  let fm: RegExpExecArray | null;
  while ((fm = formatRe.exec(content)) !== null) {
    if (!formats.includes(fm[1])) formats.push(fm[1]);
  }

  // Check context key usage
  for (const key of CONTEXT_KEYS) {
    if (content.includes(key)) {
      if (key === 'json_encode_options' && !content.includes('JSON_THROW_ON_ERROR')) {
        issues.push("json_encode_options context key used without JSON_THROW_ON_ERROR — json_encode() errors will be silent");
      }
    }
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM[1],
    supportsEncoding,
    supportsDecoding,
    formats,
    hasSerializerTag,
    issues,
  };
}

function loadEncoderInfos(appPath: string): EncoderInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: EncoderInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseEncoderFile(f, appPath);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

export function listSerializerEncoders(appPath: string): McpToolResult {
  try {
    const encoders = loadEncoderInfos(appPath);

    if (encoders.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom serializer encoders found in src/.\n\nCreate one:\n  use Symfony\\Component\\Serializer\\Encoder\\EncoderInterface;\n  use Symfony\\Component\\Serializer\\Encoder\\DecoderInterface;\n\n  class CsvEncoder implements EncoderInterface, DecoderInterface {\n    public function encode(mixed $data, string $format, array $context = []): string { ... }\n    public function supportsEncoding(string $format): bool { return $format === \'csv\'; }\n    public function decode(string $data, string $format, array $context = []): mixed { ... }\n    public function supportsDecoding(string $format): bool { return $format === \'csv\'; }\n  }',
        }],
      };
    }

    const codecs = encoders.filter((e) => e.supportsEncoding && e.supportsDecoding);
    const encoderOnly = encoders.filter((e) => e.supportsEncoding && !e.supportsDecoding);
    const decoderOnly = encoders.filter((e) => !e.supportsEncoding && e.supportsDecoding);
    const withIssues = encoders.filter((e) => e.issues.length > 0);

    let text = `Serializer Encoders/Decoders (${encoders.length})\n${'='.repeat(55)}\n`;
    text += `  Full codecs (encode+decode): ${codecs.length}\n`;
    text += `  Encoder-only:                ${encoderOnly.length}\n`;
    text += `  Decoder-only:                ${decoderOnly.length}\n`;

    for (const enc of encoders) {
      const type = enc.supportsEncoding && enc.supportsDecoding ? 'codec' :
        enc.supportsEncoding ? 'encoder' : 'decoder';
      const fmts = enc.formats.length > 0 ? `  formats: [${enc.formats.join(', ')}]` : '';
      const tag = enc.hasSerializerTag ? '' : '  [untagged]';
      text += `\n  ${enc.class.padEnd(45)}  (${type})${tag}${fmts}\n`;
      text += `    ${enc.file}\n`;
      for (const issue of enc.issues) {
        text += `    WARN: ${issue}\n`;
      }
    }

    if (withIssues.length > 0) {
      text += `\nEncoders with issues: ${withIssues.length}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSerializerEncoderStats(appPath: string): McpToolResult {
  try {
    const encoders = loadEncoderInfos(appPath);

    let text = `Serializer Encoder Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total encoders/decoders: ${encoders.length}\n`;
    text += `  Full codecs:           ${encoders.filter((e) => e.supportsEncoding && e.supportsDecoding).length}\n`;
    text += `  Encoder-only:          ${encoders.filter((e) => e.supportsEncoding && !e.supportsDecoding).length}\n`;
    text += `  Decoder-only:          ${encoders.filter((e) => !e.supportsEncoding && e.supportsDecoding).length}\n`;
    text += `Tagged serializer.encoder: ${encoders.filter((e) => e.hasSerializerTag).length}\n`;
    text += `Untagged:                ${encoders.filter((e) => !e.hasSerializerTag).length}\n`;
    text += `With issues:             ${encoders.filter((e) => e.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSerializerEncoderTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_serializer_encoders',
      description: 'List custom Symfony serializer encoders/decoders: EncoderInterface/DecoderInterface implementations, supported formats, serializer.encoder tag check, asymmetric codec warnings, supportsEncoding always-true detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_serializer_encoder_stats',
      description: 'Show serializer encoder statistics: total count, full codec vs encoder-only vs decoder-only split, tagged vs untagged, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
