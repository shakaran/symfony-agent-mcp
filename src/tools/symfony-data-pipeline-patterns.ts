/**
 * Symfony Data Pipeline Patterns Inspector
 *
 * Scans src/**\/*.php for data pipeline patterns:
 *   - Batch processing (BatchInterface, ChainedBatch)
 *   - Stream processing (generators with yield, fopen/fgets CSV, SplFileObject)
 *   - ETL patterns (extract/transform/load method names, pipeline/pipe chaining)
 *   - Import/export patterns
 *
 * Flags: loading all data into memory instead of generators, missing flush/commit
 *        in batch processing.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DataPipelineInfo {
  file: string;
  type: 'batch' | 'stream' | 'etl' | 'import' | 'export';
  pattern: string;
  issues: string[];
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

function detectPipelineType(content: string): 'batch' | 'stream' | 'etl' | 'import' | 'export' | null {
  if (content.includes('BatchInterface') || content.includes('ChainedBatch')) return 'batch';
  if (/\byield\b/.test(content) || content.includes('SplFileObject') || /\bfopen\s*\(/.test(content)) return 'stream';
  if (/\bextract\b.*\btransform\b|\btransform\b.*\bload\b|\bextract\b.*\bload\b/s.test(content)) return 'etl';
  if (/\bimport\b/i.test(content) && (content.includes('function import') || content.includes('Import'))) return 'import';
  if (/\bexport\b/i.test(content) && (content.includes('function export') || content.includes('Export'))) return 'export';
  return null;
}

function buildPatternDescription(content: string, type: 'batch' | 'stream' | 'etl' | 'import' | 'export'): string {
  const patterns: string[] = [];
  if (type === 'batch') {
    if (content.includes('BatchInterface')) patterns.push('BatchInterface');
    if (content.includes('ChainedBatch')) patterns.push('ChainedBatch');
    if (content.includes('flush')) patterns.push('flush');
  } else if (type === 'stream') {
    if (/\byield\b/.test(content)) patterns.push('generator/yield');
    if (content.includes('SplFileObject')) patterns.push('SplFileObject');
    if (/\bfopen\s*\(/.test(content) && /\bfgets\s*\(/.test(content)) patterns.push('fopen/fgets CSV');
  } else if (type === 'etl') {
    if (/\bextract\b/i.test(content)) patterns.push('extract()');
    if (/\btransform\b/i.test(content)) patterns.push('transform()');
    if (/\bload\b/i.test(content)) patterns.push('load()');
    if (content.includes('->pipe(') || content.includes('pipeline(')) patterns.push('pipeline chaining');
  } else if (type === 'import') {
    patterns.push('import pattern');
  } else if (type === 'export') {
    patterns.push('export pattern');
  }
  return patterns.join(', ') || type;
}

function analyzeDataPipelineFile(filePath: string, appPath: string): DataPipelineInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const type = detectPipelineType(content);
  if (!type) return null;

  // Skip Symfony framework internals
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const pattern = buildPatternDescription(content, type);
  const issues: string[] = [];

  // Flag: loading all data into memory (array_map on large collections vs generators)
  if (/array_map\s*\(/.test(content) && !(/\byield\b/.test(content))) {
    if (type === 'import' || type === 'etl' || type === 'batch') {
      issues.push('array_map() used for data processing — consider generators (yield) to avoid loading all records into memory');
    }
  }

  // Flag: missing flush/commit in batch contexts
  if (type === 'batch') {
    const hasFlush = content.includes('flush') || content.includes('commit');
    if (!hasFlush) {
      issues.push('Batch processing without flush() or commit() — entity manager changes may not be persisted');
    }
    // Detect large array accumulation
    if (/\[\]\s*;/.test(content) && /\$\w+\[\]\s*=/.test(content)) {
      issues.push('Array accumulation pattern detected — use batched flush every N items to avoid memory exhaustion');
    }
  }

  // Flag: stream type without generators (missed optimization)
  if (type === 'stream' && content.includes('SplFileObject') && !(/\byield\b/.test(content))) {
    if (/\$rows\s*=\s*\[\]/.test(content) || /\$data\s*=\s*\[\]/.test(content)) {
      issues.push('SplFileObject used but collecting all rows into array — use generator to stream rows one by one');
    }
  }

  // Flag: ETL without chunking
  if (type === 'etl') {
    if (!content.includes('chunk') && !content.includes('batch') && !content.includes('limit') && !(/\byield\b/.test(content))) {
      issues.push('ETL pattern without chunking or generator — may exhaust memory on large datasets');
    }
  }

  return {
    file: path.relative(appPath, filePath),
    type,
    pattern,
    issues,
  };
}

function buildDataPipelineInfos(appPath: string): DataPipelineInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: DataPipelineInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  for (const file of collectPhpFiles(srcDir, srcDir)) {
    const info = analyzeDataPipelineFile(file, appPath);
    if (info) results.push(info);
  }

  return results;
}

export function listSymfonyDataPipelinePatterns(appPath: string): McpToolResult {
  try {
    const infos = buildDataPipelineInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No data pipeline patterns (batch/stream/ETL/import/export) found in src/ PHP files.' }] };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);
    let text = `Symfony Data Pipeline Patterns\n${'='.repeat(55)}\n\n`;
    text += `Data pipeline files found: ${infos.length}  (with issues: ${withIssues.length})\n\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `  [${info.type.toUpperCase()}] ${info.file}\n`;
      text += `    Pattern: ${info.pattern}\n`;
      for (const issue of info.issues) {
        text += `    [WARN] ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyDataPipelinePatternsStats(appPath: string): McpToolResult {
  try {
    const infos = buildDataPipelineInfos(appPath);

    const byType: Record<string, number> = {};
    for (const info of infos) {
      byType[info.type] = (byType[info.type] ?? 0) + 1;
    }

    let text = `Symfony Data Pipeline Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total pipeline files: ${infos.length}\n\n`;
    text += `By type:\n`;
    for (const [type, count] of Object.entries(byType).sort()) {
      text += `  ${type.padEnd(10)}  ${count}\n`;
    }
    text += `\nTotal issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    text += `Files with issues: ${infos.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyDataPipelinePatternsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_data_pipeline_patterns',
      description: 'List Symfony data pipeline patterns: batch (BatchInterface/ChainedBatch), stream (generators/SplFileObject/CSV), ETL (extract/transform/load), import/export; flags memory issues and missing flush/commit',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_data_pipeline_patterns_stats',
      description: 'Show Symfony data pipeline statistics: count by type (batch/stream/etl/import/export), total issues, files with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
