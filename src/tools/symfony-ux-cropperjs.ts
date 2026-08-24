// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony UX CropperJS Inspector
 *
 * Checks composer.json for symfony/ux-cropperjs.
 * Scans src/ PHP for CropperField form type and crop result handling.
 * Scans Twig templates for form_row with cropper type, cropper_image().
 *
 * Warnings:
 *   - CropperField without output format specified (default PNG may be large)
 *   - Crop result stored directly in entity string property without validation
 *   - CropperField on form without enctype="multipart/form-data"
 *   - No max file size configured for crop source image (memory exhaustion)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CropperFormType {
  file: string;
  class: string;
  fieldName: string;
  hasFormat: boolean;
  issues: string[];
}

interface UxCropperJsInfo {
  hasUxCropper: boolean;
  formTypes: CropperFormType[];
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

function getTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getTwigFiles(full));
      else if (e.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function checkComposerForUxCropper(appPath: string): boolean {
  try {
    const content = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8');
    return content.includes('symfony/ux-cropperjs');
  } catch { return false; }
}

function parseCropperFile(filePath: string): CropperFormType | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasCropper = content.includes('CropperField') ||
    content.includes('CroppedField') ||
    content.includes('croppedImage()') ||
    content.includes('getCroppedField()');

  if (!hasCropper) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  // Find field name
  let fieldName = 'unknown';
  const fieldNameM = /->add\s*\(\s*['"](\w{1,80})['"][^)]{0,200}CropperField/s.exec(content);
  if (fieldNameM) fieldName = fieldNameM[1];

  // Check if output format is specified
  const hasFormat = content.includes("'format'") ||
    content.includes('"format"') ||
    content.includes("'jpeg'") ||
    content.includes("'webp'") ||
    content.includes("'png'");

  const issues: string[] = [];

  // Warning: no output format (defaults to PNG)
  if (!hasFormat) {
    issues.push('CropperField without output format specified — defaults to PNG which may produce large files; consider jpeg/webp');
  }

  // Warning: crop result stored in string property without validation
  const storesString = content.includes('string $') && content.includes('croppedImage');
  const hasValidation = content.includes('Assert\\') || content.includes('#[Assert') ||
    content.includes('getSize(') || content.includes('getMimeType(') ||
    content.includes('maxSize') || content.includes('mimeTypes');
  if (storesString && !hasValidation) {
    issues.push('Crop result stored in entity string property without file size/type validation — risk of storing invalid or oversized data');
  }

  // Warning: no max file size
  const hasMaxSize = content.includes('maxSize') ||
    content.includes('max_size') ||
    content.includes('File::MAX_SIZE') ||
    content.includes("'maxSize'");
  if (!hasMaxSize) {
    issues.push('No max file size configured for CropperField source image — large uploads may cause memory exhaustion');
  }

  return {
    file: path.basename(filePath),
    class: classM[1],
    fieldName,
    hasFormat,
    issues,
  };
}

function checkTwigForEnctype(appPath: string): { missingEnctype: string[] } {
  const missingEnctype: string[] = [];
  const templateDirs = [
    path.join(appPath, 'templates'),
    path.join(appPath, 'src'),
  ];

  for (const dir of templateDirs) {
    for (const f of getTwigFiles(dir)) {
      try {
        const content = fs.readFileSync(f, 'utf-8');
        const hasCropperForm = content.includes('form_row') && content.includes('cropper');
        const hasEnctype = content.includes('enctype') ||
          content.includes('multipart') ||
          content.includes('form_start(') && content.includes("'enctype'");
        if (hasCropperForm && !hasEnctype) {
          missingEnctype.push(path.basename(f));
        }
      } catch { /* skip */ }
    }
  }
  return { missingEnctype };
}

export function listUxCropperJs(appPath: string): McpToolResult {
  try {
    const hasUxCropper = checkComposerForUxCropper(appPath);
    const srcDir = path.join(appPath, 'src');
    const formTypes: CropperFormType[] = [];

    for (const f of getAllPhpFiles(srcDir)) {
      const info = parseCropperFile(f);
      if (info) formTypes.push(info);
    }

    const { missingEnctype } = checkTwigForEnctype(appPath);

    const globalIssues: string[] = [];
    if (missingEnctype.length > 0) {
      for (const f of missingEnctype) {
        globalIssues.push(`Twig form with CropperField missing enctype="multipart/form-data": ${f}`);
      }
    }

    const info: UxCropperJsInfo = {
      hasUxCropper,
      formTypes,
      issues: globalIssues,
    };

    if (!hasUxCropper && formTypes.length === 0) {
      return { content: [{ type: 'text', text: 'symfony/ux-cropperjs not installed and no CropperField usage found.' }] };
    }

    const totalIssues = formTypes.reduce((s, r) => s + r.issues.length, 0) + globalIssues.length;

    let text = `Symfony UX CropperJS Analysis\n${'='.repeat(55)}\n\n`;
    text += `symfony/ux-cropperjs installed:  ${info.hasUxCropper ? 'yes' : 'no'}\n`;
    text += `Form types with CropperField:    ${formTypes.length}\n`;
    text += `Total issues:                    ${totalIssues}\n`;

    for (const ft of formTypes) {
      text += `\n  ${ft.class.padEnd(50)} (${ft.file})\n`;
      text += `    field: ${ft.fieldName}  format: ${ft.hasFormat ? 'specified' : 'NOT specified'}\n`;
      for (const issue of ft.issues) text += `    ! ${issue}\n`;
    }

    for (const issue of globalIssues) {
      text += `\n  ! ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getUxCropperJsStats(appPath: string): McpToolResult {
  try {
    const hasUxCropper = checkComposerForUxCropper(appPath);
    const srcDir = path.join(appPath, 'src');
    const formTypes: CropperFormType[] = [];

    for (const f of getAllPhpFiles(srcDir)) {
      const info = parseCropperFile(f);
      if (info) formTypes.push(info);
    }

    const { missingEnctype } = checkTwigForEnctype(appPath);

    let text = `UX CropperJS Statistics\n${'='.repeat(40)}\n\n`;
    text += `symfony/ux-cropperjs installed:  ${hasUxCropper ? 'yes' : 'no'}\n`;
    text += `Form types with CropperField:    ${formTypes.length}\n`;
    text += `With format specified:           ${formTypes.filter((f) => f.hasFormat).length}\n`;
    text += `Without format (PNG default):    ${formTypes.filter((f) => !f.hasFormat).length}\n`;
    text += `Twig missing enctype:            ${missingEnctype.length}\n`;
    text += `Total issues:                    ${formTypes.reduce((s, r) => s + r.issues.length, 0) + missingEnctype.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getUxCropperJsTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_ux_cropper_js',
      description: 'Inspect Symfony UX CropperJS usage: CropperField form types, output format configuration, entity property validation, Twig enctype; warns on missing format (large PNG default), unvalidated crop result, missing max file size, missing multipart/form-data enctype',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_ux_cropper_js_stats',
      description: 'Get UX CropperJS statistics: installed status, form type count, format specification coverage, Twig enctype issues, total problems',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
