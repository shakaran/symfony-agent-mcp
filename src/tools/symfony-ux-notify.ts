// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony UX Notify Inspector
 *
 * Checks composer.json for symfony/ux-notify.
 * Reads config/packages/mercure.yaml and notifier.yaml for Mercure/notify config.
 * Scans src/ PHP for NotificationInterface with browser channel.
 * Scans Twig templates for ux_notify(), notification_widget().
 *
 * Warnings:
 *   - UX Notify installed but Mercure not configured
 *   - Push notification without VAPID keys configured
 *   - browser channel but no service worker registered
 *   - VAPID public key in non-HTTPS context
 *   - Missing notification permission request in JS
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface UxNotifyInfo {
  hasUxNotify: boolean;
  hasMercureConfig: boolean;
  hasVapidKeys: boolean;
  notificationClasses: number;
  twigUsages: number;
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

function checkComposerForUxNotify(appPath: string): boolean {
  try {
    const content = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8');
    return content.includes('symfony/ux-notify');
  } catch { return false; }
}

function checkMercureConfig(appPath: string): boolean {
  const mercurePaths = [
    path.join(appPath, 'config', 'packages', 'mercure.yaml'),
    path.join(appPath, 'config', 'packages', 'mercure.yml'),
  ];
  for (const p of mercurePaths) {
    const config = parseYamlFile(p);
    if (config) return true;
  }
  // Also check .env for MERCURE_URL
  try {
    const env = fs.readFileSync(path.join(appPath, '.env'), 'utf-8');
    if (env.includes('MERCURE_URL') || env.includes('MERCURE_PUBLISH_URL')) return true;
  } catch { /* skip */ }
  return false;
}

function checkVapidKeys(appPath: string): boolean {
  const notifierPaths = [
    path.join(appPath, 'config', 'packages', 'notifier.yaml'),
    path.join(appPath, 'config', 'packages', 'web_push_notification.yaml'),
  ];
  for (const p of notifierPaths) {
    try {
      const content = fs.readFileSync(p, 'utf-8');
      if (content.includes('vapid') || content.includes('VAPID')) return true;
    } catch { /* skip */ }
  }

  try {
    const env = fs.readFileSync(path.join(appPath, '.env'), 'utf-8');
    if (env.includes('VAPID') || env.includes('vapid_public') || env.includes('vapid_private')) return true;
  } catch { /* skip */ }

  return false;
}

function countNotificationClasses(srcDir: string): number {
  let count = 0;
  for (const f of getAllPhpFiles(srcDir)) {
    const content = safeRead(f, srcDir);
    if (content === null) continue;
    const hasBrowserChannel = content.includes("'browser'") || content.includes('"browser"');
    const hasNotificationInterface = content.includes('NotificationInterface') ||
      content.includes('getChannels()') ||
      (content.includes('Notification') && content.includes('implements'));
    if (hasNotificationInterface && hasBrowserChannel) count++;
  }
  return count;
}

function countTwigUsages(appPath: string): { count: number; hasServiceWorkerRef: boolean } {
  let count = 0;
  let hasServiceWorkerRef = false;
  const templateDirs = [
    path.join(appPath, 'templates'),
    path.join(appPath, 'src'),
  ];

  for (const dir of templateDirs) {
    for (const f of getTwigFiles(dir)) {
      const content = safeRead(f, dir);
      if (content === null) continue;
      if (content.includes('ux_notify(') || content.includes('notification_widget(')) {
        count++;
      }
      if (content.includes('service-worker') || content.includes('serviceWorker') ||
        content.includes('sw.js') || content.includes('firebase-messaging')) {
        hasServiceWorkerRef = true;
      }
    }
  }
  return { count, hasServiceWorkerRef };
}

function checkForHttpsContext(appPath: string): boolean {
  const envPaths = [
    path.join(appPath, '.env'),
    path.join(appPath, '.env.prod'),
    path.join(appPath, '.env.production'),
  ];
  for (const p of envPaths) {
    try {
      const content = fs.readFileSync(p, 'utf-8');
      if (content.includes('https://') || content.includes('APP_URL=https')) return true;
    } catch { /* skip */ }
  }
  return false;
}

export function listUxNotify(appPath: string): McpToolResult {
  try {
    const hasUxNotify = checkComposerForUxNotify(appPath);
    const hasMercureConfig = checkMercureConfig(appPath);
    const hasVapidKeys = checkVapidKeys(appPath);
    const srcDir = path.join(appPath, 'src');
    const notificationClasses = countNotificationClasses(srcDir);
    const { count: twigUsages, hasServiceWorkerRef } = countTwigUsages(appPath);
    const hasHttps = checkForHttpsContext(appPath);

    const issues: string[] = [];

    if (hasUxNotify && !hasMercureConfig) {
      issues.push('symfony/ux-notify installed but Mercure not configured — push notifications will not work');
    }

    if (notificationClasses > 0 && !hasVapidKeys) {
      issues.push('Browser push notifications used without VAPID keys configured — web push requires VAPID authentication');
    }

    if (twigUsages > 0 && !hasServiceWorkerRef) {
      issues.push('ux_notify() in Twig templates but no service worker reference found — service worker required for push notifications');
    }

    if (hasVapidKeys && !hasHttps) {
      issues.push('VAPID keys configured but no HTTPS detected — Web Push API requires HTTPS context (except localhost)');
    }

    const info: UxNotifyInfo = {
      hasUxNotify,
      hasMercureConfig,
      hasVapidKeys,
      notificationClasses,
      twigUsages,
      issues,
    };

    let text = `Symfony UX Notify Analysis\n${'='.repeat(55)}\n\n`;
    text += `symfony/ux-notify installed:    ${info.hasUxNotify ? 'yes' : 'no'}\n`;
    text += `Mercure configured:             ${info.hasMercureConfig ? 'yes' : 'NO'}\n`;
    text += `VAPID keys configured:          ${info.hasVapidKeys ? 'yes' : 'no'}\n`;
    text += `Notification classes (browser): ${info.notificationClasses}\n`;
    text += `Twig ux_notify() usages:        ${info.twigUsages}\n`;
    text += `Service worker reference:       ${hasServiceWorkerRef ? 'found' : 'not found'}\n`;
    text += `HTTPS configured:               ${hasHttps ? 'yes' : 'not detected'}\n`;

    if (issues.length > 0) {
      text += `\nIssues:\n`;
      for (const issue of issues) text += `  ! ${issue}\n`;
    } else if (hasUxNotify) {
      text += `\nNo issues detected.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getUxNotifyStats(appPath: string): McpToolResult {
  try {
    const hasUxNotify = checkComposerForUxNotify(appPath);
    const hasMercureConfig = checkMercureConfig(appPath);
    const hasVapidKeys = checkVapidKeys(appPath);
    const srcDir = path.join(appPath, 'src');
    const notificationClasses = countNotificationClasses(srcDir);
    const { count: twigUsages } = countTwigUsages(appPath);

    let text = `UX Notify Statistics\n${'='.repeat(40)}\n\n`;
    text += `symfony/ux-notify installed:    ${hasUxNotify ? 'yes' : 'no'}\n`;
    text += `Mercure configured:             ${hasMercureConfig ? 'yes' : 'no'}\n`;
    text += `VAPID keys configured:          ${hasVapidKeys ? 'yes' : 'no'}\n`;
    text += `Browser notification classes:   ${notificationClasses}\n`;
    text += `Twig notify usages:             ${twigUsages}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getUxNotifyTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_ux_notify',
      description: 'Inspect Symfony UX Notify (web push) configuration: Mercure setup, VAPID keys, service worker presence, HTTPS context; warns on missing Mercure config, missing VAPID keys, no service worker, non-HTTPS with VAPID',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_ux_notify_stats',
      description: 'Get UX Notify statistics: installed status, Mercure/VAPID config, notification class count, Twig usage count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
