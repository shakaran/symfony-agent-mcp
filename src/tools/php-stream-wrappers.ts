/**
 * PHP Stream Wrapper Inspector
 *
 * Detects custom PHP stream wrapper implementations:
 * stream_wrapper_register(), stream_wrapper_unregister(),
 * classes with stream_open/read/write/close methods.
 *
 * Warns on: missing stream_eof, missing stream_stat, unbalanced register/unregister in tests,
 * missing url_stat.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface StreamWrapper {
  file: string;
  className: string;
  scheme: string;
  implementedMethods: string[];
  missingMethods: string[];
  issues: string[];
}

const REQUIRED_METHODS = ['stream_open', 'stream_read', 'stream_write', 'stream_close', 'stream_eof', 'stream_stat', 'url_stat'];
const CORE_METHODS = ['stream_open', 'stream_read', 'stream_write', 'stream_close'];

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseStreamWrapper(filePath: string, appPath: string): StreamWrapper | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const classM = /\bclass\s+(\w{1,80})/m.exec(content);
  if (!classM) return null;
  const className = classM[1];

  // Must have at least one core stream method or register call
  const hasCoreMethod = CORE_METHODS.some((m) => new RegExp(`\\bfunction\\s+${m}\\s*\\(`).test(content));
  const hasRegister = /\bstream_wrapper_register\s*\(/.test(content);
  if (!hasCoreMethod && !hasRegister) return null;

  // Detect scheme from stream_wrapper_register('scheme', ...)
  let scheme = '';
  const schemeM = /stream_wrapper_register\s*\(\s*['"]([^'"]{1,40})['"]/.exec(content);
  if (schemeM) scheme = schemeM[1];

  // Detect which methods are implemented
  const implementedMethods: string[] = [];
  for (const m of REQUIRED_METHODS) {
    if (new RegExp(`\\bfunction\\s+${m}\\s*\\(`).test(content)) {
      implementedMethods.push(m);
    }
  }

  const missingMethods = REQUIRED_METHODS.filter((m) => !implementedMethods.includes(m));

  const isTestFile = filePath.includes('/test') || filePath.includes('/Test') || filePath.includes('/spec');

  const issues: string[] = [];

  if (!implementedMethods.includes('stream_eof')) {
    issues.push(`${className}: missing stream_eof() — reads may loop forever`);
  }
  if (!implementedMethods.includes('stream_stat')) {
    issues.push(`${className}: missing stream_stat() — stat() calls on stream will fail`);
  }
  if (!implementedMethods.includes('url_stat')) {
    issues.push(`${className}: missing url_stat() — is_file()/file_exists() will fail on custom scheme`);
  }
  if (isTestFile && hasRegister && !content.includes('stream_wrapper_unregister')) {
    issues.push(`${className}: stream_wrapper_register without stream_wrapper_unregister in test — stream leak`);
  }

  return { file: path.relative(appPath, filePath), className, scheme, implementedMethods, missingMethods, issues };
}

export function listPhpStreamWrappers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const testDirs: string[] = [];
    for (const d of ['test', 'tests', 'Test', 'Tests']) {
      const p = path.join(appPath, d);
      if (fs.existsSync(p)) testDirs.push(p);
    }

    if (!fs.existsSync(srcDir) && testDirs.length === 0) {
      return { content: [{ type: 'text', text: 'No src/ or test/ directory found.' }] };
    }

    const wrappers: StreamWrapper[] = [];
    const allDirs = fs.existsSync(srcDir) ? [srcDir, ...testDirs] : testDirs;

    for (const dir of allDirs) {
      for (const file of getAllPhpFiles(dir)) {
        const sw = parseStreamWrapper(file, appPath);
        if (sw) wrappers.push(sw);
      }
    }

    if (wrappers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom stream wrappers found.\n\nExample:\n  stream_wrapper_register(\'myscheme\', MyStreamWrapper::class);\n  class MyStreamWrapper {\n    public function stream_open(string $path, string $mode, int $options, ?string &$opened_path): bool { ... }\n  }',
        }],
      };
    }

    const totalIssues = wrappers.reduce((s, w) => s + w.issues.length, 0);

    let text = `PHP Stream Wrappers\n${'='.repeat(55)}\n`;
    text += `\nWrappers: ${wrappers.length}  Issues: ${totalIssues}\n`;

    for (const w of wrappers.sort((a, b) => b.issues.length - a.issues.length || a.className.localeCompare(b.className))) {
      const schemeStr = w.scheme ? ` scheme: ${w.scheme}` : '';
      text += `\n  ${w.className.padEnd(35)}${schemeStr}\n`;
      text += `    implemented: ${w.implementedMethods.join(', ') || '(none)'}\n`;
      if (w.missingMethods.length > 0) text += `    missing:     ${w.missingMethods.join(', ')}\n`;
      text += `    ${w.file}\n`;
      for (const issue of w.issues) text += `    ! ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpStreamWrapperStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const wrappers: StreamWrapper[] = [];
    const allDirs: string[] = [];
    if (fs.existsSync(srcDir)) allDirs.push(srcDir);
    for (const d of ['test', 'tests', 'Test', 'Tests']) {
      const p = path.join(appPath, d);
      if (fs.existsSync(p)) allDirs.push(p);
    }

    for (const dir of allDirs) {
      for (const file of getAllPhpFiles(dir)) {
        const sw = parseStreamWrapper(file, appPath);
        if (sw) wrappers.push(sw);
      }
    }

    const totalMissing = wrappers.reduce((s, w) => s + w.missingMethods.length, 0);

    let text = `PHP Stream Wrapper Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total wrappers:         ${wrappers.length}\n`;
    text += `Missing methods total:  ${totalMissing}\n`;
    text += `With issues:            ${wrappers.filter((w) => w.issues.length > 0).length}\n`;
    text += `Total issues:           ${wrappers.reduce((s, w) => s + w.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpStreamWrapperTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_stream_wrappers',
      description: 'List custom PHP stream wrapper implementations: implemented/missing methods (stream_eof, stream_stat, url_stat), unbalanced register/unregister in tests, scheme detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_stream_wrapper_stats',
      description: 'Statistics for PHP stream wrappers: total count, missing methods count, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
