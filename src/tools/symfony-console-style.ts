import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ConsoleStyleUsage {
  file: string;
  class?: string;
  hasSymfonyStyle: boolean;
  tableCount: number;
  progressBarCount: number;
  sectionCount: number;
  questionCount: number;
  writelnDirectCount: number;
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

function parseConsoleStyle(filePath: string, appPath: string): ConsoleStyleUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('extends Command') && !content.includes('AsCommand')) return null;
  if (content.includes('namespace Symfony\\') || content.includes('abstract class')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const hasSymfonyStyle = content.includes('SymfonyStyle');
  const tableCount = [...content.matchAll(/new\s+Table\s*\(|->table\s*\(/g)].length;
  const progressBarCount = [...content.matchAll(/new\s+ProgressBar\s*\(|->progressBar\s*\(/g)].length;
  const sectionCount = [...content.matchAll(/->section\s*\(/g)].length;
  const questionCount = [...content.matchAll(/->ask\s*\(|->confirm\s*\(|->choice\s*\(/g)].length;
  const writelnDirectCount = [...content.matchAll(/\$output->writeln\s*\(/g)].length;
  const issues: string[] = [];
  if (writelnDirectCount > 0 && hasSymfonyStyle) issues.push('$output->writeln() mixed with SymfonyStyle — use $io->writeln() consistently for uniform formatting');
  if (writelnDirectCount > 2 && !hasSymfonyStyle) issues.push('Using $output->writeln() directly — consider SymfonyStyle for consistent formatting, tables, and progress bars');
  if ((tableCount + progressBarCount + questionCount) > 0 && !hasSymfonyStyle) issues.push('Table/ProgressBar/questions used without SymfonyStyle — wrap in new SymfonyStyle($input, $output) for better DX');
  return { file: path.relative(appPath, filePath), class: classM[1], hasSymfonyStyle, tableCount, progressBarCount, sectionCount, questionCount, writelnDirectCount, issues };
}

export function listConsoleStyleUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: ConsoleStyleUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseConsoleStyle(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No Command classes found.' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Console Style Usage\n${'='.repeat(55)}\n\nCommands: ${usages.length}  Using SymfonyStyle: ${usages.filter((u) => u.hasSymfonyStyle).length}  Issues: ${totalIssues}\n`;
    for (const u of usages.filter((x) => x.issues.length > 0 || x.tableCount + x.progressBarCount > 0)) {
      const tools = [u.tableCount > 0 ? `table:${u.tableCount}` : '', u.progressBarCount > 0 ? `progress:${u.progressBarCount}` : '', u.sectionCount > 0 ? `section:${u.sectionCount}` : '', u.questionCount > 0 ? `questions:${u.questionCount}` : ''].filter(Boolean).join('  ');
      text += `\n  ${u.class}  ${u.hasSymfonyStyle ? '✓ SymfonyStyle' : '⚠ no SymfonyStyle'}  ${tools}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getConsoleStyleStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: ConsoleStyleUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseConsoleStyle(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `Console Style Statistics\n${'='.repeat(40)}\n\n`;
    text += `Commands: ${usages.length}\n  With SymfonyStyle: ${usages.filter((u) => u.hasSymfonyStyle).length}\n  With Table: ${usages.filter((u) => u.tableCount > 0).length}\n  With ProgressBar: ${usages.filter((u) => u.progressBarCount > 0).length}\n  With questions: ${usages.filter((u) => u.questionCount > 0).length}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getConsoleStyleTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_console_style_usage', description: 'Show console command I/O style: SymfonyStyle adoption, Table/ProgressBar/section/question usage, $output->writeln() mixed with SymfonyStyle warning, direct writeln without SymfonyStyle warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_console_style_stats', description: 'Show console style statistics: command count, SymfonyStyle adoption, Table/ProgressBar/question counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
