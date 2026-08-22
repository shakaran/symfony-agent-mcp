/**
 * Symfony Mailer Inspector
 *
 * Provides static analysis of the Symfony Mailer component:
 *   - MAILER_DSN configuration and transport type detection
 *   - Email classes (Email, TemplatedEmail, NotificationEmail subclasses)
 *   - Twig email templates in templates/emails/ and templates/mail/
 *   - Mailer package config (config/packages/mailer.yaml)
 *   - Notifier channels and transports (if Notifier is installed)
 *
 * No actual email sending — pure file analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface MailerTransport {
  dsn: string;
  type: string;
  host?: string;
  isNull: boolean;
  isTest: boolean;
  isSMTP: boolean;
}

interface EmailClass {
  class: string;
  file: string;
  extends: string;
  hasTemplate: boolean;
  templatePath?: string;
  subjectMethod: boolean;
  toMethod: boolean;
}

interface EmailTemplate {
  path: string;
  relativePath: string;
  sizeBytes: number;
  isHtml: boolean;
  isText: boolean;
}

// ─── Security helpers ──────────────────────────────────────────────────────

const SENSITIVE_HEADER_RE = /^(authorization|x-api-key|x-auth-token|cookie|proxy-authorization|x-secret|x-token|set-cookie)$/i;

function maskHeaderValue(name: string, value: string): string {
  return SENSITIVE_HEADER_RE.test(name) ? '***' : value;
}

// ─── Transport parsing ─────────────────────────────────────────────────────

function parseMailerDsn(dsn: string): MailerTransport {
  const isNull = dsn === 'null://null' || dsn === 'null://' || dsn.startsWith('null://');
  const isTest = dsn.startsWith('null://') || dsn === 'smtp://null';
  const isSMTP = dsn.startsWith('smtp://') || dsn.startsWith('smtps://');

  let type = 'unknown';
  let host: string | undefined;

  try {
    const url = new URL(dsn);
    type = url.protocol.replace(':', '');
    host = url.hostname || undefined;
  } catch {
    // DSN may contain env vars like %env(MAILER_DSN)%
    const protoMatch = /^(\w+):\/\//.exec(dsn);
    if (protoMatch) type = protoMatch[1];
  }

  // Map known transport types
  const typeMap: Record<string, string> = {
    smtp: 'SMTP',
    smtps: 'SMTP/TLS',
    sendmail: 'Sendmail',
    null: 'Null (disabled)',
    ses: 'Amazon SES',
    'ses+smtp': 'Amazon SES (SMTP)',
    'ses+https': 'Amazon SES (API)',
    sendgrid: 'SendGrid',
    'sendgrid+smtp': 'SendGrid (SMTP)',
    mailgun: 'Mailgun',
    'mailgun+smtp': 'Mailgun (SMTP)',
    'mailgun+https': 'Mailgun (API)',
    postmark: 'Postmark',
    'postmark+smtp': 'Postmark (SMTP)',
    'postmark+api': 'Postmark (API)',
    gmail: 'Gmail',
    'gmail+smtp': 'Gmail (SMTP)',
    mailchimp: 'Mailchimp Mandrill',
  };

  return {
    dsn,
    type: typeMap[type] ?? type,
    host,
    isNull,
    isTest,
    isSMTP,
  };
}

function loadMailerConfig(appPath: string): {
  dsn?: string;
  transport?: MailerTransport;
  envelope?: string;
  headers?: Record<string, string>;
} {
  // Check .env files for MAILER_DSN
  let dsn: string | undefined;

  for (const envFile of ['.env', '.env.local']) {
    try {
      const content = fs.readFileSync(path.join(appPath, envFile), 'utf-8');
      const m = /^MAILER_DSN\s*=\s*(.+)$/m.exec(content);
      if (m) { dsn = m[1].trim().replace(/^['"]|['"]$/g, ''); break; }
    } catch { /* skip */ }
  }

  // Also check mailer.yaml for DSN override and envelope
  const mailerFile = path.join(appPath, 'config', 'packages', 'mailer.yaml');
  const mailerConfig = parseYamlFile(mailerFile) as Record<string, unknown> | null;
  const frameworkSection = mailerConfig?.['framework'] as Record<string, unknown> | undefined;
  const mailerSection = (
    (frameworkSection?.['mailer'] ?? mailerConfig?.['mailer']) ?? {}
  ) as Record<string, unknown>;

  if (!dsn && mailerSection['dsn']) {
    dsn = String(mailerSection['dsn']);
  }

  const headers = mailerSection['headers'] as Record<string, string> | undefined;
  const envelope = mailerSection['envelope']
    ? JSON.stringify(mailerSection['envelope'])
    : undefined;

  return {
    dsn,
    transport: dsn ? parseMailerDsn(dsn) : undefined,
    envelope,
    headers,
  };
}

