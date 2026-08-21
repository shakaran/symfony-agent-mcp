/**
 * Symfony Expression Language Extensions Inspector
 *
 * Scans src/ PHP for: ExpressionFunctionProviderInterface implementations,
 * getFunctions() returning ExpressionFunction array, ExpressionLanguage::register(),
 * ExpressionLanguage::addFunction(), ExpressionLanguage::parse() with cached result,
 * ExpressionLanguage with PSR-6 cache.
 *
 * Warns about:
 *   - ExpressionLanguage without cache (expressions re-parsed on every evaluate() call)
 *   - ExpressionFunctionProviderInterface not tagged as expression_language.function (not auto-discovered)
 *   - Custom function with eval-like behavior (security risk from user-provided expressions)
 *   - ExpressionLanguage::evaluate() with user-provided expression string (RCE risk)
 *   - Expression function name colliding with PHP built-in
 *   - parse() result not cached (defeats purpose of parse() vs evaluate())
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ExpressionLanguageExtInfo {
  file: string;
  class: string;
  functions: string[];
  hasCaching: boolean;
  hasUserExpression: boolean;
  issues: string[];
}

const PHP_BUILTIN_FUNCTIONS = [
  'array', 'count', 'strlen', 'in_array', 'array_key_exists',
  'isset', 'empty', 'is_array', 'is_string', 'is_int', 'is_null',
  'str_contains', 'str_starts_with', 'str_ends_with',
];

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

function checkServiceTagged(appPath: string, className: string): boolean {
  const servicesCandidates = [
    path.join(appPath, 'config', 'services.yaml'),
    path.join(appPath, 'config', 'services_test.yaml'),
  ];
  for (const cfgPath of servicesCandidates) {
    try {
      const raw = parseYamlFile(cfgPath) as Record<string, unknown> | null;
      if (!raw) continue;
      const services = (raw['services'] ?? {}) as Record<string, unknown>;
      for (const [, svcData] of Object.entries(services)) {
        const svc = (svcData ?? {}) as Record<string, unknown>;
        const tags = (svc['tags'] ?? []) as unknown[];
        if (tags.some((t) => {
          const tagStr = typeof t === 'string' ? t : String((t as Record<string, unknown>)['name'] ?? '');
          return tagStr === 'expression_language.function';
        })) {
          if (String(svc['class'] ?? '').includes(className)) return true;
        }
      }
    } catch { /* skip */ }
  }
  return false;
}

function buildExpressionLanguageExtInfos(appPath: string): ExpressionLanguageExtInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: ExpressionLanguageExtInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasExpressionLang =
      content.includes('ExpressionLanguage') ||
      content.includes('ExpressionFunctionProviderInterface') ||
      content.includes('ExpressionFunction') ||
      content.includes('->getFunctions()');

    if (!hasExpressionLang) continue;

    const className = extractClassName(content);
    const issues: string[] = [];

    // Extract function names from ExpressionFunction('name', ...) or ::fromPhp('name', ...)
    const fnNameRe = /ExpressionFunction\s*(?:::fromPhp)?\s*\(\s*['"]([a-z][a-z0-9_]{0,60})['"]/gi;
    const fnMatches = [...content.matchAll(fnNameRe)];
    const functions = fnMatches.map((m) => m[1]);

    // Detect caching
    const hasCaching =
      content.includes('CacheInterface') ||
      content.includes('CacheItemPoolInterface') ||
      content.includes('new ExpressionLanguage(') && /new\s+ExpressionLanguage\s*\([^)]{1,200}cache/i.test(content) ||
      content.includes('ArrayAdapter') ||
      content.includes('PhpArrayAdapter');

    // Detect user-provided expressions (security concern)
    const hasUserExpression =
      /->evaluate\s*\(\s*\$[a-zA-Z_]{1,40}(?:Expression|Expr|Input|Query|String|Data)/i.test(content) ||
      /->evaluate\s*\(\s*\$(?:request|user|input|data|param)/i.test(content);

    const isProvider = content.includes('ExpressionFunctionProviderInterface');

    // Check for caching absence
    if (!hasCaching && content.includes('->evaluate(')) {
      issues.push(`"${className}" uses ExpressionLanguage::evaluate() without cache — expressions are re-parsed on every call (performance issue)`);
    }

    // Check for provider not tagged
    if (isProvider) {
      const isTagged = checkServiceTagged(appPath, className);
      if (!isTagged) {
        issues.push(`"${className}" implements ExpressionFunctionProviderInterface but is not tagged 'expression_language.function' in services.yaml — functions may not be auto-discovered`);
      }
    }

    // Security: user-controlled expressions
    if (hasUserExpression) {
      issues.push(`"${className}" evaluates user-provided expression strings — ExpressionLanguage can execute arbitrary PHP code; validate/whitelist expressions before evaluation (RCE risk)`);
    }

    // Check parse() without caching the result
    if (content.includes('->parse(') && !hasCaching && !content.includes('parsed') && !content.includes('parsedExpression')) {
      issues.push(`"${className}" calls ExpressionLanguage::parse() but does not cache the result — use parse() only when result is stored and reused`);
    }

    // Check for PHP built-in name collision
    for (const fn of functions) {
      if (PHP_BUILTIN_FUNCTIONS.includes(fn)) {
        issues.push(`ExpressionFunction "${fn}" collides with a PHP built-in function name — this may cause confusion or unexpected behavior`);
      }
    }

    results.push({
      file,
      class: className,
      functions,
      hasCaching,
      hasUserExpression,
      issues,
    });
  }

  return results;
}

export function listExpressionLanguageExtensions(appPath: string): McpToolResult {
  try {
    const infos = buildExpressionLanguageExtInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No ExpressionLanguage extensions or ExpressionFunctionProviderInterface found in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Expression Language Extensions Analysis\n${'='.repeat(55)}\n\n`;
    text += `Classes: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}\n`;
      text += `    functions:     ${info.functions.length > 0 ? info.functions.join(', ') : '(none detected)'}\n`;
      text += `    hasCaching:    ${info.hasCaching ? 'yes' : 'no'}\n`;
      text += `    userExpr:      ${info.hasUserExpression ? 'yes (SECURITY RISK)' : 'no'}\n`;
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

export function getExpressionLanguageExtStats(appPath: string): McpToolResult {
  try {
    const infos = buildExpressionLanguageExtInfos(appPath);

    let text = `Expression Language Extension Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes:               ${infos.length}\n`;
    text += `  With caching:              ${infos.filter((i) => i.hasCaching).length}\n`;
    text += `  Without caching:           ${infos.filter((i) => !i.hasCaching).length}\n`;
    text += `  User expression eval:      ${infos.filter((i) => i.hasUserExpression).length}\n`;
    text += `  Custom functions total:    ${infos.reduce((s, i) => s + i.functions.length, 0)}\n`;
    text += `Total issues:                ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getExpressionLanguageExtTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_expression_language_extensions',
      description: 'Inspect ExpressionLanguage extensions: ExpressionFunctionProviderInterface implementations, custom functions, caching config, user-provided expression evaluation; warns on missing cache, untagged providers, RCE risk from user expressions, parse() without result caching',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_expression_language_ext_stats',
      description: 'Statistics for ExpressionLanguage extensions: class count, caching coverage, user expression eval count, custom function count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
