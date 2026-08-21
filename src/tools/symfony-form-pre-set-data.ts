/**
 * Symfony Form PRE_SET_DATA / POST_SET_DATA Event Inspector
 *
 * Scans src/**\/*.php for Symfony FormEvent patterns:
 *   - FormEvents::PRE_SET_DATA listener adding fields based on $event->getData() without null check
 *   - FormEvents::POST_SET_DATA used to ADD fields (should use PRE_SET_DATA for add)
 *   - FormEvents::PRE_SUBMIT vs FormEvents::SUBMIT misuse for data transformation
 *   - Circular dependency: event listener fetching entity from repository by ID from form data (N+1 risk)
 *   - Missing $builder->addEventListener(FormEvents::PRE_SET_DATA, ...) in a type that uses dynamic fields
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FormPreSetDataInfo {
  file: string;
  line: number;
  pattern: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isFormType(content: string): boolean {
  return /extends\s+AbstractType|implements\s+FormTypeInterface/.test(content);
}

function hasDynamicFields(content: string): boolean {
  // Heuristic: form type conditionally adds fields using if/switch on entity data
  return /\$event\s*->\s*getData\s*\(|getData\s*\(\s*\)\s*->/.test(content);
}

// ─── File analysis ─────────────────────────────────────────────────────────────

function analyzeFile(filePath: string, base: string): FormPreSetDataInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  // Only analyze form types and event subscribers/listeners
  const isRelevant = isFormType(content) ||
    /FormEvents::|PRE_SET_DATA|POST_SET_DATA|PRE_SUBMIT|SUBMIT\b/.test(content);
  if (!isRelevant) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: FormPreSetDataInfo[] = [];

  let inPreSetDataListener = false;
  let inPostSetDataListener = false;
  let inPreSubmitListener = false;
  let inSubmitListener = false;
  let listenerDepth = 0;
  let listenerStartLine = 0;
  let dataGetCallSeen = false;
  let nullCheckSeen = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // Detect addEventListener calls
    if (/addEventListener\s*\(/.test(line)) {
      const isPreSetData = /PRE_SET_DATA/.test(line);
      const isPostSetData = /POST_SET_DATA/.test(line);
      const isPreSubmit = /PRE_SUBMIT/.test(line);
      const isSubmit = /\bSUBMIT\b/.test(line) && !/PRE_SUBMIT/.test(line);

      if (isPreSetData) {
        inPreSetDataListener = true;
        listenerDepth = 0;
        listenerStartLine = lineNum;
        dataGetCallSeen = false;
        nullCheckSeen = false;
      }
      if (isPostSetData) {
        inPostSetDataListener = true;
        listenerStartLine = lineNum;
      }
      if (isPreSubmit) {
        inPreSubmitListener = true;
        listenerStartLine = lineNum;
      }
      if (isSubmit) {
        inSubmitListener = true;
        listenerStartLine = lineNum;
      }
    }

    // Track brace depth inside listeners
    if (inPreSetDataListener || inPostSetDataListener || inPreSubmitListener || inSubmitListener) {
      for (const ch of line) {
        if (ch === '{') listenerDepth++;
        else if (ch === '}') listenerDepth--;
      }
    }

    // Pattern 1: PRE_SET_DATA listener adding fields without null check on getData()
    if (inPreSetDataListener) {
      if (/->getData\s*\(\)/.test(line)) {
        dataGetCallSeen = true;
      }
      if (/=== null|!== null|null !==|null ===|is_null\s*\(|isset\s*\(/.test(line)) {
        nullCheckSeen = true;
      }
      if (/->add\s*\(/.test(line) && dataGetCallSeen && !nullCheckSeen) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'pre-set-data-no-null-check',
          issue: 'FormEvents::PRE_SET_DATA listener calls $form->add() using $event->getData() without null check — getData() returns null for a new (unbound) form; add: if ($data === null) { return; } before accessing data properties',
          severity: 'high',
        });
      }
      // Close listener detection when depth returns to <= 0
      if (listenerDepth <= 0 && listenerStartLine > 0 && lineNum > listenerStartLine) {
        inPreSetDataListener = false;
      }
    }

    // Pattern 2: POST_SET_DATA used to add fields
    if (inPostSetDataListener) {
      if (/\$form\s*->\s*add\s*\(/.test(line) || /\$builder\s*->\s*add\s*\(/.test(line)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'post-set-data-adds-fields',
          issue: 'FormEvents::POST_SET_DATA listener adds form fields — POST_SET_DATA fires after the form is built and views are created; adding fields here is too late and fields may not render correctly. Use PRE_SET_DATA to add dynamic fields',
          severity: 'high',
        });
      }
      if (listenerDepth <= 0 && listenerStartLine > 0 && lineNum > listenerStartLine) {
        inPostSetDataListener = false;
      }
    }

    // Pattern 3: PRE_SUBMIT used for data transformation (should use SUBMIT)
    if (inPreSubmitListener) {
      const hasDataTransform = /setData\s*\(|->set\s*\(|array_map\s*\(|array_filter\s*\(|strtotime|DateTime/.test(line);
      if (hasDataTransform && !(/addError\s*\(|clearErrors\s*\(/.test(line))) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'pre-submit-data-transform',
          issue: 'FormEvents::PRE_SUBMIT listener appears to transform data — PRE_SUBMIT data is raw HTTP submission data (strings/arrays); use FormEvents::SUBMIT for transforming data after DataTransformers have run and the form model is populated',
          severity: 'medium',
        });
      }
      if (listenerDepth <= 0 && listenerStartLine > 0 && lineNum > listenerStartLine) {
        inPreSubmitListener = false;
      }
    }

    // Pattern 4: SUBMIT listener doing repository fetch by form data ID (N+1)
    if (inSubmitListener) {
      const hasRepoFetch = /->find\s*\(|->findOne|->findBy\s*\(|->getRepository/.test(line);
      const hasFormDataId = /->getData\s*\(\)\s*->\s*getId|->get\s*\(\s*['"]id['"]/.test(line);
      if (hasRepoFetch && hasFormDataId) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'submit-repository-n-plus-1',
          issue: 'FormEvents::SUBMIT listener fetches entity from repository using form data ID — this is an N+1 query pattern inside the form submission event; inject the entity via the form options instead of re-fetching it',
          severity: 'medium',
        });
      }
      if (listenerDepth <= 0 && listenerStartLine > 0 && lineNum > listenerStartLine) {
        inSubmitListener = false;
      }
    }

    // Pattern 5: Form type with dynamic fields but no PRE_SET_DATA listener in buildForm
    if (/function\s+buildForm\s*\(/.test(line) && isFormType(content)) {
      if (hasDynamicFields(content) && !content.includes('PRE_SET_DATA')) {
        const lookahead = lines.slice(i, i + 30).join('\n');
        if (/if\s*\(|switch\s*\(/.test(lookahead) && /->add\s*\(/.test(lookahead)) {
          results.push({
            file: relFile,
            line: lineNum,
            pattern: 'dynamic-fields-no-pre-set-data',
            issue: 'buildForm() contains conditional field addition but no FormEvents::PRE_SET_DATA addEventListener — for dynamic fields based on entity data, wrap in a PRE_SET_DATA event to ensure $event->getData() is populated',
            severity: 'low',
          });
        }
      }
    }
  }

  return results;
}

function loadAll(appPath: string): FormPreSetDataInfo[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);
  const results: FormPreSetDataInfo[] = [];
  for (const f of files) results.push(...analyzeFile(f, appPath));
  return results.sort((a, b) => {
    const sev: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3) || a.file.localeCompare(b.file) || a.line - b.line;
  });
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listSymfonyFormPreSetData(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);
    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony Form event issues found in src/.\n\n' +
            'Checked: PRE_SET_DATA getData() without null check, POST_SET_DATA adding fields, ' +
            'PRE_SUBMIT used for data transformation, SUBMIT with N+1 repository fetch, ' +
            'dynamic fields without PRE_SET_DATA event listener.',
        }],
      };
    }

    const high = items.filter((i) => i.severity === 'high');
    const medium = items.filter((i) => i.severity === 'medium');
    const low = items.filter((i) => i.severity === 'low');

    let text = `Symfony Form PRE_SET_DATA Event Analysis\n${'='.repeat(55)}\n\n`;
    text += `  Total findings:  ${items.length}\n`;
    text += `  High:            ${high.length}\n`;
    text += `  Medium:          ${medium.length}\n`;
    text += `  Low:             ${low.length}\n`;
    text += `  Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;

    for (const item of items) {
      text += `[${item.severity.toUpperCase()}] ${item.file}:${item.line}  [${item.pattern}]\n`;
      text += `  ${item.issue}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyFormPreSetDataStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    const byPattern: Record<string, number> = {};
    for (const item of items) {
      byPattern[item.pattern] = (byPattern[item.pattern] ?? 0) + 1;
    }

    let text = `Symfony Form PRE_SET_DATA Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total:           ${items.length}\n`;
    text += `High:            ${items.filter((i) => i.severity === 'high').length}\n`;
    text += `Medium:          ${items.filter((i) => i.severity === 'medium').length}\n`;
    text += `Low:             ${items.filter((i) => i.severity === 'low').length}\n`;
    text += `Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;
    text += `By pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) {
      text += `  ${pat}: ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function getSymfonyFormPreSetDataTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_form_pre_set_data',
      description: 'Scan src/**/*.php for Symfony Form event misuse: PRE_SET_DATA getData() without null check (form crash on new entity), POST_SET_DATA adding fields (too late), PRE_SUBMIT vs SUBMIT for data transformation, SUBMIT listener with N+1 repository fetch, dynamic fields without PRE_SET_DATA',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_form_pre_set_data_stats',
      description: 'Statistics for Symfony Form PRE_SET_DATA event findings: total count, breakdown by severity (high/medium/low) and pattern, files affected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
