// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface NelmioSecurityInfo {
  section: string;
  key: string;
  value: string;
  issue: string | null;
}

function extractYamlBool(content: string, key: string): boolean | null {
  const re = new RegExp(`${key}\\s*:\\s*(true|false)`);
  const m = re.exec(content);
  if (!m) return null;
  return m[1] === 'true';
}

function extractYamlValue(content: string, key: string): string | null {
  const re = new RegExp(`${key}\\s*:\\s*([^\\n]{1,200})`);
  const m = re.exec(content);
  return m ? m[1].trim() : null;
}

function buildNelmioSecurityInfos(appPath: string): NelmioSecurityInfo[] {
  const results: NelmioSecurityInfo[] = [];

  const yamlCandidates = [
    path.join(appPath, 'config', 'packages', 'nelmio_security.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'nelmio_security.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'nelmio_security.yaml'),
  ];

  let mainContent = '';

  for (const yamlPath of yamlCandidates) {
    if (!fs.existsSync(yamlPath)) continue;
    let content = '';
    try { content = fs.readFileSync(yamlPath, 'utf-8'); } catch { continue; }
    if (!mainContent) {
      mainContent = content;
    }

    const relSource = path.relative(appPath, yamlPath);

    const nosniff = extractYamlBool(content, 'nosniff');
    if (nosniff !== null) {
      results.push({
        section: 'content_type',
        key: 'nosniff',
        value: String(nosniff),
        issue: nosniff ? null : `content_type.nosniff is false in ${relSource} — X-Content-Type-Options: nosniff should be enabled to prevent MIME-sniffing attacks`,
      });
    } else if (content.includes('content_type:')) {
      results.push({
        section: 'content_type',
        key: 'nosniff',
        value: 'not set',
        issue: `content_type section present in ${relSource} but nosniff not explicitly set — default may not be enabled; set nosniff: true`,
      });
    }

    const xssEnabled = extractYamlBool(content, 'enabled');
    const modeBlock = extractYamlBool(content, 'mode_block');
    if (content.includes('xss_protection:')) {
      results.push({
        section: 'xss_protection',
        key: 'enabled',
        value: xssEnabled !== null ? String(xssEnabled) : 'not set',
        issue: xssEnabled === false ? `xss_protection.enabled: false in ${relSource} — X-XSS-Protection header disabled; enable for legacy browser XSS protection` : null,
      });
      if (xssEnabled !== false) {
        results.push({
          section: 'xss_protection',
          key: 'mode_block',
          value: modeBlock !== null ? String(modeBlock) : 'not set',
          issue: modeBlock === false ? `xss_protection.mode_block: false in ${relSource} — set mode_block: true to block (not sanitize) XSS-detected pages` : null,
        });
      }
    } else {
      results.push({
        section: 'xss_protection',
        key: 'enabled',
        value: 'not configured',
        issue: `xss_protection section missing in ${relSource} — X-XSS-Protection header not configured`,
      });
    }

    const frameOptionsVal = extractYamlValue(content, 'frame_options');
    if (content.includes('frame_options:')) {
      const validValues = ['DENY', 'SAMEORIGIN'];
      const isValid = frameOptionsVal ? validValues.some((v) => frameOptionsVal.toUpperCase().includes(v)) : false;
      results.push({
        section: 'frame_options',
        key: 'value',
        value: frameOptionsVal ?? 'not set',
        issue: isValid ? null : `frame_options.value in ${relSource} should be DENY or SAMEORIGIN to prevent clickjacking; current: "${frameOptionsVal}"`,
      });
    } else {
      results.push({
        section: 'frame_options',
        key: 'value',
        value: 'not configured',
        issue: `frame_options not configured in ${relSource} — X-Frame-Options header missing; add frame_options: { value: DENY } to prevent clickjacking`,
      });
    }

    if (content.includes('content_security_policy:') || content.includes('csp:')) {
      const hasDefaultSrc = content.includes('default-src') || content.includes("default_src");
      results.push({
        section: 'content_security_policy',
        key: 'default-src',
        value: hasDefaultSrc ? 'present' : 'missing',
        issue: hasDefaultSrc ? null : `CSP configured in ${relSource} but missing default-src directive — all resource types will be unconstrained; add default-src: ["'self'"]`,
      });
    } else {
      results.push({
        section: 'content_security_policy',
        key: 'enabled',
        value: 'not configured',
        issue: `content_security_policy section missing in ${relSource} — CSP header not set; configure to control allowed resource origins`,
      });
    }

    const forcedSslEnabled = extractYamlBool(content, 'forced_ssl');
    if (content.includes('forced_ssl:')) {
      const isProdFile = relSource.includes('prod');
      results.push({
        section: 'forced_ssl',
        key: 'enabled',
        value: forcedSslEnabled !== null ? String(forcedSslEnabled) : 'not set',
        issue: (forcedSslEnabled === false && isProdFile)
          ? `forced_ssl.enabled: false in prod config (${relSource}) — HTTPS redirect is disabled in production; enable to enforce HTTPS`
          : null,
      });
    }

    const referrerEnabled = extractYamlBool(content, 'referrer_policy');
    if (content.includes('referrer_policy:')) {
      results.push({
        section: 'referrer_policy',
        key: 'enabled',
        value: referrerEnabled !== null ? String(referrerEnabled) : 'not set',
        issue: referrerEnabled === false ? `referrer_policy.enabled: false in ${relSource} — Referrer-Policy header disabled; enable to control referrer information leakage` : null,
      });
    } else {
      results.push({
        section: 'referrer_policy',
        key: 'enabled',
        value: 'not configured',
        issue: `referrer_policy section missing in ${relSource} — Referrer-Policy header not set; add referrer_policy: { enabled: true }`,
      });
    }

    if (content.includes('clickjacking:')) {
      results.push({
        section: 'clickjacking',
        key: 'paths',
        value: 'configured',
        issue: null,
      });
    }
  }

  if (!mainContent) {
    results.push({
      section: 'bundle',
      key: 'nelmio_security.yaml',
      value: 'not found',
      issue: 'NelmioSecurityBundle config not found at config/packages/nelmio_security.yaml — bundle not installed or not configured',
    });
  }

  const corsYaml = path.join(appPath, 'config', 'packages', 'nelmio_cors.yaml');
  if (fs.existsSync(corsYaml)) {
    results.push({
      section: 'cors',
      key: 'nelmio_cors.yaml',
      value: 'present',
      issue: null,
    });
  }

  return results;
}

export function listNelmioSecurityBundle(appPath: string): McpToolResult {
  try {
    const infos = buildNelmioSecurityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No NelmioSecurityBundle configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `NelmioSecurityBundle Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.section.toUpperCase()}] ${info.key}: ${info.value}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNelmioSecurityBundleStats(appPath: string): McpToolResult {
  try {
    const infos = buildNelmioSecurityInfos(appPath);
    let text = `NelmioSecurityBundle Statistics\n${'='.repeat(40)}\n\n`;
    const sections = [...new Set(infos.map((i) => i.section))];
    for (const section of sections) {
      text += `${section}: ${infos.filter((i) => i.section === section).length} entries\n`;
    }
    text += `Issues: ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNelmioSecurityBundleTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_nelmio_security_bundle',
      description: 'Scan NelmioSecurityBundle config for security headers: content_type.nosniff, xss_protection, frame_options (DENY/SAMEORIGIN), CSP default-src, forced_ssl in prod, clickjacking paths, referrer_policy; detects missing headers and misconfiguration; also checks NelmioCorsBundle presence',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_nelmio_security_bundle_stats',
      description: 'Statistics for NelmioSecurityBundle: entries per section, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
