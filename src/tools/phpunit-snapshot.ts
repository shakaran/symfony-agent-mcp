/**
 * PHPUnit Snapshot Assertions Inspector
 *
 * Scans tests/ for snapshot assertion usage:
 * - assertMatchesSnapshot(), assertMatchesJsonSnapshot(), etc.
 * - MatchesSnapshots trait usage
 * - Snapshot file directories: __snapshots__, snapshots/
 *
 * Checks composer.json for: spatie/phpunit-snapshot-assertions, Pest snapshot plugin.
 *
 * Warnings:
 *   - Snapshot test without --update-snapshots in CI config
 *   - Snapshot of dynamic data (timestamps/random IDs)
 *   - MatchesSnapshots trait but snapshot file doesn't exist
 *   - assertMatchesSnapshot() in @group that runs in CI
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface PhpUnitSnapshotInfo {
  file: string;
  class: string;
  snapshotAssertions: number;
  hasMatchesTrait: boolean;
  snapshotFiles: string[];
  hasDynamicData: boolean;
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

function getSnapshotFiles(testDir: string): string[] {
  const snapshots: string[] = [];
  const dirsToCheck = ['__snapshots__', 'snapshots'];

  function scanDir(dir: string): void {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (dirsToCheck.includes(e.name)) {
            try {
              for (const snap of fs.readdirSync(full)) {
                snapshots.push(path.join(full, snap));
              }
            } catch { /* skip */ }
          } else {
            scanDir(full);
          }
        }
      }
    } catch { /* skip */ }
  }

  scanDir(testDir);
  return snapshots;
}

function checkCiForSnapshotFlag(appPath: string): boolean {
  const ciPaths = [
    path.join(appPath, '.github', 'workflows'),
    path.join(appPath, '.gitlab-ci.yml'),
    path.join(appPath, '.travis.yml'),
    path.join(appPath, 'Jenkinsfile'),
    path.join(appPath, '.circleci', 'config.yml'),
  ];

  for (const ciPath of ciPaths) {
    try {
      const stat = fs.statSync(ciPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        for (const file of fs.readdirSync(ciPath)) {
          try {
            const content = fs.readFileSync(path.join(ciPath, file), 'utf-8');
            if (content.includes('--update-snapshots') || content.includes('update-snapshots')) {
              return true;
            }
          } catch { /* skip */ }
        }
      } else {
        const content = fs.readFileSync(ciPath, 'utf-8');
        if (content.includes('--update-snapshots') || content.includes('update-snapshots')) {
          return true;
        }
      }
    } catch { /* skip */ }
  }
  return false;
}

