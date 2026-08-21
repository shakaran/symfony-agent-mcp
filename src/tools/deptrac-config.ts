import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DeptracConfigInfo {
  source: string;
  type: 'layer' | 'ruleset' | 'collector' | 'baseline' | 'violation';
  pattern: string;
  issues: string[];
}

function buildDeptracConfigInfos(appPath: string): DeptracConfigInfo[] {
  const results: DeptracConfigInfo[] = [];

  // Check for deptrac config files
  const configFiles = ['deptrac.yaml', 'deptrac.yml', 'depfile.yaml'];
  let configFound = false;
  let configContent = '';
  let configFile = '';

  for (const fname of configFiles) {
    const fpath = path.join(appPath, fname);
    if (fs.existsSync(fpath)) {
      configFound = true;
      configContent = fs.readFileSync(fpath, 'utf8');
      configFile = fname;
      break;
    }
  }

  if (!configFound) {
    results.push({
      source: 'deptrac.yaml',
      type: 'violation',
      pattern: 'missing-config',
      issues: [
        'No Deptrac configuration found — install qossmic/deptrac and create deptrac.yaml to enforce architecture layer boundaries',
      ],
    });
  } else {
    // Parse layers section
    const layerMatches = configContent.match(/^\s{2,4}name:\s+(.+)$/gm);
    if (layerMatches) {
      for (const match of layerMatches) {
        const layerName = match.replace(/^\s+name:\s+/, '').trim();
        results.push({
          source: configFile,
          type: 'layer',
          pattern: `layer:${layerName}`,
          issues: [],
        });
      }
    }

    // Parse ruleset section
    const hasRuleset = /^ruleset:/m.test(configContent);
    if (!hasRuleset) {
      results.push({
        source: configFile,
        type: 'ruleset',
        pattern: 'missing-ruleset',
        issues: [
          'Deptrac configuration without ruleset — define allowed dependencies between layers in the ruleset section',
        ],
      });
    } else {
      // Check for Domain depending on Infrastructure
      const rulesetSection = configContent.match(/^ruleset:([\s\S]*?)^[a-z]/m);
      const rulesetContent = rulesetSection ? rulesetSection[1] : '';
      if (/Domain[\s\S]{0,100}Infrastructure/.test(rulesetContent)) {
        results.push({
          source: configFile,
          type: 'ruleset',
          pattern: 'domain-depends-on-infrastructure',
          issues: [
            'Ruleset allows Domain to depend on Infrastructure — this violates clean architecture; Domain should only depend on itself',
          ],
        });
      } else {
        results.push({
          source: configFile,
          type: 'ruleset',
          pattern: 'ruleset-defined',
          issues: [],
        });
      }
    }

    // Check for collector patterns
    const collectorMatches = configContent.match(/type:\s+(className|directory|layer|bool|glob)/g);
    if (collectorMatches) {
      for (const match of collectorMatches) {
        results.push({
          source: configFile,
          type: 'collector',
          pattern: match.trim(),
          issues: [],
        });
      }
    }
  }

  // Check for baseline file
  const baselinePath = path.join(appPath, '.deptrac.baseline.yaml');
  if (fs.existsSync(baselinePath)) {
    results.push({
      source: '.deptrac.baseline.yaml',
      type: 'baseline',
      pattern: 'baseline-file',
      issues: [
        'Deptrac baseline file detected — baseline suppresses existing violations; review and resolve baseline violations gradually rather than adding new ones',
      ],
    });
  }

  // Check composer.json for qossmic/deptrac
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    const composerContent = fs.readFileSync(composerPath, 'utf8');
    if (!composerContent.includes('qossmic/deptrac')) {
      results.push({
        source: 'composer.json',
        type: 'violation',
        pattern: 'missing-dependency',
        issues: ['Deptrac not installed — add with: composer require --dev qossmic/deptrac'],
      });
    }
  }

  return results;
}

export function listDeptracConfig(appPath: string): McpToolResult {
  try {
    const infos = buildDeptracConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Deptrac configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Deptrac Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
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

export function getDeptracConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildDeptracConfigInfos(appPath);
    let text = `Deptrac Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Layer: ${infos.filter((i) => i.type === 'layer').length}\n`;
    text += `Ruleset: ${infos.filter((i) => i.type === 'ruleset').length}\n`;
    text += `Collector: ${infos.filter((i) => i.type === 'collector').length}\n`;
    text += `Baseline: ${infos.filter((i) => i.type === 'baseline').length}\n`;
    text += `Violation: ${infos.filter((i) => i.type === 'violation').length}\n`;
    text += `Issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDeptracConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_deptrac_config',
      description: 'Analyze Deptrac architecture layer configuration and detect issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_deptrac_config_stats',
      description: 'Statistics for Deptrac configuration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
