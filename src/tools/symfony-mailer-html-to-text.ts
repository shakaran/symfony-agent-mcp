// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Mailer HTML-to-Text Inspector
 *
 * Scans src/**\/*.php for Symfony Mailer HTML-to-text conversion patterns:
 *   - TemplatedEmail / Email without text() or textTemplate() part
 *   - HtmlToTextConverter usage without league/html-to-markdown in composer.json
 *   - inlineCSS() called without CSSInliner package installed
 *   - Email subject set but body only via html() without text() (spam filter risk)
 *   - TextPart used directly without HtmlPart being present
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface EmailClassInfo {
  file: string;
  className: string;
  usesTemplatedEmail: boolean;
  usesEmail: boolean;
  hasHtml: boolean;
  hasText: boolean;
  hasTextTemplate: boolean;
  hasHtmlTemplate: boolean;
  hasSubject: boolean;
  hasInlineCss: boolean;
  usesHtmlToTextConverter: boolean;
  usesTextPart: boolean;
  usesHtmlPart: boolean;
  issues: string[];
}

interface ComposerPackages {
  hasHtmlToMarkdown: boolean;
  hasCssInliner: boolean;
  hasLeagueHtmlToMarkdown: boolean;
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...getAllPhpFiles(full));
      } else if (entry.name.endsWith('.php')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

function readComposerPackages(appPath: string): ComposerPackages {
  const composerPath = path.join(appPath, 'composer.json');
  let composerContent = '';
  try { composerContent = fs.readFileSync(composerPath, 'utf-8'); } catch { /* skip */ }

  return {
    hasHtmlToMarkdown: composerContent.includes('html-to-markdown') || composerContent.includes('html2text'),
    hasCssInliner: composerContent.includes('css-inliner') || composerContent.includes('pelago/emogrifier') || composerContent.includes('tijsverkoyen/css-to-inline-styles'),
    hasLeagueHtmlToMarkdown: composerContent.includes('"league/html-to-markdown"'),
  };
}

function scanEmailClasses(appPath: string): EmailClassInfo[] {
  const resolvedBase = path.resolve(appPath);
  const srcDir = path.join(resolvedBase, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: EmailClassInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    if (!path.resolve(file).startsWith(resolvedBase + path.sep)) continue;

    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasMailerClass = content.includes('TemplatedEmail') ||
                           content.includes('new Email(') ||
                           content.includes('HtmlToTextConverter') ||
                           content.includes('inlineCss(') ||
                           content.includes('TextPart') ||
                           content.includes('HtmlPart') ||
                           content.includes('->html(') ||
                           content.includes('->htmlTemplate(');

    if (!hasMailerClass) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    const usesTemplatedEmail = content.includes('TemplatedEmail');
    const usesEmail = content.includes('new Email(') || content.includes('Email()');
    const hasHtml = content.includes('->html(') || content.includes('HtmlPart');
    const hasHtmlTemplate = content.includes('->htmlTemplate(');
    const hasText = content.includes('->text(') || content.includes('TextPart');
    const hasTextTemplate = content.includes('->textTemplate(');
    const hasSubject = content.includes('->subject(');
    const hasInlineCss = content.includes('->inlineCss(') || content.includes('inlineCss(');
    const usesHtmlToTextConverter = content.includes('HtmlToTextConverter');
    const usesTextPart = content.includes('TextPart');
    const usesHtmlPart = content.includes('HtmlPart');

    const issues: string[] = [];

    // Email with HTML but no text fallback
    if ((hasHtml || hasHtmlTemplate) && !hasText && !hasTextTemplate) {
      issues.push('Email sets HTML content but has no plain-text fallback (->text() or ->textTemplate()) — spam filters may penalize HTML-only emails');
    }

    // Subject set but no text part
    if (hasSubject && (hasHtml || hasHtmlTemplate) && !hasText && !hasTextTemplate) {
      issues.push('Email has subject and HTML body but no text part — some clients display only text part');
    }

    // TemplatedEmail with htmlTemplate but no textTemplate
    if (usesTemplatedEmail && hasHtmlTemplate && !hasTextTemplate && !hasText) {
      issues.push('TemplatedEmail uses htmlTemplate() without textTemplate() — add a matching .txt.twig template for accessibility');
    }

    // TextPart without HtmlPart
    if (usesTextPart && !usesHtmlPart && !hasHtml && !hasHtmlTemplate) {
      issues.push('TextPart used directly without HtmlPart — if HTML was intended, add HtmlPart; if text-only is intentional, this is fine');
    }

    if (issues.length > 0 || usesHtmlToTextConverter || hasInlineCss) {
      results.push({
        file: path.relative(appPath, file),
        className,
        usesTemplatedEmail,
        usesEmail,
        hasHtml,
        hasText,
        hasTextTemplate,
        hasHtmlTemplate,
        hasSubject,
        hasInlineCss,
        usesHtmlToTextConverter,
        usesTextPart,
        usesHtmlPart,
        issues,
      });
    }
  }

  return results;
}

