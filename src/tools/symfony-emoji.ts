import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface EmojiUsageInfo {
  file: string;
  type: 'transliterator' | 'slug' | 'text';
  usage: string;
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

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig') || e.name.endsWith('.html.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildEmojiInfos(appPath: string): EmojiUsageInfo[] {
  const results: EmojiUsageInfo[] = [];

  let hasEmojiPackage = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['symfony/emoji']) hasEmojiPackage = true;
    } catch { /* ignore */ }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      if (content.includes('EmojiTransliterator::create(') || content.includes('->transliterate(')) {
        const locale = /EmojiTransliterator::create\(\s*['"]([^'"]{1,40})['"]/.exec(content);
        if (!locale) {
          issues.push('EmojiTransliterator::create() called without locale argument — uses default, may produce unexpected results');
        }
        results.push({ file: relFile, type: 'transliterator', usage: 'EmojiTransliterator', issues });
      }

      const hasSlugger = content.includes('AsciiSlugger') || content.includes('->slug(');
      const hasEmojiBeforeSlug = content.includes('EmojiTransliterator') && hasSlugger;
      if (hasSlugger && !hasEmojiBeforeSlug) {
        const emojiInInput = /emoji|Emoji|😀|🎉|🚀/.test(content);
        if (emojiInInput) {
          issues.push('AsciiSlugger used without EmojiTransliterator — emoji characters will be stripped/garbled in slugs');
          results.push({ file: relFile, type: 'slug', usage: 'AsciiSlugger without emoji handling', issues });
        }
      }

      if (content.includes('mail') || content.includes('Email') || content.includes('TemplatedEmail')) {
        const hasEmoji = /emoji|🎉|📧|✅|❌/.test(content);
        if (hasEmoji && !content.includes('EmojiTransliterator')) {
          issues.push('Emoji in email content without EmojiTransliterator encoding — some mail clients may not render emoji correctly');
          results.push({ file: relFile, type: 'text', usage: 'emoji in email', issues });
        }
      }
    }
  }

  const templatesDir = path.join(appPath, 'templates');
  if (fs.existsSync(templatesDir)) {
    for (const file of getAllTwigFiles(templatesDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const relFile = path.relative(appPath, file);
      const twigFilters = ['emoji_to_text', 'text_to_emoji', 'emoji_to_short'];
      for (const filter of twigFilters) {
        if (content.includes(`|${filter}`)) {
          if (!hasEmojiPackage) {
            results.push({ file: relFile, type: 'text', usage: `|${filter} filter`, issues: [`Twig |${filter} filter used but symfony/emoji not in composer.json`] });
          } else {
            results.push({ file: relFile, type: 'text', usage: `|${filter} filter`, issues: [] });
          }
        }
      }
    }
  }

  return results;
}

export function listSymfonyEmojiUsage(appPath: string): McpToolResult {
  try {
    const infos = buildEmojiInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony Emoji component usage found (no EmojiTransliterator, emoji Twig filters).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Emoji Analysis\n${'='.repeat(50)}\n\nUsages: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.usage}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyEmojiStats(appPath: string): McpToolResult {
  try {
    const infos = buildEmojiInfos(appPath);
    let text = `Symfony Emoji Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transliterators: ${infos.filter((i) => i.type === 'transliterator').length}\n`;
    text += `Slug usages:     ${infos.filter((i) => i.type === 'slug').length}\n`;
    text += `Text usages:     ${infos.filter((i) => i.type === 'text').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyEmojiUsageTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_emoji_usage', description: 'Detect Symfony Emoji component usage; warns on EmojiTransliterator without locale, slugger without emoji handling, emoji in emails, Twig emoji filters without symfony/emoji package', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_emoji_stats', description: 'Statistics for Symfony Emoji usage: transliterator/slug/text count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
