// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface MessengerSerializerInfo {
  configSerializer?: string;
  customSerializers: Array<{ class: string; file: string; hasEncode: boolean; hasDecode: boolean; issues: string[] }>;
  usesNativeSerializer: boolean;
  usesSymfonySerializer: boolean;
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

function loadMessengerSerializer(appPath: string): MessengerSerializerInfo {
  let configSerializer: string | undefined;
  const issues: string[] = [];
  const candidates = [
    path.join(appPath, 'config', 'packages', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'messenger.yml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const messenger = (framework['messenger'] ?? raw['messenger'] ?? {}) as Record<string, unknown>;
    if (messenger['serializer']) configSerializer = String(messenger['serializer']);
  }
  const srcDir = path.join(appPath, 'src');
  const customSerializers: MessengerSerializerInfo['customSerializers'] = [];
  let usesNativeSerializer = false;
  let usesSymfonySerializer = false;
  if (fs.existsSync(srcDir)) {
    for (const filePath of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      if (!content.includes('MessageSerializerInterface') && !content.includes('SerializerInterface') && !content.includes('messenger') && !content.includes('encode') && !content.includes('decode')) continue;
      if (!content.includes('MessageSerializerInterface')) continue;
      if (content.includes('namespace Symfony\\')) continue;
      const classM = /class\s+(\w{1,120})/.exec(content);
      if (!classM) continue;
      const hasEncode = content.includes('function encode(') || content.includes('encode(Envelope');
      const hasDecode = content.includes('function decode(') || content.includes('decode(array');
      const serIssues: string[] = [];
      if (!hasEncode) serIssues.push('MessageSerializerInterface without encode() — serializer incomplete');
      if (!hasDecode) serIssues.push('MessageSerializerInterface without decode() — serializer incomplete');
      customSerializers.push({ class: classM[1], file: path.relative(appPath, filePath), hasEncode, hasDecode, issues: serIssues });
    }
    usesNativeSerializer = !configSerializer || configSerializer.includes('messenger.transport.native_php_serializer');
    usesSymfonySerializer = configSerializer?.includes('messenger.transport.symfony_serializer') ?? false;
  }
  if (usesNativeSerializer && customSerializers.length === 0) {
    issues.push('Using native PHP serializer — messages are not human-readable and PHP version sensitive; prefer Symfony Serializer for cross-version compatibility');
  }
  return { configSerializer, customSerializers, usesNativeSerializer, usesSymfonySerializer, issues };
}

export function listMessengerSerializer(appPath: string): McpToolResult {
  try {
    const info = loadMessengerSerializer(appPath);
    let text = `Messenger Serializer\n${'='.repeat(55)}\n\n`;
    text += `Configured: ${info.configSerializer ?? 'default (native)'}\nNative PHP: ${info.usesNativeSerializer ? 'yes' : 'no'}  Symfony: ${info.usesSymfonySerializer ? 'yes' : 'no'}\nCustom serializers: ${info.customSerializers.length}\nIssues: ${info.issues.length + info.customSerializers.reduce((s, c) => s + c.issues.length, 0)}\n`;
    for (const c of info.customSerializers.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${c.class}  encode: ${c.hasEncode ? '✓' : '✗'}  decode: ${c.hasDecode ? '✓' : '✗'}  (${c.file})\n`;
      for (const i of c.issues) text += `    ⚠ ${i}\n`;
    }
    for (const i of info.issues) text += `\n⚠ ${i}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerSerializerStats(appPath: string): McpToolResult {
  try {
    const info = loadMessengerSerializer(appPath);
    let text = `Messenger Serializer Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config serializer: ${info.configSerializer ?? 'default'}\nNative PHP: ${info.usesNativeSerializer ? 'yes' : 'no'}\nSymfony Serializer: ${info.usesSymfonySerializer ? 'yes' : 'no'}\nCustom serializers: ${info.customSerializers.length}\nIssues: ${info.issues.length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerSerializerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_messenger_serializer', description: 'Detect Messenger message serializer: config (native/symfony/custom), MessageSerializerInterface encode/decode implementation, native PHP serializer warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_messenger_serializer_stats', description: 'Messenger serializer statistics: configured serializer type, custom serializer count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