function buildReport(appPath: string): { items: EmailClassInfo[]; packages: ComposerPackages } {
  const packages = readComposerPackages(appPath);
  const items = scanEmailClasses(appPath);

  // Add package-level issues
  for (const item of items) {
    if (item.usesHtmlToTextConverter && !packages.hasLeagueHtmlToMarkdown) {
      item.issues.push('HtmlToTextConverter used but "league/html-to-markdown" not found in composer.json — install with: composer require league/html-to-markdown');
    }
    if (item.hasInlineCss && !packages.hasCssInliner) {
      item.issues.push('inlineCss() called but no CSS inliner package found in composer.json — install pelago/emogrifier or tijsverkoyen/css-to-inline-styles');
    }
  }

  return { items, packages };
}

export function listSymfonyMailerHtmlToText(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { items, packages } = buildReport(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony Mailer HTML-to-text issues found.\n\nBest practice:\n  $email->html($htmlContent)\n        ->text($plainText)\n        ->subject(\'Subject\');\n\nOr with TemplatedEmail:\n  ->htmlTemplate(\'emails/welcome.html.twig\')\n  ->textTemplate(\'emails/welcome.txt.twig\')',
        }],
      };
    }

    let text = `Symfony Mailer HTML-to-Text Issues\n${'='.repeat(55)}\n\n`;
    text += `Composer packages:\n`;
    text += `  league/html-to-markdown: ${packages.hasLeagueHtmlToMarkdown ? 'installed' : 'NOT found'}\n`;
    text += `  CSS inliner:             ${packages.hasCssInliner ? 'installed' : 'NOT found'}\n\n`;

    const withIssues = items.filter((i) => i.issues.length > 0);
    text += `Files with issues: ${withIssues.length} / ${items.length} email-related files\n\n`;

    for (const item of items) {
      text += `  ${item.className}  (${item.file})\n`;
      text += `    html=${item.hasHtml || item.hasHtmlTemplate}  text=${item.hasText || item.hasTextTemplate}  `;
      text += `subject=${item.hasSubject}  inlineCss=${item.hasInlineCss}\n`;
      for (const issue of item.issues) {
        text += `    - ${issue}\n`;
      }
      if (item.issues.length === 0) {
        text += `    [OK — no issues]\n`;
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

export function getSymfonyMailerHtmlToTextStats(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { items, packages } = buildReport(appPath);

    const htmlOnly = items.filter((i) => (i.hasHtml || i.hasHtmlTemplate) && !i.hasText && !i.hasTextTemplate).length;
    const withConverter = items.filter((i) => i.usesHtmlToTextConverter).length;
    const withInlineCss = items.filter((i) => i.hasInlineCss).length;
    const totalIssues = items.reduce((s, i) => s + i.issues.length, 0);

    let text = `Symfony Mailer HTML-to-Text Stats\n${'='.repeat(40)}\n\n`;
    text += `Email-related files:              ${items.length}\n`;
    text += `HTML-only (missing text part):    ${htmlOnly}\n`;
    text += `Using HtmlToTextConverter:        ${withConverter}\n`;
    text += `Using inlineCss():                ${withInlineCss}\n`;
    text += `league/html-to-markdown present:  ${packages.hasLeagueHtmlToMarkdown}\n`;
    text += `CSS inliner package present:      ${packages.hasCssInliner}\n`;
    text += `Total issues:                     ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyMailerHtmlToTextTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_mailer_html_to_text',
      description: 'Scan src/ for Symfony Mailer HTML-to-text issues: missing text() / textTemplate() fallback, HtmlToTextConverter without league/html-to-markdown, inlineCss() without CSS inliner package, HTML-only emails without plain-text counterpart',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_mailer_html_to_text_stats',
      description: 'Statistics for Symfony Mailer HTML-to-text: email file count, HTML-only count, converter usage, inlineCss usage, missing package flags, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
