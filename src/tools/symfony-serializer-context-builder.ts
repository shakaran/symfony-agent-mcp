/**
 * Symfony Serializer Context Builder Inspector
 *
 * Scans src/**\/*.php for serializer context builder usage:
 * - SerializerContextBuilder, ObjectNormalizerContextBuilder,
 *   DateTimeNormalizerContextBuilder
 * - ->withGroups([...]), ->withVersion('...'), ->withContext([...])
 * - AbstractNormalizer::GROUPS, AbstractNormalizer::ATTRIBUTES
 * - Detect context builder created but not passed to serialize()
 * - Flag: building context but not using it
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SerializerContextBuilderInfo {
  file: string;
  class: string;
  contexts: string[];
  issues: string[];
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

const BUILDER_CLASSES = [
  'SerializerContextBuilder',
  'ObjectNormalizerContextBuilder',
  'DateTimeNormalizerContextBuilder',
  'JsonSerializerContextBuilder',
];

const CONTEXT_METHODS = [
  'withGroups',
  'withVersion',
  'withContext',
  'withObjectToPopulate',
  'withCircularReferenceHandler',
  'withAttributes',
  'withSkipNullValues',
];

function analyseSerializerContextFile(content: string, relFile: string): SerializerContextBuilderInfo[] {
  const infos: SerializerContextBuilderInfo[] = [];
  const lines = content.split('\n');

  // Find all builder variable assignments
  const builderVars: Array<{ varName: string; lineIndex: number; builderClass: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const cls of BUILDER_CLASSES) {
      if (line.includes(cls)) {
        // Extract variable name being assigned
        const varMatch = /(\$\w+)\s*=\s*(?:new\s+)?[\w\\]*/.exec(line);
        const varName = varMatch ? varMatch[1] : `$builder_line${i + 1}`;
        builderVars.push({ varName, lineIndex: i, builderClass: cls });
        break;
      }
    }
  }

  for (const builder of builderVars) {
    const contexts: string[] = [];
    const issues: string[] = [];
    const varName = builder.varName;

    // Look ahead for method chaining on this builder variable
    const searchBlock = lines.slice(builder.lineIndex, Math.min(builder.lineIndex + 30, lines.length));
    const blockText = searchBlock.join('\n');

    for (const method of CONTEXT_METHODS) {
      if (blockText.includes(`->${method}(`) || blockText.includes(`${varName}->${method}`)) {
        contexts.push(method);
      }
    }

    // Check AbstractNormalizer constants
    if (/AbstractNormalizer::GROUPS/.test(blockText)) contexts.push('AbstractNormalizer::GROUPS');
    if (/AbstractNormalizer::ATTRIBUTES/.test(blockText)) contexts.push('AbstractNormalizer::ATTRIBUTES');

    // Check if builder variable is used in serialize()/normalize()/denormalize()
    const fullFileBlock = content;
    const serializePattern = new RegExp(`serialize|normalize|denormalize`);
    const usedInSerialize = serializePattern.test(blockText);

    // Check if ->toArray() is called (context builder is converted)
    const toArrayUsed = blockText.includes('->toArray()') || blockText.includes('->withContext');

    if (!usedInSerialize && !toArrayUsed && contexts.length > 0) {
      issues.push(`Context builder '${varName}' built with ${contexts.join(', ')} but no serialize/normalize call found in vicinity — may be disconnected`);
    }

    if (contexts.length === 0 && builder.builderClass !== 'SerializerContextBuilder') {
      issues.push(`Context builder '${varName}' instantiated but no context methods called`);
    }

    // Check if ->toArray() missing (required to pass to serializer)
    if (contexts.length > 0 && !blockText.includes('toArray()') && usedInSerialize) {
      issues.push(`Context builder '${varName}' — ensure ->toArray() is called when passing to serialize()`);
    }

    void fullFileBlock;

    infos.push({
      file: relFile,
      class: builder.builderClass,
      contexts: contexts.length > 0 ? contexts : ['(none)'],
      issues,
    });
  }

  // Detect inline AbstractNormalizer usage without builder
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/AbstractNormalizer::GROUPS|AbstractNormalizer::ATTRIBUTES/.test(line)) {
      if (!/SerializerContextBuilder|ObjectNormalizerContextBuilder/.test(content)) {
        const contexts = [];
        if (/AbstractNormalizer::GROUPS/.test(line)) contexts.push('AbstractNormalizer::GROUPS');
        if (/AbstractNormalizer::ATTRIBUTES/.test(line)) contexts.push('AbstractNormalizer::ATTRIBUTES');
        infos.push({
          file: relFile,
          class: 'AbstractNormalizer (inline)',
          contexts,
          issues: ['Using AbstractNormalizer constants inline — consider SerializerContextBuilder for type-safe context construction'],
        });
        break;
      }
    }
  }

  return infos;
}

function buildSerializerContextBuilderInfos(appPath: string): SerializerContextBuilderInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: SerializerContextBuilderInfo[] = [];
  const files = collectPhpFiles(srcDir, appPath);

  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    const hasBuilder = BUILDER_CLASSES.some((cls) => content.includes(cls));
    const hasAbstractNorm = /AbstractNormalizer::(GROUPS|ATTRIBUTES)/.test(content);
    if (!hasBuilder && !hasAbstractNorm) continue;
    const infos = analyseSerializerContextFile(content, path.relative(appPath, file));
    results.push(...infos);
  }

  return results;
}

export function listSymfonySerializerContextBuilder(appPath: string): McpToolResult {
  try {
    const infos = buildSerializerContextBuilderInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony serializer context builder usage found in src/.' }] };
    }

    let text = `Symfony Serializer Context Builder Analysis\n${'='.repeat(55)}\n\n`;
    text += `Context builder usages: ${infos.length}\n\n`;

    for (const info of infos) {
      text += `File:    ${info.file}\n`;
      text += `Builder: ${info.class}\n`;
      text += `Contexts: ${info.contexts.join(', ')}\n`;
      if (info.issues.length > 0) {
        for (const issue of info.issues) {
          text += `  - ${issue}\n`;
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySerializerContextBuilderStats(appPath: string): McpToolResult {
  try {
    const infos = buildSerializerContextBuilderInfos(appPath);

    const withIssues = infos.filter((i) => i.issues.length > 0).length;
    const builderCounts: Record<string, number> = {};
    for (const info of infos) {
      builderCounts[info.class] = (builderCounts[info.class] ?? 0) + 1;
    }
    const filesAffected = new Set(infos.map((i) => i.file)).size;

    let text = `Symfony Serializer Context Builder Statistics\n${'='.repeat(50)}\n\n`;
    text += `Total usages:         ${infos.length}\n`;
    text += `Files affected:       ${filesAffected}\n`;
    text += `Usages with issues:   ${withIssues}\n\n`;
    text += `By builder class:\n`;
    for (const [cls, count] of Object.entries(builderCounts)) {
      text += `  ${cls}: ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySerializerContextBuilderTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_serializer_context_builder',
      description: 'List Symfony serializer context builder usage: withGroups/withVersion/withContext calls, AbstractNormalizer constants, disconnected builders not passed to serialize/normalize',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_serializer_context_builder_stats',
      description: 'Get Symfony serializer context builder statistics: usage counts by builder class, files affected, usages with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
