// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface MongodbIntegrationInfo {
  file: string;
  type: 'driver' | 'query' | 'security' | 'config';
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

function maskMongoUri(uri: string): string {
  return uri
    .replace(/mongodb(?:\+srv)?:\/\/([^:@]+):([^@]+)@/, 'mongodb://$1:***@')
    .replace(/([?&](?:password|auth|token|secret|key)=)[^&\s]+/gi, '$1***');
}

function buildMongodbIntegrationInfos(appPath: string): MongodbIntegrationInfo[] {
  const results: MongodbIntegrationInfo[] = [];

  // Check composer.json for MongoDB packages
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (composerContent.includes('mongodb/mongodb')) {
      results.push({ file: 'composer.json', type: 'driver', issues: ['mongodb/mongodb driver detected'] });
    }
    if (composerContent.includes('doctrine/mongodb-odm')) {
      results.push({ file: 'composer.json', type: 'driver', issues: ['doctrine/mongodb-odm detected'] });
    }
  }

  // Scan config/**/*.yaml for MongoDB config
  const configFiles: string[] = [
    ...scanDirRecursive(path.join(appPath, 'config'), '.yaml'),
    ...scanDirRecursive(path.join(appPath, 'config'), '.yml'),
  ];
  for (const filePath of configFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (!content.includes('mongodb') && !content.includes('doctrine_mongodb')) continue;
    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    // Detect hardcoded MongoDB URI with credentials in YAML
    const uriMatch = /mongodb:\/\/[^:]+:[^@\s]+@[^\s'"]+/.exec(content);
    if (uriMatch) {
      const masked = maskMongoUri(uriMatch[0]);
      issues.push(`Hardcoded MongoDB URI with credentials in ${relFile} (masked: ${masked}) — use env var instead`);
    }

    results.push({ file: relFile, type: 'config', issues });
  }

  // Scan src/**/*.php for MongoDB usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('->find(') &&
      !content.includes('->findOne(') &&
      !content.includes('$where') &&
      !content.includes('"$where"') &&
      !content.includes("'$where'") &&
      !content.includes('$regex') &&
      !content.includes('"$regex"') &&
      !content.includes("'$regex'") &&
      !content.includes('mongodb://')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    // Query injection via $where operator near user input
    if (content.includes("'$where'") || content.includes('"$where"') || content.includes('$where')) {
      const userInputPattern = /\$request->get|\$_GET|\$_POST|\$data|\$input/;
      const whereIndex = Math.max(
        content.indexOf("'$where'"),
        content.indexOf('"$where"'),
        content.indexOf('$where'),
      );
      const contextWindow = content.slice(Math.max(0, whereIndex - 300), whereIndex + 300);
      if (userInputPattern.test(contextWindow)) {
        issues.push(
          `Query injection risk: '$where' operator used near user input in ${relFile} — never pass user-supplied JavaScript to $where; use aggregation pipeline instead`,
        );
        results.push({ file: relFile, type: 'security', issues });
        continue;
      }
    }

    // $regex with user-supplied pattern (ReDoS risk)
    if (content.includes("'$regex'") || content.includes('"$regex"') || content.includes('$regex')) {
      const userInputPattern = /\$request->get|\$_GET|\$_POST|\$input/;
      const regexIndex = Math.max(
        content.indexOf("'$regex'"),
        content.indexOf('"$regex"'),
        content.indexOf('$regex'),
      );
      const contextWindow = content.slice(Math.max(0, regexIndex - 300), regexIndex + 300);
      if (userInputPattern.test(contextWindow)) {
        issues.push(
          `ReDoS risk: '$regex' operator used with user-supplied pattern in ${relFile} — validate/escape user regex input or use $text search instead`,
        );
      }
    }

    // Missing typeMap option on find()/findOne()
    if (content.includes('->find(') || content.includes('->findOne(')) {
      const findMatches = [...content.matchAll(/->find(One)?\s*\(/g)];
      for (const match of findMatches) {
        const after = content.slice(match.index ?? 0, (match.index ?? 0) + 400);
        if (!after.includes('typeMap')) {
          issues.push(
            `Missing 'typeMap' option on ${match[0].trim().replace('(', '')}() in ${relFile} — specify typeMap to control BSON-to-PHP type mapping and avoid unexpected BSONDocument objects`,
          );
          break;
        }
      }
    }

    // Unindexed query: find([...]) without hint()
    if (content.includes('->find([')) {
      const findBracketMatches = [...content.matchAll(/->find\(\[/g)];
      for (const match of findBracketMatches) {
        const around = content.slice(Math.max(0, (match.index ?? 0) - 100), (match.index ?? 0) + 400);
        if (!around.includes('->hint(')) {
          issues.push(
            `Potentially unindexed query in ${relFile}: ->find([...]) without ->hint() — ensure query fields are indexed on large collections`,
          );
          break;
        }
      }
    }

    // Hardcoded MongoDB URI with credentials in PHP
    const uriMatches = [...content.matchAll(/mongodb:\/\/[^:]+:[^@\s'"]+@[^\s'"]+/g)];
    for (const m of uriMatches) {
      const masked = maskMongoUri(m[0]);
      issues.push(
        `Hardcoded MongoDB URI with credentials in ${relFile} (masked: ${masked}) — use env var instead`,
      );
    }

    if (issues.length > 0) {
      const hasSecurityIssue = issues.some(
        (i) => i.includes('injection') || i.includes('ReDoS') || i.includes('credentials'),
      );
      results.push({ file: relFile, type: hasSecurityIssue ? 'security' : 'query', issues });
    }
  }

  return results;
}

export function listMongodbIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildMongodbIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No MongoDB integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `MongoDB Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMongodbIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildMongodbIntegrationInfos(appPath);
    let text = `MongoDB Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Driver patterns:   ${infos.filter((i) => i.type === 'driver').length}\n`;
    text += `Query patterns:    ${infos.filter((i) => i.type === 'query').length}\n`;
    text += `Security patterns: ${infos.filter((i) => i.type === 'security').length}\n`;
    text += `Config patterns:   ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Total issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMongodbIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_mongodb_integration',
      description: 'Analyze MongoDB integration: detect composer packages (mongodb/mongodb, doctrine/mongodb-odm), query injection via $where, missing typeMap on find/findOne, unindexed queries without hint(), $regex ReDoS risk with user input, hardcoded connection URIs (credentials masked)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_mongodb_integration_stats',
      description: 'Statistics for MongoDB integration: driver/query/security/config pattern counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
