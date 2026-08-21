/**
 * Symfony FormTypeExtension Inspector
 *
 * Distinct from symfony-form-events.ts (form events) and forms.ts (form type definitions).
 * Focuses on FormTypeExtensionInterface implementations:
 *
 * FormTypeExtensionInterface:
 *   class HelpTextExtension extends AbstractTypeExtension
 *   {
 *     public static function getExtendedTypes(): iterable
 *     {
 *       return [TextType::class, EmailType::class];
 *     }
 *
 *     public function buildForm(FormBuilderInterface $builder, array $options): void
 *     {
 *       $builder->setAttribute('help', $options['help']);
 *     }
 *
 *     public function buildView(FormView $view, FormInterface $form, array $options): void
 *     {
 *       $view->vars['help'] = $options['help'];
 *     }
 *
 *     public function configureOptions(OptionsResolver $resolver): void
 *     {
 *       $resolver->setDefined(['help']);
 *     }
 *   }
 *
 * getExtendedTypes() returning FormType::class extends ALL form types.
 *
 * Analysis:
 *   - Extension without getExtendedTypes() (required since Symfony 4.2 deprecation)
 *   - getExtendedTypes() returning empty array
 *   - Extension on FormType::class (affects ALL forms — broad blast radius)
 *   - configureOptions() without calling $resolver->setDefined or $resolver->setOptional
 *     (option declared but not accessible in templates)
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

interface FormTypeExtension {
  class: string;
  file: string;
  extendedTypes: string[];
  extendsAllForms: boolean;
  hasBuildForm: boolean;
  hasBuildView: boolean;
  hasFinishView: boolean;
  hasConfigureOptions: boolean;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseTypeExtension(filePath: string, appPath: string): FormTypeExtension | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isExtension = content.includes('AbstractTypeExtension') ||
                      content.includes('FormTypeExtensionInterface') ||
                      content.includes('getExtendedTypes');
  if (!isExtension) return null;
  if (content.includes('namespace Symfony\\') || content.includes('abstract class')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const hasGetExtendedTypes = content.includes('function getExtendedTypes');

  const extendedTypes: string[] = [];
  if (hasGetExtendedTypes) {
    const getTypesM = /getExtendedTypes[^{]*\{([\s\S]{0,500})/.exec(content);
    if (getTypesM) {
      for (const m of getTypesM[1].matchAll(/([A-Za-z0-9_]+)::class/g)) {
        extendedTypes.push(m[1]);
      }
    }
  }

  const extendsAllForms = extendedTypes.includes('FormType');

  const hasBuildForm       = content.includes('function buildForm(');
  const hasBuildView       = content.includes('function buildView(');
  const hasFinishView      = content.includes('function finishView(');
  const hasConfigureOptions = content.includes('function configureOptions(');

  const issues: string[] = [];
  if (!hasGetExtendedTypes) {
    issues.push('FormTypeExtension without getExtendedTypes() — required since Symfony 4.2; extension will not be applied');
  }
  if (hasGetExtendedTypes && extendedTypes.length === 0) {
    issues.push('getExtendedTypes() returns empty — extension applies to no form type');
  }
  if (extendsAllForms) {
    issues.push('Extends FormType::class — applied to ALL form types; verify broad scope is intentional');
  }
  if (hasConfigureOptions) {
    const configM = /function configureOptions[^{]*\{([\s\S]{0,600})/.exec(content);
    if (configM && !configM[1].includes('setDefined') && !configM[1].includes('setOptional') &&
        !configM[1].includes('setRequired') && !configM[1].includes('setAllowedValues')) {
      issues.push('configureOptions() without defining options — options added to views may not be accessible in templates');
    }
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    extendedTypes,
    extendsAllForms,
    hasBuildForm,
    hasBuildView,
    hasFinishView,
    hasConfigureOptions,
    issues,
  };
}

export function listFormTypeExtensions(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const extensions: FormTypeExtension[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const ext = parseTypeExtension(file, appPath);
      if (ext) extensions.push(ext);
    }

    if (extensions.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No FormTypeExtension classes found.\n\nCreate with:\n  class HelpTextExtension extends AbstractTypeExtension\n  {\n    public static function getExtendedTypes(): iterable\n    {\n      return [TextType::class, EmailType::class];\n    }\n  }',
        }],
      };
    }

    const totalIssues = extensions.reduce((s, e) => s + e.issues.length, 0);

    let text = `Form Type Extensions\n${'='.repeat(55)}\n`;
    text += `\nExtensions found: ${extensions.length}  Issues: ${totalIssues}\n`;

    for (const e of extensions.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
      const types   = e.extendedTypes.length > 0 ? `extends: ${e.extendedTypes.join(', ')}` : 'no types';
      const methods = [
        e.hasBuildForm    ? 'buildForm' : '',
        e.hasBuildView    ? 'buildView' : '',
        e.hasFinishView   ? 'finishView' : '',
        e.hasConfigureOptions ? 'configureOptions' : '',
      ].filter(Boolean).join(' | ');

      text += `\n  ${e.class}  ${types}  ${methods}  (${e.file})\n`;
      for (const issue of e.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormTypeExtensionStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const extensions: FormTypeExtension[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const ext = parseTypeExtension(file, appPath);
        if (ext) extensions.push(ext);
      }
    }

    let text = `Form Type Extension Statistics\n${'='.repeat(40)}\n\n`;
    text += `Extensions:          ${extensions.length}\n`;
    text += `  Extends all forms: ${extensions.filter((e) => e.extendsAllForms).length}\n`;
    text += `  With buildForm():  ${extensions.filter((e) => e.hasBuildForm).length}\n`;
    text += `  With buildView():  ${extensions.filter((e) => e.hasBuildView).length}\n`;
    text += `  With configureOptions(): ${extensions.filter((e) => e.hasConfigureOptions).length}\n`;
    text += `Issues:              ${extensions.reduce((s, e) => s + e.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormTypeExtensionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_form_type_extensions',
      description: 'Show Symfony FormTypeExtensionInterface/AbstractTypeExtension classes: extended form types, implemented methods (buildForm/buildView/finishView/configureOptions), FormType::class (all-forms) warning, missing getExtendedTypes() warning, empty types warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_form_type_extension_stats',
      description: 'Show form type extension statistics: extension count, extends-all-forms count, method adoption counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
