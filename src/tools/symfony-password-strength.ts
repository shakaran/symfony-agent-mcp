/**
 * Symfony Password Strength Inspector
 *
 * Scans src/ PHP for:
 *   - #[Assert\PasswordStrength] (Symfony 6.3+)
 *   - PasswordStrengthValidator usage
 *   - minScore option (0-4)
 *   - NotCompromisedPassword constraint (Symfony 5.2+)
 *   - Registration/user change forms with password fields
 *
 * Warns about:
 *   - User entity with password field but no PasswordStrength constraint
 *   - PasswordStrength with minScore: 0 or 1 (effectively no restriction)
 *   - NotCompromisedPassword without try/catch (network call can fail)
 *   - Registration form without any password constraint
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface PasswordStrengthInfo {
  file: string;
  class: string;
  hasPasswordStrength: boolean;
  hasNotCompromised: boolean;
  minScore?: number;
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

function extractMinScore(content: string): number | undefined {
  const m = /minScore\s*[=:]\s*(\d)/.exec(content);
  return m ? parseInt(m[1], 10) : undefined;
}

function hasPasswordField(content: string): boolean {
  return (
    /PasswordType|PasswordField|'password'|"password"|->password\b/.test(content) &&
    !/\/\/[^\n]{0,200}password/i.test(content)
  );
}

function hasPasswordColumn(content: string): boolean {
  return (
    (content.includes('UserPasswordHasherInterface') ||
      content.includes('PasswordAuthenticatedUserInterface') ||
      content.includes('$password') ||
      /Column[^)]{0,100}password/i.test(content)) &&
    (content.includes('Entity') || content.includes('@ORM') || content.includes('#[ORM'))
  );
}

function hasTryCatch(content: string, constraintName: string): boolean {
  // Find the position of the constraint, then check if surrounded by try/catch within 400 chars
  const idx = content.indexOf(constraintName);
  if (idx === -1) return false;
  const snippet = content.slice(Math.max(0, idx - 400), idx + 200);
  return /\btry\s*\{/.test(snippet);
}

function scanPasswordStrength(appPath: string): PasswordStrengthInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: PasswordStrengthInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const hasPasswordStrength =
      content.includes('PasswordStrength') || content.includes('PasswordStrengthValidator');
    const hasNotCompromised =
      content.includes('NotCompromisedPassword') || content.includes('NotCompromisedPasswordValidator');
    const isForm = content.includes('AbstractType') || content.includes('FormBuilderInterface');
    const isEntity = hasPasswordColumn(content);

    if (!hasPasswordStrength && !hasNotCompromised && !isForm && !isEntity) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    const minScore = hasPasswordStrength ? extractMinScore(content) : undefined;
    const issues: string[] = [];

    if (hasPasswordStrength && minScore !== undefined && minScore <= 1) {
      issues.push(`PasswordStrength with minScore=${minScore} — effectively no password restriction (0=very weak, 1=weak)`);
    }
    if (hasNotCompromised && !hasTryCatch(content, 'NotCompromisedPassword')) {
      issues.push('NotCompromisedPassword constraint without try/catch — network call to HIBP API can throw on failure');
    }
    if (isEntity && hasPasswordField(content) && !hasPasswordStrength && !hasNotCompromised) {
      issues.push('User entity with password field but no PasswordStrength or NotCompromisedPassword constraint');
    }
    if (isForm && hasPasswordField(content) && !hasPasswordStrength && !hasNotCompromised) {
      const isRegistration = /register|registration|signup|sign.?up|create.*user|user.*create/i.test(content);
      if (isRegistration) {
        issues.push('Registration form with password field but no password strength constraint');
      }
    }

    if (hasPasswordStrength || hasNotCompromised || issues.length > 0) {
      results.push({ file, class: className, hasPasswordStrength, hasNotCompromised, minScore, issues });
    }
  }

  return results;
}

export function listPasswordStrength(appPath: string): McpToolResult {
  try {
    const infos = scanPasswordStrength(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PasswordStrength or NotCompromisedPassword constraints found in src/.\n\nExample:\n  #[Assert\\PasswordStrength(minScore: 2)]\n  #[Assert\\NotCompromisedPassword]',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Password Strength Constraints\n${'='.repeat(55)}\n\n`;
    text += `Total classes: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}  (${path.relative(appPath, info.file)})\n`;
      text += `    PasswordStrength: ${info.hasPasswordStrength ? 'yes' : 'no'}`;
      if (info.minScore !== undefined) text += `  minScore: ${info.minScore}`;
      text += `\n`;
      text += `    NotCompromisedPassword: ${info.hasNotCompromised ? 'yes' : 'no'}\n`;
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

export function getPasswordStrengthStats(appPath: string): McpToolResult {
  try {
    const infos = scanPasswordStrength(appPath);

    let text = `Password Strength Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes scanned:        ${infos.length}\n`;
    text += `  With PasswordStrength:      ${infos.filter((i) => i.hasPasswordStrength).length}\n`;
    text += `  With NotCompromisedPwd:     ${infos.filter((i) => i.hasNotCompromised).length}\n`;
    text += `  minScore <= 1 (weak):       ${infos.filter((i) => i.minScore !== undefined && i.minScore <= 1).length}\n`;
    text += `  minScore >= 3 (strong):     ${infos.filter((i) => i.minScore !== undefined && i.minScore >= 3).length}\n`;
    text += `Total issues:                 ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPasswordStrengthTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_password_strength',
      description: 'Scan src/ for PasswordStrength (Symfony 6.3+) and NotCompromisedPassword constraints; warns on weak minScore (0-1), missing constraints on user entities/registration forms, NotCompromisedPassword without try/catch',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_password_strength_stats',
      description: 'Statistics for password strength: class count, PasswordStrength/NotCompromisedPassword coverage, minScore distribution, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
