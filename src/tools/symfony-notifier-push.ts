import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface PushNotifierInfo {
  transport: string;
  type: 'firebase' | 'onesignal' | 'expo' | 'apple' | 'generic';
  issues: string[];
}

function buildPushNotifierInfos(appPath: string): PushNotifierInfo[] {
  const results: PushNotifierInfo[] = [];

  let hasFirebase = false;
  let hasOneSignal = false;
  let hasExpo = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['symfony/firebase-notifier']) hasFirebase = true;
      if (req['symfony/one-signal-notifier']) hasOneSignal = true;
      if (req['symfony/expo-notifier']) hasExpo = true;
    } catch { /* ignore */ }
  }

  const notifierYaml = path.join(appPath, 'config', 'packages', 'notifier.yaml');
  if (fs.existsSync(notifierYaml)) {
    let content = '';
    try { content = fs.readFileSync(notifierYaml, 'utf-8'); } catch { /* skip */ }

    if (content.includes('chatter_transports:') || content.includes('push')) {
      const lines = content.split('\n');
      for (const line of lines) {
        const dsnMatch = /(firebase|onesignal|expo|apns)/.exec(line.toLowerCase());
        if (!dsnMatch) continue;

        const transportType = dsnMatch[1] as 'firebase' | 'onesignal' | 'expo' | 'apple';
        const issues: string[] = [];

        if (transportType === 'firebase') {
          const hasKey = line.includes('key') || line.includes('server_key') || line.includes('AAAA');
          if (hasKey && !line.includes('%env(')) {
            issues.push('Firebase server key hardcoded in notifier.yaml — use %env(FIREBASE_DSN)%; Firebase server keys allow sending messages to ALL your app users');
          }
          const hasTopic = content.includes('topic') || content.includes('Topic');
          if (!hasTopic) {
            issues.push('Firebase push without topic segmentation — consider using topics or condition targeting to avoid broadcasting to all devices');
          }
        }

        if (transportType === 'onesignal') {
          if (line.includes('api_key') && !line.includes('%env(')) {
            issues.push('OneSignal API key hardcoded — use %env(ONESIGNAL_DSN)%; OneSignal API keys allow sending notifications to all subscribers');
          }
        }

        if (transportType === 'expo') {
          const hasAuth = content.includes('access_token') || content.includes('EXPO_TOKEN');
          if (!hasAuth) {
            issues.push('Expo push without access token — unauthenticated Expo push has rate limits and no receipt validation; add expo.access_token');
          }
        }

        results.push({ transport: transportType, type: transportType, issues });
      }
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            if (!content.includes('PushMessage') && !content.includes('FirebaseMessage') && !content.includes('OneSignalOptions')) return;

            const relFile = path.relative(appPath, full);
            const issues: string[] = [];

            if (content.includes('setRecipientId(') && content.includes('$_') || content.includes('getUser()')) {
              const hasValidation = content.includes('filter_var') || content.includes('preg_match') || content.includes('assert(');
              if (!hasValidation) {
                issues.push(`Push notification recipient ID in "${relFile}" may use user-supplied data without validation — push token/ID injection can redirect notifications`);
              }
            }

            if (content.includes('setTitle(') || content.includes('setBody(')) {
              const hasEscape = content.includes('htmlspecialchars') || content.includes('strip_tags') || content.includes('|e');
              if (!hasEscape) {
                issues.push(`Push notification title/body in "${relFile}" without escaping — push notification content rendered in native UI; avoid HTML tags that may be partially rendered`);
              }
            }

            results.push({ transport: 'custom', type: 'generic', issues });
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  if (results.length === 0) {
    if (!hasFirebase && !hasOneSignal && !hasExpo) {
      results.push({ transport: 'none', type: 'generic', issues: ['No push notification transport installed — install: composer require symfony/firebase-notifier OR symfony/one-signal-notifier'] });
    }
  }

  return results;
}

export function listSymfonyNotifierPush(appPath: string): McpToolResult {
  try {
    const infos = buildPushNotifierInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Push Notification Analysis\n${'='.repeat(50)}\n\nTransports: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.transport}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyNotifierPushStats(appPath: string): McpToolResult {
  try {
    const infos = buildPushNotifierInfos(appPath);
    let text = `Push Notifier Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transports: ${infos.filter((i) => i.transport !== 'none').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyNotifierPushTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_notifier_push', description: 'Analyze Symfony push notification transports (Firebase FCM, OneSignal, Expo); warns on hardcoded API keys, missing Expo access token, no topic segmentation, unvalidated recipient IDs, unescaped notification content', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_notifier_push_stats', description: 'Statistics for push notifier: transport count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
