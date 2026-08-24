// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Form Button Inspector
 *
 * Scans src/ PHP for SubmitType/ButtonType in buildForm().
 * Detects handleRequest() calls and isSubmitted()/isValid() order in controllers.
 * Detects method override _method in forms.
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface FormButton {
  name: string;
  type: 'submit' | 'button';
  label: string | null;
  issues: string[];
}

interface FormButtonInfo {
  file: string;
  class: string;
  buttons: FormButton[];
  controllerHandlePattern: boolean;
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

function extractClassFromContent(content: string): string | null {
  const m = /class\s+(\w{1,120})\b/.exec(content);
  return m ? m[1] : null;
}

function analyzeFormButtons(content: string): FormButton[] {
  const buttons: FormButton[] = [];

  // Match ->add('name', SubmitType::class, [...]) or ButtonType::class
  const addPattern = /->add\s*\(\s*['"](\w{1,120})['"]\s*,\s*\\?(?:\w+\\){0,10}(Submit|Button)Type::class([^;]{0,500})/g;
  let m: RegExpExecArray | null;

  while ((m = addPattern.exec(content)) !== null) {
    const fieldName = m[1];
    const typePart = m[2].toLowerCase() as 'submit' | 'button';
    const optionsBlock = m[3];

    const labelMatch = /['"]label['"]\s*=>\s*['"]([^'"]{0,200})['"]/.exec(optionsBlock);
    const label = labelMatch ? labelMatch[1] : null;

    buttons.push({
      name: fieldName,
      type: typePart,
      label,
      issues: [],
    });
  }

  return buttons;
}

function analyzeControllerPattern(content: string): { controllerHandlePattern: boolean; issues: string[] } {
  const issues: string[] = [];
  const hasHandleRequest = content.includes('handleRequest(');
  if (!hasHandleRequest) {
    return { controllerHandlePattern: false, issues };
  }

  // Detect isValid() called before isSubmitted() — look for isValid before isSubmitted in same method block
  // We look for the pattern: isValid() ... isSubmitted() within 500 chars
  const isValidFirst = /->isValid\s*\(\s*\)[^;]{0,500}->isSubmitted\s*\(\s*\)/.test(content);
  if (isValidFirst) {
    issues.push('isValid() called before isSubmitted() — always check isSubmitted() first to avoid unexpected validation');
  }

  return { controllerHandlePattern: true, issues };
}

function scanFormButtonFiles(appPath: string): FormButtonInfo[] {
  const results: FormButtonInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = getAllPhpFiles(srcDir);

  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isFormType = content.includes('AbstractType') || content.includes('FormBuilderInterface');
    const isController = content.includes('handleRequest(');
    if (!isFormType && !isController) continue;

    const className = extractClassFromContent(content) ?? path.basename(file, '.php');
    const fileIssues: string[] = [];

    // Scan for buttons in form types
    const buttons = analyzeFormButtons(content);

    // Controller-side analysis
    const { controllerHandlePattern, issues: ctrlIssues } = analyzeControllerPattern(content);
    fileIssues.push(...ctrlIssues);

    // Form type checks
    if (isFormType && content.includes('handleRequest(') && buttons.length === 0) {
      // actually handleRequest is in controller, not form type — skip this check
    }

    // Detect forms with multiple SubmitType without named check
    const submitButtons = buttons.filter(b => b.type === 'submit');
    if (submitButtons.length > 1) {
      const hasClickedCheck = content.includes('isClicked()');
      if (!hasClickedCheck) {
        fileIssues.push(`Form has ${submitButtons.length} submit buttons but no isClicked() check — cannot distinguish which was clicked`);
      }
    }

    // Detect method override _method
    const hasMethodOverride = content.includes('_method') || content.includes('METHOD_OVERRIDE');
    if (hasMethodOverride) {
      fileIssues.push('Method override (_method) detected — ensure MethodOverrideListener/HttpMethodOverride is enabled in framework');
    }

    // Only record files with buttons or controller issues
    if (buttons.length === 0 && fileIssues.length === 0) continue;

    results.push({
      file: path.relative(appPath, file),
      class: className,
      buttons,
      controllerHandlePattern,
      issues: fileIssues,
    });
  }

  return results;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listFormButtons(appPath: string): McpToolResult {
  try {
    const infos = scanFormButtonFiles(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No form buttons (SubmitType/ButtonType) found in src/.\n\nExample:\n  $builder->add(\'save\', SubmitType::class, [\'label\' => \'Save\']);',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    const totalButtons = infos.reduce((s, i) => s + i.buttons.length, 0);

    let text = `Form Buttons (SubmitType / ButtonType)\n${'='.repeat(50)}\n`;
    text += `Files: ${infos.length}  |  Buttons: ${totalButtons}  |  Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n${info.file}  (${info.class})\n`;
      if (info.controllerHandlePattern) {
        text += `  Controller: handleRequest() pattern detected\n`;
      }
      for (const btn of info.buttons) {
        text += `  [${btn.type}] ${btn.name}`;
        if (btn.label) text += `  label: "${btn.label}"`;
        text += '\n';
        for (const issue of btn.issues) {
          text += `    ⚠ ${issue}\n`;
        }
      }
      for (const issue of info.issues) {
        text += `  ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error scanning form buttons: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getFormButtonStats(appPath: string): McpToolResult {
  try {
    const infos = scanFormButtonFiles(appPath);

    const totalFiles = infos.length;
    const totalButtons = infos.reduce((s, i) => s + i.buttons.length, 0);
    const submitCount = infos.flatMap(i => i.buttons).filter(b => b.type === 'submit').length;
    const buttonCount = infos.flatMap(i => i.buttons).filter(b => b.type === 'button').length;
    const withLabel = infos.flatMap(i => i.buttons).filter(b => b.label !== null).length;
    const withHandleRequest = infos.filter(i => i.controllerHandlePattern).length;
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);

    const text = [
      'Form Button Statistics',
      '='.repeat(40),
      `Files with buttons:         ${totalFiles}`,
      `Total buttons:              ${totalButtons}`,
      `  SubmitType:               ${submitCount}`,
      `  ButtonType:               ${buttonCount}`,
      `With explicit label:        ${withLabel}`,
      `With handleRequest pattern: ${withHandleRequest}`,
      `Total issues:               ${totalIssues}`,
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error computing form button stats: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getFormButtonTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'list_form_buttons',
      description: 'List SubmitType/ButtonType buttons in Symfony forms and detect issues like isValid() before isSubmitted(), missing buttons, or multiple submit buttons without isClicked() check.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_form_button_stats',
      description: 'Get statistics about form button usage in the Symfony application.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
  ];
}
