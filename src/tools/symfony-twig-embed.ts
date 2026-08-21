/**
 * Symfony Twig Embed Tag Inspector
 *
 * Scans templates/**\/*.twig and src/**\/*.twig for Twig embed tag patterns:
 *   - {% embed %} without matching {% endembed %}
 *   - {% embed variable %} where variable could be user-controlled (injection risk)
 *   - Embedded templates from untrusted directory paths
 *   - {% embed %} overriding {% block %} that is used in parent — block name collisions
 *   - Missing `with {...} only` for isolated variable scope in embeds
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface TwigEmbedInfo {
  file: string;
  line: number;
  pattern: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectTwigFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectTwigFiles(full, base));
    else if (entry.endsWith('.twig')) results.push(full);
  }
  return results;
}

// ─── Twig embed analysis ──────────────────────────────────────────────────────

function analyzeFile(filePath: string, base: string): TwigEmbedInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: TwigEmbedInfo[] = [];

  // Track embed positions for matching
  const embedStack: number[] = [];
  const embedLines: number[] = [];
  const endembedLines: number[] = [];
  const blocksInFile = new Set<string>();
  const blocksInEmbeds = new Set<string>();
  let insideEmbed = false;

  // First pass: collect block names defined at top level (not inside embed)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const blockMatch = /\{%[-]?\s*block\s+([\w]{1,80})\s*[-]?%\}/.exec(line);
    if (blockMatch) {
      blocksInFile.add(blockMatch[1]);
    }
  }

  // Second pass: analyze embed tags
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Detect {% embed ... %}
    const embedMatch = /\{%[-]?\s*embed\s+(.{1,200}?)[-]?\s*%\}/.exec(line);
    if (embedMatch) {
      embedLines.push(lineNum);
      embedStack.push(lineNum);
      insideEmbed = true;
      const embedArg = embedMatch[1].trim();

      // Check if embed arg is a variable (not a string literal)
      const isVariable = !embedArg.startsWith("'") && !embedArg.startsWith('"') && /\w/.test(embedArg);
      if (isVariable) {
        // Check if it looks user-controlled
        const isUserControlled = /app\.(request|user)|_GET|_POST|request\.get|request\.query/.test(embedArg);
        if (isUserControlled) {
          results.push({
            file: relFile,
            line: lineNum,
            pattern: 'embed-user-variable',
            issue: `{% embed ${embedArg} %} — embed path appears user-controlled; attacker may control which template is embedded, leading to information disclosure or template injection`,
            severity: 'high',
          });
        } else {
          results.push({
            file: relFile,
            line: lineNum,
            pattern: 'embed-dynamic-variable',
            issue: `{% embed ${embedArg} %} — embed path is a variable, not a string literal; verify it cannot be influenced by user input and is constrained to a known set of template paths`,
            severity: 'medium',
          });
        }
      }

      // Check for missing `only` keyword for isolated scope
      if (embedArg.includes(' with ') && !embedArg.includes(' only')) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'embed-missing-only',
          issue: `{% embed ... with {...} %} without "only" — the embedded template inherits ALL parent variables; use "{% embed ... with {...} only %}" to isolate scope and prevent accidental variable leakage`,
          severity: 'low',
        });
      } else if (!embedArg.includes(' with ')) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'embed-no-with-only',
          issue: `{% embed %} without "with {...} only" — the embedded template inherits all parent variables; consider "{% embed '...' with {} only %}" for explicit, isolated variable scope`,
          severity: 'low',
        });
      }

      // Check for untrusted path patterns (../  or absolute paths)
      if (embedArg.includes('..') || embedArg.startsWith('/')) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'embed-path-traversal',
          issue: `{% embed ${embedArg} %} contains path traversal (../) or absolute path — only embed templates from trusted relative paths within the templates/ directory`,
          severity: 'high',
        });
      }

      continue;
    }

    // Detect {% endembed %}
    if (/\{%[-]?\s*endembed\s*[-]?%\}/.test(line)) {
      endembedLines.push(lineNum);
      if (embedStack.length > 0) {
        embedStack.pop();
        insideEmbed = embedStack.length > 0;
      }
      continue;
    }

    // Track blocks inside embeds to detect collisions
    const blockMatch = /\{%[-]?\s*block\s+([\w]{1,80})\s*[-]?%\}/.exec(line);
    if (blockMatch && insideEmbed) {
      blocksInEmbeds.add(blockMatch[1]);
    }
  }

  // Check for unclosed embeds
  if (embedStack.length > 0) {
    for (const unclosedLine of embedStack) {
      results.push({
        file: relFile,
        line: unclosedLine,
        pattern: 'embed-unclosed',
        issue: `{% embed %} at line ${unclosedLine} has no matching {% endembed %} — template will fail to render; add {% endembed %} to close the block`,
        severity: 'high',
      });
    }
  }

  // Check for block name collisions between embed and file
  for (const blockName of blocksInEmbeds) {
    if (blocksInFile.has(blockName)) {
      results.push({
        file: relFile,
        line: 1,
        pattern: 'embed-block-collision',
        issue: `Block "${blockName}" is defined both at file level and inside an {% embed %} block — the embed override may shadow the parent block unexpectedly; rename one of the blocks to avoid collision`,
        severity: 'medium',
      });
    }
  }

  return results;
}

function loadAll(appPath: string): TwigEmbedInfo[] {
  const templatesDir = path.join(appPath, 'templates');
  const srcDir = path.join(appPath, 'src');
  const results: TwigEmbedInfo[] = [];

  if (fs.existsSync(templatesDir)) {
    for (const f of collectTwigFiles(templatesDir, appPath)) {
      results.push(...analyzeFile(f, appPath));
    }
  }
  if (fs.existsSync(srcDir)) {
    for (const f of collectTwigFiles(srcDir, appPath)) {
      results.push(...analyzeFile(f, appPath));
    }
  }

  return results.sort((a, b) => {
    const sev: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3) || a.file.localeCompare(b.file) || a.line - b.line;
  });
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listSymfonyTwigEmbed(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);
    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Twig embed issues found in templates/ or src/.\n\n' +
            'Checked: unclosed embed tags, dynamic/user-controlled embed paths, ' +
            'missing "with {...} only" scope isolation, block name collisions, path traversal in embed paths.',
        }],
      };
    }

    const high = items.filter((i) => i.severity === 'high');
    const medium = items.filter((i) => i.severity === 'medium');
    const low = items.filter((i) => i.severity === 'low');

    let text = `Symfony Twig Embed Analysis\n${'='.repeat(55)}\n\n`;
    text += `  Total findings:  ${items.length}\n`;
    text += `  High:            ${high.length}\n`;
    text += `  Medium:          ${medium.length}\n`;
    text += `  Low:             ${low.length}\n`;
    text += `  Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;

    for (const item of items) {
      text += `[${item.severity.toUpperCase()}] ${item.file}:${item.line}  [${item.pattern}]\n`;
      text += `  ${item.issue}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyTwigEmbedStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    const byPattern: Record<string, number> = {};
    for (const item of items) {
      byPattern[item.pattern] = (byPattern[item.pattern] ?? 0) + 1;
    }

    let text = `Symfony Twig Embed Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total:           ${items.length}\n`;
    text += `High:            ${items.filter((i) => i.severity === 'high').length}\n`;
    text += `Medium:          ${items.filter((i) => i.severity === 'medium').length}\n`;
    text += `Low:             ${items.filter((i) => i.severity === 'low').length}\n`;
    text += `Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;
    text += `By pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) {
      text += `  ${pat}: ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function getSymfonyTwigEmbedTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_twig_embed',
      description: 'Scan templates/**/*.twig and src/**/*.twig for Twig embed issues: unclosed embed tags, dynamic/user-controlled embed paths (injection risk), path traversal, missing "with {} only" scope isolation, block name collisions between embed and parent template',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_twig_embed_stats',
      description: 'Statistics for Symfony Twig embed findings: total count, breakdown by severity (high/medium/low) and pattern, files affected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
