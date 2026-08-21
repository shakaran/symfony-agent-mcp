import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface FormHoneypotInfo {
  file: string;
  type: 'form-type' | 'config' | 'template';
  pattern: string;
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

function buildFormHoneypotInfos(appPath: string): FormHoneypotInfo[] {
  const results: FormHoneypotInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath); if (content === null) continue;
    if (!content.includes('AbstractType') && !content.includes('FormTypeInterface')) continue;

    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    const hasHoneypot = content.includes('HoneypotType') || content.includes('honeypot') || content.includes('trap_field');
    const hasCsrf = content.includes('csrf_protection') || content.includes('_csrf_token') || content.includes('CsrfTokenManager');
    const isPublicForm = !content.includes('IsGranted') && !content.includes('denyAccessUnlessGranted') && (content.includes('EmailType') || content.includes('TextType') || content.includes('SubmitType'));

    if (isPublicForm && !hasHoneypot) {
      issues.push(`Public form in "${relFile}" without honeypot field — add a hidden honeypot field (e.g., HoneypotType extension or a "website" field that should stay blank) to deter bots`);
    }

    if (isPublicForm && !hasCsrf) {
      issues.push(`Public form in "${relFile}" without CSRF protection — add csrf_protection: true in form options or configure it globally in framework.yaml`);
    }

    if (hasHoneypot) {
      const hasServerValidation = content.includes('if (') && (content.includes('honeypot') || content.includes('trap'));
      if (!hasServerValidation) {
        issues.push(`Form "${relFile}" has honeypot field but may not validate it server-side — ensure submitted value is checked and form rejected if filled`);
      }
      results.push({ file: relFile, type: 'form-type', pattern: 'form with honeypot', issues });
    } else if (issues.length > 0) {
      results.push({ file: relFile, type: 'form-type', pattern: 'public form without honeypot', issues });
    }
  }

  const frameworkYaml = path.join(appPath, 'config', 'packages', 'framework.yaml');
  if (fs.existsSync(frameworkYaml)) {
    let content = '';
    try { content = fs.readFileSync(frameworkYaml, 'utf-8'); } catch { /* skip */ }
    const hasCsrfGlobal = content.includes('csrf_protection:') && (content.includes('enabled: true') || content.includes('enabled:true'));
    if (!hasCsrfGlobal) {
      results.push({ file: 'config/packages/framework.yaml', type: 'config', pattern: 'CSRF protection config', issues: ['csrf_protection.enabled not set to true globally in framework.yaml — individual forms must enable CSRF protection explicitly; configure globally to protect all forms by default'] });
    }
  }

  return results;
}

export function listSymfonyFormHoneypot(appPath: string): McpToolResult {
  try {
    const infos = buildFormHoneypotInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No form honeypot or CSRF issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Form Honeypot / Anti-Spam Analysis\n${'='.repeat(55)}\n\nForms: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyFormHoneypotStats(appPath: string): McpToolResult {
  try {
    const infos = buildFormHoneypotInfos(appPath);
    let text = `Form Honeypot Statistics\n${'='.repeat(40)}\n\n`;
    text += `Forms checked:  ${infos.filter((i) => i.type === 'form-type').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyFormHoneypotTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_form_honeypot', description: 'Analyze Symfony form anti-spam measures; warns on public forms without honeypot field, missing CSRF protection, honeypot without server-side validation, global CSRF not enabled in framework.yaml', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_form_honeypot_stats', description: 'Statistics for form honeypot/CSRF: form count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
