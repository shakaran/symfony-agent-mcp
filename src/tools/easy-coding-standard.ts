import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface EasyCodingStandardInfo {
  source: string;
  type: 'ruleset' | 'fixer' | 'skip' | 'parallel' | 'cache';
  pattern: string;
  issues: string[];
}

function countPhpFilesInDir(dir: string): number {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      count += countPhpFilesInDir(path.join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith('.php')) {
      count++;
    }
  }
  return count;
}

function buildEasyCodingStandardInfos(appPath: string): EasyCodingStandardInfo[] {
  const results: EasyCodingStandardInfo[] = [];

  const ecsConfigPath = path.join(appPath, 'ecs.php');
  const ecsExists = fs.existsSync(ecsConfigPath);

  if (!ecsExists) {
    // Check if PHP-CS-Fixer exists as alternative
    const phpCsFixerExists =
      fs.existsSync(path.join(appPath, '.php-cs-fixer.php')) ||
      fs.existsSync(path.join(appPath, '.php-cs-fixer.dist.php')) ||
      fs.existsSync(path.join(appPath, '.php_cs'));

    if (!phpCsFixerExists) {
      results.push({
        source: 'ecs.php',
        type: 'ruleset',
        pattern: 'missing-config',
        issues: [
          'No ECS (Easy Coding Standard) configuration found — install with: composer require --dev symplify/easy-coding-standard; create ecs.php configuration file',
        ],
      });
    } else {
      results.push({
        source: '.php-cs-fixer.php',
        type: 'fixer',
        pattern: 'php-cs-fixer-found',
        issues: [],
      });
    }
    return results;
  }

  // ecs.php found — parse content
  const ecsContent = fs.readFileSync(ecsConfigPath, 'utf8');

  // SetList usage
  const setListMatches = ecsContent.match(/SetList::\w+/g);
  if (setListMatches) {
    const uniqueSets = [...new Set(setListMatches)];
    for (const setName of uniqueSets) {
      results.push({
        source: 'ecs.php',
        type: 'ruleset',
        pattern: `SetList:${setName}`,
        issues: [],
      });
    }
  } else {
    results.push({
      source: 'ecs.php',
      type: 'ruleset',
      pattern: 'missing-setlist',
      issues: [
        'ECS configuration without predefined ruleset sets — add SetList::PSR_12 or SetList::SYMFONY for standard Symfony project rules',
      ],
    });
  }

  // withSkip / skip
  if (/->withSkip\s*\(|->skip\s*\(/.test(ecsContent)) {
    results.push({
      source: 'ecs.php',
      type: 'skip',
      pattern: 'skip-rules-defined',
      issues: [],
    });
  }

  // withParallel
  if (/->withParallel\s*\(/.test(ecsContent)) {
    results.push({
      source: 'ecs.php',
      type: 'parallel',
      pattern: 'parallel-processing-enabled',
      issues: [],
    });
  } else {
    // Check if codebase is large (>100 PHP files in src/)
    const srcPhpCount = countPhpFilesInDir(path.join(appPath, 'src'));
    if (srcPhpCount > 100) {
      results.push({
        source: 'ecs.php',
        type: 'parallel',
        pattern: 'parallel-not-configured',
        issues: [
          'ECS without parallel processing — add ->withParallel() to ECSConfig for faster checking on multi-core systems',
        ],
      });
    }
  }

  // withCache / setCacheDirectory
  if (/->withCache\s*\(|->setCacheDirectory\s*\(/.test(ecsContent)) {
    results.push({
      source: 'ecs.php',
      type: 'cache',
      pattern: 'cache-configured',
      issues: [],
    });
  }

  // Check composer.json scripts for ecs
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    const composerContent = fs.readFileSync(composerPath, 'utf8');
    if (/"ecs"|"cs-fix"/.test(composerContent)) {
      results.push({
        source: 'composer.json',
        type: 'ruleset',
        pattern: 'composer-script-defined',
        issues: [],
      });
    }
  }

  // Check CI pipeline
  const ciFiles = [
    path.join(appPath, '.github', 'workflows'),
    path.join(appPath, '.gitlab-ci.yml'),
    path.join(appPath, '.gitlab-ci.yaml'),
  ];
  let foundInCi = false;
  for (const ciPath of ciFiles) {
    if (fs.existsSync(ciPath)) {
      if (fs.statSync(ciPath).isDirectory()) {
        const workflowFiles = fs.readdirSync(ciPath);
        for (const wf of workflowFiles) {
          const wfPath = path.join(ciPath, wf);
          if (fs.statSync(wfPath).isFile()) {
            const wfContent = fs.readFileSync(wfPath, 'utf8');
            if (/\becs\b/.test(wfContent)) {
              foundInCi = true;
              break;
            }
          }
        }
      } else {
        const ciContent = fs.readFileSync(ciPath, 'utf8');
        if (/\becs\b/.test(ciContent)) foundInCi = true;
      }
    }
    if (foundInCi) break;
  }

  if (!foundInCi) {
    results.push({
      source: 'ecs.php',
      type: 'ruleset',
      pattern: 'missing-ci-integration',
      issues: [
        'ECS configuration found but not detected in CI pipeline — add ECS check to CI to enforce coding standards automatically',
      ],
    });
  } else {
    results.push({
      source: 'ecs.php',
      type: 'ruleset',
      pattern: 'ci-integration-found',
      issues: [],
    });
  }

  return results;
}

export function listEasyCodingStandard(appPath: string): McpToolResult {
  try {
    const infos = buildEasyCodingStandardInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Easy Coding Standard configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Easy Coding Standard Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
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

export function getEasyCodingStandardStats(appPath: string): McpToolResult {
  try {
    const infos = buildEasyCodingStandardInfos(appPath);
    let text = `Easy Coding Standard Statistics\n${'='.repeat(40)}\n\n`;
    text += `Ruleset: ${infos.filter((i) => i.type === 'ruleset').length}\n`;
    text += `Fixer: ${infos.filter((i) => i.type === 'fixer').length}\n`;
    text += `Skip: ${infos.filter((i) => i.type === 'skip').length}\n`;
    text += `Parallel: ${infos.filter((i) => i.type === 'parallel').length}\n`;
    text += `Cache: ${infos.filter((i) => i.type === 'cache').length}\n`;
    text += `Issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getEasyCodingStandardTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_easy_coding_standard',
      description: 'Analyze Easy Coding Standard (ECS) configuration and detect issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_easy_coding_standard_stats',
      description: 'Statistics for Easy Coding Standard configuration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
