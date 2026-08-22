import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface StimulusControllerInfo {
  file: string;
  name: string;
  values: string[];
  targets: string[];
  outlets: string[];
  isLazy: boolean;
  issues: string[];
}

function getAllJsFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllJsFiles(full));
      else if (e.name.endsWith('.js') || e.name.endsWith('.ts')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractStaticArray(content: string, key: string): string[] {
  const re = new RegExp(`static\\s+${key}\\s*=\\s*\\[([^\\]]{0,500})\\]`);
  const m = re.exec(content);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
}

function extractStaticObject(content: string, key: string): string[] {
  const re = new RegExp(`static\\s+${key}\\s*=\\s*\\{([^}]{0,500})\\}`);
  const m = re.exec(content);
  if (!m) return [];
  return m[1].split(',').map((s) => s.split(':')[0].trim().replace(/['"]/g, '')).filter(Boolean);
}

function buildStimulusInfos(appPath: string): StimulusControllerInfo[] {
  const controllerDirs = [
    path.join(appPath, 'assets', 'controllers'),
    path.join(appPath, 'assets', 'stimulus-controllers'),
    path.join(appPath, 'assets', 'js', 'controllers'),
  ];

  const results: StimulusControllerInfo[] = [];

  for (const dir of controllerDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllJsFiles(dir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      if (!content.includes('extends Controller')) continue;

      const relFile = path.relative(appPath, file);
      const baseName = path.basename(file).replace(/_controller\.(js|ts)$/, '').replace(/\.(js|ts)$/, '');
      const name = baseName.replace(/_/g, '-');

      const values = extractStaticObject(content, 'values');
      const targets = extractStaticArray(content, 'targets');
      const outlets = extractStaticArray(content, 'outlets');
      const isLazy = content.includes('stimulusLazy') || content.includes('/* lazy */');
      const issues: string[] = [];

      const hasConnect = content.includes('connect()');
      const hasDisconnect = content.includes('disconnect()');
      const hasEventListener = content.includes('addEventListener(');
      if (hasConnect && hasEventListener && !hasDisconnect) {
        issues.push(`Controller "${name}" adds event listeners in connect() but has no disconnect() — memory leak on element removal`);
      }

      if (values.length > 0) {
        const valuesWithoutDefault = values.filter((v) => {
          const re = new RegExp(`${v}:\\s*\\{[^}]{0,200}default:`);
          return !re.test(content);
        });
        if (valuesWithoutDefault.length > 0) {
          issues.push(`Controller "${name}" values without defaultValue: ${valuesWithoutDefault.join(', ')} — undefined if attribute is missing from element`);
        }
      }

      if (targets.length > 0) {
        const uncheckedTargets = targets.filter((t) => {
          const capitalized = t.charAt(0).toUpperCase() + t.slice(1);
          return !content.includes(`has${capitalized}Target`) && content.includes(`this.${t}Target`);
        });
        if (uncheckedTargets.length > 0) {
          issues.push(`Controller "${name}" accesses targets without has*Target guard: ${uncheckedTargets.join(', ')} — throws if element is absent`);
        }
      }

      if (outlets.length > 0) {
        const uncheckedOutlets = outlets.filter((o) => {
          const camel = o.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
          return !content.includes(`has${camel.charAt(0).toUpperCase()}${camel.slice(1)}Outlet`) &&
            content.includes(`${camel}Outlet`);
        });
        if (uncheckedOutlets.length > 0) {
          issues.push(`Controller "${name}" uses outlets without hasXxxOutlet guard: ${uncheckedOutlets.join(', ')} — throws if outlet not connected`);
        }
      }

      results.push({ file: relFile, name, values, targets, outlets, isLazy, issues });
    }
  }

  return results;
}

export function listSymfonyUxStimulusControllers(appPath: string): McpToolResult {
  try {
    const infos = buildStimulusInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Stimulus controllers found in assets/controllers/ or assets/stimulus-controllers/.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Stimulus Controller Analysis\n${'='.repeat(55)}\n\nControllers: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  ${info.name}  (${info.file})${info.isLazy ? '  [lazy]' : ''}\n`;
      if (info.values.length) text += `    values: ${info.values.join(', ')}\n`;
      if (info.targets.length) text += `    targets: ${info.targets.join(', ')}\n`;
      if (info.outlets.length) text += `    outlets: ${info.outlets.join(', ')}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyUxStimulusStats(appPath: string): McpToolResult {
  try {
    const infos = buildStimulusInfos(appPath);
    let text = `Stimulus Controller Statistics\n${'='.repeat(40)}\n\n`;
    text += `Controllers:  ${infos.length}\n`;
    text += `  Lazy:       ${infos.filter((i) => i.isLazy).length}\n`;
    text += `  With vals:  ${infos.filter((i) => i.values.length > 0).length}\n`;
    text += `  With tgts:  ${infos.filter((i) => i.targets.length > 0).length}\n`;
    text += `  With otlts: ${infos.filter((i) => i.outlets.length > 0).length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyUxStimulusControllerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_ux_stimulus_controllers', description: 'Deep analyze Stimulus controllers in assets/controllers/; detects values/targets/outlets; warns on missing disconnect() cleanup, values without defaultValue, unchecked target/outlet access', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_ux_stimulus_stats', description: 'Statistics for Stimulus controllers: count, lazy count, values/targets/outlets coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
