/**
 * PHPStan Custom Rules Inspector
 *
 * Reads phpstan.neon / phpstan.neon.dist:
 *   - rules: section (custom rule classes)
 *   - stubFiles: entries
 *   - ignoreErrors: entries
 *   - bootstrapFiles:
 *
 * Scans src/ PHP for:
 *   - Classes implementing PHPStan\Rules\Rule (getNodeType, processNode)
 *   - RuleError / RuleErrorBuilder usage
 *
 * Warns about:
 *   - Custom rule class not listed in rules: config (exists but not active)
 *   - ignoreErrors entry without 'message' (matches all errors in path)
 *   - Stub file path not found on disk
 *   - processNode() that never builds a RuleError (no-op rule)
 *   - >20 ignoreErrors entries (technical debt accumulation)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpStanCustomRuleInfo {
  file: string;
  class: string;
  nodeType: string;
  isRegistered: boolean;
  hasMessage: boolean;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

interface NeonConfig {
  registeredRules: string[];
  stubFiles: string[];
  ignoreErrors: Array<{ hasMessage: boolean; raw: string }>;
  bootstrapFiles: string[];
  level?: string;
}

function parseNeonConfig(appPath: string): NeonConfig {
  const candidates = ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon'];
  for (const fname of candidates) {
    const filePath = path.join(appPath, fname);
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    // Extract rules: section — lines that look like class paths
    const registeredRules: string[] = [];
    const rulesSection = /\brules\s*:([\s\S]{0,2000}?)(?=\n\w|\nparameters|\nservices)/.exec(content);
    if (rulesSection) {
      const ruleLines = rulesSection[1].matchAll(/\s+-\s+([\w\\]{1,200})/g);
      for (const m of ruleLines) {
        registeredRules.push(m[1]);
      }
    }

    // Extract stubFiles
    const stubFiles: string[] = [];
    const stubSection = /\bstubFiles\s*:([\s\S]{0,1000}?)(?=\n\s*\w[^:]{0,80}:)/.exec(content);
    if (stubSection) {
      for (const m of stubSection[1].matchAll(/\s+-\s+([^\n]{1,200})/g)) {
        stubFiles.push(m[1].trim());
      }
    }

    // Extract bootstrapFiles
    const bootstrapFiles: string[] = [];
    const bsSection = /\bbootstrapFiles\s*:([\s\S]{0,1000}?)(?=\n\s*\w[^:]{0,80}:)/.exec(content);
    if (bsSection) {
      for (const m of bsSection[1].matchAll(/\s+-\s+([^\n]{1,200})/g)) {
        bootstrapFiles.push(m[1].trim());
      }
    }

    // Extract ignoreErrors entries — each entry may have 'message:' and/or 'path:'
    const ignoreErrors: Array<{ hasMessage: boolean; raw: string }> = [];
    const ignoreSection = /\bignoreErrors\s*:([\s\S]{0,5000}?)(?=\n\w[^:]{0,80}:)/.exec(content);
    if (ignoreSection) {
      // Each entry starts with '  -'
      const entries = ignoreSection[1].split(/\n\s+-\s+/);
      for (const entry of entries) {
        if (!entry.trim()) continue;
        const hasMessage = /\bmessage\s*:/.test(entry) || /^['"]/.test(entry.trim());
        ignoreErrors.push({ hasMessage, raw: entry.substring(0, 100) });
      }
    }

    const levelMatch = /\blevel\s*:\s*(\w{1,10})/.exec(content);

    return {
      registeredRules,
      stubFiles,
      ignoreErrors,
      bootstrapFiles,
      level: levelMatch?.[1],
    };
  }
  return { registeredRules: [], stubFiles: [], ignoreErrors: [], bootstrapFiles: [] };
}

function parseRuleClass(filePath: string): {
  className: string;
  nodeType: string;
  hasMessage: boolean;
} | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const implementsRule = content.includes('implements Rule') || content.includes('Rule<');
  if (!implementsRule) return null;
  if (!/\bclass\s+/.test(content)) return null;

  const classMatch = /class\s+(\w{1,100})/.exec(content);
  if (!classMatch) return null;

  // Extract getNodeType return value
  const nodeTypeMatch = /getNodeType\s*\([^)]{0,50}\)[^{]{0,50}\{[^}]{0,500}return\s+([\w\\:]{1,100})/.exec(content);
  const nodeType = nodeTypeMatch ? nodeTypeMatch[1] : 'unknown';

  // Check if processNode ever returns a RuleError
  const hasMessage = /RuleError|RuleErrorBuilder|RuleErrorBuilder::message/.test(content);

  return { className: classMatch[1], nodeType, hasMessage };
}

function buildRuleInfos(appPath: string): {
  rules: PhpStanCustomRuleInfo[];
  neonConfig: NeonConfig;
} {
  const neonConfig = parseNeonConfig(appPath);
  const registeredShortNames = new Set(
    neonConfig.registeredRules.map((r) => {
      const parts = r.split('\\');
      return parts[parts.length - 1] ?? r;
    })
  );

  const srcDir = path.join(appPath, 'src');
  const rules: PhpStanCustomRuleInfo[] = [];

  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      const parsed = parseRuleClass(file);
      if (!parsed) continue;

      const isRegistered =
        registeredShortNames.has(parsed.className) ||
        neonConfig.registeredRules.some((r) => r.endsWith(parsed.className));

      const issues: string[] = [];
      if (!isRegistered) {
        issues.push(`${parsed.className}: custom PHPStan rule exists in code but is not listed in rules: section — rule is inactive`);
      }
      if (!parsed.hasMessage) {
        issues.push(`${parsed.className}: processNode() never constructs a RuleError — rule may be a no-op`);
      }

      rules.push({
        file: path.basename(file),
        class: parsed.className,
        nodeType: parsed.nodeType,
        isRegistered,
        hasMessage: parsed.hasMessage,
        issues,
      });
    }
  }

  return { rules, neonConfig };
}

export function listPhpStanCustomRules(appPath: string): McpToolResult {
  try {
    const { rules, neonConfig } = buildRuleInfos(appPath);

    const configIssues: string[] = [];

    // ignoreErrors without message
    const noMessageCount = neonConfig.ignoreErrors.filter((e) => !e.hasMessage).length;
    if (noMessageCount > 0) {
      configIssues.push(`${noMessageCount} ignoreErrors entries without 'message' — may suppress all errors in matching paths`);
    }
    if (neonConfig.ignoreErrors.length > 20) {
      configIssues.push(`${neonConfig.ignoreErrors.length} ignoreErrors entries — significant technical debt accumulation`);
    }

    // Stub files not found
    for (const stub of neonConfig.stubFiles) {
      const stubPath = path.isAbsolute(stub) ? stub : path.join(appPath, stub);
      if (!fs.existsSync(stubPath)) {
        configIssues.push(`Stub file '${stub}' listed in phpstan.neon not found on disk`);
      }
    }

    // Bootstrap files not found
    for (const bs of neonConfig.bootstrapFiles) {
      const bsPath = path.isAbsolute(bs) ? bs : path.join(appPath, bs);
      if (!fs.existsSync(bsPath)) {
        configIssues.push(`Bootstrap file '${bs}' listed in phpstan.neon not found on disk`);
      }
    }

    if (rules.length === 0 && configIssues.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom PHPStan rules found in src/ and no configuration issues detected.\n\nCreate a custom PHPStan rule:\n  class MyRule implements Rule<Node\\Expr\\MethodCall>\n  {\n    public function getNodeType(): string { return MethodCall::class; }\n    public function processNode(Node $node, Scope $scope): array { ... }\n  }',
        }],
      };
    }

    let text = `PHPStan Custom Rules\n${'='.repeat(55)}\n`;

    if (neonConfig.level !== undefined) text += `\nLevel: ${neonConfig.level}\n`;
    text += `Registered rules:   ${neonConfig.registeredRules.length}\n`;
    text += `ignoreErrors count: ${neonConfig.ignoreErrors.length}\n`;

    if (configIssues.length > 0) {
      text += `\nConfiguration warnings:\n`;
      for (const issue of configIssues) {
        text += `  WARNING: ${issue}\n`;
      }
    }

    if (rules.length > 0) {
      text += `\nCustom rule classes (${rules.length}):\n`;
      for (const rule of rules) {
        const regMark = rule.isRegistered ? '[active]' : '[INACTIVE]';
        text += `\n  ${rule.class} (${rule.file}) ${regMark}\n`;
        text += `    NodeType: ${rule.nodeType}\n`;
        for (const issue of rule.issues) {
          text += `    WARNING: ${issue}\n`;
        }
      }
    }

    const totalWarnings = configIssues.length + rules.reduce((s, r) => s + r.issues.length, 0);
    if (totalWarnings === 0) {
      text += '\nNo issues detected.\n';
    } else {
      text += `\nTotal warnings: ${totalWarnings}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpStanCustomRuleStats(appPath: string): McpToolResult {
  try {
    const { rules, neonConfig } = buildRuleInfos(appPath);

    let text = `PHPStan Custom Rule Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom rule classes:        ${rules.length}\n`;
    text += `  Active (registered):      ${rules.filter((r) => r.isRegistered).length}\n`;
    text += `  Inactive (unregistered):  ${rules.filter((r) => !r.isRegistered).length}\n`;
    text += `  No-op (no RuleError):     ${rules.filter((r) => !r.hasMessage).length}\n`;
    text += `Registered in neon:         ${neonConfig.registeredRules.length}\n`;
    text += `ignoreErrors entries:       ${neonConfig.ignoreErrors.length}\n`;
    text += `  Without message:          ${neonConfig.ignoreErrors.filter((e) => !e.hasMessage).length}\n`;
    text += `Stub files:                 ${neonConfig.stubFiles.length}\n`;
    text += `Level:                      ${neonConfig.level ?? 'not set'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpStanCustomRuleTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpstan_custom_rules',
      description: 'Analyze PHPStan custom rules: parse phpstan.neon rules/stubFiles/ignoreErrors/bootstrapFiles, scan src/ for Rule implementations, detect inactive rules (not in config), no-op rules (no RuleError), missing stub/bootstrap files, excessive ignoreErrors count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpstan_custom_rule_stats',
      description: 'Statistics for PHPStan custom rules: rule class count (active/inactive/no-op), registered count, ignoreErrors count with/without message, stub file count, configured level',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
