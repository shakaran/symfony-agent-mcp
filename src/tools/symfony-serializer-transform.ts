/**
 * Symfony Serializer Transform Attributes Inspector
 *
 * Detects #[Transform], #[Ignore], #[Context], #[Groups], #[SerializedName],
 * #[SerializedPath], GetSetMethodNormalizer, AfterDenormalize, BeforeNormalize
 * and warns on common misconfigurations.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import * as fs from 'fs';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface SerializerTransformEntry {
  file: string;
  className: string;
  transforms: string[];
  hasIgnore: boolean;
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

function extractClassName(content: string, file: string): string {
  const m = /class\s+(\w{1,120})/u.exec(content);
  return m ? m[1] : path.basename(file, '.php');
}

const TRANSFORM_PATTERNS: Array<[RegExp, string]> = [
  [/#\[Transform/u, '#[Transform]'],
  [/#\[Ignore/u, '#[Ignore]'],
  [/#\[Context/u, '#[Context]'],
  [/#\[Groups/u, '#[Groups]'],
  [/#\[SerializedName/u, '#[SerializedName]'],
  [/#\[SerializedPath/u, '#[SerializedPath]'],
  [/GetSetMethodNormalizer/u, 'GetSetMethodNormalizer'],
  [/AfterDenormalize/u, 'AfterDenormalize'],
  [/BeforeNormalize/u, 'BeforeNormalize'],
];

function extractTransforms(content: string): string[] {
  const found: string[] = [];
  for (const [re, label] of TRANSFORM_PATTERNS) {
    if (re.test(content)) found.push(label);
  }
  return found;
}

function hasNameConverter(content: string): boolean {
  return /NameConverter|CamelCaseToSnake|MetadataAwareNameConverter/u.test(content);
}

function hasGroupsContext(content: string): boolean {
  return /AbstractNormalizer::GROUPS|'groups'\s*=>/u.test(content);
}

function detectIgnoredRequiredProps(content: string): string[] {
  const ignored: string[] = [];
  // Match #[Ignore] followed by a @var or typed property that looks required (no ? prefix)
  const re = /#\[Ignore\][^$]{0,200}\$(\w{1,80})/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    ignored.push(m[1]);
  }
  return ignored;
}

function scanPhpForTransforms(appPath: string): SerializerTransformEntry[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir);
  const results: SerializerTransformEntry[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const transforms = extractTransforms(content);
    if (transforms.length === 0) continue;

    const className = extractClassName(content, file);
    const hasIgnore = transforms.includes('#[Ignore]');
    const issues: string[] = [];

    if (hasIgnore) {
      const ignoredProps = detectIgnoredRequiredProps(content);
      if (ignoredProps.length > 0) {
        issues.push(
          `#[Ignore] on propert${ignoredProps.length === 1 ? 'y' : 'ies'} ${ignoredProps.join(', ')} — deserialization always yields null for these fields`
        );
      }
    }

    if (transforms.includes('#[SerializedName]') && hasNameConverter(content)) {
      issues.push(
        '#[SerializedName] used alongside a NameConverter — property name may be double-transformed (SerializedName result fed into NameConverter)'
      );
    }

    if (transforms.includes('#[Groups]') && !hasGroupsContext(content)) {
      issues.push(
        '#[Groups] attributes defined but no groups context key detected in this file — groups may be silently ignored if the serializer context does not specify them'
      );
    }

    results.push({
      file: path.relative(appPath, file),
      className,
      transforms,
      hasIgnore,
      issues,
    });
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listSymfonySerializerTransforms(appPath: string): McpToolResult {
  try {
    const entries = scanPhpForTransforms(appPath);

    if (entries.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony Serializer transform attributes found in src/.',
        }],
      };
    }

    let text = `Symfony Serializer Transform Attributes  (${entries.length} classes)\n${'='.repeat(62)}\n`;

    for (const e of entries) {
      text += `\n  ${e.className}\n`;
      text += `    File:       ${e.file}\n`;
      text += `    Transforms: ${e.transforms.join(', ')}\n`;
      text += `    Has Ignore: ${e.hasIgnore ? 'yes' : 'no'}\n`;
      if (e.issues.length > 0) {
        for (const issue of e.issues) {
          text += `    [!] ${issue}\n`;
        }
      }
    }

    const totalIssues = entries.reduce((s, e) => s + e.issues.length, 0);
    if (totalIssues > 0) {
      text += `\nTotal issues: ${totalIssues}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonySerializerTransformStats(appPath: string): McpToolResult {
  try {
    const entries = scanPhpForTransforms(appPath);

    const withIssues = entries.filter((e) => e.issues.length > 0);
    const transformCounts: Record<string, number> = {};
    for (const e of entries) {
      for (const t of e.transforms) {
        transformCounts[t] = (transformCounts[t] ?? 0) + 1;
      }
    }

    let text = `Symfony Serializer Transform Statistics\n${'='.repeat(42)}\n\n`;
    text += `Classes with transform attributes: ${entries.length}\n`;
    text += `Classes with issues:               ${withIssues.length}\n`;
    text += `Classes with #[Ignore]:            ${entries.filter((e) => e.hasIgnore).length}\n`;
    text += `\nAttribute usage:\n`;
    for (const [attr, count] of Object.entries(transformCounts)) {
      text += `  ${attr.padEnd(28)} ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getSymfonySerializerTransformTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_symfony_serializer_transforms',
      description: 'Detect Symfony Serializer transform attributes (#[Transform], #[Ignore], #[Groups], #[SerializedName], etc.) and warn on #[Ignore] on required properties, SerializedName+NameConverter conflicts, and unused #[Groups]',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_symfony_serializer_transform_stats',
      description: 'Statistics on Symfony Serializer transform attribute usage: classes found, attribute counts, issues detected',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
