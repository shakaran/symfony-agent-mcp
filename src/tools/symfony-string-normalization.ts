import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface StringNormalizationInfo {
  file: string;
  type: 'nfc' | 'nfd' | 'nfkc' | 'nfkd' | 'ascii';
  method: string;
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

function buildNormalizationInfos(appPath: string): StringNormalizationInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: StringNormalizationInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);

    const hasNormalize = content.includes('->normalize(') || content.includes('normalizer_normalize(') || content.includes('Normalizer::normalize(');
    const hasAscii = content.includes('->ascii()') || content.includes('->folded()');
    const hasCollation = content.includes('Collator::create(') || content.includes('new Collator(');

    if (hasNormalize) {
      const issues: string[] = [];
      const nfcUsed = content.includes('NFC') || content.includes('normalizer_normalize') && !content.includes('NFD') && !content.includes('NFKC') && !content.includes('NFKD');
      const form = nfcUsed ? 'nfc' : content.includes('NFD') ? 'nfd' : content.includes('NFKC') ? 'nfkc' : content.includes('NFKD') ? 'nfkd' : 'nfc';

      const doubleNormalize = /->normalize\([^)]{0,100}\)[^;]{0,200}->normalize\(/.test(content);
      if (doubleNormalize) {
        issues.push('Double normalize() call detected — normalize is idempotent but calling it twice wastes cycles; use isNormalized() check first');
      }

      if (content.includes('strcmp(') || content.includes('strnatcmp(')) {
        issues.push('strcmp/strnatcmp used after normalize — for locale-aware comparison use Collator::compare() instead');
      }

      results.push({ file: relFile, type: form, method: '->normalize()', issues });
    }

    if (hasAscii) {
      const issues: string[] = [];
      const slugWithoutFolded = content.includes('->ascii()') && !content.includes('->folded()') && content.includes('slug');
      if (slugWithoutFolded) {
        issues.push('->ascii() used for slugging without ->folded() first — diacritics may not be stripped correctly (use ->folded()->ascii())');
      }
      results.push({ file: relFile, type: 'ascii', method: '->ascii() / ->folded()', issues });
    }

    if (content.includes('mb_strtolower(') || content.includes('mb_convert_case(')) {
      const issues: string[] = [];
      const noLocale = /mb_strtolower\(\s*\$\w{1,60}\s*\)/.test(content);
      if (noLocale) {
        issues.push('mb_strtolower() without locale argument — Turkish dotless-i and other locale-sensitive casing not handled correctly');
      }
      results.push({ file: relFile, type: 'nfc', method: 'mb_strtolower/mb_convert_case', issues });
    }

    if (hasCollation) {
      results.push({ file: relFile, type: 'nfc', method: 'Collator', issues: [] });
    }

    if (!hasNormalize && !hasAscii && !hasCollation) {
      const sortIssue = content.includes('usort(') && content.includes('strcmp(');
      if (sortIssue) {
        results.push({ file: relFile, type: 'nfc', method: 'usort+strcmp', issues: ['usort() with strcmp() on Unicode strings produces byte-order sort, not locale-aware sort — use Collator::compare() for correct ordering'] });
      }
    }
  }

  return results;
}

export function listSymfonyStringNormalization(appPath: string): McpToolResult {
  try {
    const infos = buildNormalizationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Unicode normalization patterns found (no normalize(), mb_strtolower, Collator, or ascii() calls).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `String Normalization Analysis\n${'='.repeat(50)}\n\nUsages: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.method}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyStringNormalizationStats(appPath: string): McpToolResult {
  try {
    const infos = buildNormalizationInfos(appPath);
    let text = `String Normalization Statistics\n${'='.repeat(40)}\n\n`;
    text += `NFC usages:   ${infos.filter((i) => i.type === 'nfc').length}\n`;
    text += `NFD usages:   ${infos.filter((i) => i.type === 'nfd').length}\n`;
    text += `NFKC usages:  ${infos.filter((i) => i.type === 'nfkc').length}\n`;
    text += `ASCII/folded: ${infos.filter((i) => i.type === 'ascii').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyStringNormalizationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_string_normalization', description: 'Analyze Unicode normalization patterns; warns on double normalize, strcmp after normalize, mb_strtolower without locale, ascii() without folded(), usort with strcmp on Unicode', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_string_normalization_stats', description: 'Statistics for string normalization: NFC/NFD/NFKC/ASCII usage count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
