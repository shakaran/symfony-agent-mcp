/**
 * Symfony Serializer MaxDepth Inspector
 *
 * Detects @MaxDepth / #[MaxDepth] usage and checks for common
 * configuration mistakes that cause silent failures in serialization.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import * as fs from 'fs';
import { McpToolResult } from '../server.js';


interface MaxDepthEntry {
  file: string;
  className: string;
  maxDepthProps: string[];
  contextEnabled: boolean;
  issues: string[];
}

// ─── PHP scanning ────────────────────────────────────────────────────────────

function collectPhpFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

function extractClassName(content: string, file: string): string {
  const m = /class\s+(\w{1,120})/u.exec(content);
  return m ? m[1] : path.basename(file, '.php');
}

function extractMaxDepthProps(content: string): string[] {
  const props: string[] = [];
  // Match @MaxDepth or #[MaxDepth] followed by a property declaration
  const re = /(?:@MaxDepth|#\[MaxDepth(?:\([^)]{0,80}\))?\])\s*(?:\*\/\s*)?(?:(?:private|protected|public)\s+)?(?:\w+\s+)?\$(\w{1,80})/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    props.push(m[1]);
  }
  // Fallback: just count occurrences by block proximity
  if (props.length === 0) {
    const simpleRe = /(?:@MaxDepth|#\[MaxDepth)/gu;
    const matches = content.match(simpleRe);
    if (matches) {
      for (let i = 0; i < matches.length; i++) {
        props.push(`prop${i + 1}`);
      }
    }
  }
  return props;
}

function hasMaxDepthValue1(content: string): boolean {
  return /#\[MaxDepth\s*\(\s*1\s*\)\]/u.test(content) || /@MaxDepth\s*\(\s*1\s*\)/u.test(content);
}

function scanPhpForMaxDepth(appPath: string): MaxDepthEntry[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir);
  const results: MaxDepthEntry[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const hasMaxDepth = /@MaxDepth/u.test(content) || /#\[MaxDepth/u.test(content);
    if (!hasMaxDepth) continue;

    const className = extractClassName(content, file);
    const maxDepthProps = extractMaxDepthProps(content);
    const contextEnabled =
      /ENABLE_MAX_DEPTH/u.test(content) || /enable_max_depth/u.test(content);
    const hasHandler = /MAX_DEPTH_HANDLER/u.test(content) || /setMaxDepthHandler/u.test(content);

    const issues: string[] = [];

    if (!contextEnabled) {
      issues.push(
        'MaxDepth annotation used without ENABLE_MAX_DEPTH context key — annotation is silently ignored by the serializer'
      );
    }

    if (!hasHandler) {
      issues.push(
        'MaxDepth without setMaxDepthHandler() — the default handler returns null, which may break API clients expecting the nested object'
      );
    }

    if (hasMaxDepthValue1(content)) {
      issues.push(
        'MaxDepth value of 1 detected — too shallow for nested serialization; child objects will not appear in output'
      );
    }

    results.push({
      file: path.relative(appPath, file),
      className,
      maxDepthProps,
      contextEnabled,
      issues,
    });
  }

  return results;
}

// ─── Circular reference detection ────────────────────────────────────────────

function detectCircularRiskFiles(appPath: string): string[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir);
  const risky: string[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const hasRelation =
      /OneToMany|ManyToMany|ManyToOne|OneToOne/u.test(content);
    const hasCircularProtection =
      /@MaxDepth|#\[MaxDepth|circularReferenceHandler|CIRCULAR_REFERENCE/u.test(content);

    if (hasRelation && !hasCircularProtection) {
      risky.push(path.relative(appPath, file));
    }
  }

  return risky;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listSymfonySerializerMaxDepths(appPath: string): McpToolResult {
  try {
    const entries = scanPhpForMaxDepth(appPath);
    const circularRisk = detectCircularRiskFiles(appPath);

    if (entries.length === 0 && circularRisk.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No MaxDepth annotations found in src/. No circular reference protection detected either.',
        }],
      };
    }

    let text = `Symfony Serializer MaxDepth  (${entries.length} classes)\n${'='.repeat(60)}\n`;

    for (const e of entries) {
      text += `\n  ${e.className}\n`;
      text += `    File:             ${e.file}\n`;
      text += `    Properties:       ${e.maxDepthProps.join(', ') || 'none detected'}\n`;
      text += `    ENABLE_MAX_DEPTH: ${e.contextEnabled ? 'yes' : 'NO [!]'}\n`;
      if (e.issues.length > 0) {
        for (const issue of e.issues) {
          text += `    [!] ${issue}\n`;
        }
      }
    }

    if (circularRisk.length > 0) {
      text += `\nFiles with Doctrine relations but no circular reference protection (${circularRisk.length}):\n`;
      for (const f of circularRisk.slice(0, 20)) {
        text += `  [!] ${f}\n`;
      }
      if (circularRisk.length > 20) {
        text += `  ... and ${circularRisk.length - 20} more\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonySerializerMaxDepthStats(appPath: string): McpToolResult {
  try {
    const entries = scanPhpForMaxDepth(appPath);
    const circularRisk = detectCircularRiskFiles(appPath);

    const withIssues = entries.filter((e) => e.issues.length > 0);
    const withoutContextKey = entries.filter((e) => !e.contextEnabled);

    let text = `Symfony Serializer MaxDepth Statistics\n${'='.repeat(42)}\n\n`;
    text += `Classes using MaxDepth:         ${entries.length}\n`;
    text += `Without ENABLE_MAX_DEPTH key:   ${withoutContextKey.length}\n`;
    text += `With issues:                    ${withIssues.length}\n`;
    text += `Circular-risk entity files:     ${circularRisk.length}\n`;
    text += `Total MaxDepth properties:      ${entries.reduce((s, e) => s + e.maxDepthProps.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getSymfonySerializerMaxDepthTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_symfony_serializer_max_depths',
      description: 'Detect @MaxDepth / #[MaxDepth] annotation usage, check for missing ENABLE_MAX_DEPTH context key, missing MaxDepth handlers, depth=1 issues, and entities with circular relations but no protection',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_symfony_serializer_max_depth_stats',
      description: 'Statistics on Symfony Serializer MaxDepth usage: classes found, missing context key, circular risk entities, total annotated properties',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
