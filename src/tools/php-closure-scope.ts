/**
 * PHP Closure Scope Binding Inspector
 *
 * Detects closure scope issues: use ($var), use (&$var) by-reference,
 * Closure::bind/bindTo, $this capture, static function() (no $this).
 *
 * Warns on: use (&$var) in loop body (shared reference), $this in class property closure
 * (memory leak), Closure::bind to incompatible scope, static closure using $this.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ClosureScopeFile {
  file: string;
  className: string;
  closureCount: number;
  byRefCaptures: number;
  thisCaptured: boolean;
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

function parseClosureScope(filePath: string, appPath: string): ClosureScopeFile | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  // Count closures: function( or function (
  const closureMatches = content.match(/\bfunction\s*\([^)]{0,200}\)\s*(?:use\s*\([^)]{0,200}\)\s*)?(?::\s*\w{1,80}\s*)?\{/gm);
  const closureCount = closureMatches?.length ?? 0;
  if (closureCount === 0) return null;

  const classM = /\bclass\s+(\w{1,80})/m.exec(content);
  const className = classM ? classM[1] : path.basename(filePath, '.php');

  // Count by-reference captures: use (&$var)
  const byRefMatches = content.match(/\buse\s*\([^)]{0,200}&\$\w{1,80}[^)]{0,200}\)/gm);
  const byRefCaptures = byRefMatches?.length ?? 0;

  // Check $this captured in closure: function() use ($this) is an error in PHP,
  // but implicit $this is available in object method closures.
  // Detect: closure stored as property while using $this
  const thisCaptured = /\$this->\w{1,80}\s*=\s*function/.test(content)
    || /\$this->\w{1,80}\s*=\s*static\s+function/.test(content);

  // Closure::bind or bindTo
  const hasClosureBind = /Closure::bind\s*\(/.test(content) || /->bindTo\s*\(/.test(content);

  // static function() using $this
  const staticClosureWithThis = /\bstatic\s+function\s*\([^)]{0,200}\)[^{]{0,100}\{[^}]{0,400}\$this\b/m.test(content);

  // By-ref in loop
  let byRefInLoop = false;
  if (byRefCaptures > 0) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/\b(foreach|for|while)\s*\(/.test(lines[i])) {
        const lookahead = lines.slice(i + 1, i + 20).join('\n');
        if (/\buse\s*\([^)]{0,200}&\$\w{1,80}[^)]{0,200}\)/.test(lookahead)) {
          byRefInLoop = true;
          break;
        }
      }
    }
  }

  const issues: string[] = [];

  if (byRefInLoop) {
    issues.push(`${className}: use (&$var) capture inside loop — all iterations share the same reference`);
  }

  if (thisCaptured) {
    issues.push(`${className}: closure capturing $this stored as class property — potential circular reference memory leak`);
  }

  if (staticClosureWithThis) {
    issues.push(`${className}: static closure uses $this — static closures have no $this binding (will throw Error)`);
  }

  if (hasClosureBind) {
    issues.push(`${className}: Closure::bind()/bindTo() — verify scope compatibility with target class`);
  }

  if (closureCount === 0 && issues.length === 0) return null;

  return {
    file: path.relative(appPath, filePath),
    className,
    closureCount,
    byRefCaptures,
    thisCaptured,
    issues,
  };
}

export function listPhpClosureScopes(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const results: ClosureScopeFile[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = parseClosureScope(file, appPath);
      if (r) results.push(r);
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No closures found in src/.' }] };
    }

    const totalClosures = results.reduce((s, r) => s + r.closureCount, 0);
    const totalByRef = results.reduce((s, r) => s + r.byRefCaptures, 0);
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `PHP Closure Scope Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Closures: ${totalClosures}  By-ref captures: ${totalByRef}  Issues: ${totalIssues}\n`;

    const withIssues = results.filter((r) => r.issues.length > 0);
    for (const r of withIssues.sort((a, b) => b.issues.length - a.issues.length || a.className.localeCompare(b.className))) {
      const tags: string[] = [`closures:${r.closureCount}`];
      if (r.byRefCaptures > 0) tags.push(`by-ref:${r.byRefCaptures}`);
      if (r.thisCaptured) tags.push('this-captured');
      text += `\n  ${r.className.padEnd(35)} ${tags.join(', ')}\n`;
      text += `    ${r.file}\n`;
      for (const issue of r.issues) text += `    ! ${issue}\n`;
    }

    if (withIssues.length === 0) {
      text += '\n  No issues found.\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpClosureScopeStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: ClosureScopeFile[] = [];

    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseClosureScope(file, appPath);
        if (r) results.push(r);
      }
    }

    let text = `PHP Closure Scope Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with closures:   ${results.length}\n`;
    text += `Total closures:        ${results.reduce((s, r) => s + r.closureCount, 0)}\n`;
    text += `By-ref captures:       ${results.reduce((s, r) => s + r.byRefCaptures, 0)}\n`;
    text += `$this in property:     ${results.filter((r) => r.thisCaptured).length}\n`;
    text += `With issues:           ${results.filter((r) => r.issues.length > 0).length}\n`;
    text += `Total issues:          ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpClosureScopeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_closure_scopes',
      description: 'List PHP closure scope binding issues: use (&$var) in loops, $this captured as class property (memory leak), static closure using $this (error), Closure::bind/bindTo scope compatibility',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_closure_scope_stats',
      description: 'Statistics for PHP closure scope: total closures, by-ref captures, $this captured in property, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
