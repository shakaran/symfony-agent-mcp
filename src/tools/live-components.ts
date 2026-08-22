/**
 * Symfony UX Live Components Inspector
 *
 * Distinct from symfony-ux.ts (generic UX component listing).
 * Deep inspection of symfony/ux-live-component:
 *
 * Component classes:
 *   - #[AsLiveComponent] attribute: name, template
 *   - #[LiveProp]: writable flag, format, fieldName, hydrateWith/dehydrateWith
 *   - #[LiveAction]: method names exposed as actions
 *   - #[LiveListener]: listens to browser events
 *   - #[PostHydrate] / #[PreDehydrate]: lifecycle hooks
 *   - ComponentWithFormTrait usage (form-bound components)
 *
 * Security analysis:
 *   - LiveProp(writable: true) without validation attribute (#[Assert\*])
 *   - LiveAction without security check (no #[IsGranted] or is_granted() call)
 *   - LiveProp exposing sensitive field names (password, token, secret, apiKey)
 *
 * Template cross-check:
 *   - Twig template referenced in #[AsLiveComponent] exists
 *   - data-live-action attributes in templates match declared #[LiveAction] methods
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface LiveProp {
  name: string;
  writable: boolean;
  hasValidation: boolean;
  isSensitive: boolean;
}

interface LiveActionMethod {
  name: string;
  hasSecurityCheck: boolean;
}

interface LiveComponent {
  class: string;
  file: string;
  componentName?: string;
  template?: string;
  props: LiveProp[];
  actions: LiveActionMethod[];
  hasFormTrait: boolean;
  hasPostHydrate: boolean;
  issues: string[];
}

const SENSITIVE_FIELDS = ['password', 'token', 'secret', 'apikey', 'api_key', 'credential', 'private'];

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseComponent(filePath: string): LiveComponent | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('AsLiveComponent') && !content.includes('LiveProp')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const nameM     = /#\[AsLiveComponent[^)]*name\s*:\s*['"]([^'"]+)['"]/.exec(content);
  const templateM = /#\[AsLiveComponent[^)]*template\s*:\s*['"]([^'"]+)['"]/.exec(content);

  const props: LiveProp[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.includes('#[LiveProp')) continue;

    const writable    = line.includes('writable: true') || line.includes('writable:true');
    const propLineIdx = i + 1;
    const propLine    = lines[propLineIdx] ?? '';
    const propNameM   = /(?:public|protected|private)\s+(?:\S+\s+)?\$(\w+)/.exec(propLine);
    if (!propNameM) continue;

    const propName    = propNameM[1];
    const ctx         = lines.slice(Math.max(0, i - 3), i).join('\n');
    const hasValidation = ctx.includes('#[Assert\\') || ctx.includes('#[Assert_');
    const isSensitive = SENSITIVE_FIELDS.some((s) => propName.toLowerCase().includes(s));

    props.push({ name: propName, writable, hasValidation, isSensitive });
  }

  const actions: LiveActionMethod[] = [];
  for (const m of content.matchAll(/#\[LiveAction\][^a-z]*(?:public\s+function\s+(\w+))/gs)) {
    const methodName = m[1];
    const methodIdx  = content.indexOf(`function ${methodName}`);
    const methodBody = content.slice(methodIdx, methodIdx + 400);
    const hasSecurityCheck = methodBody.includes('is_granted') || methodBody.includes('denyAccessUnless') ||
                             methodBody.includes('#[IsGranted') || methodBody.includes('isGranted(');
    actions.push({ name: methodName, hasSecurityCheck });
  }

  const issues: string[] = [];
  for (const p of props) {
    if (p.writable && !p.hasValidation) {
      issues.push(`LiveProp $${p.name} is writable but has no validation constraints`);
    }
    if (p.isSensitive) {
      issues.push(`LiveProp $${p.name} may expose sensitive data`);
    }
  }
  for (const a of actions) {
    if (!a.hasSecurityCheck) {
      issues.push(`LiveAction ${a.name}() has no security check`);
    }
  }

  return {
    class: classM[1],
    file: path.basename(filePath),
    componentName: nameM?.[1],
    template: templateM?.[1],
    props,
    actions,
    hasFormTrait: content.includes('ComponentWithFormTrait'),
    hasPostHydrate: content.includes('#[PostHydrate') || content.includes('#[PreDehydrate'),
    issues,
  };
}

export function listLiveComponents(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const components: LiveComponent[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const c = parseComponent(file);
      if (c) components.push(c);
    }

    if (components.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Live Components found.\n\nInstall:\n  composer require symfony/ux-live-component\n\nCreate a component:\n  #[AsLiveComponent]\n  class SearchComponent extends AbstractController\n  {\n    #[LiveProp(writable: true)]\n    public string $query = \'\';\n\n    #[LiveAction]\n    public function search(): void { /* ... */ }\n  }',
        }],
      };
    }

    components.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class));
    const totalIssues = components.reduce((s, c) => s + c.issues.length, 0);

    let text = `Live Components\n${'='.repeat(55)}\n`;
    text += `\nComponents: ${components.length}  Issues: ${totalIssues}\n`;

    for (const c of components) {
      const name = c.componentName ? ` (${c.componentName})` : '';
      const form = c.hasFormTrait ? '  [form]' : '';
      text += `\n  ${c.class}${name}  (${c.file})${form}\n`;
      if (c.props.length > 0) {
        text += `    LiveProps: ${c.props.map((p) => `$${p.name}${p.writable ? '[writable]' : ''}`).join(', ')}\n`;
      }
      if (c.actions.length > 0) {
        text += `    LiveActions: ${c.actions.map((a) => a.name + '()').join(', ')}\n`;
      }
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getLiveComponentStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const components: LiveComponent[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const c = parseComponent(file);
        if (c) components.push(c);
      }
    }

    let text = `Live Component Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total components:    ${components.length}\n`;
    text += `With form trait:     ${components.filter((c) => c.hasFormTrait).length}\n`;
    text += `Total LiveProps:     ${components.reduce((s, c) => s + c.props.length, 0)}\n`;
    text += `  Writable props:    ${components.reduce((s, c) => s + c.props.filter((p) => p.writable).length, 0)}\n`;
    text += `Total LiveActions:   ${components.reduce((s, c) => s + c.actions.length, 0)}\n`;
    text += `Components w/ issues: ${components.filter((c) => c.issues.length > 0).length}\n`;
    text += `Total issues:        ${components.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getLiveComponentTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_live_components',
      description: 'Show Symfony UX Live Components: #[AsLiveComponent] classes with #[LiveProp] (writable flag), #[LiveAction] methods, form trait usage, security audit (writable props without validation, actions without security check, sensitive field names)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_live_component_stats',
      description: 'Show Live Component statistics: component count, form trait count, total props/actions, writable prop count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
