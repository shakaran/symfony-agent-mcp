import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface FileArchiveInfo {
  file: string;
  type: 'zip-slip' | 'path-traversal' | 'unpack' | 'upload' | 'performance';
  pattern: string;
  issues: string[];
}

function buildFileArchiveInfos(appPath: string): FileArchiveInfo[] {
  const results: FileArchiveInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  const checkFiles = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) checkFiles(full);
        else if (e.name.endsWith('.php')) {
          let content = '';
          try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }

          const hasZip = content.includes('ZipArchive') || content.includes('zip_open') || content.includes('PharData') || content.includes('Phar::');
          const hasTar = content.includes('PharData') || content.includes('.tar.gz') || content.includes('tar_open') || content.includes('.tar');
          if (!hasZip && !hasTar) return;

          const relFile = path.relative(appPath, full);
          const issues: string[] = [];

          if (hasZip) {
            const hasZipSlipProtection = content.includes('realpath(') || content.includes('str_starts_with') || content.includes('../') || content.includes('basename(');
            const hasExtract = content.includes('extractTo(') || content.includes('zip_entry_open(') || content.includes('getFromIndex(');
            if (hasExtract && !hasZipSlipProtection) {
              issues.push(`ZipArchive::extractTo() in "${relFile}" without path traversal check — zip entries with "../" paths escape the target directory (Zip Slip); validate that realpath(extractDir . '/' . entryName) starts with extractDir`);
            }

            const hasEntryNameFromInput = content.includes('getNameIndex') || content.includes('statIndex') || content.includes('$zip->');
            const hasFilenameValidation = content.includes('basename(') || content.includes('preg_match') || content.includes('pathinfo');
            if (hasEntryNameFromInput && !hasFilenameValidation) {
              issues.push(`ZIP entry names in "${relFile}" without filename sanitization — entry names can contain null bytes or special chars; use basename() and validate entry names before using as filesystem paths`);
            }

            const hasMimeCheck = content.includes('getMimeType') || content.includes('finfo') || content.includes('mime_content_type');
            const hasContentExtract = content.includes('getFromIndex(') || content.includes('getStream(');
            if (hasContentExtract && !hasMimeCheck) {
              issues.push(`ZIP content extraction in "${relFile}" without content-type validation — extracted files may be PHP scripts or executables; validate MIME type of extracted content and store outside web root`);
            }
          }

          if (hasTar) {
            const hasPharDeserialize = content.includes('unserialize') || content.includes('phar://');
            if (hasPharDeserialize) {
              issues.push(`Phar deserialization risk in "${relFile}" — phar:// stream wrapper triggers PHP object deserialization; if user controls filenames, they can trigger phar deserialization gadget chains; validate file paths before use`);
            }
          }

          const hasSyncExtraction = content.includes('extractTo(') && content.includes('stream_copy_to_stream') === false;
          const isInController = content.includes('AbstractController') || content.includes('#[Route');
          if (hasSyncExtraction && isInController) {
            issues.push(`Archive extraction in controller "${relFile}" synchronously — archive extraction is CPU/IO intensive; dispatch to Messenger for async processing to avoid blocking web requests`);
          }

          results.push({ file: relFile, type: 'zip-slip', pattern: 'file archive operations', issues });
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  return results;
}

export function listFileArchive(appPath: string): McpToolResult {
  try {
    const infos = buildFileArchiveInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No file archive patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `File Archive Security Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFileArchiveStats(appPath: string): McpToolResult {
  try {
    const infos = buildFileArchiveInfos(appPath);
    let text = `File Archive Statistics\n${'='.repeat(40)}\n\n`;
    text += `Archive operations:  ${infos.filter((i) => i.type === 'zip-slip').length}\n`;
    text += `Issues:              ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFileArchiveTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_file_archive', description: 'Analyze file archive operations (ZipArchive/PharData) for security issues; warns on Zip Slip path traversal in extractTo(), ZIP entry names without sanitization, extracted content without MIME check, Phar deserialization via phar://, synchronous extraction in controllers', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_file_archive_stats', description: 'Statistics for file archive: operation count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
