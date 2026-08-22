/**
 * Symfony Mime / Email Parts Inspector
 *
 * Distinct from mailer.ts (mailer config), symfony-mailer-transport.ts (DSN/transport),
 * and symfony-mailer-events.ts (email events).
 * Focuses on structured email composition using symfony/mime:
 *
 * Email construction:
 *   $email = (new Email())
 *     ->from('sender@example.com')
 *     ->to('recipient@example.com')
 *     ->subject('Hello')
 *     ->html('<p>Hello</p>')
 *     ->text('Hello')
 *     ->attachFromPath('/path/to/file.pdf')
 *     ->attach($content, 'filename.pdf', 'application/pdf')
 *     ->embed($content, 'logo', 'image/png')
 *     ->embedFromPath('/path/to/logo.png', 'logo');
 *
 * TemplatedEmail (Twig integration):
 *   $email = (new TemplatedEmail())
 *     ->htmlTemplate('emails/welcome.html.twig')
 *     ->textTemplate('emails/welcome.txt.twig')
 *     ->context(['user' => $user]);
 *
 * EmbeddedImage / DataPart / FilePart:
 *   new DataPart(fopen($path, 'r'), 'file.pdf', 'application/pdf');
 *   new Part\DataPart($content, 'name', 'image/png', 'base64');
 *
 * InlineEmail (inline image):
 *   $email->embed(fopen('logo.png', 'r'), 'logo', 'image/png');
 *   // In Twig: <img src="{{ email.image('logo') }}">
 *
 * Analysis:
 *   - TemplatedEmail without context() call (template variables missing)
 *   - attachFromPath() with absolute path (portability issue across environments)
 *   - Email without subject() (common oversight)
 *   - Email reply-to/from with hardcoded address (should use %env()% or config parameter)
 *   - DataPart with 'base64' encoding and binary content (fine, just note)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface EmailConstruction {
  file: string;
  class?: string;
  usesTemplatedEmail: boolean;
  hasHtmlTemplate: boolean;
  hasTextTemplate: boolean;
  hasContext: boolean;
  attachmentCount: number;
  embedCount: number;
  hasSubject: boolean;
  hasHardcodedFrom: boolean;
  issues: string[];
}

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

function parseEmailConstruction(filePath: string, appPath: string): EmailConstruction | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasEmail = content.includes('new Email()') || content.includes('new TemplatedEmail()') ||
                   content.includes('(new Email') || content.includes('(new TemplatedEmail');
  if (!hasEmail) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);

  const usesTemplatedEmail = content.includes('TemplatedEmail');
  const hasHtmlTemplate    = content.includes('->htmlTemplate(');
  const hasTextTemplate    = content.includes('->textTemplate(');
  const hasContext         = content.includes('->context(');
  const hasSubject         = content.includes('->subject(');

  const attachmentCount = [...content.matchAll(/->attach(?:FromPath)?\s*\(/g)].length;
  const embedCount      = [...content.matchAll(/->embed(?:FromPath)?\s*\(/g)].length;

  // Detect hardcoded from email (not using parameter/env var)
  const fromM = /->from\s*\(\s*['"]([^@'"]+@[^'"]+)['"]\s*\)/.exec(content);
  const hasHardcodedFrom = !!fromM && !content.includes('%env(') && !content.includes('$this->');

  // Detect absolute paths in attachFromPath
  const hasAbsolutePath = /->attachFromPath\s*\(\s*['"]\//.test(content) ||
                          /->embedFromPath\s*\(\s*['"]\//.test(content);

  const issues: string[] = [];
  if (usesTemplatedEmail && !hasContext) {
    issues.push('TemplatedEmail without ->context() — template variables will not be available');
  }
  if (!hasSubject) {
    issues.push('Email without ->subject() — email will have no subject line');
  }
  if (hasHardcodedFrom) {
    issues.push(`Hardcoded from address "${fromM![1]}" — consider using a container parameter or env variable`);
  }
  if (hasAbsolutePath) {
    issues.push('attachFromPath()/embedFromPath() with absolute path — not portable across environments; use kernel.project_dir parameter');
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM?.[1],
    usesTemplatedEmail,
    hasHtmlTemplate,
    hasTextTemplate,
    hasContext,
    attachmentCount,
    embedCount,
    hasSubject,
    hasHardcodedFrom,
    issues,
  };
}

export function listMimeParts(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const emails: EmailConstruction[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const e = parseEmailConstruction(file, appPath);
      if (e) emails.push(e);
    }

    if (emails.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Email/TemplatedEmail construction found.\n\nExample:\n  use Symfony\\Bridge\\Twig\\Mime\\TemplatedEmail;\n\n  $email = (new TemplatedEmail())\n    ->from(\'sender@example.com\')\n    ->to($user->getEmail())\n    ->subject(\'Welcome\')\n    ->htmlTemplate(\'emails/welcome.html.twig\')\n    ->context([\'user\' => $user]);\n\n  $this->mailer->send($email);',
        }],
      };
    }

    const totalIssues = emails.reduce((s, e) => s + e.issues.length, 0);

    let text = `Symfony Mime Email Parts\n${'='.repeat(55)}\n`;
    text += `\nFiles with Email construction: ${emails.length}  Issues: ${totalIssues}\n`;
    text += `  TemplatedEmail:     ${emails.filter((e) => e.usesTemplatedEmail).length}\n`;
    text += `  With attachments:   ${emails.filter((e) => e.attachmentCount > 0).length}\n`;
    text += `  With embeds:        ${emails.filter((e) => e.embedCount > 0).length}\n`;

    for (const e of emails.sort((a, b) => b.issues.length - a.issues.length)) {
      const type    = e.usesTemplatedEmail ? 'TemplatedEmail' : 'Email';
      const attStr  = e.attachmentCount > 0 ? `  att:${e.attachmentCount}` : '';
      const embStr  = e.embedCount > 0 ? `  embed:${e.embedCount}` : '';
      text += `\n  ${e.class ?? '(file)'}  ${type}${attStr}${embStr}  (${e.file})\n`;
      for (const issue of e.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMimePartsStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const emails: EmailConstruction[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const e = parseEmailConstruction(file, appPath);
        if (e) emails.push(e);
      }
    }

    let text = `Mime Parts Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with Email:      ${emails.length}\n`;
    text += `  TemplatedEmail:      ${emails.filter((e) => e.usesTemplatedEmail).length}\n`;
    text += `  Plain Email:         ${emails.filter((e) => !e.usesTemplatedEmail).length}\n`;
    text += `  With attachments:    ${emails.filter((e) => e.attachmentCount > 0).length}\n`;
    text += `  With embeds:         ${emails.filter((e) => e.embedCount > 0).length}\n`;
    text += `  Hardcoded from:      ${emails.filter((e) => e.hasHardcodedFrom).length}\n`;
    text += `Issues:                ${emails.reduce((s, e) => s + e.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMimePartsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_mime_parts',
      description: 'Show Symfony Mime email construction: Email vs TemplatedEmail, htmlTemplate/textTemplate/context usage, attachment/embed counts, TemplatedEmail without context() warning, missing subject() warning, hardcoded from address warning, absolute path in attachFromPath/embedFromPath warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_mime_parts_stats',
      description: 'Show Mime email statistics: total emails, TemplatedEmail vs plain count, attachments/embeds/hardcoded-from counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
