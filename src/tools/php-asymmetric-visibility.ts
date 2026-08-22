/**
 * PHP 8.4 Asymmetric Visibility Inspector
 *
 * Scans src/ PHP files for PHP 8.4 asymmetric visibility syntax:
 *   - public(set) / protected(set) / private(set) on properties
 *   - public(get) / protected(get) / private(get) (read restriction)
 *
 * Warns about:
 *   - private(set) on readonly property (redundant — use readonly alone)
 *   - asymmetric visibility on static properties (not supported in PHP 8.4)
 *   - get restriction more permissive than set restriction (unusual pattern)
 *   - usage in project targeting PHP < 8.4 (cross-checks composer.json)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface AsymmetricPropEntry {
  name: string;
  getVisibility: string;
  setVisibility: string;
  isReadonly: boolean;
  isStatic: boolean;
  issues: string[];
}

interface AsymmetricVisibilityInfo {
  file: string;
  class: string;
  properties: AsymmetricPropEntry[];
  phpRequire?: string;
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

const VISIBILITY_RANK: Record<string, number> = { public: 3, protected: 2, private: 1 };

function readMinPhpVersion(appPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const require = json['require'] as Record<string, string> | undefined;
    return require?.['php'];
  } catch { return undefined; }
}

function parseAsymmetricVisibility(filePath: string): AsymmetricVisibilityInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  // Quick filter — must contain asymmetric visibility syntax
  if (!(/\b(?:public|protected|private)\s*\(\s*(?:get|set)\s*\)/.test(content))) return null;
  if (!/\bclass\s+/.test(content)) return null;

  const classMatch = /(?:abstract\s+)?class\s+(\w{1,100})/.exec(content);
  if (!classMatch) return null;

  const className = classMatch[1];
  const properties: AsymmetricPropEntry[] = [];
  const fileIssues: string[] = [];

  // Match asymmetric visibility declarations
  // e.g.: public(set) protected string $name
  // e.g.: public private(set) readonly int $id
  const propPattern = /(?:(?:public|protected|private|static|readonly|abstract)\s+){0,6}(?:public|protected|private)\s*\(\s*(get|set)\s*\)\s+(?:(?:public|protected|private|static|readonly|abstract)\s+){0,4}\$(\w{1,80})/g;

  // Also match: public(set) TYPE $name or private(set) on its own
  const fullPattern = /((?:(?:public|protected|private|static|readonly)\s+){0,5}(?:public|protected|private)\s*\(\s*(?:get|set)\s*\)\s+(?:(?:public|protected|private|static|readonly)\s+){0,4}(?:\??\w[\w\\]{0,80}(?:\|[\w\\]{1,80}){0,5}\s+)?\$(\w{1,80}))/g;

  const seenProps = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = fullPattern.exec(content)) !== null) {
    const propName = m[2];
    if (!propName || seenProps.has(propName)) continue;
    seenProps.add(propName);

    const declaration = m[1];
    const isStatic = /\bstatic\b/.test(declaration);
    const isReadonly = /\breadonly\b/.test(declaration);

    // Extract the asymmetric part: e.g. public(set), private(get)
    const asymMatch = /\b(public|protected|private)\s*\(\s*(get|set)\s*\)/.exec(declaration);
    if (!asymMatch) continue;

    const asymVis = asymMatch[1];
    const asymKind = asymMatch[2] as 'get' | 'set';

    // Find the "base" visibility (the one without parentheses)
    const baseVisMatch = /\b(public|protected|private)\b(?!\s*\()/.exec(declaration);
    const baseVis = baseVisMatch ? baseVisMatch[1] : 'public';

    const getVisibility = asymKind === 'get' ? asymVis : baseVis;
    const setVisibility = asymKind === 'set' ? asymVis : baseVis;

    const propIssues: string[] = [];

    if (isStatic) {
      propIssues.push(`$${propName}: asymmetric visibility on static property is not supported in PHP 8.4`);
    }
    if (isReadonly && setVisibility === 'private') {
      propIssues.push(`$${propName}: private(set) combined with readonly is redundant — readonly already prevents external writes`);
    }

    const getRank = VISIBILITY_RANK[getVisibility] ?? 3;
    const setRank = VISIBILITY_RANK[setVisibility] ?? 3;
    if (getRank < setRank) {
      propIssues.push(`$${propName}: get visibility (${getVisibility}) is more restrictive than set visibility (${setVisibility}) — unusual pattern`);
    }

    properties.push({
      name: propName,
      getVisibility,
      setVisibility,
      isReadonly,
      isStatic,
      issues: propIssues,
    });
  }

  // Suppress false-positive void result from propPattern
  void propPattern;

  if (properties.length === 0) return null;

  return {
    file: path.relative(path.dirname(path.dirname(filePath)), filePath),
    class: className,
    properties,
    issues: fileIssues,
  };
}

function scanAsymmetricVisibility(appPath: string): AsymmetricVisibilityInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: AsymmetricVisibilityInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = parseAsymmetricVisibility(file);
    if (info) results.push(info);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

function isPhpVersionBelow84(versionConstraint: string): boolean {
  // Very conservative check: if constraint explicitly excludes 8.4+
  const match = />=?\s*(\d+\.\d+)/.exec(versionConstraint);
  if (!match) return false;
  const [major, minor] = match[1].split('.').map(Number);
  if (major === undefined || minor === undefined) return false;
  return major < 8 || (major === 8 && minor < 4);
}

export function listAsymmetricVisibility(appPath: string): McpToolResult {
  try {
    const infos = scanAsymmetricVisibility(appPath);
    const phpRequire = readMinPhpVersion(appPath);
    const phpTooLow = phpRequire ? isPhpVersionBelow84(phpRequire) : false;

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHP 8.4 asymmetric visibility declarations detected in src/.\n\nAsymmetric visibility (PHP 8.4+) syntax:\n  class User {\n    public private(set) string $name;\n    public protected(set) int $age;\n  }',
        }],
      };
    }

    let text = `PHP 8.4 Asymmetric Visibility\n${'='.repeat(55)}\n`;

    if (phpRequire) {
      text += `\ncomposer.json PHP requirement: ${phpRequire}\n`;
      if (phpTooLow) {
        text += `WARNING: Asymmetric visibility requires PHP >= 8.4 but project targets ${phpRequire}\n`;
      }
    }

    let totalIssues = 0;

    for (const info of infos) {
      text += `\n${info.class} (${info.file})\n`;
      for (const prop of info.properties) {
        const flags: string[] = [];
        if (prop.isStatic) flags.push('static');
        if (prop.isReadonly) flags.push('readonly');
        const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        text += `  $${prop.name}${flagStr}  get:${prop.getVisibility} set:${prop.setVisibility}\n`;
        for (const issue of prop.issues) {
          text += `    WARNING: ${issue}\n`;
          totalIssues++;
        }
      }
      for (const issue of info.issues) {
        text += `  WARNING: ${issue}\n`;
        totalIssues++;
      }
    }

    if (totalIssues === 0 && !phpTooLow) {
      text += '\nNo issues detected.\n';
    } else {
      text += `\nTotal warnings: ${totalIssues + (phpTooLow ? 1 : 0)}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getAsymmetricVisibilityStats(appPath: string): McpToolResult {
  try {
    const infos = scanAsymmetricVisibility(appPath);
    const phpRequire = readMinPhpVersion(appPath);

    const allProps = infos.flatMap((i) => i.properties);
    const totalIssues = infos.reduce(
      (s, i) => s + i.issues.length + i.properties.reduce((ps, p) => ps + p.issues.length, 0),
      0
    );

    let text = `Asymmetric Visibility Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with asymmetric vis:  ${infos.length}\n`;
    text += `Total properties:             ${allProps.length}\n`;
    text += `  private(set):               ${allProps.filter((p) => p.setVisibility === 'private').length}\n`;
    text += `  protected(set):             ${allProps.filter((p) => p.setVisibility === 'protected').length}\n`;
    text += `  get-restricted:             ${allProps.filter((p) => VISIBILITY_RANK[p.getVisibility] < 3).length}\n`;
    text += `  static (unsupported):       ${allProps.filter((p) => p.isStatic).length}\n`;
    text += `  readonly+private(set):      ${allProps.filter((p) => p.isReadonly && p.setVisibility === 'private').length}\n`;
    if (phpRequire) text += `PHP requirement:              ${phpRequire}\n`;
    text += `Total warnings:               ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getAsymmetricVisibilityTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_asymmetric_visibility',
      description: 'List PHP 8.4 asymmetric visibility declarations (public/protected/private(set) and (get)) in src/: detect redundant readonly+private(set), unsupported static properties, unusual get-more-restrictive-than-set patterns, PHP version compatibility via composer.json',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_asymmetric_visibility_stats',
      description: 'Statistics for PHP 8.4 asymmetric visibility: class/property counts by set/get visibility level, static and readonly combinations, PHP version requirement, total warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
