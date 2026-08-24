// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ImageProcessingInfo {
  file: string;
  type: 'upload' | 'processing' | 'security' | 'storage' | 'library';
  pattern: string;
  issues: string[];
}

function buildImageProcessingInfos(appPath: string): ImageProcessingInfo[] {
  const results: ImageProcessingInfo[] = [];

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

          const hasImageUpload = content.includes('UploadedFile') || content.includes('getClientOriginalExtension') || content.includes('getClientMimeType') || content.includes('move(');
          const hasImageProcessing = content.includes('Imagine') || content.includes('GD') || content.includes('Imagick') || content.includes('intervention/image') || content.includes('getimagesize') || content.includes('exif_');
          if (!hasImageUpload && !hasImageProcessing) return;

          const relFile = path.relative(appPath, full);
          const issues: string[] = [];

          if (hasImageUpload) {
            const hasMimeCheck = content.includes('getMimeType()') || content.includes('getClientMimeType()') || content.includes('image/jpeg') || content.includes('image/png') || content.includes('image/gif') || content.includes('image/webp');
            if (!hasMimeCheck) {
              issues.push(`File upload in "${relFile}" without MIME type validation — validate MIME type server-side (not just client-provided extension); use getimagesizefromstring() or finfo for magic-byte MIME detection`);
            }

            const hasExtensionAllowlist = content.includes('allowedExtensions') || content.includes('validExtensions') || content.includes('allowed_extensions') || (content.includes('jpg') && content.includes('png') && content.includes('jpeg'));
            if (!hasExtensionAllowlist) {
              issues.push(`File upload in "${relFile}" without extension allowlist — without allowlist, PHP files could be uploaded; restrict to jpg/png/gif/webp and store outside web root or disable PHP execution in upload directory`);
            }

            const hasMaxSize = content.includes('getSize()') || content.includes('MAX_FILE_SIZE') || content.includes('maxSize') || content.includes('max_size');
            if (!hasMaxSize) {
              issues.push(`File upload in "${relFile}" without size limit — users can upload arbitrarily large files causing disk exhaustion; validate getSize() against a maximum (e.g. 10MB)`);
            }

            const hasRandomFilename = content.includes('uniqid') || content.includes('uuid') || content.includes('Uuid') || content.includes('random') || content.includes('hash(');
            if (!hasRandomFilename) {
              issues.push(`File upload in "${relFile}" without random filename — using original filename allows path traversal and file overwrite attacks; generate a random UUID or hash-based filename`);
            }

            const hasMetadataStrip = content.includes('exif_') || content.includes('Exif') || content.includes('strip') || content.includes('sanitize');
            if (!hasMetadataStrip) {
              issues.push(`Image upload in "${relFile}" without EXIF metadata stripping — EXIF data can contain GPS location, camera info, and software versions; strip metadata before storing user-uploaded images`);
            }
          }

          if (hasImageProcessing) {
            const hasReencode = content.includes('save(') || content.includes('writeImage(') || content.includes('imagejpeg(') || content.includes('imagepng(');
            if (!hasReencode && hasImageUpload) {
              issues.push(`Image processing in "${relFile}" without re-encoding — process and re-encode all uploaded images through GD/Imagick to strip embedded malicious content and metadata; don't serve original uploaded files directly`);
            }
          }

          results.push({ file: relFile, type: 'upload', pattern: 'image upload/processing', issues });
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  return results;
}

export function listImageProcessing(appPath: string): McpToolResult {
  try {
    const infos = buildImageProcessingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No image upload/processing patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Image Processing Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getImageProcessingStats(appPath: string): McpToolResult {
  try {
    const infos = buildImageProcessingInfos(appPath);
    let text = `Image Processing Statistics\n${'='.repeat(40)}\n\n`;
    text += `Upload handlers:  ${infos.filter((i) => i.type === 'upload').length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getImageProcessingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_image_processing', description: 'Analyze image upload and processing security; warns on missing MIME type validation, no extension allowlist, no size limit, non-random filenames (path traversal), missing EXIF metadata stripping, serving original uploads without re-encoding', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_image_processing_stats', description: 'Statistics for image processing: upload handler count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
