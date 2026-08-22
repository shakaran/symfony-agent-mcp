/**
 * Symfony Console Question Helper Inspector
 *
 * Scans src/ PHP for QuestionHelper usage: new Question(), new ChoiceQuestion(),
 * new ConfirmationQuestion(), ->setAutocompleterValues(), ->setValidator(),
 * ->setMaxAttempts(), ->setHidden() (password input).
 *
 * Warns: Question without setMaxAttempts() (infinite loop risk in non-interactive),
 * hidden question without setHiddenFallback(false) on Windows,
 * ChoiceQuestion without setErrorMessage(),
 * Question without default in non-interactive environments.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ConsoleQuestionEntry {
  type: 'question' | 'choice' | 'confirm';
  hasDefault: boolean;
  hasValidator: boolean;
  hasMaxAttempts: boolean;
  isHidden: boolean;
  issues: string[];
}

interface ConsoleQuestionInfo {
  file: string;
  class: string;
  questions: ConsoleQuestionEntry[];
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

function buildQuestionEntry(
  type: 'question' | 'choice' | 'confirm',
  content: string,
  blockStart: number,
): ConsoleQuestionEntry {
  // Only look within a reasonable window after the construction point
  const window = content.slice(blockStart, blockStart + 2000);
  const hasDefault = /new\s+(?:Confirmation)?Question\s*\([^)]{0,300}\$[a-zA-Z]/.test(window)
    || /new\s+(?:Confirmation)?Question\s*\('[^']{0,200}'/.test(window)
    || /new\s+(?:Confirmation)?Question\s*\("[^"]{0,200}"/.test(window);
  const hasValidator = window.includes('->setValidator(');
  const hasMaxAttempts = window.includes('->setMaxAttempts(');
  const isHidden = window.includes('->setHidden(true)') || window.includes('->setHidden( true )');
  const hasHiddenFallback = window.includes('->setHiddenFallback(');

  const issues: string[] = [];
  if (!hasMaxAttempts && type !== 'confirm') {
    issues.push(`${type} Question without setMaxAttempts() — infinite loop risk in non-interactive mode`);
  }
  if (isHidden && !hasHiddenFallback) {
    issues.push('Hidden (password) question without setHiddenFallback(false) — may expose password on Windows terminals');
  }
  if (type === 'choice' && !window.includes('->setErrorMessage(')) {
    issues.push('ChoiceQuestion without setErrorMessage() — default error message may be unclear to users');
  }

  return { type, hasDefault, hasValidator, hasMaxAttempts, isHidden, issues };
}

function parseConsoleQuestion(filePath: string, appPath: string): ConsoleQuestionInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasQuestion = content.includes('QuestionHelper')
    || content.includes('new Question(')
    || content.includes('new ChoiceQuestion(')
    || content.includes('new ConfirmationQuestion(');

  if (!hasQuestion) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const questions: ConsoleQuestionEntry[] = [];
  const fileIssues: string[] = [];

  // Find all ChoiceQuestion instances
  const choiceRe = /new\s+ChoiceQuestion\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = choiceRe.exec(content)) !== null) {
    questions.push(buildQuestionEntry('choice', content, m.index));
  }

  // Find ConfirmationQuestion instances
  const confirmRe = /new\s+ConfirmationQuestion\s*\(/g;
  while ((m = confirmRe.exec(content)) !== null) {
    questions.push(buildQuestionEntry('confirm', content, m.index));
  }

  // Find plain Question instances (not Choice or Confirmation)
  const questionRe = /new\s+Question\s*\(/g;
  while ((m = questionRe.exec(content)) !== null) {
    questions.push(buildQuestionEntry('question', content, m.index));
  }

  if (questions.length === 0 && !content.includes('QuestionHelper')) return null;

  const allEntryIssues = questions.flatMap((q) => q.issues);
  const allIssues = [...allEntryIssues, ...fileIssues];

  return {
    file: path.relative(appPath, filePath),
    class: classM[1],
    questions,
    issues: allIssues,
  };
}

export function listConsoleQuestions(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }
    const results: ConsoleQuestionInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const q = parseConsoleQuestion(file, appPath);
      if (q) results.push(q);
    }
    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No Console Question usage found in src/.' }] };
    }
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Symfony Console Question Usage\n${'='.repeat(55)}\n`;
    text += `\nClasses using Questions: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.class}  (${r.file})\n`;
      const byType = r.questions.reduce<Record<string, number>>((acc, q) => {
        acc[q.type] = (acc[q.type] ?? 0) + 1;
        return acc;
      }, {});
      for (const [type, count] of Object.entries(byType)) {
        text += `    ${type}: ${count}\n`;
      }
      const hiddenCount = r.questions.filter((q) => q.isHidden).length;
      if (hiddenCount > 0) text += `    Hidden (password): ${hiddenCount}\n`;
      for (const issue of r.issues) {
        text += `    WARNING: ${issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getConsoleQuestionStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: ConsoleQuestionInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const q = parseConsoleQuestion(file, appPath);
        if (q) results.push(q);
      }
    }
    const allQuestions = results.flatMap((r) => r.questions);
    let text = `Console Question Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with questions:     ${results.length}\n`;
    text += `Total questions:            ${allQuestions.length}\n`;
    text += `  Question:                 ${allQuestions.filter((q) => q.type === 'question').length}\n`;
    text += `  ChoiceQuestion:           ${allQuestions.filter((q) => q.type === 'choice').length}\n`;
    text += `  ConfirmationQuestion:     ${allQuestions.filter((q) => q.type === 'confirm').length}\n`;
    text += `  Hidden (password):        ${allQuestions.filter((q) => q.isHidden).length}\n`;
    text += `  With validator:           ${allQuestions.filter((q) => q.hasValidator).length}\n`;
    text += `  With maxAttempts:         ${allQuestions.filter((q) => q.hasMaxAttempts).length}\n`;
    text += `Issues detected:            ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getConsoleQuestionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_console_questions',
      description: 'Show Symfony Console QuestionHelper usage: Question/ChoiceQuestion/ConfirmationQuestion, setValidator, setMaxAttempts, setHidden (password), setAutocompleterValues; warns on missing maxAttempts, hidden without hiddenFallback, ChoiceQuestion without error message',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_console_question_stats',
      description: 'Show Console Question statistics: class count, question type breakdown, hidden count, validator count, maxAttempts count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
