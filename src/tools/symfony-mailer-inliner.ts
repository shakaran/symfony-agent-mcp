import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MailerInlinerInfo {
  file: string;
  type: 'template' | 'service' | 'css';
  pattern: string;
  issues: string[];
}

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig') || e.name.endsWith('.html')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
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

function buildMailerInlinerInfos(appPath: string): MailerInlinerInfo[] {
  const results: MailerInlinerInfo[] = [];

  let hasCssInliner = false;
  let hasInlineCssExtra = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['symfony/css-inliner-extra']) hasCssInliner = true;
      if (req['twig/cssinliner-extra'] || req['twig/extra-bundle']) hasInlineCssExtra = true;
    } catch { /* ignore */ }
  }

  const templatesDir = path.join(appPath, 'templates');
  if (fs.existsSync(templatesDir)) {
    const emailTemplates: string[] = [];
    for (const file of getAllTwigFiles(templatesDir)) {
      const content = safeRead(file, appPath);
      if (content === null) continue;

      const relFile = path.relative(appPath, file);
      const isEmail = file.includes('/email') || file.includes('/mail') || file.includes('/notification') ||
        content.includes('{% extends') && (content.includes('email') || content.includes('mail'));

      if (!isEmail) continue;
      emailTemplates.push(file);
      const issues: string[] = [];

      if (content.includes('<style>') && !content.includes('{% apply inline_css %}')) {
        issues.push(`Email template "${relFile}" has <style> block without |inline_css filter — most email clients (Gmail, Yahoo) strip <style> blocks`);
      }

      if (content.includes('<link') && content.includes('stylesheet') && content.includes('http')) {
        issues.push(`Email template "${relFile}" has external CSS stylesheet link — blocked by most email clients (Outlook, Apple Mail)`);
      }

      if (content.includes('{% apply inline_css %}') && !hasCssInliner && !hasInlineCssExtra) {
        issues.push(`Email template "${relFile}" uses |inline_css but symfony/css-inliner-extra not in composer.json`);
      }

      results.push({ file: relFile, type: 'template', pattern: 'email template', issues });
    }

    if (emailTemplates.length > 0) {
      const haTextPlainAlternative = emailTemplates.some((f) => {
        const c = safeRead(f, appPath);
        if (c === null) return false;
        return c.includes('text/plain') || c.includes('.txt.twig');
      });
      if (!haTextPlainAlternative) {
        results.push({ file: 'templates/email/', type: 'template', pattern: 'text/plain alternative', issues: ['No text/plain email template found — all emails are HTML-only (spam filters penalize missing plain text alternative)'] });
      }
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      const content = safeRead(file, appPath);
      if (content === null) continue;

      const relFile = path.relative(appPath, file);

      if (content.includes('TemplatedEmail') || content.includes('TwigBodyRenderer')) {
        const issues: string[] = [];
        const hasTextPart = content.includes('textTemplate(') || content.includes('text(');
        const hasHtmlPart = content.includes('htmlTemplate(') || content.includes('html(');
        if (hasHtmlPart && !hasTextPart) {
          issues.push(`Email in "${relFile}" has HTML but no text/plain alternative — add ->textTemplate() for accessibility and deliverability`);
        }
        results.push({ file: relFile, type: 'service', pattern: 'TemplatedEmail', issues });
      }
    }
  }

  return results;
}

export function listSymfonyMailerInliner(appPath: string): McpToolResult {
  try {
    const infos = buildMailerInlinerInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No email templates or TemplatedEmail usage found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Mailer CSS Inliner Analysis\n${'='.repeat(50)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMailerInlinerStats(appPath: string): McpToolResult {
  try {
    const infos = buildMailerInlinerInfos(appPath);
    let text = `Mailer Inliner Statistics\n${'='.repeat(40)}\n\n`;
    text += `Templates:  ${infos.filter((i) => i.type === 'template').length}\n`;
    text += `Services:   ${infos.filter((i) => i.type === 'service').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMailerInlinerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_mailer_inliner', description: 'Analyze email templates for CSS inlining; warns on <style> blocks without inline_css, external CSS links, missing text/plain alternative, inline_css without twig/cssinliner-extra', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_mailer_inliner_stats', description: 'Statistics for mailer CSS inlining: template/service count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
