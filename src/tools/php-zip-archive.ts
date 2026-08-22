import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ZipArchiveInfo {
  file: string;
  operation: 'open' | 'extract' | 'add';
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

function buildZipArchiveInfos(appPath: string): ZipArchiveInfo[] {
  const results: ZipArchiveInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);

  for (const file of files) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('ZipArchive')) continue;

    const hasOpen = content.includes('->open(');
    const hasExtract = content.includes('->extractTo(');
    const hasAddFile = content.includes('->addFile(');
    const hasAddFromString = content.includes('->addFromString(');

    if (!hasOpen && !hasExtract && !hasAddFile && !hasAddFromString && !content.includes('new ZipArchive')) continue;

    // Check open() return value
    if (hasOpen) {
      const issues: string[] = [];
      // Look for open() call not followed by === TRUE or !== FALSE check
      const openIdx = content.indexOf('->open(');
      if (openIdx !== -1) {
        const surroundingSlice = content.slice(Math.max(0, openIdx - 50), Math.min(content.length, openIdx + 150));
        if (!surroundingSlice.includes('=== true') && !surroundingSlice.includes('=== TRUE') &&
            !surroundingSlice.includes('!== true') && !surroundingSlice.includes('!== ZipArchive') &&
            !surroundingSlice.includes('if (') && !surroundingSlice.includes('if(')) {
          issues.push('ZipArchive::open() return value not checked — must verify === TRUE before proceeding');
        }
      }
      if (issues.length > 0) {
        results.push({ file: path.relative(appPath, file), operation: 'open', issues });
      }
    }

    // Check extractTo()
    if (hasExtract) {
      const issues: string[] = [];
      const extractIdx = content.indexOf('->extractTo(');
      if (extractIdx !== -1) {
        const surroundingSlice = content.slice(Math.max(0, extractIdx - 300), Math.min(content.length, extractIdx + 200));
        // Heuristic: look for user-controlled input near extractTo
        if (surroundingSlice.includes('$_GET') || surroundingSlice.includes('$_POST') ||
            surroundingSlice.includes('$_REQUEST') || surroundingSlice.includes('$request->')) {
          issues.push('extractTo() called with data derived from user input — validate target path against allowed directories');
        } else {
          issues.push('extractTo() detected — ensure destination path is validated to prevent path traversal from zip entries');
        }
      }
      results.push({ file: path.relative(appPath, file), operation: 'extract', issues });
    }

    // Check addFile() / addFromString()
    if (hasAddFile || hasAddFromString) {
      const issues: string[] = [];
      if (hasAddFile) {
        const addIdx = content.indexOf('->addFile(');
        if (addIdx !== -1) {
          const surroundingSlice = content.slice(Math.max(0, addIdx - 200), Math.min(content.length, addIdx + 150));
          if (surroundingSlice.includes('$_GET') || surroundingSlice.includes('$_POST') ||
              surroundingSlice.includes('$_REQUEST') || surroundingSlice.includes('$request->')) {
            issues.push('addFile() called with user-controlled filename — validate and sanitize filename to prevent path traversal');
          } else {
            issues.push('addFile() detected — ensure filenames are not user-controlled without validation');
          }
        }
      }
      if (hasAddFromString) {
        issues.push('addFromString() detected — verify archive entry names are sanitized if derived from user input');
      }
      results.push({ file: path.relative(appPath, file), operation: 'add', issues });
    }
  }

  return results;
}

export function listPhpZipArchive(appPath: string): McpToolResult {
  try {
    const infos = buildZipArchiveInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP ZipArchive usage patterns found.' }] };
    }
    const lines = infos.map(i =>
      `${i.file} [${i.operation}]\n  Issues: ${i.issues.join('; ')}`
    );
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpZipArchiveStats(appPath: string): McpToolResult {
  try {
    const infos = buildZipArchiveInfos(appPath);
    const stats = {
      total: infos.length,
      byOperation: {} as Record<string, number>,
      withIssues: infos.filter(i => i.issues.length > 0).length,
    };
    for (const i of infos) {
      stats.byOperation[i.operation] = (stats.byOperation[i.operation] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpZipArchiveTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_php_zip_archive',
      description: 'List PHP ZipArchive usage patterns: open(), extractTo(), addFile(), addFromString() — flags missing return value checks, path traversal risks from user-controlled filenames, and unsafe extraction targets.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    },
    {
      name: 'get_php_zip_archive_stats',
      description: 'Get statistics for PHP ZipArchive usage: total occurrences grouped by operation (open/extract/add), count with security issues.',
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
