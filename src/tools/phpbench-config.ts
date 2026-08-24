// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface PhpbenchInfo {
  configFile: string;
  runners: string[];
  benchmarkCount: number;
  iterationDefault: number;
  revolutions: number;
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

function countBenchmarkFiles(appPath: string): number {
  let count = 0;
  const dirs = [path.join(appPath, 'benchmarks'), path.join(appPath, 'bench'), path.join(appPath, 'src')];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      if (!file.endsWith('Bench.php') && !file.endsWith('Benchmark.php')) continue;
      const content = safeRead(file, appPath);
      if (content === null) continue;
      if (content.includes('@Bench') || content.includes('#[Bench]') || content.includes('@Subject') || content.includes('#[Subject]')) {
        count++;
      }
    }
  }
  return count;
}

function buildPhpbenchInfos(appPath: string): PhpbenchInfo[] {
  const configCandidates = [
    path.join(appPath, 'phpbench.json'),
    path.join(appPath, 'phpbench.xml'),
  ];
  const configFile = configCandidates.find((c) => fs.existsSync(c)) ?? null;

  let composerHasPhpbench = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const dev = (composer['require-dev'] ?? {}) as Record<string, string>;
      if (dev['phpbench/phpbench']) composerHasPhpbench = true;
    } catch { /* ignore */ }
  }

  const benchmarkCount = countBenchmarkFiles(appPath);
  const issues: string[] = [];

  if (!composerHasPhpbench && benchmarkCount > 0) {
    issues.push(`${benchmarkCount} benchmark file(s) found but phpbench/phpbench not in composer.json`);
  }

  if (!configFile) {
    if (composerHasPhpbench) issues.push('PHPBench installed but no phpbench.json or phpbench.xml config file');
    return [{ configFile: 'none', runners: [], benchmarkCount, iterationDefault: 0, revolutions: 0, issues }];
  }

  let content = '';
  try { content = fs.readFileSync(configFile, 'utf-8'); } catch { /* ignore */ }

  let iterationDefault = 0;
  let revolutions = 1;
  const runners: string[] = [];

  if (configFile.endsWith('.json')) {
    try {
      const cfg = JSON.parse(content) as Record<string, unknown>;
      iterationDefault = parseInt(String(cfg['runner.iterations'] ?? cfg['iterations'] ?? '0'), 10);
      revolutions = parseInt(String(cfg['runner.revolutions'] ?? cfg['revolutions'] ?? '1'), 10);
      const runner = String(cfg['runner'] ?? cfg['runner.executor'] ?? '');
      if (runner) runners.push(runner);
    } catch { /* ignore */ }
  } else {
    const iterMatch = /iterations=["']?(\d+)["']?/.exec(content);
    if (iterMatch) iterationDefault = parseInt(iterMatch[1], 10);
    const revMatch = /revolutions=["']?(\d+)["']?/.exec(content);
    if (revMatch) revolutions = parseInt(revMatch[1], 10);
    if (content.includes('microtime')) runners.push('microtime');
    if (content.includes('xdebug')) runners.push('xdebug');
  }

  if (revolutions <= 1) {
    issues.push('revolutions=1 — single-run benchmarks are unstable; set revolutions >= 10 for reliable results');
  }
  if (benchmarkCount > 0 && iterationDefault === 0) {
    issues.push('No default iterations configured — PHPBench uses its default (may be insufficient for statistical reliability)');
  }

  const hasBenchInSrc = fs.existsSync(path.join(appPath, 'src')) &&
    getAllPhpFiles(path.join(appPath, 'src')).some((f) => f.endsWith('Bench.php'));
  if (hasBenchInSrc) {
    issues.push('Benchmark files found in src/ — consider moving to benchmarks/ to separate from production code');
  }

  const ciFiles = ['.github/workflows', '.gitlab-ci.yml', 'Makefile'];
  let ciIntegrated = false;
  for (const ci of ciFiles) {
    const ciPath = path.join(appPath, ci);
    if (fs.existsSync(ciPath)) {
      try {
        if (fs.readFileSync(ciPath, 'utf-8').includes('phpbench')) { ciIntegrated = true; break; }
      } catch { /* ignore */ }
    }
  }
  if (benchmarkCount > 0 && !ciIntegrated) {
    issues.push('Benchmarks exist but not found in CI — performance regressions not automatically detected');
  }

  return [{ configFile: path.relative(appPath, configFile), runners, benchmarkCount, iterationDefault, revolutions, issues }];
}

export function listPhpbenchConfig(appPath: string): McpToolResult {
  try {
    const infos = buildPhpbenchInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHPBench Configuration Analysis\n${'='.repeat(50)}\n\nIssues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  Config: ${info.configFile}  Benchmarks: ${info.benchmarkCount}\n`;
      text += `    runners: ${info.runners.join(', ') || '(default)'}  iterations: ${info.iterationDefault || '(default)'}  revolutions: ${info.revolutions}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpbenchStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpbenchInfos(appPath);
    let text = `PHPBench Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config files:     ${infos.filter((i) => i.configFile !== 'none').length}\n`;
    text += `Benchmark files:  ${infos.reduce((s, i) => s + i.benchmarkCount, 0)}\n`;
    text += `Total issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpbenchTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_phpbench_config', description: 'Analyze PHPBench benchmarking configuration; warns on low revolutions, missing iterations default, benchmarks in src/, not in CI', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_phpbench_stats', description: 'Statistics for PHPBench: config files, benchmark count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
