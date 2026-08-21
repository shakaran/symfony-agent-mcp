/**
 * Symfony Mailer Attachments Inspector
 *
 * Scans src/ PHP for attachment-related calls:
 *   - ->attachFromPath(), ->attach(), ->embed(), ->embedFromPath()
 *   - addPart() with application/octet-stream, Part::fromPath
 *
 * Warns: attachFromPath() without file_exists() check,
 * embed() without corresponding cid reference,
 * user-provided path without validation (path traversal),
 * raw attach() without Content-Type.
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

interface AttachmentUsage {
  method: string;
  hasFileExistCheck: boolean;
  isEmbed: boolean;
  hasContentType: boolean;
  issues: string[];
}

interface MailerAttachmentInfo {
  file: string;
  class: string;
  attachments: AttachmentUsage[];
  issues: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

const ATTACH_METHODS = ['attachFromPath', 'attach', 'embed', 'embedFromPath'];

function scanMailerAttachments(appPath: string): MailerAttachmentInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: MailerAttachmentInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    // Quick check for any attachment pattern
    const hasAttachment = ATTACH_METHODS.some((m) => content.includes(`->${m}(`)) ||
      content.includes('addPart(') ||
      content.includes('Part::fromPath');

    if (!hasAttachment) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    const attachments: AttachmentUsage[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';

      for (const method of ATTACH_METHODS) {
        if (!line.includes(`->${method}(`)) continue;

        const isEmbed = method === 'embed' || method === 'embedFromPath';
        const isFromPath = method === 'attachFromPath' || method === 'embedFromPath';

        // Look in surrounding ±8 lines for file_exists check
        const contextStart = Math.max(0, i - 8);
        const context = lines.slice(contextStart, Math.min(lines.length, i + 5)).join('\n');
        const hasFileExistCheck = /file_exists\s*\(|is_file\s*\(|is_readable\s*\(/.test(context);

        // Content-Type detection for raw attach()
        const hasContentType = method === 'attach'
          ? /contentType|mimeType|'application\/|"application\/|'image\/|"image\//.test(context)
          : true;

        const issues: string[] = [];

        if (isFromPath && !hasFileExistCheck) {
          issues.push(`${method}() without file_exists() check — throws if file is missing`);
        }

        if (isEmbed && !/embed.*cid|cid.*embed|\$cid/.test(context)) {
          issues.push(`embed() result not stored in $cid variable — inline image may not be referenced in template`);
        }

        if (!hasContentType && method === 'attach') {
          issues.push('attach() without explicit Content-Type — mail clients may misdetect file type');
        }

        // Path traversal risk: variable path without sanitisation
        if (isFromPath) {
          const pathArg = /(?:attachFromPath|embedFromPath)\s*\(\s*\$(\w{1,80})/.exec(line);
          if (pathArg) {
            const varName = pathArg[1];
            if (!/realpath|basename|pathinfo|str_replace|sanitize/.test(context) &&
                !/private\s+string/.test(context)) {
              issues.push(`${method}() with variable path $${varName} — validate path to prevent traversal attacks`);
            }
          }
        }

        attachments.push({ method, hasFileExistCheck, isEmbed, hasContentType, issues });
      }

      // Part::fromPath
      if (line.includes('Part::fromPath') || line.includes('addPart(')) {
        const issues: string[] = [];
        const contextStart = Math.max(0, i - 5);
        const context = lines.slice(contextStart, Math.min(lines.length, i + 3)).join('\n');
        if (!/'application\/|"application\/|contentType/.test(context)) {
          issues.push('Part::fromPath / addPart without explicit Content-Type');
        }
        attachments.push({ method: 'Part::fromPath', hasFileExistCheck: false, isEmbed: false, hasContentType: false, issues });
      }
    }

    if (attachments.length === 0) continue;

    const fileIssues: string[] = [];
    const totalIssues = attachments.reduce((s, a) => s + a.issues.length, 0);
    if (totalIssues > 0) {
      fileIssues.push(`${totalIssues} attachment issue(s) in this file`);
    }

    results.push({ file: path.relative(appPath, file), class: className, attachments, issues: fileIssues });
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listMailerAttachments(appPath: string): McpToolResult {
  try {
    const items = scanMailerAttachments(appPath);

    if (items.length === 0) {
      return { content: [{ type: 'text', text: 'No mailer attachment calls found in src/.' }] };
    }

    let text = `Mailer Attachment Usages\n${'='.repeat(50)}\n\n`;
    text += `Found attachment calls in ${items.length} file(s):\n\n`;

    for (const item of items) {
      text += `  ${item.class}  (${item.file})\n`;
      for (const a of item.attachments) {
        text += `    ${a.method}()  embed=${a.isEmbed}  fileCheck=${a.hasFileExistCheck}  contentType=${a.hasContentType}\n`;
        for (const issue of a.issues) {
          text += `      - ${issue}\n`;
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMailerAttachmentStats(appPath: string): McpToolResult {
  try {
    const items = scanMailerAttachments(appPath);

    const totalAttachments = items.reduce((s, i) => s + i.attachments.length, 0);
    const embeds = items.reduce((s, i) => s + i.attachments.filter((a) => a.isEmbed).length, 0);
    const withIssues = items.reduce((s, i) => s + i.attachments.filter((a) => a.issues.length > 0).length, 0);

    let text = `Mailer Attachment Stats\n${'='.repeat(40)}\n\n`;
    text += `Files with attachments: ${items.length}\n`;
    text += `Total attachment calls: ${totalAttachments}\n`;
    text += `Embed calls:            ${embeds}\n`;
    text += `Calls with issues:      ${withIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getMailerAttachmentTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_mailer_attachments',
      description: 'Scan src/ for mailer attachment calls: attachFromPath, embed, embedFromPath, Part::fromPath — file-exists checks, content-type, path traversal risk',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_mailer_attachment_stats',
      description: 'Statistics for mailer attachment calls: total count, embed count, calls with issues',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
