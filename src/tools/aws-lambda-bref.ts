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

interface BrefLambdaInfo {
  source: string;
  type: 'runtime' | 'cold-start' | 'filesystem' | 'timeout' | 'messenger';
  pattern: string;
  issues: string[];
}

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

function buildAwsLambdaBrefInfos(appPath: string): BrefLambdaInfo[] {
  const results: BrefLambdaInfo[] = [];

  // 1. Check serverless.yml or bref.yaml
  const serverlessFiles = ['serverless.yml', 'serverless.yaml', 'bref.yaml'];
  let serverlessContent = '';
  let serverlessFile = '';
  for (const fname of serverlessFiles) {
    const fpath = path.join(appPath, fname);
    if (fs.existsSync(fpath)) {
      try { serverlessContent = fs.readFileSync(fpath, 'utf-8'); serverlessFile = fname; } catch { /* skip */ }
      break;
    }
  }

  if (serverlessContent) {
    // Bref runtimes
    const runtimeMatches = serverlessContent.match(/php-\d{2}(?:-fpm)?/g);
    if (runtimeMatches) {
      for (const rt of [...new Set(runtimeMatches)]) {
        results.push({ source: serverlessFile, type: 'runtime', pattern: `Bref runtime: ${rt}`, issues: [] });
      }
    } else {
      results.push({
        source: serverlessFile,
        type: 'runtime',
        pattern: 'Bref deployment without explicit layers',
        issues: ['Bref deployment without explicit layers — ensure bref runtime layers are listed in serverless.yml for reproducible deploys'],
      });
    }

    // Timeout check
    const timeoutMatch = serverlessContent.match(/timeout:\s*(\d+)/);
    if (timeoutMatch) {
      const timeout = parseInt(timeoutMatch[1], 10);
      const info: BrefLambdaInfo = { source: serverlessFile, type: 'timeout', pattern: `timeout: ${timeout}s`, issues: [] };
      if (timeout > 29) {
        info.issues.push(`Lambda function timeout ${timeout}s is high — keep HTTP functions under 29 seconds to respect ALB/API Gateway limits; use async Messenger handlers for long operations`);
      }
      results.push(info);
    }

    // memorySize check
    const memMatch = serverlessContent.match(/memorySize:\s*(\d+)/);
    if (memMatch) {
      const mem = parseInt(memMatch[1], 10);
      const info: BrefLambdaInfo = { source: serverlessFile, type: 'cold-start', pattern: `memorySize: ${mem}MB`, issues: [] };
      if (mem < 256) {
        info.issues.push(`Lambda memorySize=${mem}MB may be too low for Symfony — Symfony typically needs 128-256MB; cold starts are slower with less memory`);
      }
      results.push(info);
    }

    // APP_ENV check
    if (!/APP_ENV\s*:\s*prod/.test(serverlessContent)) {
      results.push({
        source: serverlessFile,
        type: 'runtime',
        pattern: 'Missing APP_ENV=prod in environment',
        issues: ['Lambda deployment without APP_ENV=prod — ensure APP_ENV=prod in serverless.yml environment section for optimized Symfony production mode'],
      });
    }
  }

  // 2. Check PHP files for filesystem assumptions
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      const content = safeRead(file, appPath);
      if (content === null) continue;
      const relPath = path.relative(appPath, file);

      if (/sys_get_temp_dir\s*\(\s*\)/.test(content)) {
        results.push({ source: relPath, type: 'filesystem', pattern: 'sys_get_temp_dir() usage', issues: [] });
      }

      // file_put_contents without /tmp path
      const fpMatches = content.match(/file_put_contents\s*\(\s*['"][^'"]*['"]/g) ?? [];
      for (const match of fpMatches) {
        if (!/\/tmp/.test(match)) {
          results.push({
            source: relPath,
            type: 'filesystem',
            pattern: 'file_put_contents without /tmp path',
            issues: ['File write outside /tmp in Lambda — only /tmp directory is writable in Lambda; use S3/Flysystem for persistent file storage'],
          });
          break;
        }
      }
    }
  }

  // 3. Check composer.json for bref/bref
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    let content = '';
    try { content = fs.readFileSync(composerPath, 'utf-8'); } catch { /* skip */ }

    if (content.includes('bref/bref')) {
      results.push({ source: 'composer.json', type: 'runtime', pattern: 'bref/bref package found', issues: [] });
    }
  }

  // 4. Check messenger.yaml for SQS transport
  const messengerPaths = [
    path.join(appPath, 'config', 'packages', 'messenger.yaml'),
    path.join(appPath, 'config', 'messenger.yaml'),
  ];
  for (const mPath of messengerPaths) {
    if (!fs.existsSync(mPath)) continue;
    let content = '';
    try { content = fs.readFileSync(mPath, 'utf-8'); } catch { continue; }
    if (/sqs:|SqsTransport/i.test(content)) {
      results.push({ source: path.relative(appPath, mPath), type: 'messenger', pattern: 'SQS transport configured', issues: [] });
    }
    break;
  }

  return results;
}

export function listAwsLambdaBref(appPath: string): McpToolResult {
  try {
    const infos = buildAwsLambdaBrefInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No AWS Lambda/Bref configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `AWS Lambda / Bref Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAwsLambdaBrefStats(appPath: string): McpToolResult {
  try {
    const infos = buildAwsLambdaBrefInfos(appPath);
    let text = `AWS Lambda / Bref Statistics\n${'='.repeat(40)}\n\n`;
    text += `Runtime:    ${infos.filter((i) => i.type === 'runtime').length}\n`;
    text += `Cold-start: ${infos.filter((i) => i.type === 'cold-start').length}\n`;
    text += `Filesystem: ${infos.filter((i) => i.type === 'filesystem').length}\n`;
    text += `Timeout:    ${infos.filter((i) => i.type === 'timeout').length}\n`;
    text += `Messenger:  ${infos.filter((i) => i.type === 'messenger').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAwsLambdaBrefTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_aws_lambda_bref',
      description: 'Analyse AWS Lambda / Bref configuration: runtime layers, cold-start memory, filesystem write safety, timeout limits, missing APP_ENV=prod, and SQS Messenger transport',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_aws_lambda_bref_stats',
      description: 'Statistics for AWS Lambda / Bref: counts by type (runtime/cold-start/filesystem/timeout/messenger) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
