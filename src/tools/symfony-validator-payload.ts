import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ValidatorPayloadInfo {
  file: string;
  constraint: string;
  hasSeverity: boolean;
  hasTranslationDomain: boolean;
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

function buildValidatorPayloadInfos(appPath: string): ValidatorPayloadInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: ValidatorPayloadInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isConstraint = content.includes('extends Constraint') ||
      content.includes('implements ConstraintInterface');
    const isValidator = content.includes('extends ConstraintValidator') ||
      content.includes('ConstraintValidatorInterface');

    if (!isConstraint && !isValidator) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const constraint = classMatch ? classMatch[1] : path.basename(file, '.php');
    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    if (isConstraint) {
      const hasPayloadProp = content.includes('$payload') || content.includes('public mixed $payload');
      const usesPayload = content.includes("'payload'") || /\bpayload\b/.test(content);
      const hasSeverity = content.includes("'severity'") || content.includes('severity');
      const hasTranslationDomain = content.includes('$translationDomain') || content.includes("'translationDomain'");

      if (!hasPayloadProp && usesPayload) {
        issues.push(`Constraint "${constraint}" references payload but has no $payload property — payload metadata not persisted`);
      }
      if (hasPayloadProp) {
        const optionsMethod = content.includes('getDefaultOption') || content.includes('getRequiredOptions');
        if (!optionsMethod && !content.includes("'payload'")) {
          issues.push(`Constraint "${constraint}" has $payload property but 'payload' not included in options() array — payload not passed through`);
        }
      }

      results.push({ file: relFile, constraint, hasSeverity: !!hasSeverity, hasTranslationDomain: !!hasTranslationDomain, issues });
    }

    if (isValidator) {
      const readsPayload = content.includes('->payload') || content.includes("->options['payload']") || content.includes('$constraint->payload');
      const hasPayloadResponse = content.includes('severity') || content.includes('payload');
      if (readsPayload && !hasPayloadResponse) {
        issues.push(`Validator "${constraint}" reads payload but does not act on it — payload severity/metadata not surfaced in violation`);
      }
      if (!results.find((r) => r.file === relFile)) {
        results.push({ file: relFile, constraint, hasSeverity: false, hasTranslationDomain: false, issues });
      }
    }
  }

  return results;
}

export function listSymfonyValidatorPayloads(appPath: string): McpToolResult {
  try {
    const infos = buildValidatorPayloadInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No custom Constraint or ConstraintValidator classes found in src/.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Validator Constraint Payload Analysis\n${'='.repeat(55)}\n\nConstraints: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  ${info.constraint}  (${info.file})\n`;
      text += `    severity: ${info.hasSeverity ? 'yes' : 'no'}  translationDomain: ${info.hasTranslationDomain ? 'yes' : 'no'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyValidatorPayloadStats(appPath: string): McpToolResult {
  try {
    const infos = buildValidatorPayloadInfos(appPath);
    let text = `Validator Payload Statistics\n${'='.repeat(40)}\n\n`;
    text += `Constraints:    ${infos.length}\n`;
    text += `With severity:  ${infos.filter((i) => i.hasSeverity).length}\n`;
    text += `With i18n:      ${infos.filter((i) => i.hasTranslationDomain).length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyValidatorPayloadTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_validator_payloads', description: 'Analyze custom Symfony Constraint payload usage; warns on missing $payload property, payload not in options array, payload read but not acted on in validator', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_validator_payload_stats', description: 'Statistics for validator payloads: constraint count, severity/i18n coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
