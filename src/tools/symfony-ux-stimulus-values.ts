import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface StimulusValueInfo {
  file: string;
  controller: string;
  type: 'value' | 'target' | 'outlet' | 'twig';
  name: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function getAllJsTsFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllJsTsFiles(full));
      else if (e.name.endsWith('.js') || e.name.endsWith('.ts')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig') || e.name.endsWith('.html')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractStaticValues(content: string): Array<{ name: string; valueType: string }> {
  const re = /static\s+values\s*=\s*\{([^}]{0,800})\}/;
  const m = re.exec(content);
  if (!m) return [];
  const inner = m[1];
  const results: Array<{ name: string; valueType: string }> = [];
  const entryRe = /([a-zA-Z_$][a-zA-Z0-9_$]{0,100})\s*:\s*([A-Za-z]{1,50})/g;
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(inner)) !== null) {
    results.push({ name: em[1], valueType: em[2] });
  }
  return results;
}

function extractStaticArray(content: string, key: string): string[] {
  const re = new RegExp(`static\\s+${key}\\s*=\\s*\\[([^\\]]{0,500})\\]`);
  const m = re.exec(content);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
}

function buildStimulusValueInfos(appPath: string): StimulusValueInfo[] {
  const results: StimulusValueInfo[] = [];

  const controllerDirs = [
    path.join(appPath, 'assets', 'controllers'),
    path.join(appPath, 'assets', 'stimulus-controllers'),
    path.join(appPath, 'assets', 'js', 'controllers'),
  ];

  for (const dir of controllerDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllJsTsFiles(dir)) {
      const content = safeRead(file, appPath);
      if (content === null) continue;
      if (!content.includes('extends Controller')) continue;

      const relFile = path.relative(appPath, file);
      const baseName = path.basename(file).replace(/_controller\.(js|ts)$/, '').replace(/\.(js|ts)$/, '');
      const controllerName = baseName.replace(/_/g, '-');

      const hasConnect = content.includes('connect()') || content.includes('connect ()');
      const hasDisconnect = content.includes('disconnect()') || content.includes('disconnect ()');
      const hasEventListener = content.includes('addEventListener(');
      if (hasConnect && hasEventListener && !hasDisconnect) {
        results.push({
          file: relFile,
          controller: controllerName,
          type: 'value',
          name: 'disconnect',
          issue: `Controller "${controllerName}" adds event listeners in connect() but has no disconnect() — memory leak when element is removed from DOM`,
        });
      }

      const hasDatasetAccess = /this\.element\.dataset\.[a-zA-Z]/.test(content);
      if (hasDatasetAccess) {
        results.push({
          file: relFile,
          controller: controllerName,
          type: 'value',
          name: 'dataset-anti-pattern',
          issue: `Controller "${controllerName}" uses this.element.dataset.* directly — anti-pattern; define typed values via static values = {} and use this.xxxValue instead`,
        });
      }

      const staticValues = extractStaticValues(content);
      for (const { name, valueType } of staticValues) {
        const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
        const usesValue = content.includes(`this.${name}Value`);
        const hasGuard = content.includes(`this.has${capitalized}Value`);
        let issue: string | null = null;
        if (usesValue && !hasGuard) {
          issue = `Value "${name}" (${valueType}) used without has${capitalized}Value guard — will use default if attribute absent; guard only needed for optional values`;
        }
        results.push({ file: relFile, controller: controllerName, type: 'value', name: `${name}:${valueType}`, issue });
      }

      const targets = extractStaticArray(content, 'targets');
      for (const target of targets) {
        const capitalized = target.charAt(0).toUpperCase() + target.slice(1);
        const usesTarget = content.includes(`this.${target}Target`) || content.includes(`this.${target}Targets`);
        const hasGuard = content.includes(`this.has${capitalized}Target`);
        let issue: string | null = null;
        if (usesTarget && !hasGuard) {
          issue = `Target "${target}" accessed without has${capitalized}Target guard — throws MissingTargetError if element is absent`;
        }
        results.push({ file: relFile, controller: controllerName, type: 'target', name: target, issue });
      }

      const outlets = extractStaticArray(content, 'outlets');
      for (const outlet of outlets) {
        const camel = outlet.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        const capitalized = camel.charAt(0).toUpperCase() + camel.slice(1);
        const usesOutlet = content.includes(`this.${camel}Outlet`) || content.includes(`this.${camel}Outlets`);
        const hasGuard = content.includes(`this.has${capitalized}Outlet`);
        let issue: string | null = null;
        if (usesOutlet && !hasGuard) {
          issue = `Outlet "${outlet}" used without has${capitalized}Outlet check — Stimulus 3.x outlets are optional; throws if outlet not connected`;
        }
        results.push({ file: relFile, controller: controllerName, type: 'outlet', name: outlet, issue });
      }
    }
  }

  const templatesDir = path.join(appPath, 'templates');
  if (fs.existsSync(templatesDir)) {
    for (const file of getAllTwigFiles(templatesDir)) {
      const content = safeRead(file, appPath);
      if (content === null) continue;
      if (!content.includes('data-controller')) continue;

      const relFile = path.relative(appPath, file);

      const controllerRe = /data-controller=["']([^"']{1,200})["']/g;
      let cm: RegExpExecArray | null;
      while ((cm = controllerRe.exec(content)) !== null) {
        const controllers = cm[1].split(/\s+/);
        for (const ctrl of controllers) {
          results.push({ file: relFile, controller: ctrl, type: 'twig', name: 'data-controller', issue: null });
        }
      }

      const valueAttrRe = /data-([a-z0-9-]{1,100})-([a-z0-9-]{1,100})-value=["']([^"']{0,500})["']/g;
      let vm: RegExpExecArray | null;
      while ((vm = valueAttrRe.exec(content)) !== null) {
        results.push({ file: relFile, controller: vm[1], type: 'twig', name: `${vm[2]}-value=${vm[3].substring(0, 50)}`, issue: null });
      }

      const targetAttrRe = /data-([a-z0-9-]{1,100})-target=["']([^"']{1,200})["']/g;
      let tm: RegExpExecArray | null;
      while ((tm = targetAttrRe.exec(content)) !== null) {
        results.push({ file: relFile, controller: tm[1], type: 'twig', name: `target:${tm[2]}`, issue: null });
      }
    }
  }

  return results;
}

export function listSymfonyUxStimulusValues(appPath: string): McpToolResult {
  try {
    const infos = buildStimulusValueInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Stimulus values/targets/outlets found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Stimulus Values/Targets/Outlets Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.controller} — ${info.name}  (${info.file})\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyUxStimulusValuesStats(appPath: string): McpToolResult {
  try {
    const infos = buildStimulusValueInfos(appPath);
    let text = `Stimulus Values Statistics\n${'='.repeat(40)}\n\n`;
    text += `Values:   ${infos.filter((i) => i.type === 'value').length}\n`;
    text += `Targets:  ${infos.filter((i) => i.type === 'target').length}\n`;
    text += `Outlets:  ${infos.filter((i) => i.type === 'outlet').length}\n`;
    text += `Twig:     ${infos.filter((i) => i.type === 'twig').length}\n`;
    text += `Issues:   ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyUxStimulusValuesTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_ux_stimulus_values',
      description: 'Scan Stimulus controllers for values/targets/outlets API usage; detects unguarded value access, unguarded target/outlet access, dataset anti-pattern, missing disconnect(), and Twig template data-controller/value/target attributes',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_ux_stimulus_values_stats',
      description: 'Statistics for Stimulus values/targets/outlets: count per type and issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
