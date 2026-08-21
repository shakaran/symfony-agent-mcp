import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FirebaseIntegrationInfo {
  file: string;
  type: 'fcm' | 'auth' | 'realtime-db' | 'firestore' | 'storage' | 'config';
  setting: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const files: string[] = [];
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return files;
  try {
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      const full = path.join(resolved, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...collectPhpFiles(full, base));
      else if (entry.isFile() && entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function maskCredential(value: string): string {
  if (!value || value.startsWith('${') || value.startsWith('%')) return value;
  return '***';
}

function buildFirebaseIntegrationInfos(appPath: string): FirebaseIntegrationInfo[] {
  const results: FirebaseIntegrationInfo[] = [];

  // Check composer.json
  const composerContent = safeRead(path.join(appPath, 'composer.json'), appPath);
  if (composerContent) {
    if (composerContent.includes('kreait/firebase-bundle')) {
      results.push({ file: 'composer.json', type: 'config', setting: 'kreait/firebase-bundle', issues: [] });
    }
    if (composerContent.includes('kreait/laravel-firebase')) {
      results.push({ file: 'composer.json', type: 'config', setting: 'kreait/laravel-firebase', issues: [] });
    }
    if (composerContent.includes('google/apiclient')) {
      results.push({ file: 'composer.json', type: 'config', setting: 'google/apiclient', issues: [] });
    }
  }

  // Scan .env* files
  const envFiles = ['.env', '.env.local', '.env.test', '.env.prod'];
  for (const fname of envFiles) {
    const content = safeRead(path.join(appPath, fname), appPath);
    if (!content) continue;

    const projectIdMatch = /FIREBASE_PROJECT_ID\s*=\s*([^\n]+)/.exec(content);
    if (projectIdMatch) {
      results.push({ file: fname, type: 'config', setting: 'FIREBASE_PROJECT_ID', issues: [] });
    }

    const credsMatch = /FIREBASE_CREDENTIALS\s*=\s*([^\n]+)/.exec(content);
    if (credsMatch) {
      const val = credsMatch[1].trim();
      const issues: string[] = [];
      // Check if it's a path that looks like an embedded JSON or service account file
      if (val.includes('{') || val.includes('.json')) {
        issues.push(`FIREBASE_CREDENTIALS in ${fname} references a file path or inline JSON — prefer GOOGLE_APPLICATION_CREDENTIALS with Cloud IAM Workload Identity; never commit service account JSON`);
      } else if (val && !val.startsWith('%') && !val.startsWith('${')) {
        issues.push(`FIREBASE_CREDENTIALS value "${maskCredential(val)}" in ${fname} — use Cloud IAM or inject via CI secrets, not committed env files`);
      }
      results.push({ file: fname, type: 'config', setting: 'FIREBASE_CREDENTIALS', issues });
    }

    const googleCredsMatch = /GOOGLE_APPLICATION_CREDENTIALS\s*=\s*([^\n]+)/.exec(content);
    if (googleCredsMatch) {
      const val = googleCredsMatch[1].trim();
      const issues: string[] = [];
      // Check if the referenced file exists relative to app
      if (val && !val.startsWith('%') && !val.startsWith('${')) {
        const credPath = path.isAbsolute(val) ? val : path.join(appPath, val);
        const credResolved = path.resolve(credPath);
        // Only check existence if within appPath
        if (credResolved.startsWith(path.resolve(appPath) + path.sep)) {
          if (!fs.existsSync(credResolved)) {
            const safePath = val.replace(/\S+\.(p12|pfx|key|crt|der|pem)$/i, '[KEY-PATH]');
            issues.push(`GOOGLE_APPLICATION_CREDENTIALS path "${safePath}" does not exist relative to app root — ensure credential file is present or use IAM Workload Identity`);
          }
        }
      }
      results.push({ file: fname, type: 'config', setting: 'GOOGLE_APPLICATION_CREDENTIALS', issues });
    }
  }

  // Check config/packages/kreait_firebase.yaml
  const kreaitConfig = safeRead(path.join(appPath, 'config', 'packages', 'kreait_firebase.yaml'), appPath);
  if (kreaitConfig) {
    const issues: string[] = [];
    if (kreaitConfig.includes('credentials:') && kreaitConfig.includes('.json')) {
      issues.push('kreait_firebase.yaml references .json credentials file — use GOOGLE_APPLICATION_CREDENTIALS env var or Cloud IAM instead of hardcoded path');
    }
    results.push({ file: 'config/packages/kreait_firebase.yaml', type: 'config', setting: 'kreait_firebase', issues });
  }

  // Scan src/**/*.php for Firebase usage
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const filePath of collectPhpFiles(srcDir, appPath)) {
      const content = safeRead(filePath, appPath);
      if (!content) continue;

      const hasFirebase = content.includes('FirebaseFactory') ||
        content.includes('->getMessaging()') ||
        content.includes('->getAuth()') ||
        content.includes('->getDatabase()') ||
        content.includes('->getFirestore()') ||
        content.includes('->getStorage()');

      if (!hasFirebase) continue;

      const relFile = path.relative(appPath, filePath);
      const issues: string[] = [];

      // Detect FCM without TTL
      if (content.includes('->getMessaging()') && !content.includes('ttl') && !content.includes('TimeToLive')) {
        issues.push(`FCM notification in ${relFile} without TTL — set message TTL to avoid stale push notifications being delivered after expiry`);
      }

      // Detect inline service account JSON
      if (/"type"\s*:\s*"service_account"/.test(content)) {
        issues.push(`Inline service account JSON detected in ${relFile} — never hardcode service account credentials; use GOOGLE_APPLICATION_CREDENTIALS env var`);
      }

      const type: FirebaseIntegrationInfo['type'] = content.includes('->getMessaging()') ? 'fcm'
        : content.includes('->getAuth()') ? 'auth'
        : content.includes('->getDatabase()') ? 'realtime-db'
        : content.includes('->getFirestore()') ? 'firestore'
        : content.includes('->getStorage()') ? 'storage'
        : 'config';

      results.push({ file: relFile, type, setting: 'php-usage', issues });
    }
  }

  return results;
}

export function listFirebaseIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildFirebaseIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Firebase integration found (kreait/firebase-bundle, google/apiclient, FIREBASE_* env vars).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Firebase Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  setting:${info.setting}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFirebaseIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildFirebaseIntegrationInfos(appPath);
    let text = `Firebase Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total patterns:   ${infos.length}\n`;
    text += `  config:         ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `  fcm:            ${infos.filter((i) => i.type === 'fcm').length}\n`;
    text += `  auth:           ${infos.filter((i) => i.type === 'auth').length}\n`;
    text += `  realtime-db:    ${infos.filter((i) => i.type === 'realtime-db').length}\n`;
    text += `  firestore:      ${infos.filter((i) => i.type === 'firestore').length}\n`;
    text += `  storage:        ${infos.filter((i) => i.type === 'storage').length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFirebaseIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_firebase_integration',
      description: 'Analyze Firebase integration: detect kreait/firebase-bundle, kreait/laravel-firebase, google/apiclient in composer.json; scan .env* for FIREBASE_PROJECT_ID/CREDENTIALS/GOOGLE_APPLICATION_CREDENTIALS; scan src/**/*.php for FirebaseFactory/getMessaging/getAuth/getDatabase; check kreait_firebase.yaml; flag credential path in .env, inline service account JSON, FCM without TTL, missing credential file; masks credential values',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_firebase_integration_stats',
      description: 'Statistics for Firebase integration: pattern counts by type (config/fcm/auth/realtime-db/firestore/storage) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
