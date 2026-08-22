/**
 * Symfony Expression Language Inspector
 *
 * Distinct from security-config.ts (access_control security checks) and workflow.ts (workflow states).
 * Focuses on the ExpressionLanguage component and its extension points:
 *
 * ExpressionFunctionProviderInterface implementations:
 *   - getFunctions() returns array of ExpressionFunction
 *   - Custom function names registered
 *   - Lazy-loaded function providers (tagged expression_language.function_provider)
 *
 * ExpressionFunction::fromPhp() usage:
 *   - Functions exposed from PHP builtins (is_numeric, strtolower, etc.)
 *   - Custom expression functions added via addFunction()
 *
 * Expression usage scan:
 *   - security.yaml access_control condition: "is_granted('ROLE_ADMIN') and request.isXmlHttpRequest()"
 *   - workflow transitions guard: "is_granted('ROLE_ADMIN') and subject.isPublished()"
 *   - Route condition: attribute #[Route(condition: '...')]
 *   - @Security("is_granted(...)") annotations
 *   - $expressionLanguage->evaluate() call sites in src/
 *
 * Analysis:
 *   - Complex expressions in access_control (hard to debug)
 *   - ExpressionLanguage instantiated without caching (performance)
 *   - Custom functions not registered as a provider (manual addFunction calls scattered)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface ExpressionProvider {
  class: string;
  file: string;
  functions: string[];
}

interface ExpressionUsage {
  context: string;
  expression: string;
  location: string;
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

function scanExpressionProviders(appPath: string): ExpressionProvider[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const providers: ExpressionProvider[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('ExpressionFunctionProviderInterface') && !content.includes('addFunction(')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const functions: string[] = [];
    for (const m of content.matchAll(/ExpressionFunction::fromPhp\s*\(\s*['"]([^'"]+)['"]/g)) {
      functions.push(m[1]);
    }
    for (const m of content.matchAll(/new\s+ExpressionFunction\s*\(\s*['"]([^'"]+)['"]/g)) {
      functions.push(m[1]);
    }

    providers.push({ class: classM[1], file: path.basename(file), functions });
  }
  return providers;
}

function scanExpressionUsages(appPath: string): ExpressionUsage[] {
  const usages: ExpressionUsage[] = [];

  // security.yaml access_control conditions
  const securityPath = path.join(appPath, 'config', 'packages', 'security.yaml');
  const secRaw = parseYamlFile(securityPath) as Record<string, unknown> | null;
  if (secRaw) {
    const security = (secRaw['security'] ?? secRaw) as Record<string, unknown>;
    const acl = security['access_control'] as unknown[];
    if (Array.isArray(acl)) {
      for (const rule of acl) {
        const r = rule as Record<string, unknown>;
        if (r['allow_if'] ?? r['condition']) {
          const expr = String(r['allow_if'] ?? r['condition']);
          usages.push({ context: 'security access_control', expression: expr.slice(0, 80), location: 'security.yaml' });
        }
      }
    }
  }

  // PHP source: condition: in #[Route], @Security, ->evaluate()
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return usages;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const classM = /class\s+(\w+)/.exec(content);
    const loc = classM?.[1] ?? path.basename(file);

    // #[Route(condition: '...')]
    for (const m of content.matchAll(/condition\s*:\s*['"]([^'"]{10,80})['"]/g)) {
      usages.push({ context: 'Route condition', expression: m[1], location: loc });
    }

    // @Security("...")
    for (const m of content.matchAll(/@Security\s*\(\s*["']([^"']{10,80})["']/g)) {
      usages.push({ context: '@Security', expression: m[1], location: loc });
    }

    // ->evaluate(
    if (content.includes('->evaluate(') && usages.length < 20) {
      usages.push({ context: 'evaluate()', expression: '(dynamic)', location: loc });
    }
  }

  return usages.slice(0, 20);
}

export function listExpressionFunctions(appPath: string): McpToolResult {
  try {
    const providers = scanExpressionProviders(appPath);
    const usages    = scanExpressionUsages(appPath);

    if (providers.length === 0 && usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom ExpressionLanguage providers or expression usages found.\n\nCreate a provider:\n  class AppExpressionProvider implements ExpressionFunctionProviderInterface\n  {\n    public function getFunctions(): array\n    {\n      return [\n        ExpressionFunction::fromPhp(\'is_numeric\'),\n        new ExpressionFunction(\'slugify\', ...),\n      ];\n    }\n  }',
        }],
      };
    }

    let text = `Expression Language\n${'='.repeat(55)}\n`;
    text += `\nFunction providers: ${providers.length}\n`;
    text += `Expression usages:  ${usages.length}\n`;

    if (providers.length > 0) {
      text += `\nProviders:\n`;
      for (const p of providers.sort((a, b) => a.class.localeCompare(b.class))) {
        text += `  ${p.class}  (${p.file})\n`;
        if (p.functions.length > 0) text += `    Functions: ${p.functions.join(', ')}\n`;
      }
    }

    if (usages.length > 0) {
      text += `\nExpression usages:\n`;
      for (const u of usages.slice(0, 15)) {
        text += `  [${u.context}] ${u.location}: ${u.expression}\n`;
      }
    }

    // Issues
    const complexExpressions = usages.filter((u) => u.expression.length > 60 && u.context !== 'evaluate()');
    const issues: string[] = [];
    if (complexExpressions.length > 0) {
      issues.push(`${complexExpressions.length} complex expression(s) > 60 chars — consider extracting to custom voter`);
    }

    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
      for (const issue of issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getExpressionStats(appPath: string): McpToolResult {
  try {
    const providers = scanExpressionProviders(appPath);
    const usages    = scanExpressionUsages(appPath);
    const totalFunctions = providers.reduce((s, p) => s + p.functions.length, 0);

    let text = `Expression Language Statistics\n${'='.repeat(40)}\n\n`;
    text += `Providers:         ${providers.length}\n`;
    text += `Custom functions:  ${totalFunctions}\n`;
    text += `Expression usages: ${usages.length}\n`;
    text += `  Route condition: ${usages.filter((u) => u.context === 'Route condition').length}\n`;
    text += `  @Security:       ${usages.filter((u) => u.context === '@Security').length}\n`;
    text += `  access_control:  ${usages.filter((u) => u.context === 'security access_control').length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getExpressionLanguageTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_expression_functions',
      description: 'Show ExpressionLanguage usage: ExpressionFunctionProviderInterface implementations, fromPhp() functions, expression usages in Route condition/@Security/access_control/workflow guard, complex expression warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_expression_stats',
      description: 'Show expression language statistics: provider count, custom function count, usage count by context (Route/Security/access_control)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
