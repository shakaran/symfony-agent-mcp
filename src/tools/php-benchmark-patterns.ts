/**
 * PHP Benchmark Patterns Inspector
 *
 * Scans benchmarks/, bench/, and src/**\/*Bench.php / src/**\/*Benchmark.php
 * for PHPBench annotation and attribute usage patterns.
 *
 * Detection:
 * - PHPBench annotation style: @Revs, @Iterations, @BeforeMethods, @Groups, @ParamProviders, @OutputTimeUnit
 * - PHPBench attribute style: #[Bench\Revs], #[Bench\Iterations], etc.
 * - Mixed annotation + attribute in same class
 * - sleep()/usleep() in benchmark methods (latency contamination)
 * - time() usage inside benchmark methods
 * - Methods without @Revs / #[Bench\Revs] (only 1 rev by default — not reliable)
 * - Benchmark classes without @Groups / #[Bench\Groups]
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpBenchmarkInfo {
  file: string;
  class: string;
  method: string;
  style: 'annotation' | 'attribute' | 'mixed' | 'none';
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

function collectBenchmarkFiles(appPath: string): string[] {
  const files: string[] = [];

  const candidateDirs = [
    path.join(appPath, 'benchmarks'),
    path.join(appPath, 'bench'),
  ];
  for (const dir of candidateDirs) {
    if (fs.existsSync(dir)) {
      files.push(...getAllPhpFiles(dir));
    }
  }

  // Also src/**/*Bench.php and src/**/*Benchmark.php
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const f of getAllPhpFiles(srcDir)) {
      const base = path.basename(f);
      if (/Bench\.php$/.test(base) || /Benchmark\.php$/.test(base)) {
        files.push(f);
      }
    }
  }

  // Deduplicate
  return [...new Set(files)];
}

function extractMethodBody(content: string, methodStart: number): string {
  // Find opening brace of method
  const braceIdx = content.indexOf('{', methodStart);
  if (braceIdx === -1) return '';
  let depth = 1;
  let i = braceIdx + 1;
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') depth--;
    i++;
  }
  return content.slice(braceIdx, Math.min(i, braceIdx + 4000));
}