function parseSnapshotFile(
  filePath: string,
  snapshotFiles: string[],
  hasCiFlag: boolean
): PhpUnitSnapshotInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasSnapshotAssert = content.includes('assertMatchesSnapshot(') ||
    content.includes('assertMatchesJsonSnapshot(') ||
    content.includes('assertMatchesHtmlSnapshot(') ||
    content.includes('assertMatchesXmlSnapshot(');
  const hasMatchesTrait = content.includes('MatchesSnapshots') ||
    content.includes('use MatchesSnapshots');

  if (!hasSnapshotAssert && !hasMatchesTrait) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  // Count assertions
  let snapshotAssertions = 0;
  const assertionPatterns = [
    /assertMatchesSnapshot\s*\(/g,
    /assertMatchesJsonSnapshot\s*\(/g,
    /assertMatchesHtmlSnapshot\s*\(/g,
    /assertMatchesXmlSnapshot\s*\(/g,
  ];
  for (const p of assertionPatterns) {
    snapshotAssertions += (content.match(p) ?? []).length;
  }

  // Find related snapshot files for this test class
  const relatedSnapshots = snapshotFiles.filter((sf) =>
    sf.includes(className) || path.basename(sf).includes(className)
  );

  // Detect dynamic data
  const dynamicPatterns = [
    /new\s+\\\?DateTime/,
    /time\s*\(\s*\)/,
    /uniqid\s*\(/,
    /Uuid::v[0-9]/,
    /random_/,
    /mt_rand\s*\(/,
    /rand\s*\(/,
  ];
  const hasDynamicData = dynamicPatterns.some((p) => p.test(content));

  const issues: string[] = [];

  // Warning: snapshot test without --update-snapshots CI flag
  if (!hasCiFlag && snapshotAssertions > 0) {
    issues.push('Snapshot test without --update-snapshots flag in CI config — snapshots may fail after code changes');
  }

  // Warning: snapshot of dynamic data
  if (hasDynamicData && snapshotAssertions > 0) {
    issues.push('Snapshot test with dynamic data (timestamp/random ID) — snapshot will fail on every run');
  }

  // Warning: MatchesSnapshots trait but no snapshot file exists
  if (hasMatchesTrait && relatedSnapshots.length === 0 && snapshotAssertions > 0) {
    issues.push('MatchesSnapshots trait used but no snapshot file found — run test once to generate the snapshot');
  }

  // Warning: snapshot test in @group that runs in CI
  const hasCiGroup = /@group\s+(ci|integration|acceptance|functional)/i.test(content);
  if (snapshotAssertions > 0 && hasCiGroup) {
    issues.push('assertMatchesSnapshot() in @group that runs in CI — snapshots must be committed and updated on changes');
  }

  return {
    file: path.basename(filePath),
    class: className,
    snapshotAssertions,
    hasMatchesTrait,
    snapshotFiles: relatedSnapshots.map((f) => path.basename(f)),
    hasDynamicData,
    issues,
  };
}

function checkComposerForSnapshot(appPath: string): { hasSpatie: boolean; hasPest: boolean } {
  const result = { hasSpatie: false, hasPest: false };
  try {
    const content = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8');
    result.hasSpatie = content.includes('spatie/phpunit-snapshot-assertions');
    result.hasPest = content.includes('pestphp/pest') && (content.includes('snapshot') || content.includes('pest-plugin'));
  } catch { /* skip */ }
  return result;
}

export function listPhpUnitSnapshots(appPath: string): McpToolResult {
  try {
    const testDir = path.join(appPath, 'tests');
    const allFiles = getAllPhpFiles(testDir);
    const snapshotFiles = getSnapshotFiles(testDir);
    const hasCiFlag = checkCiForSnapshotFlag(appPath);
    const composer = checkComposerForSnapshot(appPath);

    const results: PhpUnitSnapshotInfo[] = [];
    for (const f of allFiles) {
      const info = parseSnapshotFile(f, snapshotFiles, hasCiFlag);
      if (info) results.push(info);
    }

    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No snapshot tests found in tests/.\nspatie/phpunit-snapshot-assertions: ${composer.hasSpatie ? 'installed' : 'not found'}\nPest snapshot: ${composer.hasPest ? 'installed' : 'not found'}`,
        }],
      };
    }

    results.sort((a, b) => a.class.localeCompare(b.class));
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `PHPUnit Snapshot Assertions Analysis\n${'='.repeat(55)}\n`;
    text += `\nTest files: ${results.length}  Snapshot files: ${snapshotFiles.length}  Issues: ${totalIssues}\n`;
    text += `CI --update-snapshots flag: ${hasCiFlag ? 'found' : 'NOT FOUND'}\n`;
    text += `spatie/phpunit-snapshot-assertions: ${composer.hasSpatie ? 'installed' : 'not found'}\n`;

    for (const r of results) {
      text += `\n  ${r.class.padEnd(50)} (${r.file})\n`;
      text += `    assertions: ${r.snapshotAssertions}  snapshots: ${r.snapshotFiles.length}  dynamic: ${r.hasDynamicData}\n`;
      for (const issue of r.issues) text += `    ! ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitSnapshotStats(appPath: string): McpToolResult {
  try {
    const testDir = path.join(appPath, 'tests');
    const allFiles = getAllPhpFiles(testDir);
    const snapshotFiles = getSnapshotFiles(testDir);
    const hasCiFlag = checkCiForSnapshotFlag(appPath);
    const composer = checkComposerForSnapshot(appPath);

    const results: PhpUnitSnapshotInfo[] = [];
    for (const f of allFiles) {
      const info = parseSnapshotFile(f, snapshotFiles, hasCiFlag);
      if (info) results.push(info);
    }

    let text = `PHPUnit Snapshot Statistics\n${'='.repeat(40)}\n\n`;
    text += `Test classes with snapshots:    ${results.length}\n`;
    text += `Total snapshot assertions:      ${results.reduce((s, r) => s + r.snapshotAssertions, 0)}\n`;
    text += `Snapshot files on disk:         ${snapshotFiles.length}\n`;
    text += `With dynamic data:              ${results.filter((r) => r.hasDynamicData).length}\n`;
    text += `CI --update-snapshots flag:     ${hasCiFlag ? 'yes' : 'NO'}\n`;
    text += `spatie library installed:       ${composer.hasSpatie ? 'yes' : 'no'}\n`;
    text += `Total issues:                   ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitSnapshotTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpunit_snapshots',
      description: 'Scan PHPUnit/Pest test files for snapshot assertions (assertMatchesSnapshot/Json/Html/Xml); warns on missing --update-snapshots in CI, dynamic data in snapshots, missing snapshot files, @group that runs in CI',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_snapshot_stats',
      description: 'Get statistics on PHPUnit snapshot tests: test class count, assertion count, snapshot files on disk, dynamic data issues, CI flag presence',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
