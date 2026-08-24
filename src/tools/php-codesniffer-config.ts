// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CodesnifferConfigInfo {
  file: string;
  type: 'ruleset' | 'standard' | 'ignored' | 'custom-sniff';
  pattern: string;
  issues: string[];
}

function buildPhpCodesnifferConfigInfos(appPath: string): CodesnifferConfigInfo[] {
  const results: CodesnifferConfigInfo[] = [];

  const configCandidates = [
    path.join(appPath, 'phpcs.xml'),
    path.join(appPath, 'phpcs.xml.dist'),
    path.join(appPath, '.phpcs.xml'),
  ];

  let foundConfig = false;

  for (const configPath of configCandidates) {
    if (!fs.existsSync(configPath)) continue;
    foundConfig = true;

    let content: string;
    try {
      content = fs.readFileSync(configPath, 'utf8');
    } catch { continue; }

    const relFile = path.relative(appPath, configPath);

    if (!/<rule\s+ref=/.test(content)) {
      results.push({
        file: relFile,
        type: 'ruleset',
        pattern: 'phpcs.xml without ruleset rules',
        issues: ['phpcs.xml has no ruleset rules — add <rule ref="PSR12"/> or <rule ref="Symfony"/> to enforce coding standards'],
      });
    }

    if (/<rule\s+ref="PSR2"/.test(content)) {
      results.push({
        file: relFile,
        type: 'standard',
        pattern: 'PSR-2 standard (deprecated)',
        issues: ['PSR-2 standard is superseded by PSR-12 — update <rule ref="PSR12"/> for PHP 7.4+ projects'],
      });
    }

    if (!/<exclude-pattern>[^<]*vendor/.test(content)) {
      results.push({
        file: relFile,
        type: 'ignored',
        pattern: 'phpcs.xml without vendor exclusion',
        issues: ['phpcs.xml without vendor exclusion — add <exclude-pattern>vendor/*</exclude-pattern> to avoid checking third-party code'],
      });
    }

    const customSniffMatches = content.match(/<rule\s+ref="[^"]*Sniff[^"]*"/g);
    if (customSniffMatches) {
      for (const match of customSniffMatches) {
        results.push({
          file: relFile,
          type: 'custom-sniff',
          pattern: match.replace(/<rule\s+ref="|"/g, ''),
          issues: [],
        });
      }
    }
  }

  if (!foundConfig) {
    results.push({
      file: appPath,
      type: 'ruleset',
      pattern: 'No PHP_CodeSniffer configuration found',
      issues: ['No PHP_CodeSniffer configuration found — add phpcs.xml to enforce coding standards; recommended: PSR-12 or Symfony standard'],
    });
  }

  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    let composerContent: string;
    try {
      composerContent = fs.readFileSync(composerPath, 'utf8');
      if (composerContent.includes('"phpcs"') || composerContent.includes('php_codesniffer')) {
        results.push({
          file: 'composer.json',
          type: 'standard',
          pattern: 'phpcs script in composer.json',
          issues: [],
        });
      }
    } catch { /* skip */ }
  }

  return results;
}

export function listPhpCodesnifferConfig(appPath: string): McpToolResult {
  try {
    const infos = buildPhpCodesnifferConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP_CodeSniffer configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP CodeSniffer Config Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpCodesnifferConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpCodesnifferConfigInfos(appPath);
    let text = `PHP CodeSniffer Config Statistics\n${'='.repeat(40)}\n\n`;
    text += `Ruleset:      ${infos.filter((i) => i.type === 'ruleset').length}\n`;
    text += `Standard:     ${infos.filter((i) => i.type === 'standard').length}\n`;
    text += `Ignored:      ${infos.filter((i) => i.type === 'ignored').length}\n`;
    text += `Custom-sniff: ${infos.filter((i) => i.type === 'custom-sniff').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpCodesnifferConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_codesniffer_config', description: 'Analyze PHP_CodeSniffer configuration for ruleset, standard, exclusions, and custom sniff issues', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_codesniffer_config_stats', description: 'Statistics for PHP_CodeSniffer config: counts by type and issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