// ─── PHP scanning ──────────────────────────────────────────────────────────

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

function parseEmailClass(filePath: string): EmailClass | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isEmail =
    /extends\s+(?:Templated)?Email/.test(content) ||
    /extends\s+NotificationEmail/.test(content) ||
    /use\s+Symfony\\Component\\Mime\\Email/.test(content) ||
    (content.includes('TemplatedEmail') && /class\s+\w/.test(content));

  if (!isEmail) return null;

  const classMatch = /class\s+(\w+)/.exec(content);
  if (!classMatch) return null;

  const extendsMatch = /extends\s+([\w\\]+Email)/.exec(content);
  const extendsClass = extendsMatch ? extendsMatch[1].split('\\').pop() ?? '' : 'Email';

  // Detect template path
  const templateMatch = /htmlTemplate\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(content) ??
                        /->htmlTemplate\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(content);

  return {
    class: classMatch[1],
    file: path.basename(filePath),
    extends: extendsClass,
    hasTemplate: !!templateMatch || extendsClass === 'TemplatedEmail',
    templatePath: templateMatch?.[1],
    subjectMethod: content.includes('->subject(') || content.includes('getDefaultContext'),
    toMethod: content.includes('->to(') || content.includes('->addTo('),
  };
}

function loadEmailClasses(appPath: string): EmailClass[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const classes: EmailClass[] = [];
  const scanDirs = [
    path.join(srcDir, 'Mail'),
    path.join(srcDir, 'Email'),
    path.join(srcDir, 'Mailer'),
    path.join(srcDir, 'Notification'),
    srcDir,
  ];

  const seen = new Set<string>();
  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const ec = parseEmailClass(file);
      if (ec) classes.push(ec);
    }
  }

  return classes.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Template scanning ─────────────────────────────────────────────────────

