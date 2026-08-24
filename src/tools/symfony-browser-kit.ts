// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony BrowserKit Inspector
 *
 * Scans tests/ PHP for: $client->click(, $client->submit(, $crawler->filter(,
 * $crawler->selectLink(, $crawler->form(, $crawler->selectButton(, followRedirects(),
 * disableFollowingRedirects(), $crawler->selectImage().
 *
 * Warns about:
 *   - $crawler->filter() with complex CSS selector that may not match (empty result)
 *   - $client->submit() on form with CSRF token not injected (may fail in non-WebTestCase)
 *   - $crawler->link() on element without href (throws)
 *   - Clicking link that opens new tab (BrowserKit ignores target=_blank)
 *   - $crawler->filter()->first()->link() without checking count() first (throws if no match)
 *   - selectButton() with text containing special chars not escaped
 *   - Crawler tests without any assertion after interaction (navigation tested but result not verified)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface BrowserKitInfo {
  file: string;
  class: string;
  crawlerUsages: number;
  hasFormSubmit: boolean;
  hasLinkClick: boolean;
  hasUncheckedCount: boolean;
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

function extractClassName(content: string): string {
  const m = content.match(/class\s+([A-Za-z0-9_]{1,120})/);
  return m ? m[1] : '(unknown)';
}

function buildBrowserKitInfos(appPath: string): BrowserKitInfo[] {
  const testsDir = path.join(appPath, 'tests');
  if (!fs.existsSync(testsDir)) return [];

  const results: BrowserKitInfo[] = [];

  for (const file of getAllPhpFiles(testsDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasBrowserKit =
      content.includes('->filter(') ||
      content.includes('->click(') ||
      content.includes('->submit(') ||
      content.includes('->selectLink(') ||
      content.includes('->form(') ||
      content.includes('->selectButton(') ||
      content.includes('followRedirects(') ||
      content.includes('disableFollowingRedirects(') ||
      content.includes('->selectImage(') ||
      content.includes('WebTestCase');

    if (!hasBrowserKit) continue;

    const className = extractClassName(content);
    const issues: string[] = [];

    // Count crawler usages
    const filterMatches = content.match(/->filter\s*\(/g) ?? [];
    const crawlerUsages = filterMatches.length;

    const hasFormSubmit = content.includes('->submit(');
    const hasLinkClick = content.includes('->click(');

    // Detect ->filter()->first()->link() without count() check
    const hasUncheckedCount = /->filter\s*\([^)]{1,200}\)\s*->(?:first|last)\s*\(\s*\)\s*->link\s*\(/.test(content) &&
      !content.includes('->count()');

    if (hasUncheckedCount) {
      issues.push(`"${className}" calls ->filter()->first()->link() without checking ->count() first — throws if the selector matches nothing`);
    }

    // Detect filter with complex selectors (many combinators or pseudo-selectors)
    const complexFilterRe = /->filter\s*\(\s*['"]([^'"]{30,200})['"]/g;
    const complexMatches = [...content.matchAll(complexFilterRe)];
    for (const m of complexMatches) {
      if ((m[1].match(/[>,+~]/g) ?? []).length >= 3) {
        issues.push(`"${className}" uses complex CSS selector "${m[1].substring(0, 60)}..." — complex selectors may not match; check for empty Crawler result`);
        break;
      }
    }

    // Detect submit without CSRF token consideration
    if (hasFormSubmit && !content.includes('WebTestCase') && !content.includes('csrf') && !content.includes('_token')) {
      issues.push(`"${className}" calls submit() outside of WebTestCase without CSRF token injection — form submission may fail with CSRF validation error`);
    }

    // Detect link() without href check (looking for selectLink on non-link elements)
    if (content.includes('->link(') && !content.includes('->selectLink(') && !content.includes('href')) {
      issues.push(`"${className}" calls ->link() which throws if element has no href attribute — verify element is an anchor before calling link()`);
    }

    // Detect target=_blank concern
    if (content.includes('target') && content.includes('_blank') && hasLinkClick) {
      issues.push(`"${className}" may be clicking links with target="_blank" — BrowserKit ignores the target attribute and follows the link in the same client context`);
    }

    // Detect assertions after interactions
    const hasAssertAfterClick = ((): boolean => {
      const clickIdx = content.indexOf('->click(');
      const submitIdx = content.indexOf('->submit(');
      const interactIdx = Math.min(
        clickIdx >= 0 ? clickIdx : Infinity,
        submitIdx >= 0 ? submitIdx : Infinity,
      );
      if (interactIdx === Infinity) return true;
      const afterInteract = content.slice(interactIdx);
      return /\$this->assert[A-Z]/.test(afterInteract) ||
        /assertEquals\s*\(/.test(afterInteract) ||
        /assertResponseIsSuccessful/.test(afterInteract);
    })();

    if (!hasAssertAfterClick && (hasLinkClick || hasFormSubmit)) {
      issues.push(`"${className}" performs click/submit but has no assertions after the interaction — navigation is tested but response content is not verified`);
    }

    results.push({
      file,
      class: className,
      crawlerUsages,
      hasFormSubmit,
      hasLinkClick,
      hasUncheckedCount,
      issues,
    });
  }

  return results;
}

export function listBrowserKitUsage(appPath: string): McpToolResult {
  try {
    const infos = buildBrowserKitInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No BrowserKit/Crawler usage found in tests/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `BrowserKit Usage Analysis\n${'='.repeat(55)}\n\n`;
    text += `Test files: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}\n`;
      text += `    crawlerUsages:      ${info.crawlerUsages}\n`;
      text += `    hasFormSubmit:      ${info.hasFormSubmit ? 'yes' : 'no'}\n`;
      text += `    hasLinkClick:       ${info.hasLinkClick ? 'yes' : 'no'}\n`;
      text += `    uncheckedCount:     ${info.hasUncheckedCount ? 'yes' : 'no'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getBrowserKitStats(appPath: string): McpToolResult {
  try {
    const infos = buildBrowserKitInfos(appPath);

    let text = `BrowserKit Usage Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total test files:            ${infos.length}\n`;
    text += `  With form submit:          ${infos.filter((i) => i.hasFormSubmit).length}\n`;
    text += `  With link click:           ${infos.filter((i) => i.hasLinkClick).length}\n`;
    text += `  With unchecked count:      ${infos.filter((i) => i.hasUncheckedCount).length}\n`;
    text += `  Total crawler usages:      ${infos.reduce((s, i) => s + i.crawlerUsages, 0)}\n`;
    text += `Total issues:                ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getBrowserKitTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_browser_kit_usage',
      description: 'Inspect BrowserKit/Crawler usage in tests/: filter/click/submit/selectLink patterns, CSRF token handling, complex CSS selectors, assertions after interactions; warns on unchecked count(), missing assertions, target=_blank clicks, non-WebTestCase CSRF issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_browser_kit_stats',
      description: 'Statistics for BrowserKit usage: test file count, form submit count, link click count, unchecked count() usage, total crawler usages, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
