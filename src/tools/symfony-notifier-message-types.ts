import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface NotifierMessageUsage {
  file: string;
  class?: string;
  chatMessages: number;
  smsMessages: number;
  pushMessages: number;
  emailMessages: number;
  hasSubject: boolean;
  hasContent: boolean;
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

function parseNotifierMessages(filePath: string, appPath: string): NotifierMessageUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const chatMessages = [...content.matchAll(/new\s+ChatMessage\s*\(/g)].length;
  const smsMessages = [...content.matchAll(/new\s+SmsMessage\s*\(/g)].length;
  const pushMessages = [...content.matchAll(/new\s+PushMessage\s*\(/g)].length;
  const emailMessages = [...content.matchAll(/new\s+EmailMessage\s*\(/g)].length;
  if (chatMessages + smsMessages + pushMessages + emailMessages === 0) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const hasSubject = content.includes('->subject(') || content.includes('subject:');
  const hasContent = content.includes('->content(') || content.includes('->notification(');
  const issues: string[] = [];
  if (smsMessages > 0 && content.includes('->subject(')) issues.push('SmsMessage does not support subject() — SMS is content-only; remove ->subject() call');
  if (chatMessages > 0 && !hasContent) issues.push('ChatMessage without content — message will be empty');
  return { file: path.relative(appPath, filePath), class: classM?.[1], chatMessages, smsMessages, pushMessages, emailMessages, hasSubject, hasContent, issues };
}

export function listNotifierMessageTypes(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: NotifierMessageUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseNotifierMessages(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No Notifier message types found (ChatMessage/SmsMessage/PushMessage/EmailMessage).' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Notifier Message Types\n${'='.repeat(55)}\n\nFiles: ${usages.length}  Issues: ${totalIssues}\n`;
    text += `  ChatMessage: ${usages.reduce((s, u) => s + u.chatMessages, 0)}  SmsMessage: ${usages.reduce((s, u) => s + u.smsMessages, 0)}  PushMessage: ${usages.reduce((s, u) => s + u.pushMessages, 0)}  EmailMessage: ${usages.reduce((s, u) => s + u.emailMessages, 0)}\n`;
    for (const u of usages.filter((x) => x.issues.length > 0)) {
      text += `\n  ${u.class ?? '(file)'}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNotifierMessageTypeStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: NotifierMessageUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseNotifierMessages(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `Notifier Message Type Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files: ${usages.length}\nChatMessage: ${usages.reduce((s, u) => s + u.chatMessages, 0)}\nSmsMessage: ${usages.reduce((s, u) => s + u.smsMessages, 0)}\nPushMessage: ${usages.reduce((s, u) => s + u.pushMessages, 0)}\nEmailMessage: ${usages.reduce((s, u) => s + u.emailMessages, 0)}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNotifierMessageTypeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_notifier_message_types', description: 'Show Symfony Notifier message types: ChatMessage/SmsMessage/PushMessage/EmailMessage usage counts, SmsMessage with subject() warning, ChatMessage without content warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_notifier_message_type_stats', description: 'Show notifier message type statistics: per-type counts, file count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
