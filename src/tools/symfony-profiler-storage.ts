// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Profiler Storage Inspector
 *
 * Reads framework.yaml web_profiler and profiler sections:
 *   - dsn, enabled, collect, only_exceptions, only_main_requests
 *   - DSN type: file://, redis://, elasticsearch://, mongodb://
 *   - Checks prod environment profiler config
 *
 * Warns: profiler enabled in production, file profiler in /tmp,
 * no DSN configured, collect without only_main_requests,
 * redis profiler without expiry.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface ProfilerStorageInfo {
  dsn: string;
  dsnType: string;
  enabled: boolean;
  collect: boolean;
  onlyExceptions: boolean;
  onlyMainRequests: boolean;
  isProductionEnabled: boolean;
  issues: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function classifyDsn(dsn: string): string {
  if (!dsn) return 'default (file)';
  if (dsn.startsWith('file://')) return 'file';
  if (dsn.startsWith('redis://') || dsn.startsWith('rediss://')) return 'redis';
  if (dsn.startsWith('elasticsearch://') || dsn.startsWith('es://')) return 'elasticsearch';
  if (dsn.startsWith('mongodb://')) return 'mongodb';
  return 'custom';
}

function readProfilerSection(appPath: string): { dsn: string; enabled: boolean; collect: boolean; onlyExceptions: boolean; onlyMainRequests: boolean } {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'web_profiler.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'web_profiler.yaml'),
  ];

  let dsn = '';
  let enabled = false;
  let collect = false;
  let onlyExceptions = false;
  let onlyMainRequests = false;

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    // web_profiler key
    const wp = raw['web_profiler'] as Record<string, unknown> | undefined;
    if (wp) {
      if (typeof wp['toolbar'] === 'boolean') enabled = wp['toolbar'] as boolean;
      if (typeof wp['intercept_redirects'] === 'boolean') { /* informational */ }
    }

    // framework.profiler key
    const fw = raw['framework'] as Record<string, unknown> | undefined;
    const profiler = (fw?.['profiler'] ?? raw['profiler']) as Record<string, unknown> | undefined;
    if (profiler) {
      if (typeof profiler['dsn'] === 'string') dsn = profiler['dsn'] as string;
      if (typeof profiler['enabled'] === 'boolean') enabled = profiler['enabled'] as boolean;
      if (typeof profiler['collect'] === 'boolean') collect = profiler['collect'] as boolean;
      if (typeof profiler['only_exceptions'] === 'boolean') onlyExceptions = profiler['only_exceptions'] as boolean;
      if (typeof profiler['only_main_requests'] === 'boolean') onlyMainRequests = profiler['only_main_requests'] as boolean;
    }
  }

  return { dsn, enabled, collect, onlyExceptions, onlyMainRequests };
}

function isProfilerEnabledInProd(appPath: string): boolean {
  const prodFiles = [
    path.join(appPath, 'config', 'packages', 'prod', 'web_profiler.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'framework.yaml'),
  ];

  for (const filePath of prodFiles) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const wp = raw['web_profiler'] as Record<string, unknown> | undefined;
    if (wp?.['toolbar'] === true) return true;

    const fw = raw['framework'] as Record<string, unknown> | undefined;
    const profiler = (fw?.['profiler'] ?? raw['profiler']) as Record<string, unknown> | undefined;
    if (profiler?.['enabled'] === true) return true;
  }

  return false;
}

function buildProfilerInfo(appPath: string): ProfilerStorageInfo {
  const { dsn, enabled, collect, onlyExceptions, onlyMainRequests } = readProfilerSection(appPath);
  const isProductionEnabled = isProfilerEnabledInProd(appPath);
  const dsnType = classifyDsn(dsn);

  const issues: string[] = [];

  if (isProductionEnabled) {
    issues.push('Profiler is enabled in production — significant performance overhead and information disclosure risk');
  }

  if (!dsn) {
    issues.push('No profiler DSN configured — defaults to system temp directory (lost on container restart)');
  } else if (dsnType === 'file' && (dsn.includes('/tmp') || dsn.includes('\\tmp'))) {
    issues.push('File profiler path in /tmp — profile data lost on container restart');
  }

  if (collect && !onlyMainRequests) {
    issues.push('profiler.collect: true without only_main_requests: true — sub-requests are also profiled (extra overhead)');
  }

  if (dsnType === 'redis') {
    // Can't verify expiry from static files; emit advisory
    issues.push('Redis profiler DSN: ensure TTL/maxmemory-policy is configured to prevent Redis filling up');
  }

  return { dsn, dsnType, enabled, collect, onlyExceptions, onlyMainRequests, isProductionEnabled, issues };
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listProfilerStorage(appPath: string): McpToolResult {
  try {
    const info = buildProfilerInfo(appPath);

    let text = `Profiler Storage Configuration\n${'='.repeat(50)}\n\n`;
    text += `Enabled:            ${info.enabled}\n`;
    text += `DSN:                ${info.dsn || '(default — system temp)'}\n`;
    text += `DSN type:           ${info.dsnType}\n`;
    text += `Collect:            ${info.collect}\n`;
    text += `Only exceptions:    ${info.onlyExceptions}\n`;
    text += `Only main requests: ${info.onlyMainRequests}\n`;
    text += `Enabled in prod:    ${info.isProductionEnabled ? 'YES (WARNING)' : 'no'}\n`;

    if (info.issues.length > 0) {
      text += `\nIssues:\n`;
      for (const issue of info.issues) {
        text += `  - ${issue}\n`;
      }
    } else {
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

export function getProfilerStorageStats(appPath: string): McpToolResult {
  try {
    const info = buildProfilerInfo(appPath);

    let text = `Profiler Storage Stats\n${'='.repeat(40)}\n\n`;
    text += `Profiler enabled:     ${info.enabled}\n`;
    text += `DSN type:             ${info.dsnType}\n`;
    text += `Production risk:      ${info.isProductionEnabled ? 'YES' : 'no'}\n`;
    text += `Issues:               ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getProfilerStorageTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_profiler_storage',
      description: 'Show Symfony profiler storage configuration: DSN type, collect settings, only_main_requests, production-enabled check',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_profiler_storage_stats',
      description: 'Statistics for profiler storage configuration: enabled state, DSN type, production risk flag, issue count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