function analyzeFile(filePath: string, appPath: string): PhpBenchmarkInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const classMatch = /\bclass\s+(\w{1,80})/.exec(content);
  if (!classMatch) return [];
  const className = classMatch[1];
  const relFile = path.relative(appPath, filePath);

  // Class-level: check for @Groups / #[Bench\Groups]
  const classAnnotationGroups = /@Groups\s*\(/.test(content);
  const classAttributeGroups = /#\[Bench\\Groups\s*\(/.test(content);
  const hasClassGroups = classAnnotationGroups || classAttributeGroups;

  // Class-level style detection
  const hasClassAnnotations = /@(Revs|Iterations|BeforeMethods|Groups|ParamProviders|OutputTimeUnit)\s*\(/.test(content);
  const hasClassAttributes = /#\[Bench\\(Revs|Iterations|BeforeMethods|Groups|ParamProviders)\s*\(/.test(content);

  const results: PhpBenchmarkInfo[] = [];

  // Extract public bench methods (benchX style convention)
  const methodPattern = /(?:public)\s+function\s+(bench[A-Za-z0-9_]{0,80})\s*\([^)]{0,200}\)\s*(?::\s*\w{1,40}\s*)?\{/g;
  let m: RegExpExecArray | null;

  while ((m = methodPattern.exec(content)) !== null) {
    const methodName = m[1];
    const methodStart = m.index;
    const body = extractMethodBody(content, methodStart);

    // Docblock for this method (look back up to 20 lines)
    const preceding = content.slice(Math.max(0, methodStart - 600), methodStart);
    const docblockMatch = /\/\*\*[^*]{0,2000}?\*\/\s*$/.exec(preceding);
    const docblock = docblockMatch ? docblockMatch[0] : '';

    const hasAnnotationRevs = /@Revs\s*\(/.test(docblock);
    const hasAttributeRevs = /#\[Bench\\Revs\s*\(/.test(preceding.slice(-300));
    const hasAnnotationIter = /@Iterations\s*\(/.test(docblock);
    const hasAttributeIter = /#\[Bench\\Iterations\s*\(/.test(preceding.slice(-300));

    const methodHasAnnotations = hasAnnotationRevs || hasAnnotationIter
      || /@(BeforeMethods|ParamProviders|OutputTimeUnit)\s*\(/.test(docblock);
    const methodHasAttributes = hasAttributeRevs || hasAttributeIter
      || /#\[Bench\\(BeforeMethods|ParamProviders)\s*\(/.test(preceding.slice(-300));

    let style: 'annotation' | 'attribute' | 'mixed' | 'none';
    if ((methodHasAnnotations || hasClassAnnotations) && (methodHasAttributes || hasClassAttributes)) {
      style = 'mixed';
    } else if (methodHasAnnotations || hasClassAnnotations) {
      style = 'annotation';
    } else if (methodHasAttributes || hasClassAttributes) {
      style = 'attribute';
    } else {
      style = 'none';
    }

    const issues: string[] = [];

    if (style === 'mixed') {
      issues.push('Mixed annotation and attribute style in same class — use one style consistently (prefer PHP 8 attributes #[Bench\\Revs(...)] for new code)');
    }

    if (!hasAnnotationRevs && !hasAttributeRevs) {
      issues.push('Method has no @Revs / #[Bench\\Revs] annotation — defaults to 1 revolution which is insufficient for micro-benchmarks; add @Revs(1000) or #[Bench\\Revs(1000)]');
    }

    // sleep()/usleep() in method body
    if (/\bsleep\s*\(/.test(body)) {
      issues.push('sleep() found inside benchmark method — introduces artificial latency and invalidates timing; remove it');
    }
    if (/\busleep\s*\(/.test(body)) {
      issues.push('usleep() found inside benchmark method — introduces artificial latency and invalidates timing; remove it');
    }

    // time() inside benchmark method body
    if (/\btime\s*\(\s*\)/.test(body)) {
      issues.push('time() used inside benchmark method — PHPBench handles timing automatically; this is unnecessary and may skew results');
    }

    if (!hasClassGroups) {
      issues.push(`Class "${className}" has no @Groups / #[Bench\\Groups] annotation — add groups to allow selective benchmark filtering with --group=`);
    }

    results.push({ file: relFile, class: className, method: methodName, style, issues });
  }

  return results;
}

function buildPhpBenchmarkInfos(appPath: string): PhpBenchmarkInfo[] {
  const files = collectBenchmarkFiles(appPath);
  const results: PhpBenchmarkInfo[] = [];
  for (const f of files) {
    results.push(...analyzeFile(f, appPath));
  }
  return results;
}

export function listPhpBenchmarkPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildPhpBenchmarkInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHPBench benchmark methods found in benchmarks/, bench/, or src/**/*Bench.php / src/**/*Benchmark.php.' }] };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);
    let text = `PHP Benchmark Patterns Analysis\n${'='.repeat(55)}\n\n`;
    text += `Benchmark methods found: ${infos.length}  |  With issues: ${withIssues.length}\n\n`;

    const byFile = new Map<string, PhpBenchmarkInfo[]>();
    for (const info of infos) {
      const existing = byFile.get(info.file) ?? [];
      existing.push(info);
      byFile.set(info.file, existing);
    }

    for (const [file, entries] of byFile) {
      text += `${file}\n`;
      for (const entry of entries) {
        text += `  ${entry.class}::${entry.method}()  [style: ${entry.style}]\n`;
        for (const issue of entry.issues) {
          text += `    ISSUE: ${issue}\n`;
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpBenchmarkPatternsStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpBenchmarkInfos(appPath);

    const annotationStyle = infos.filter((i) => i.style === 'annotation').length;
    const attributeStyle = infos.filter((i) => i.style === 'attribute').length;
    const mixedStyle = infos.filter((i) => i.style === 'mixed').length;
    const noneStyle = infos.filter((i) => i.style === 'none').length;
    const missingRevs = infos.filter((i) => i.issues.some((s) => s.includes('@Revs'))).length;
    const hasSleep = infos.filter((i) => i.issues.some((s) => s.includes('sleep()'))).length;
    const missingGroups = infos.filter((i) => i.issues.some((s) => s.includes('@Groups'))).length;
    const withIssues = infos.filter((i) => i.issues.length > 0).length;

    let text = `PHP Benchmark Patterns Statistics\n${'='.repeat(40)}\n\n`;
    text += `Benchmark methods found:   ${infos.length}\n`;
    text += `  Annotation style:        ${annotationStyle}\n`;
    text += `  Attribute style (PHP 8): ${attributeStyle}\n`;
    text += `  Mixed style:             ${mixedStyle}\n`;
    text += `  No style detected:       ${noneStyle}\n`;
    text += `\nIssues:\n`;
    text += `  Methods with issues:     ${withIssues}\n`;
    text += `  Missing @Revs:           ${missingRevs}\n`;
    text += `  sleep()/usleep() usage:  ${hasSleep}\n`;
    text += `  Missing @Groups:         ${missingGroups}\n`;

    const uniqueFiles = new Set(infos.map((i) => i.file)).size;
    text += `\nBenchmark files scanned:   ${uniqueFiles}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpBenchmarkPatternsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_benchmark_patterns',
      description: 'Scan PHPBench benchmark files (benchmarks/, bench/, src/**/*Bench.php) for annotation/attribute style issues: mixed styles, missing @Revs, sleep() usage, missing @Groups — grouped by file',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_benchmark_patterns_stats',
      description: 'Show PHPBench benchmark statistics: method counts by style (annotation/attribute/mixed/none), missing @Revs count, sleep() usage count, missing @Groups count, total files scanned',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