function loadEmailTemplates(appPath: string): EmailTemplate[] {
  const templateRoot = path.join(appPath, 'templates');
  const emailDirs = [
    path.join(templateRoot, 'emails'),
    path.join(templateRoot, 'email'),
    path.join(templateRoot, 'mail'),
    path.join(templateRoot, 'mails'),
    path.join(templateRoot, 'notification'),
  ];

  const templates: EmailTemplate[] = [];

  for (const dir of emailDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const full = path.join(dir, entry.name);
        const stat = fs.statSync(full);
        const rel = path.relative(templateRoot, full);
        templates.push({
          path: full,
          relativePath: rel,
          sizeBytes: stat.size,
          isHtml: entry.name.includes('.html.'),
          isText: entry.name.includes('.txt.') || entry.name.includes('.text.'),
        });
      }
    } catch { /* skip */ }
  }

  return templates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function getMailerConfig(appPath: string): McpToolResult {
  try {
    const config = loadMailerConfig(appPath);

    if (!config.dsn && !config.transport) {
      return {
        content: [{
          type: 'text',
          text: 'No MAILER_DSN configured.\n\nAdd to .env:\n  MAILER_DSN=smtp://user:pass@smtp.example.com:587\n\nInstall: composer require symfony/mailer',
        }],
      };
    }

    let text = `Mailer Configuration\n${'='.repeat(40)}\n\n`;

    if (config.transport) {
      const t = config.transport;
      text += `DSN:       ${t.isNull ? '(null transport — emails not sent)' : t.dsn.replace(/:[^@]+@/, ':***@')}\n`;
      text += `Type:      ${t.type}\n`;
      if (t.host) text += `Host:      ${t.host}\n`;
      if (t.isNull) text += `\n⚠ Null transport active — no emails will be sent.\n`;
      if (t.isSMTP) text += `\nSMTP mode — emails sent directly via SMTP server.\n`;
    } else if (config.dsn) {
      text += `DSN: ${config.dsn}\n`;
    }

    if (config.envelope) text += `\nEnvelope: ${config.envelope}\n`;

    if (config.headers && Object.keys(config.headers).length > 0) {
      text += `\nGlobal headers:\n`;
      for (const [k, v] of Object.entries(config.headers)) {
        text += `  ${k}: ${maskHeaderValue(k, v)}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function listEmailClasses(appPath: string): McpToolResult {
  try {
    const classes = loadEmailClasses(appPath);

    if (classes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom Email classes found in src/.\n\nCreate with:\n  use Symfony\\Component\\Mime\\Email;\n  class WelcomeEmail extends TemplatedEmail { ... }',
        }],
      };
    }

    let text = `Email Classes (${classes.length})\n${'='.repeat(50)}\n\n`;

    for (const ec of classes) {
      text += `  ${ec.class}  extends ${ec.extends}  (${ec.file})\n`;
      const features: string[] = [];
      if (ec.hasTemplate) features.push('templated');
      if (ec.templatePath) features.push(`template: ${ec.templatePath}`);
      if (features.length > 0) text += `    ${features.join(' · ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function listEmailTemplates(appPath: string): McpToolResult {
  try {
    const templates = loadEmailTemplates(appPath);
    const classes = loadEmailClasses(appPath);

    if (templates.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No email templates found.\n\nExpected locations: templates/emails/, templates/mail/\n\nExample: templates/emails/welcome.html.twig',
        }],
      };
    }

    let text = `Email Templates (${templates.length})\n${'='.repeat(50)}\n\n`;

    for (const t of templates) {
      const usedBy = classes
        .filter((c) => c.templatePath && c.templatePath.includes(path.basename(t.relativePath)))
        .map((c) => c.class);
      const usage = usedBy.length > 0 ? `  ← ${usedBy.join(', ')}` : '';
      const type = t.isHtml ? '[HTML]' : t.isText ? '[TEXT]' : '[TWIG]';
      text += `  ${type} ${t.relativePath.padEnd(45)} ${formatBytes(t.sizeBytes)}${usage}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMailerStats(appPath: string): McpToolResult {
  try {
    const config = loadMailerConfig(appPath);
    const classes = loadEmailClasses(appPath);
    const templates = loadEmailTemplates(appPath);

    let text = `Mailer Statistics\n${'='.repeat(40)}\n\n`;

    text += `Transport:      ${config.transport?.type ?? '(not configured)'}\n`;
    text += `Active:         ${config.transport?.isNull ? 'no (null transport)' : config.transport ? 'yes' : 'unknown'}\n`;
    text += `Email classes:  ${classes.length}\n`;
    text += `Templated:      ${classes.filter((c) => c.hasTemplate).length}\n`;
    text += `Templates:      ${templates.length}\n`;
    text += `HTML templates: ${templates.filter((t) => t.isHtml).length}\n`;
    text += `Text templates: ${templates.filter((t) => t.isText).length}\n`;

    if (classes.length > 0) {
      const unlinked = classes.filter((c) => c.hasTemplate && !c.templatePath);
      if (unlinked.length > 0) {
        text += `\nTemplated emails without detected template path:\n`;
        for (const c of unlinked) text += `  ${c.class}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getMailerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'get_mailer_config',
      description: 'Show Symfony Mailer configuration: MAILER_DSN transport type, host, global headers, and whether emails are actually sent',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'list_email_classes',
      description: 'List custom Email/TemplatedEmail subclasses in src/ with their template paths and parent class',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'list_email_templates',
      description: 'List Twig email templates in templates/emails/ and templates/mail/, showing HTML vs text variants and which Email class uses each',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_mailer_stats',
      description: 'Show mailer statistics: transport type, email class count, template count, HTML vs text templates',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
