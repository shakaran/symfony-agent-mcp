// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface OpenAiIntegrationInfo {
  file: string;
  type: 'completion' | 'chat' | 'embedding' | 'image' | 'moderation';
  model: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildOpenAiIntegrationInfos(appPath: string): OpenAiIntegrationInfo[] {
  const results: OpenAiIntegrationInfo[] = [];

  // Check composer.json for OpenAI packages
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (composerContent.includes('openai-php/client')) {
      results.push({ file: 'composer.json', type: 'chat', model: '', issues: [] });
    }
    if (composerContent.includes('openai-php/symfony')) {
      results.push({ file: 'composer.json', type: 'chat', model: '', issues: [] });
    }
    if (composerContent.includes('symfony/openai-bundle')) {
      results.push({ file: 'composer.json', type: 'chat', model: '', issues: [] });
    }
  }

  // Scan .env* for OpenAI credentials
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const apiKeyMatch = /OPENAI_API_KEY\s*=\s*([^\n]+)/.exec(content);
    const orgMatch = /OPENAI_ORGANIZATION\s*=\s*([^\n]+)/.exec(content);

    if (apiKeyMatch) {
      const rawKey = apiKeyMatch[1].trim();
      const issues: string[] = [];
      if (rawKey && !rawKey.startsWith('%env(') && !rawKey.startsWith('${')) {
        issues.push(`OPENAI_API_KEY present in ${fname} — inject via CI secrets; OpenAI API keys grant full account access and must never be committed to version control`);
      }
      results.push({ file: fname, type: 'chat', model: '', issues });
    }
    if (orgMatch) {
      results.push({ file: fname, type: 'chat', model: '', issues: [] });
    }
  }

  // Scan src/**/*.php for OpenAI usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('OpenAI::client(') &&
      !content.includes('->chat()->create(') &&
      !content.includes('->completions()->create(') &&
      !content.includes('->embeddings()->create(') &&
      !content.includes("'model' => 'gpt-") &&
      !content.includes('"model" => "gpt-')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    // Hardcoded API key
    if (/OpenAI::client\s*\(\s*['"][a-zA-Z0-9\-_]{20,}/.test(content)) {
      issues.push(`Hardcoded OpenAI API key in ${relFile} — use OPENAI_API_KEY env variable instead of inline string`);
    }

    // No timeout configured
    if (content.includes('OpenAI::client(') && !content.includes('timeout') && !content.includes('connectTimeout')) {
      issues.push(`OpenAI client in ${relFile} without timeout configuration — set timeout to prevent hanging requests from blocking workers; use OpenAI::factory()->withHttpClient(...) with a timeout`);
    }

    // Prompt injection risk: user input directly in messages[]
    const hasUserInput = content.includes('$request->get(') || content.includes('$request->getContent(') || content.includes('$_POST') || content.includes('$_GET');
    const hasMessages = content.includes("'messages'") || content.includes('"messages"');
    if (hasUserInput && hasMessages) {
      const hasValidation = content.includes('strip_tags') || content.includes('htmlspecialchars') || content.includes('filter_var') || content.includes('Assert');
      if (!hasValidation) {
        issues.push(`Potential prompt injection in ${relFile} — user input passed directly to OpenAI messages[] without sanitization; validate and sanitize user content before including in prompts`);
      }
    }

    // No rate limiting
    if ((content.includes('->chat()->create(') || content.includes('->completions()->create(')) && !content.includes('RateLimiter') && !content.includes('rate_limit')) {
      issues.push(`OpenAI API call in ${relFile} without rate limiting — implement rate limiting (Symfony RateLimiter) to prevent abuse and control costs on AI endpoints`);
    }

    // Detect model type
    const modelM = /'model'\s*=>\s*'([a-zA-Z0-9-]{3,50})'/.exec(content)
      ?? /"model"\s*=>\s*"([a-zA-Z0-9-]{3,50})"/.exec(content);
    const model = modelM ? modelM[1] : '';

    const type: OpenAiIntegrationInfo['type'] = content.includes('->embeddings()->create(') ? 'embedding'
      : content.includes('->images()->create(') ? 'image'
      : content.includes('->moderations()->create(') ? 'moderation'
      : content.includes('->completions()->create(') ? 'completion'
      : 'chat';

    results.push({ file: relFile, type, model, issues });
  }

  return results;
}

export function listOpenAiIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildOpenAiIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No OpenAI integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `OpenAI Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      const modelStr = info.model ? `  model:${info.model}` : '';
      text += `\n  [${info.type.toUpperCase()}]${modelStr}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getOpenAiIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildOpenAiIntegrationInfos(appPath);
    let text = `OpenAI Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Completion patterns: ${infos.filter((i) => i.type === 'completion').length}\n`;
    text += `Chat patterns:       ${infos.filter((i) => i.type === 'chat').length}\n`;
    text += `Embedding patterns:  ${infos.filter((i) => i.type === 'embedding').length}\n`;
    text += `Image patterns:      ${infos.filter((i) => i.type === 'image').length}\n`;
    text += `Moderation patterns: ${infos.filter((i) => i.type === 'moderation').length}\n`;
    text += `Issues:              ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getOpenAiIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_openai_integration',
      description: 'Analyze OpenAI integration: detect composer packages (openai-php/client, openai-php/symfony), env credentials (OPENAI_API_KEY/ORGANIZATION), PHP OpenAI::client/chat/completions/embeddings usage, flag hardcoded API key, no timeout, prompt injection risk (user input in messages[]), no rate limiting',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_openai_integration_stats',
      description: 'Statistics for OpenAI integration: completion/chat/embedding/image/moderation pattern counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
