import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpArkitectConfigInfo {
  source: string;
  type: 'rule' | 'naming' | 'namespace' | 'dependency' | 'structure';
  pattern: string;
  issues: string[];
}

function buildPhpArkitectConfigInfos(appPath: string): PhpArkitectConfigInfo[] {
  const results: PhpArkitectConfigInfo[] = [];

  const configPath = path.join(appPath, 'phparkitect.php');
  const configExists = fs.existsSync(configPath);

  if (!configExists) {
    results.push({
      source: 'phparkitect.php',
      type: 'rule',
      pattern: 'missing-config',
      issues: [
        'No PHPArkitect configuration found — install phparkitect/phparkitect to enforce architecture rules; create phparkitect.php with Architecture::with()->rules(...)',
      ],
    });
  } else {
    const configContent = fs.readFileSync(configPath, 'utf8');

    // Check for naming rules (Controller namespace)
    if (/Controller/i.test(configContent) && /andResideInOneOfTheseNamespaces|ShouldNotDependOn|haveNameMatching/i.test(configContent)) {
      results.push({
        source: 'phparkitect.php',
        type: 'naming',
        pattern: 'controller-naming-rule',
        issues: [],
      });
    }

    // Check for dependency rules
    const dependencyMatches = configContent.match(/ShouldNotDependOn|CanOnlyDependOn|beFinal|beAbstract/g);
    if (dependencyMatches) {
      const dependencyRules = new Set(dependencyMatches);
      for (const rule of dependencyRules) {
        if (rule === 'ShouldNotDependOn' || rule === 'CanOnlyDependOn') {
          results.push({
            source: 'phparkitect.php',
            type: 'dependency',
            pattern: rule,
            issues: [],
          });
        }
        if (rule === 'beFinal' || rule === 'beAbstract') {
          results.push({
            source: 'phparkitect.php',
            type: 'structure',
            pattern: rule,
            issues: [],
          });
        }
      }
    }

    // Check for namespace rules
    if (/andResideInOneOfTheseNamespaces|resideInAPath/i.test(configContent)) {
      results.push({
        source: 'phparkitect.php',
        type: 'namespace',
        pattern: 'namespace-rule',
        issues: [],
      });
    }

    // Generic rule count
    const ruleMatches = configContent.match(/->rules\s*\(/g);
    if (ruleMatches) {
      results.push({
        source: 'phparkitect.php',
        type: 'rule',
        pattern: `rules-defined:${ruleMatches.length}`,
        issues: [],
      });
    }
  }

  // Check composer.json for phparkitect/phparkitect
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    const composerContent = fs.readFileSync(composerPath, 'utf8');
    if (!composerContent.includes('phparkitect/phparkitect')) {
      results.push({
        source: 'composer.json',
        type: 'rule',
        pattern: 'missing-dependency',
        issues: ['PHPArkitect not installed — add with: composer require --dev phparkitect/phparkitect'],
      });
    }
  }

  // Check CI pipeline
  if (configExists) {
    const ciFiles = [
      path.join(appPath, '.github', 'workflows'),
      path.join(appPath, '.gitlab-ci.yml'),
      path.join(appPath, '.gitlab-ci.yaml'),
    ];
    let foundInCi = false;
    for (const ciPath of ciFiles) {
      if (fs.existsSync(ciPath)) {
        if ((()=>{const _s=fs.lstatSync(ciPath);return !_s.isSymbolicLink()&&_s.isDirectory();})()) {
          const workflowFiles = fs.readdirSync(ciPath);
          for (const wf of workflowFiles) {
            const wfContent = fs.readFileSync(path.join(ciPath, wf), 'utf8');
            if (wfContent.includes('phparkitect')) {
              foundInCi = true;
              break;
            }
          }
        } else {
          const ciContent = fs.readFileSync(ciPath, 'utf8');
          if (ciContent.includes('phparkitect')) foundInCi = true;
        }
      }
      if (foundInCi) break;
    }

    if (!foundInCi) {
      results.push({
        source: 'phparkitect.php',
        type: 'rule',
        pattern: 'missing-ci-integration',
        issues: [
          'PHPArkitect configuration exists but not found in CI pipeline — add phparkitect check to your CI workflow to enforce architecture rules automatically',
        ],
      });
    }
  }

  return results;
}

export function listPhpArkitectConfig(appPath: string): McpToolResult {
  try {
    const infos = buildPhpArkitectConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHPArkitect configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHPArkitect Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
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

export function getPhpArkitectConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpArkitectConfigInfos(appPath);
    let text = `PHPArkitect Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Rule: ${infos.filter((i) => i.type === 'rule').length}\n`;
    text += `Naming: ${infos.filter((i) => i.type === 'naming').length}\n`;
    text += `Namespace: ${infos.filter((i) => i.type === 'namespace').length}\n`;
    text += `Dependency: ${infos.filter((i) => i.type === 'dependency').length}\n`;
    text += `Structure: ${infos.filter((i) => i.type === 'structure').length}\n`;
    text += `Issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpArkitectConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phparkitect_config',
      description: 'Analyze PHPArkitect architecture rule configuration and detect issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phparkitect_config_stats',
      description: 'Statistics for PHPArkitect configuration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
