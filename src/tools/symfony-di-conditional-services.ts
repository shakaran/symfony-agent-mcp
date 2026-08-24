// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DiConditionalServiceInfo {
  file: string;
  type: 'when-attribute' | 'yaml-when' | 'compiler-pass' | 'env-specific';
  pattern: string;
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

function readFileSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function buildSymfonyDiConditionalServiceInfos(appPath: string): DiConditionalServiceInfo[] {
  const results: DiConditionalServiceInfo[] = [];

  // Scan PHP files for #[When] and #[WhenNot] attributes and CompilerPass
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      const content = readFileSafe(file);
      const rel = path.relative(appPath, file);

      if (content.includes('#[When(')) {
        const envMatch = content.match(/#\[When\(env:\s*'([^']+)'\)/);
        const envName = envMatch ? envMatch[1] : 'unknown';
        const issues: string[] = [];
        if (envName === 'test') {
          issues.push("Service only registered for test env with #[When(env: 'test')] — ensure prod equivalent exists or use factory pattern");
        }
        results.push({ file: rel, type: 'when-attribute', pattern: `#[When(env: '${envName}')]`, issues });
      }

      if (content.includes('#[WhenNot(')) {
        const envMatch = content.match(/#\[WhenNot\(env:\s*'([^']+)'\)/);
        const envName = envMatch ? envMatch[1] : 'unknown';
        results.push({ file: rel, type: 'when-attribute', pattern: `#[WhenNot(env: '${envName}')]`, issues: [] });
      }

      if (content.includes('implements CompilerPassInterface')) {
        results.push({ file: rel, type: 'compiler-pass', pattern: 'CompilerPassInterface implementation', issues: [] });
      }
    }
  }

  // Check config/packages/ for env-specific YAML overrides
  const packagesDir = path.join(appPath, 'config', 'packages');
  if (fs.existsSync(packagesDir)) {
    const envDirs = ['test', 'dev', 'prod'];
    for (const envDir of envDirs) {
      const envDirPath = path.join(packagesDir, envDir);
      if (fs.existsSync(envDirPath) && fs.statSync(envDirPath).isDirectory()) {
        results.push({ file: `config/packages/${envDir}/`, type: 'yaml-when', pattern: `env-specific config dir: ${envDir}`, issues: [] });
      }
    }
  }

  // Check for services_test.yaml, services_dev.yaml
  const configDir = path.join(appPath, 'config');
  if (fs.existsSync(configDir)) {
    try {
      for (const f of fs.readdirSync(configDir)) {
        if (/services_(test|dev|prod)\.yaml/.test(f)) {
          results.push({ file: `config/${f}`, type: 'yaml-when', pattern: `env-specific services file: ${f}`, issues: [] });
        }
      }
    } catch { /* skip */ }
  }

  // Check config/services.yaml for _instanceof or _defaults
  const servicesYaml = path.join(appPath, 'config', 'services.yaml');
  if (fs.existsSync(servicesYaml)) {
    const content = readFileSafe(servicesYaml);
    if (content.includes('_instanceof:')) {
      results.push({ file: 'config/services.yaml', type: 'env-specific', pattern: '_instanceof configuration', issues: [] });
    }
    if (content.includes('_defaults:')) {
      results.push({ file: 'config/services.yaml', type: 'env-specific', pattern: '_defaults configuration', issues: [] });
    }
  }

  return results;
}

export function listSymfonyDiConditionalServices(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyDiConditionalServiceInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No conditional DI service configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony DI Conditional Services Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyDiConditionalServiceStats(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyDiConditionalServiceInfos(appPath);
    let text = `Symfony DI Conditional Services Statistics\n${'='.repeat(40)}\n\n`;
    text += `When-attribute:  ${infos.filter((i) => i.type === 'when-attribute').length}\n`;
    text += `Yaml-when:       ${infos.filter((i) => i.type === 'yaml-when').length}\n`;
    text += `Compiler-pass:   ${infos.filter((i) => i.type === 'compiler-pass').length}\n`;
    text += `Env-specific:    ${infos.filter((i) => i.type === 'env-specific').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyDiConditionalServiceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_di_conditional_services', description: 'Analyze Symfony DI conditional services: #[When]/#[WhenNot] attributes, env-specific YAML configs, CompilerPass implementations, _instanceof/_defaults', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_di_conditional_service_stats', description: 'Statistics for conditional DI services: counts by type (when-attribute/yaml-when/compiler-pass/env-specific) and total issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
