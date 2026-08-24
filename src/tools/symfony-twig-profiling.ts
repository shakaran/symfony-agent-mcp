// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TwigProfilingInfo {
  file: string;
  type: 'nested-loop' | 'n-plus-one' | 'heavy-filter' | 'include-chain' | 'cache-missing';
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
      else if (e.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildTwigProfilingInfos(appPath: string): TwigProfilingInfo[] {
  const results: TwigProfilingInfo[] = [];
  const templatesDir = path.join(appPath, 'templates');
  if (!fs.existsSync(templatesDir)) return results;

  for (const file of getAllTwigFiles(templatesDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const relFile = path.relative(appPath, file);

    const forMatches = [...content.matchAll(/{%\s*for\s+/g)];
    const endForMatches = [...content.matchAll(/{%\s*endfor\s*%}/g)];
    if (forMatches.length >= 2 && endForMatches.length >= 2) {
      const loopPositions = forMatches.map((m) => m.index ?? 0);
      const endPositions = endForMatches.map((m) => m.index ?? 0);
      let hasNested = false;
      for (let i = 0; i < loopPositions.length - 1; i++) {
        const outerStart = loopPositions[i];
        const outerEnd = endPositions[endPositions.length - 1] ?? 0;
        for (let j = i + 1; j < loopPositions.length; j++) {
          if (loopPositions[j] > outerStart && loopPositions[j] < outerEnd) {
            hasNested = true;
            break;
          }
        }
        if (hasNested) break;
      }
      if (hasNested) {
        results.push({ file: relFile, type: 'nested-loop', pattern: 'nested for loops', issues: ['Nested Twig for-loops detected — O(n×m) renders; consider flattening the dataset in the controller before passing to the template'] });
      }
    }

    if (content.includes('.count()') || content.includes('|length') || content.includes('.length')) {
      const forBlocks = content.matchAll(/{%\s*for[^%]{1,100}%}([\s\S]{1,2000}?){%\s*endfor\s*%}/g);
      for (const block of forBlocks) {
        const inner = block[1] ?? '';
        if ((inner.includes('.count()') || inner.includes('|length')) && (inner.includes('repository') || inner.includes('->find') || inner.includes('getAll'))) {
          results.push({ file: relFile, type: 'n-plus-one', pattern: 'count/length inside for-loop touching repository', issues: ['Potential N+1 in Twig: size/count call inside loop may trigger additional DB queries — eager-load collections or pass counts pre-computed from controller'] });
          break;
        }
      }
    }

    if (content.includes('|json_encode') && content.includes('for ')) {
      results.push({ file: relFile, type: 'heavy-filter', pattern: '|json_encode inside loop', issues: ['json_encode filter inside a for-loop is expensive — serialize once in the controller and pass as a variable'] });
    }

    if (content.includes('|markdown') || content.includes('|markdown_to_html')) {
      const inLoop = /{%\s*for[\s\S]{1,500}markdown[\s\S]{1,500}{%\s*endfor/.test(content);
      if (inLoop) {
        results.push({ file: relFile, type: 'heavy-filter', pattern: '|markdown inside for-loop', issues: ['Markdown rendering inside a for-loop is CPU-intensive — pre-render markdown in the controller or use a cache tag'] });
      }
    }

    const includeDepth = (content.match(/{%\s*include\s/g) ?? []).length;
    if (includeDepth >= 4) {
      results.push({ file: relFile, type: 'include-chain', pattern: `${includeDepth} includes`, issues: [`Template has ${includeDepth} include tags — deep include chains increase render time; consider using Twig blocks and a single parent template instead`] });
    }

    const hasCacheTag = content.includes('{% cache ') || content.includes('{# cache #}');
    const hasBigLoop = (content.match(/{%\s*for\s+/g) ?? []).length >= 2;
    if (!hasCacheTag && hasBigLoop) {
      results.push({ file: relFile, type: 'cache-missing', pattern: 'multiple loops, no cache tag', issues: ['Template has multiple for-loops but no {% cache %} tag — consider wrapping expensive list rendering with Twig cache (requires twig/cache-extra or symfony/ux-twig-component cache attribute)'] });
    }
  }

  return results;
}

export function listSymfonyTwigProfiling(appPath: string): McpToolResult {
  try {
    const infos = buildTwigProfilingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Twig template performance issues detected (no nested loops, N+1 patterns, heavy filters, or deep include chains).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Twig Template Performance Analysis\n${'='.repeat(55)}\n\nFindings: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyTwigProfilingStats(appPath: string): McpToolResult {
  try {
    const infos = buildTwigProfilingInfos(appPath);
    let text = `Twig Profiling Statistics\n${'='.repeat(40)}\n\n`;
    text += `Nested loops:      ${infos.filter((i) => i.type === 'nested-loop').length}\n`;
    text += `N+1 patterns:      ${infos.filter((i) => i.type === 'n-plus-one').length}\n`;
    text += `Heavy filters:     ${infos.filter((i) => i.type === 'heavy-filter').length}\n`;
    text += `Include chains:    ${infos.filter((i) => i.type === 'include-chain').length}\n`;
    text += `Cache missing:     ${infos.filter((i) => i.type === 'cache-missing').length}\n`;
    text += `Issues:            ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyTwigProfilingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_twig_profiling', description: 'Detect Twig template performance issues: nested for-loops, N+1 count calls inside loops, json_encode/markdown inside loops, deep include chains, missing cache tags', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_twig_profiling_stats', description: 'Statistics for Twig performance: nested-loop/n+1/heavy-filter/include-chain/cache-missing count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
