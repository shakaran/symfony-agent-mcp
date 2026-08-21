import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface PhpGcInfo {
  setting: string;
  value: string;
  source: string;
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

function buildGcInfos(appPath: string): PhpGcInfo[] {
  const results: PhpGcInfo[] = [];
  const iniCandidates = [
    path.join(appPath, 'php.ini'),
    path.join(appPath, 'docker', 'php.ini'),
    path.join(appPath, '.docker', 'php.ini'),
    path.join(appPath, 'docker', 'php', 'php.ini'),
  ];

  for (const iniFile of iniCandidates) {
    if (!fs.existsSync(iniFile)) continue;
    let content = '';
    try { content = fs.readFileSync(iniFile, 'utf-8'); } catch { continue; }
    const source = path.relative(appPath, iniFile);

    const gcEnabled = /zend\.enable_gc\s*=\s*(Off|0)/i.test(content);
    if (gcEnabled) {
      results.push({ setting: 'zend.enable_gc', value: 'Off', source, issues: ['zend.enable_gc=Off disables PHP garbage collection — circular references will leak memory in long-running processes'] });
    }

    const gcProbMatch = /gc_probability\s*=\s*(\d+)/.exec(content);
    if (gcProbMatch) {
      const prob = parseInt(gcProbMatch[1], 10);
      if (prob === 0) {
        results.push({ setting: 'gc_probability', value: '0', source, issues: ['gc_probability=0 disables GC probability — effectively disables garbage collection'] });
      }
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  const gcDisableCalls: string[] = [];
  const gcCollectLoops: string[] = [];
  let gcDisableFound = false;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    if (content.includes('gc_disable()')) {
      gcDisableFound = true;
      const isMessenger = content.includes('MessageHandler') || content.includes('Worker') || content.includes('Command');
      if (isMessenger) {
        gcDisableCalls.push(path.relative(appPath, file));
      }
    }

    if (content.includes('gc_collect_cycles()')) {
      const loopPatterns = /(?:for(?:each)?|while)\s*\([^)]{0,200}\)[^{]{0,50}\{[^}]{0,500}gc_collect_cycles\(\)/.test(content);
      if (loopPatterns) {
        gcCollectLoops.push(path.relative(appPath, file));
      }
    }
  }

  if (gcDisableFound && gcDisableCalls.length > 0) {
    results.push({
      setting: 'gc_disable()', value: 'called', source: gcDisableCalls.join(', '),
      issues: ['gc_disable() called in message handler/worker/command — circular references will accumulate and cause memory leaks in long-running processes'],
    });
  }

  if (gcCollectLoops.length > 0) {
    results.push({
      setting: 'gc_collect_cycles()', value: 'in loop', source: gcCollectLoops.join(', '),
      issues: ['gc_collect_cycles() called inside a loop — GC collection on every iteration causes significant performance degradation; call it less frequently'],
    });
  }

  return results;
}

export function listPhpGcConfig(appPath: string): McpToolResult {
  try {
    const infos = buildGcInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP GC configuration issues found.' }] };
    }
    let text = `PHP Garbage Collection Analysis\n${'='.repeat(50)}\n\nIssues: ${infos.length}\n`;
    for (const info of infos) {
      text += `\n  ${info.setting}=${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpGcStats(appPath: string): McpToolResult {
  try {
    const infos = buildGcInfos(appPath);
    let text = `PHP GC Statistics\n${'='.repeat(40)}\n\n`;
    text += `Issues found:     ${infos.length}\n`;
    text += `  GC disabled:    ${infos.filter((i) => i.setting === 'zend.enable_gc' || i.setting === 'gc_probability').length}\n`;
    text += `  gc_disable():   ${infos.filter((i) => i.setting === 'gc_disable()').length}\n`;
    text += `  GC in loops:    ${infos.filter((i) => i.setting === 'gc_collect_cycles()').length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpGcTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_gc_config', description: 'Analyze PHP garbage collection settings; warns on zend.enable_gc=Off, gc_probability=0, gc_disable() in workers, gc_collect_cycles() in tight loops', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_gc_stats', description: 'Statistics for PHP GC issues: disabled count, gc_disable usage, loop-GC count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
