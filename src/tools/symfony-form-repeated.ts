/**
 * Symfony Form RepeatedType Inspector
 *
 * Scans src/ PHP for RepeatedType usage in buildForm():
 *   - type option (PasswordType, EmailType, TextType)
 *   - first_options, second_options
 *   - invalid_message option
 *
 * Also detects:
 *   - Plain password confirmation without RepeatedType (manual comparison in handler)
 *
 * Warns about:
 *   - RepeatedType without invalid_message (default message is generic)
 *   - RepeatedType with type not PasswordType when used for passwords (HTML type mismatch)
 *   - Manual password comparison without hash_equals() (timing attack)
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

interface FormRepeatedInfo {
  file: string;
  class?: string;
  fieldName: string;
  innerType: string;
  hasInvalidMessage: boolean;
  hasFirstOptions: boolean;
  hasSecondOptions: boolean;
  issues: string[];
}

interface FileRepeatedResult {
  file: string;
  class?: string;
  repeatedFields: FormRepeatedInfo[];
  hasManualPasswordComparison: boolean;
  fileIssues: string[];
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

function parseRepeatedFile(filePath: string, appPath: string): FileRepeatedResult | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isAbstractType = content.includes('extends AbstractType') || content.includes('extends BaseType');
  const hasRepeated = content.includes('RepeatedType');
  const hasManualPasswordComparison = content.includes('password_confirm') ||
    content.includes('passwordConfirm') ||
    (content.includes('password') && content.includes('===') && content.includes('confirm'));

  if (!isAbstractType && !hasManualPasswordComparison) return null;
  if (!hasRepeated && !hasManualPasswordComparison) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  const repeatedFields: FormRepeatedInfo[] = [];
  const fileIssues: string[] = [];

  // Find all ->add( calls with RepeatedType
  const addPattern = /->add\s*\(\s*['"]([^'"]{1,100})['"]\s*,\s*(?:\\?[\w\\]{1,100}::class|RepeatedType::class)\s*,\s*\[([^\]]{0,800})\]\s*\)/gs;
  let addM: RegExpExecArray | null;
  while ((addM = addPattern.exec(content)) !== null) {
    const fieldName = addM[1];
    const optionsBlock = addM[2];

    if (!optionsBlock.includes('RepeatedType') && !content.includes(`'${fieldName}'`) ) continue;
    // Must reference RepeatedType somewhere in context
    if (!content.includes('RepeatedType')) continue;

    // Extract inner type
    const typeM = /['"]type['"]\s*=>\s*([\w\\]{1,100}::class|['"][^'"]{1,100}['"])/.exec(optionsBlock);
    const innerType = typeM
      ? typeM[1].replace('::class', '').split('\\').pop() ?? typeM[1]
      : 'unknown';

    const hasInvalidMessage = optionsBlock.includes('invalid_message');
    const hasFirstOptions = optionsBlock.includes('first_options');
    const hasSecondOptions = optionsBlock.includes('second_options');

    const issues: string[] = [];
    if (!hasInvalidMessage) {
      issues.push(`RepeatedType field "${fieldName}" without invalid_message — default message is generic and not translatable`);
    }
    // Check if it's likely a password field without PasswordType
    const lc = fieldName.toLowerCase();
    const isPasswordField = lc.includes('password') || lc.includes('passwd') || lc.includes('pwd');
    if (isPasswordField && innerType !== 'PasswordType') {
      issues.push(`RepeatedType field "${fieldName}" appears to be a password but uses ${innerType} — use PasswordType to get correct HTML type="password"`);
    }

    repeatedFields.push({ file: path.relative(appPath, filePath), class: classM?.[1], fieldName, innerType, hasInvalidMessage, hasFirstOptions, hasSecondOptions, issues });
  }

  // Detect manual password comparison
  if (hasManualPasswordComparison && !hasRepeated) {
    const hasHashEquals = content.includes('hash_equals(');
    if (!hasHashEquals) {
      fileIssues.push('Manual password comparison detected without hash_equals() — vulnerable to timing attacks; use RepeatedType or hash_equals()');
    } else {
      fileIssues.push('Manual password comparison using hash_equals() — consider using RepeatedType for cleaner form handling');
    }
  }

  if (repeatedFields.length === 0 && fileIssues.length === 0) return null;

  return {
    file: path.relative(appPath, filePath),
    class: classM?.[1],
    repeatedFields,
    hasManualPasswordComparison,
    fileIssues,
  };
}

function loadRepeatedInfos(appPath: string): FileRepeatedResult[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: FileRepeatedResult[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseRepeatedFile(f, appPath);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listFormRepeated(appPath: string): McpToolResult {
  try {
    const results = loadRepeatedInfos(appPath);

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No RepeatedType or password confirmation patterns found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.fileIssues.length + r.repeatedFields.reduce((fs2, f) => fs2 + f.issues.length, 0), 0);
    let text = `Symfony Form RepeatedType Inspector (${results.length} files)\n${'='.repeat(55)}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const result of results) {
      text += `\n  ${result.file}`;
      if (result.class) text += `  [${result.class}]`;
      text += '\n';

      for (const field of result.repeatedFields) {
        text += `    field: "${field.fieldName}"  type: ${field.innerType}\n`;
        const flags = [
          field.hasInvalidMessage ? 'invalid_message' : '',
          field.hasFirstOptions ? 'first_options' : '',
          field.hasSecondOptions ? 'second_options' : '',
        ].filter(Boolean).join(', ');
        if (flags) text += `      options: [${flags}]\n`;
        for (const issue of field.issues) text += `      WARN: ${issue}\n`;
      }

      if (result.hasManualPasswordComparison) {
        text += `    manual-password-comparison: yes\n`;
      }
      for (const issue of result.fileIssues) text += `    WARN: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormRepeatedStats(appPath: string): McpToolResult {
  try {
    const results = loadRepeatedInfos(appPath);

    const allFields = results.flatMap((r) => r.repeatedFields);
    let text = `Form RepeatedType Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with RepeatedType:       ${results.filter((r) => r.repeatedFields.length > 0).length}\n`;
    text += `Total RepeatedType fields:     ${allFields.length}\n`;
    text += `  With invalid_message:        ${allFields.filter((f) => f.hasInvalidMessage).length}\n`;
    text += `  With first_options:          ${allFields.filter((f) => f.hasFirstOptions).length}\n`;
    text += `  With second_options:         ${allFields.filter((f) => f.hasSecondOptions).length}\n`;
    text += `Manual password comparisons:   ${results.filter((r) => r.hasManualPasswordComparison).length}\n`;
    const totalIssues = results.reduce((s, r) => s + r.fileIssues.length + r.repeatedFields.reduce((fs2, f) => fs2 + f.issues.length, 0), 0);
    text += `Issues:                        ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormRepeatedTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_form_repeated',
      description: 'List Symfony RepeatedType form fields: inner type, first/second_options, invalid_message; warns about missing invalid_message, wrong type for password fields, manual password comparison timing attacks',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_form_repeated_stats',
      description: 'Show RepeatedType statistics: field count, invalid_message/first_options/second_options coverage, manual password comparison count, issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
