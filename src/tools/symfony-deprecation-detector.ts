// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface SymfonyDeprecationInfo {
  file: string;
  type: 'class' | 'method' | 'annotation' | 'constant';
  pattern: string;
  since: string;
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

function buildSymfonyDeprecationInfos(appPath: string): SymfonyDeprecationInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: SymfonyDeprecationInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const rel = path.relative(appPath, file);

    if (content.includes('ContainerAwareInterface')) {
      results.push({ file: rel, type: 'class', pattern: 'ContainerAwareInterface', since: '4.0', issues: ['ContainerAwareInterface is deprecated since Symfony 4.0 — inject specific services through constructor instead of using the container directly'] });
    }
    if (/extends\s+Controller\b/.test(content) && !content.includes('extends AbstractController')) {
      results.push({ file: rel, type: 'class', pattern: 'extends Controller', since: '4.0', issues: ['Symfony\\Bundle\\FrameworkBundle\\Controller\\Controller is deprecated — extend AbstractController instead'] });
    }
    if (content.includes('->getRequest()')) {
      results.push({ file: rel, type: 'method', pattern: '->getRequest()', since: '2.4', issues: ['getRequest() method is deprecated since Symfony 2.4 — inject Request through action method argument or use RequestStack'] });
    }
    if (content.includes('->getRootDir()')) {
      results.push({ file: rel, type: 'method', pattern: '->getRootDir()', since: '4.0', issues: ['Kernel::getRootDir() is deprecated since Symfony 4.0 — use getProjectDir() instead'] });
    }
    if (/@Route\b/.test(content) && !/#\[Route/.test(content)) {
      results.push({ file: rel, type: 'annotation', pattern: '@Route annotation', since: '5.2', issues: ['Doctrine @Route annotation is deprecated in favor of PHP 8 attributes — use #[Route] attribute instead'] });
    }
    if (content.includes('@Template')) {
      results.push({ file: rel, type: 'annotation', pattern: '@Template annotation', since: '4.0', issues: ['@Template annotation is deprecated — return an array or use #[Template] attribute if using SensioFrameworkExtraBundle'] });
    }
    if (content.includes('SYMFONY_ENV')) {
      results.push({ file: rel, type: 'constant', pattern: 'SYMFONY_ENV', since: '4.2', issues: ['SYMFONY_ENV constant is deprecated since Symfony 4.2 — use APP_ENV env variable instead'] });
    }
  }

  return results;
}

export function listSymfonyDeprecations(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyDeprecationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony deprecations found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Deprecation Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  since ${info.since}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyDeprecationStats(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyDeprecationInfos(appPath);
    let text = `Symfony Deprecation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Class:       ${infos.filter((i) => i.type === 'class').length}\n`;
    text += `Method:      ${infos.filter((i) => i.type === 'method').length}\n`;
    text += `Annotation:  ${infos.filter((i) => i.type === 'annotation').length}\n`;
    text += `Constant:    ${infos.filter((i) => i.type === 'constant').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyDeprecationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_deprecations', description: 'Analyze Symfony deprecated APIs: ContainerAwareInterface, old Controller, getRequest(), getRootDir(), @Route/@Template annotations, SYMFONY_ENV constant', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_deprecation_stats', description: 'Statistics for Symfony deprecations: counts by type (class/method/annotation/constant) and total issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
