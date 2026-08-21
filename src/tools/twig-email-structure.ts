import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TwigEmailInfo {
  file: string;
  class?: string;
  usesTemplatedEmail: boolean;
  hasCssInliner: boolean;
  hasMjml: boolean;
  hasTextPart: boolean;
  hasHtmlPart: boolean;
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

function parseEmailFile(filePath: string, appPath: string): TwigEmailInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const usesTemplatedEmail = content.includes('TemplatedEmail') || content.includes('new Email()') || content.includes('->htmlTemplate(') || content.includes('->textTemplate(');
  if (!usesTemplatedEmail) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const hasCssInliner = content.includes('CssInliner') || content.includes('InlineCss') || content.includes('twig/cssinliner-extra');
  const hasMjml = content.includes('mjml') || content.includes('MJML');
  const hasTextPart = content.includes('->textTemplate(') || content.includes('->text(');
  const hasHtmlPart = content.includes('->htmlTemplate(') || content.includes('->html(');
  const issues: string[] = [];
  if (hasHtmlPart && !hasTextPart) issues.push('HTML email without text/plain part — mail clients without HTML rendering show empty email');
  if (hasHtmlPart && !hasCssInliner) issues.push('HTML email without CSS inliner — email clients may ignore <style> tags; use SymfonyCssInliner extra');
  if (!hasHtmlPart && !hasTextPart) issues.push('Email without html or text body — email will be empty');
  return { file: path.relative(appPath, filePath), class: classM?.[1], usesTemplatedEmail, hasCssInliner, hasMjml, hasTextPart, hasHtmlPart, issues };
}

export function listTwigEmailStructure(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: TwigEmailInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseEmailFile(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No TemplatedEmail/Email usage found.' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Twig Email Structure\n${'='.repeat(55)}\n\nEmail senders: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [
        r.hasHtmlPart ? '✓HTML' : '✗HTML',
        r.hasTextPart ? '✓text' : '✗text',
        r.hasCssInliner ? '✓CSSInliner' : '',
        r.hasMjml ? 'MJML' : '',
      ].filter(Boolean).join('  ');
      text += `\n  ${r.class ?? '(file)'}  ${flags}  (${r.file})\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTwigEmailStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: TwigEmailInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseEmailFile(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `Twig Email Statistics\n${'='.repeat(40)}\n\n`;
    text += `Email senders: ${results.length}\n  With HTML: ${results.filter(r => r.hasHtmlPart).length}\n  With text: ${results.filter(r => r.hasTextPart).length}\n  With CSS inliner: ${results.filter(r => r.hasCssInliner).length}\n  With MJML: ${results.filter(r => r.hasMjml).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTwigEmailTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_twig_email_structure', description: 'Detect Symfony TemplatedEmail usage: HTML/text part coverage, SymfonyCssInliner usage, MJML detection, missing text-part warning, missing CSS inliner warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_twig_email_stats', description: 'Twig email statistics: sender count, HTML/text/CSS-inliner/MJML coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
