import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FfiInfo {
  file: string;
  type: 'cdef' | 'load' | 'scope' | 'preload' | 'config';
  pattern: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function buildFfiInfos(appPath: string): FfiInfo[] {
  const results: FfiInfo[] = [];
  const srcDir = path.join(appPath, 'src');

  let ffiEnabled: string | null = null;
  const iniCandidates = [
    path.join(appPath, 'php.ini'),
    path.join(appPath, 'docker', 'php', 'php.ini'),
    path.join(appPath, 'docker', 'php', 'conf.d', 'ffi.ini'),
  ];
  for (const iniFile of iniCandidates) {
    if (!fs.existsSync(iniFile)) continue;
    try {
      const content = fs.readFileSync(iniFile, 'utf-8');
      const m = /^\s*ffi\.enable\s*=\s*(.+)$/m.exec(content);
      if (m) { ffiEnabled = m[1].trim().toLowerCase(); break; }
    } catch { /* skip */ }
  }

  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('FFI') && !content.includes('ffi')) continue;

    const relFile = path.relative(appPath, file);

    if (content.includes('FFI::cdef(') || content.includes('\\FFI::cdef(')) {
      const issues: string[] = [];
      const hasSanitize = content.includes('escapeshellarg') || content.includes('htmlspecialchars') || content.includes('filter_var');

      if (content.includes('$_GET') || content.includes('$_POST') || content.includes('$_REQUEST')) {
        issues.push('FFI::cdef() called with user-supplied data — FFI executes native code; user-controlled C definitions allow arbitrary code execution');
      }

      const cdefMatch = /FFI::cdef\(\s*(['"`][\s\S]{0,500}?['"`])/.exec(content);
      if (cdefMatch) {
        const cdef = cdefMatch[1];
        if (cdef.includes('system(') || cdef.includes('exec(') || cdef.includes('popen(')) {
          issues.push('FFI C definition includes shell execution functions (system/exec/popen) — direct OS command execution via FFI');
        }
      }

      if (ffiEnabled === 'false' || ffiEnabled === '0') {
        issues.push('FFI::cdef() used but ffi.enable=false in php.ini — FFI calls will throw at runtime');
      }

      if (!hasSanitize && content.includes('$')) {
        issues.push('FFI::cdef() with PHP variables — ensure no user-controlled data reaches C definitions');
      }

      results.push({ file: relFile, type: 'cdef', pattern: 'FFI::cdef()', issues });
    }

    if (content.includes('FFI::load(') || content.includes('\\FFI::load(')) {
      const issues: string[] = [];
      const loadMatch = /FFI::load\(\s*(['"`])([^'"` ]{1,300})\1/.exec(content);
      const libPath = loadMatch ? loadMatch[2] : '';

      if (libPath && !path.isAbsolute(libPath) && !libPath.startsWith(__dirname)) {
        issues.push(`FFI::load() with relative path "${libPath}" — use absolute paths or __DIR__ to prevent library hijacking`);
      }
      if (content.includes('$') && /FFI::load\(\s*\$/.test(content)) {
        issues.push('FFI::load() with variable path — user-controlled library paths allow loading arbitrary native libraries');
      }

      results.push({ file: relFile, type: 'load', pattern: 'FFI::load()', issues });
    }

    if (content.includes('#[FFI\\Attr') || content.includes('#[\\FFI\\Attr')) {
      results.push({ file: relFile, type: 'scope', pattern: 'FFI scope attribute', issues: [] });
    }

    const hasMemoryOps = content.includes('FFI::new(') || content.includes('->cast(') || content.includes('FFI::addr(');
    if (hasMemoryOps) {
      const issues: string[] = [];
      const hasFree = content.includes('FFI::free(') || content.includes('unset(');
      if (!hasFree) {
        issues.push('FFI memory allocation (FFI::new) without FFI::free() or unset() — native memory is not garbage-collected; memory leak in long-running processes');
      }
      results.push({ file: relFile, type: 'preload', pattern: 'FFI memory ops', issues });
    }
  }

  if (ffiEnabled === 'preload') {
    results.push({ file: 'php.ini', type: 'config', pattern: 'ffi.enable=preload', issues: ['ffi.enable=preload limits FFI to preloaded scripts only — safest setting for production; verify all FFI usage is in preloaded files'] });
  } else if (ffiEnabled === 'true' || ffiEnabled === '1') {
    results.push({ file: 'php.ini', type: 'config', pattern: 'ffi.enable=true', issues: ['ffi.enable=true allows FFI from any PHP file — use ffi.enable=preload in production to restrict FFI to trusted preloaded scripts'] });
  }

  return results;
}

export function listPhpFfi(appPath: string): McpToolResult {
  try {
    const infos = buildFfiInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP FFI usage found (no FFI::cdef(), FFI::load(), or ffi.enable configuration).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP FFI Security Analysis\n${'='.repeat(50)}\n\nUsages: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFfiStats(appPath: string): McpToolResult {
  try {
    const infos = buildFfiInfos(appPath);
    let text = `PHP FFI Statistics\n${'='.repeat(40)}\n\n`;
    text += `cdef usages:  ${infos.filter((i) => i.type === 'cdef').length}\n`;
    text += `load usages:  ${infos.filter((i) => i.type === 'load').length}\n`;
    text += `Memory ops:   ${infos.filter((i) => i.type === 'preload').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFfiTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_ffi', description: 'Analyze PHP FFI (Foreign Function Interface) usage; warns on user-controlled cdef definitions (RCE risk), variable load paths (library hijacking), memory leaks without FFI::free(), ffi.enable=true vs safer preload mode', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_ffi_stats', description: 'Statistics for PHP FFI: cdef/load/memory-ops count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
