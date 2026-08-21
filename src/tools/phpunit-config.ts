/**
 * PHPUnit Configuration Inspector
 *
 * Reads phpunit.xml / phpunit.xml.dist:
 *   - Test suites: name, directories, file patterns, excluded paths
 *   - Bootstrap file
 *   - Coverage: driver (xdebug/pcov/phpdbg), include/exclude paths
 *   - Coverage thresholds (minimum coverage %)
 *   - Extensions and listeners registered
 *   - Environment variables set for tests
 *
 * Also reads phpunit.xml.dist as fallback.
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface TestSuite {
  name: string;
  directories: string[];
  files: string[];
  excludes: string[];
}

interface CoverageConfig {
  driver?: string;
  includePatterns: string[];
  excludePatterns: string[];
  minLines?: number;
  minMethods?: number;
  minClasses?: number;
  minBranches?: number;
}

interface PhpUnitConfig {
  version?: string;
  bootstrap?: string;
  colors: boolean;
  stopOnFailure: boolean;
  suites: TestSuite[];
  coverage?: CoverageConfig;
  extensions: string[];
  envVars: Record<string, string>;
}

// ─── XML parsing helpers ───────────────────────────────────────────────────

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  return re.exec(tag)?.[1];
}

function allTags(content: string, tagName: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>|<${tagName}(?:\\s[^>]*)?\\/>`, 'gi');
  for (const m of content.matchAll(re)) results.push(m[0]);
  return results;
}

function selfClosingAttr(content: string, tagName: string, attrName: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tagName}\\s[^>]*${attrName}="([^"]*)"[^>]*>`, 'gi');
  for (const m of content.matchAll(re)) results.push(m[1]);
  return results;
}

// ─── PHPUnit XML parsing ───────────────────────────────────────────────────

function parsePhpUnit(content: string): PhpUnitConfig {
  const config: PhpUnitConfig = {
    colors: content.includes('colors="true"') || content.includes("colors='true'"),
    stopOnFailure: content.includes('stopOnFailure="true"'),
    suites: [],
    extensions: [],
    envVars: {},
  };

  // Version / bootstrap
  const phpunitTagM = /<phpunit\s([^>]*)>/i.exec(content);
  if (phpunitTagM) {
    config.version = attr(phpunitTagM[1], 'xmlns:xsi') ? undefined : attr(phpunitTagM[1], 'backupGlobals');
    config.bootstrap = attr(phpunitTagM[1], 'bootstrap');
  }

  // Test suites
  const suitesBlock = /<testsuites>([\s\S]*?)<\/testsuites>/i.exec(content);
  if (suitesBlock) {
    for (const suiteTag of allTags(suitesBlock[1], 'testsuite')) {
      const nameM = /name="([^"]*)"/.exec(suiteTag);
      const dirs = selfClosingAttr(suiteTag, 'directory', '').length > 0
        ? selfClosingAttr(suiteTag, 'directory', '')
        : [];

      // <directory>./tests</directory>
      const dirTexts: string[] = [];
      for (const m of suiteTag.matchAll(/<directory[^>]*>([^<]+)<\/directory>/gi)) {
        dirTexts.push(m[1].trim());
      }
      const fileTexts: string[] = [];
      for (const m of suiteTag.matchAll(/<file[^>]*>([^<]+)<\/file>/gi)) {
        fileTexts.push(m[1].trim());
      }
      const excludeTexts: string[] = [];
      for (const m of suiteTag.matchAll(/<exclude[^>]*>([^<]+)<\/exclude>/gi)) {
        excludeTexts.push(m[1].trim());
      }

      config.suites.push({
        name: nameM?.[1] ?? 'default',
        directories: [...dirs, ...dirTexts],
        files: fileTexts,
        excludes: excludeTexts,
      });
    }
  }

  // Coverage (PHPUnit 10+: <coverage> block; older: <filter>)
  const coverageBlock = /<coverage([^>]*)>([\s\S]*?)<\/coverage>/i.exec(content)
    ?? /<filter>([\s\S]*?)<\/filter>/i.exec(content);

  if (coverageBlock) {
    const block = coverageBlock[0];
    const includePatterns: string[] = [];
    const excludePatterns: string[] = [];

    for (const m of block.matchAll(/<include[^>]*>([\s\S]*?)<\/include>/gi)) {
      for (const dm of m[1].matchAll(/<directory[^>]*>([^<]+)<\/directory>/gi)) {
        includePatterns.push(dm[1].trim());
      }
    }
    for (const m of block.matchAll(/<exclude[^>]*>([\s\S]*?)<\/exclude>/gi)) {
      for (const dm of m[1].matchAll(/<directory[^>]*>([^<]+)<\/directory>/gi)) {
        excludePatterns.push(dm[1].trim());
      }
    }

    const minLines   = /lines="(\d+)"/.exec(block)?.[1];
    const minMethods = /methods="(\d+)"/.exec(block)?.[1];
    const minClasses = /classes="(\d+)"/.exec(block)?.[1];
    const minBranches= /branches="(\d+)"/.exec(block)?.[1];
    const driver     = /driver="([^"]+)"/.exec(block)?.[1];

    config.coverage = {
      driver,
      includePatterns,
      excludePatterns,
      minLines:    minLines    ? parseInt(minLines, 10)    : undefined,
      minMethods:  minMethods  ? parseInt(minMethods, 10)  : undefined,
      minClasses:  minClasses  ? parseInt(minClasses, 10)  : undefined,
      minBranches: minBranches ? parseInt(minBranches, 10) : undefined,
    };
  }

  // Extensions (PHPUnit 10+: <extensions>, older: <listeners>)
  for (const m of content.matchAll(/<extension\s+class="([^"]+)"/gi)) {
    config.extensions.push(m[1]);
  }
  for (const m of content.matchAll(/<listener\s+class="([^"]+)"/gi)) {
    config.extensions.push(m[1] + ' [listener]');
  }

  // Env vars
  const phpBlock = /<php>([\s\S]*?)<\/php>/i.exec(content);
  if (phpBlock) {
    for (const m of phpBlock[1].matchAll(/<(?:env|server)\s+name="([^"]+)"\s+value="([^"]*)"/gi)) {
      config.envVars[m[1]] = m[2];
    }
  }

  return config;
}

function loadPhpUnitConfig(appPath: string): { config: PhpUnitConfig; file: string } | null {
  const candidates = ['phpunit.xml', 'phpunit.xml.dist'];
  for (const fname of candidates) {
    try {
      const content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      return { config: parsePhpUnit(content), file: fname };
    } catch { /* try next */ }
  }
  return null;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpUnitConfig(appPath: string): McpToolResult {
  try {
    const result = loadPhpUnitConfig(appPath);
    if (!result) {
      return {
        content: [{
          type: 'text',
          text: 'phpunit.xml / phpunit.xml.dist not found.\n\nInstall:\n  composer require --dev phpunit/phpunit\n\nCreate via Symfony:\n  php bin/console make:test',
        }],
      };
    }

    const { config, file } = result;
    let text = `PHPUnit Configuration  (${file})\n${'='.repeat(55)}\n`;

    if (config.bootstrap) text += `\nBootstrap: ${config.bootstrap}\n`;
    text += `Colors:    ${config.colors ? 'yes' : 'no'}\n`;

    if (config.suites.length > 0) {
      text += `\nTest suites (${config.suites.length}):\n`;
      for (const s of config.suites) {
        text += `  ${s.name}\n`;
        for (const d of s.directories) text += `    dir:     ${d}\n`;
        for (const f of s.files)       text += `    file:    ${f}\n`;
        for (const e of s.excludes)    text += `    exclude: ${e}\n`;
      }
    }

    if (config.coverage) {
      const cov = config.coverage;
      text += `\nCoverage:\n`;
      if (cov.driver) text += `  Driver:    ${cov.driver}\n`;
      if (cov.includePatterns.length > 0)
        text += `  Include:   ${cov.includePatterns.join(', ')}\n`;
      if (cov.excludePatterns.length > 0)
        text += `  Exclude:   ${cov.excludePatterns.join(', ')}\n`;
      if (cov.minLines    !== undefined) text += `  Min lines:    ${cov.minLines}%\n`;
      if (cov.minMethods  !== undefined) text += `  Min methods:  ${cov.minMethods}%\n`;
      if (cov.minClasses  !== undefined) text += `  Min classes:  ${cov.minClasses}%\n`;
      if (cov.minBranches !== undefined) text += `  Min branches: ${cov.minBranches}%\n`;
      if (cov.minLines === undefined && cov.minMethods === undefined) {
        text += `  ⚠ No minimum coverage thresholds configured\n`;
      }
    } else {
      text += `\nCoverage: not configured\n`;
    }

    if (config.extensions.length > 0) {
      text += `\nExtensions/listeners (${config.extensions.length}):\n`;
      for (const e of config.extensions) text += `  ${e}\n`;
    }

    if (Object.keys(config.envVars).length > 0) {
      text += `\nTest environment variables:\n`;
      for (const [k, v] of Object.entries(config.envVars)) {
        const masked = ['DATABASE_URL', 'REDIS_URL', 'SECRET', 'PASSWORD', 'TOKEN',
          'PASS', 'KEY', 'CREDENTIAL', 'CERT', 'DSN', 'AUTH'].some(
          (p) => k.toUpperCase().includes(p)
        ) ? '***' : v;
        text += `  ${k}=${masked}\n`;
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

export function getPhpUnitStats(appPath: string): McpToolResult {
  try {
    const result = loadPhpUnitConfig(appPath);

    let text = `PHPUnit Statistics\n${'='.repeat(40)}\n\n`;

    if (!result) {
      text += 'phpunit.xml: not found\n';
      return { content: [{ type: 'text', text }] };
    }

    const { config } = result;
    const totalDirs = config.suites.reduce((s, suite) => s + suite.directories.length, 0);
    const hasCoverage = config.coverage !== undefined;
    const hasThresholds = hasCoverage && (
      config.coverage!.minLines !== undefined ||
      config.coverage!.minMethods !== undefined
    );

    text += `Test suites:    ${config.suites.length}\n`;
    text += `Test dirs:      ${totalDirs}\n`;
    text += `Coverage:       ${hasCoverage ? 'configured' : 'not configured'}\n`;
    text += `Thresholds:     ${hasThresholds ? 'yes' : 'no (quality gate missing)'}\n`;
    text += `Extensions:     ${config.extensions.length}\n`;
    text += `Test env vars:  ${Object.keys(config.envVars).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpUnitConfigTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_phpunit_config',
      description: 'Show PHPUnit configuration: test suites and directories, bootstrap, coverage driver/paths/thresholds, extensions, test env vars',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_stats',
      description: 'Show PHPUnit statistics: suite count, directory count, coverage configured, threshold presence, extension count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
