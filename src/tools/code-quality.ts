/**
 * PHP Code Quality Metrics
 *
 * Static analysis of PHP class quality without executing PHP:
 *   - Class size: lines of code, method count, property count
 *   - Long methods: methods exceeding a configurable threshold (default 30 lines)
 *   - God classes: too many methods (>15) or too many dependencies (>8)
 *   - Cyclomatic complexity estimate: count of if/for/while/case/catch branches
 *   - Constructor bloat: too many injected dependencies
 *   - Violation summary with per-class scores
 *
 * Pure static analysis — counts source lines and branch keywords.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MethodInfo {
  name: string;
  lines: number;
  complexity: number;
  isPublic: boolean;
}

interface ClassMetrics {
  class: string;
  file: string;
  layer: string;
  totalLines: number;
  methodCount: number;
  publicMethodCount: number;
  propertyCount: number;
  constructorDeps: number;
  methods: MethodInfo[];
  score: number;
  violations: string[];
}

// Thresholds
const MAX_METHOD_LINES = 30;
const MAX_CLASS_METHODS = 15;
const MAX_CONSTRUCTOR_DEPS = 8;
const MAX_CLASS_LINES = 300;
const COMPLEXITY_WARNING = 10;

// ─── Layer detection ────────────────────────────────────────────────────────

function detectLayer(filePath: string, content: string): string {
  const rel = filePath.toLowerCase();
  if (rel.includes('/controller/') || /extends\s+AbstractController/.test(content)) return 'Controller';
  if (rel.includes('/command/') || /extends\s+Command/.test(content)) return 'Command';
  if (rel.includes('/repository/')) return 'Repository';
  if (rel.includes('/entity/') || /#\[(?:ORM\\)?Entity/.test(content)) return 'Entity';
  if (rel.includes('/form/') || /extends\s+AbstractType/.test(content)) return 'Form';
  return 'Service';
}

// ─── Method extraction ──────────────────────────────────────────────────────

function estimateComplexity(body: string): number {
  const keywords = ['if ', 'if(', 'elseif', 'else if', 'for ', 'for(', 'foreach', 'while ', 'while(',
                    'case ', 'catch ', 'catch(', '? ', '?? ', '&&', '||'];
  let score = 1;
  for (const kw of keywords) {
    const count = (body.split(kw).length - 1);
    score += count;
  }
  return score;
}

function extractMethods(content: string): MethodInfo[] {
  const methods: MethodInfo[] = [];
  const lines = content.split('\n');

  let inMethod = false;
  let braceDepth = 0;
  let methodStart = 0;
  let currentMethod = '';
  let isPublic = true;
  let methodBody = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!inMethod) {
      const methodMatch = /^(public|protected|private)?\s+(?:static\s+)?function\s+(\w+)\s*\(/.exec(trimmed);
      if (methodMatch) {
        currentMethod = methodMatch[2];
        isPublic = !methodMatch[1] || methodMatch[1] === 'public';
        methodStart = i;
        inMethod = true;
        braceDepth = 0;
        methodBody = '';
      }
    }

    if (inMethod) {
      methodBody += line + '\n';
      braceDepth += (line.match(/\{/g) ?? []).length;
      braceDepth -= (line.match(/\}/g) ?? []).length;

      if (braceDepth <= 0 && i > methodStart) {
        const methodLines = i - methodStart + 1;
        methods.push({
          name: currentMethod,
          lines: methodLines,
          complexity: estimateComplexity(methodBody),
          isPublic,
        });
        inMethod = false;
        currentMethod = '';
        methodBody = '';
      }
    }
  }

  return methods;
}

function countConstructorDeps(content: string): number {
  const ctorM = /public\s+function\s+__construct\s*\(([^)]*)\)/s.exec(content);
  if (!ctorM) return 0;
  const params = ctorM[1].split(',').filter((p) => p.trim().length > 0);
  return params.filter((p) => /[\w\\]+\s+\$/.test(p.trim())).length;
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

function analyzeFile(filePath: string, appPath: string): ClassMetrics | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  // Skip interfaces and traits
  if (/^\s*(interface|trait)\s+/m.test(content)) return null;

  const classM = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const className = classM[1];
  const lines = content.split('\n');
  const totalLines = lines.length;

  const methods = extractMethods(content);
  const publicMethods = methods.filter((m) => m.isPublic);
  const constructorDeps = countConstructorDeps(content);

  const propertyCount = (content.match(/(?:private|protected|public)\s+(?:readonly\s+)?(?:static\s+)?(?:\??\w+\s+)?\$\w+/g) ?? []).length;

  // Violations
  const violations: string[] = [];
  if (totalLines > MAX_CLASS_LINES) {
    violations.push(`Class too large: ${totalLines} lines (max ${MAX_CLASS_LINES})`);
  }
  if (methods.length > MAX_CLASS_METHODS) {
    violations.push(`Too many methods: ${methods.length} (max ${MAX_CLASS_METHODS})`);
  }
  if (constructorDeps > MAX_CONSTRUCTOR_DEPS) {
    violations.push(`Constructor bloat: ${constructorDeps} dependencies (max ${MAX_CONSTRUCTOR_DEPS})`);
  }

  const longMethods = methods.filter((m) => m.lines > MAX_METHOD_LINES);
  for (const m of longMethods) {
    violations.push(`Long method: ${m.name}() — ${m.lines} lines (max ${MAX_METHOD_LINES})`);
  }

  const complexMethods = methods.filter((m) => m.complexity > COMPLEXITY_WARNING);
  for (const m of complexMethods) {
    violations.push(`High complexity: ${m.name}() — estimated ${m.complexity} branches`);
  }

  // Score: 0 = clean, higher = worse
  const score = violations.length * 10 +
    Math.max(0, totalLines - MAX_CLASS_LINES) / 10 +
    Math.max(0, methods.length - MAX_CLASS_METHODS) * 5 +
    Math.max(0, constructorDeps - MAX_CONSTRUCTOR_DEPS) * 8;

  const relFile = path.relative(appPath, filePath);
  return {
    class: className,
    file: relFile,
    layer: detectLayer(filePath, content),
    totalLines,
    methodCount: methods.length,
    publicMethodCount: publicMethods.length,
    propertyCount,
    constructorDeps,
    methods,
    score,
    violations,
  };
}

function loadMetrics(appPath: string): ClassMetrics[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const metrics: ClassMetrics[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const m = analyzeFile(file, appPath);
    if (m) metrics.push(m);
  }

  return metrics.sort((a, b) => b.score - a.score);
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function getCodeQualityReport(appPath: string): McpToolResult {
  try {
    const metrics = loadMetrics(appPath);

    if (metrics.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP classes found in src/.' }] };
    }

    const withViolations = metrics.filter((m) => m.violations.length > 0);
    const clean = metrics.length - withViolations.length;

    let text = `Code Quality Report  (${metrics.length} classes, ${withViolations.length} with issues)\n${'='.repeat(65)}\n`;

    if (withViolations.length === 0) {
      text += '\n✓ All classes within quality thresholds.\n';
      text += `\nThresholds: ≤${MAX_CLASS_LINES} lines, ≤${MAX_CLASS_METHODS} methods, ≤${MAX_CONSTRUCTOR_DEPS} deps, ≤${MAX_METHOD_LINES} lines/method\n`;
    } else {
      text += `\nClasses with violations (top ${Math.min(20, withViolations.length)}):\n`;
      for (const m of withViolations.slice(0, 20)) {
        text += `\n  ${m.class}  [${m.layer}]  (${m.file})\n`;
        for (const v of m.violations) {
          text += `    ⚠ ${v}\n`;
        }
      }
    }

    void clean;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getGodClasses(appPath: string): McpToolResult {
  try {
    const metrics = loadMetrics(appPath);
    const gods = metrics.filter((m) =>
      m.methodCount > MAX_CLASS_METHODS ||
      m.constructorDeps > MAX_CONSTRUCTOR_DEPS ||
      m.totalLines > MAX_CLASS_LINES
    );

    if (gods.length === 0) {
      return {
        content: [{ type: 'text', text: `No god classes found.\n\nThresholds: >${MAX_CLASS_METHODS} methods, >${MAX_CONSTRUCTOR_DEPS} deps, >${MAX_CLASS_LINES} lines.` }],
      };
    }

    let text = `God Classes / Oversized Classes (${gods.length})\n${'='.repeat(60)}\n\n`;
    text += `  ${'Class'.padEnd(35)} Methods  Deps  Lines  Layer\n`;
    text += `  ${'-'.repeat(70)}\n`;

    for (const m of gods) {
      const flags = [
        m.methodCount > MAX_CLASS_METHODS ? `!${m.methodCount}m` : `${m.methodCount}m`,
        m.constructorDeps > MAX_CONSTRUCTOR_DEPS ? `!${m.constructorDeps}d` : `${m.constructorDeps}d`,
        m.totalLines > MAX_CLASS_LINES ? `!${m.totalLines}l` : `${m.totalLines}l`,
      ].join('  ');
      text += `  ${m.class.padEnd(35)} ${flags}  ${m.layer}\n`;
    }

    text += `\n! = exceeds threshold  m=methods  d=constructor deps  l=lines\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCodeQualityStats(appPath: string): McpToolResult {
  try {
    const metrics = loadMetrics(appPath);

    if (metrics.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP classes found in src/.' }] };
    }

    const avgLines = Math.round(metrics.reduce((s, m) => s + m.totalLines, 0) / metrics.length);
    const avgMethods = (metrics.reduce((s, m) => s + m.methodCount, 0) / metrics.length).toFixed(1);
    const avgDeps = (metrics.reduce((s, m) => s + m.constructorDeps, 0) / metrics.length).toFixed(1);
    const withViolations = metrics.filter((m) => m.violations.length > 0).length;
    const longMethodTotal = metrics.reduce((s, m) => s + m.methods.filter((me) => me.lines > MAX_METHOD_LINES).length, 0);

    let text = `Code Quality Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes:       ${metrics.length}\n`;
    text += `With violations:     ${withViolations}\n`;
    text += `Avg lines/class:     ${avgLines}\n`;
    text += `Avg methods/class:   ${avgMethods}\n`;
    text += `Avg ctor deps:       ${avgDeps}\n`;
    text += `Long methods total:  ${longMethodTotal}  (>${MAX_METHOD_LINES} lines)\n`;

    text += `\nThresholds applied:\n`;
    text += `  Max class lines:    ${MAX_CLASS_LINES}\n`;
    text += `  Max methods:        ${MAX_CLASS_METHODS}\n`;
    text += `  Max ctor deps:      ${MAX_CONSTRUCTOR_DEPS}\n`;
    text += `  Max method lines:   ${MAX_METHOD_LINES}\n`;
    text += `  Max complexity:     ${COMPLEXITY_WARNING}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getCodeQualityTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'get_code_quality_report',
      description: 'Scan PHP classes for quality violations: long methods (>30 lines), high cyclomatic complexity, constructor bloat, oversized classes (>300 lines)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_god_classes',
      description: 'List classes exceeding thresholds: >15 methods, >8 constructor dependencies, or >300 lines — potential "god class" anti-pattern',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_code_quality_stats',
      description: 'Show code quality statistics: average lines/methods/deps per class, violation count, long method total',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
