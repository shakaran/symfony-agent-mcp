/**
 * EasyAdmin / Admin Panel Inspector
 *
 * Detects EasyAdmin 4.x (EasyAdminBundle):
 *   - DashboardController subclasses
 *   - AbstractCrudController subclasses (one per entity)
 *   - configureFields() — custom fields
 *   - configureActions() — extra actions
 *   - configureFilters() — filters
 *   - #[IsGranted] on dashboard (security check)
 *
 * Detects SonataAdmin:
 *   - AbstractAdmin subclasses
 *   - configureListFields(), configureFormFields()
 *
 * Reads easyadmin config from config/packages/easy_admin.yaml if present.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface CrudController {
  class: string;
  file: string;
  entity?: string;
  hasCustomFields: boolean;
  hasCustomActions: boolean;
  hasCustomFilters: boolean;
  isGranted?: string;
  kind: 'easyadmin' | 'sonata';
}

interface DashboardInfo {
  class: string;
  file: string;
  isGranted?: string;
  menuItems: number;
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── Parsing ─────────────────────────────────────────────────────────────────

function extractIsGranted(content: string): string | undefined {
  const m = /#\[IsGranted\s*\(\s*['"]([^'"]+)['"]/.exec(content);
  return m?.[1];
}

function parseCrudController(filePath: string): CrudController | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isEasyAdmin = content.includes('AbstractCrudController');
  const isSonata    = content.includes('AbstractAdmin') &&
    (content.includes('configureListFields') || content.includes('configureFormFields'));

  if (!isEasyAdmin && !isSonata) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  // Entity from getEntityFqcn() or class name heuristic
  const entityM = /getEntityFqcn[^{]*\{[^}]*return\s+([A-Za-z\\]+)::class/.exec(content);
  const entity = entityM
    ? (entityM[1].split('\\').pop() ?? entityM[1])
    : classM[1].replace(/CrudController$|Admin$/, '');

  return {
    class: classM[1],
    file: path.basename(filePath),
    entity,
    hasCustomFields:  content.includes('configureFields') || content.includes('configureListFields') || content.includes('configureFormFields'),
    hasCustomActions: content.includes('configureActions'),
    hasCustomFilters: content.includes('configureFilters'),
    isGranted: extractIsGranted(content),
    kind: isEasyAdmin ? 'easyadmin' : 'sonata',
  };
}

function parseDashboard(filePath: string): DashboardInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('DashboardController') && !content.includes('AbstractDashboardController')) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  // Count menu items (yield MenuItem:: calls)
  const menuCount = (content.match(/MenuItem::/g) ?? []).length;

  return {
    class: classM[1],
    file: path.basename(filePath),
    isGranted: extractIsGranted(content),
    menuItems: menuCount,
  };
}

function scanAdmin(appPath: string): { dashboards: DashboardInfo[]; cruds: CrudController[] } {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { dashboards: [], cruds: [] };

  const dashboards: DashboardInfo[] = [];
  const cruds: CrudController[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const dash = parseDashboard(file);
    if (dash) { dashboards.push(dash); continue; }

    const crud = parseCrudController(file);
    if (crud) cruds.push(crud);
  }

  return {
    dashboards: dashboards.sort((a, b) => a.class.localeCompare(b.class)),
    cruds: cruds.sort((a, b) => a.class.localeCompare(b.class)),
  };
}

function detectAdminBundles(appPath: string): string[] {
  const bundles: string[] = [];
  try {
    const content = fs.readFileSync(path.join(appPath, 'config', 'bundles.php'), 'utf-8');
    if (content.includes('EasyAdmin'))  bundles.push('EasyAdmin (EasyAdminBundle)');
    if (content.includes('SonataAdmin')) bundles.push('Sonata Admin (SonataAdminBundle)');
  } catch { /* skip */ }
  try {
    const composerRaw = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8');
    const composer = JSON.parse(composerRaw) as Record<string, Record<string, string>>;
    const deps = { ...composer['require'], ...composer['require-dev'] };
    if (deps['easycorp/easyadmin-bundle']) bundles.push(`easycorp/easyadmin-bundle@${deps['easycorp/easyadmin-bundle']}`);
    if (deps['sonata-project/admin-bundle']) bundles.push(`sonata-project/admin-bundle@${deps['sonata-project/admin-bundle']}`);
  } catch { /* skip */ }
  return [...new Set(bundles)];
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listEasyAdminConfig(appPath: string): McpToolResult {
  try {
    const { dashboards, cruds } = scanAdmin(appPath);
    const bundles = detectAdminBundles(appPath);

    if (dashboards.length === 0 && cruds.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No EasyAdmin or SonataAdmin controllers found.\n\nInstall EasyAdmin:\n  composer require easycorp/easyadmin-bundle\n  php bin/console make:admin:dashboard\n  php bin/console make:admin:crud --entity=User',
        }],
      };
    }

    let text = `Admin Panel Configuration\n${'='.repeat(55)}\n`;

    if (bundles.length > 0) {
      text += `\nDetected: ${bundles.join(', ')}\n`;
    }

    if (dashboards.length > 0) {
      text += `\nDashboard${dashboards.length > 1 ? 's' : ''} (${dashboards.length}):\n`;
      for (const d of dashboards) {
        const secured = d.isGranted ? `  [#[IsGranted('${d.isGranted}')]]` : '  ⚠ no #[IsGranted]';
        text += `  ${d.class.padEnd(40)} menu items: ${d.menuItems}${secured}\n`;
      }
    }

    const eaCruds    = cruds.filter((c) => c.kind === 'easyadmin');
    const sonataCruds = cruds.filter((c) => c.kind === 'sonata');

    if (eaCruds.length > 0) {
      text += `\nEasyAdmin CRUD controllers (${eaCruds.length}):\n`;
      for (const c of eaCruds) {
        const flags: string[] = [];
        if (c.hasCustomFields)  flags.push('fields');
        if (c.hasCustomActions) flags.push('actions');
        if (c.hasCustomFilters) flags.push('filters');
        const grant = c.isGranted ? `  [${c.isGranted}]` : '';
        const customized = flags.length > 0 ? `  custom: ${flags.join('+')}` : '';
        text += `  ${c.class.padEnd(45)} entity: ${(c.entity ?? '?').padEnd(20)}${grant}${customized}\n`;
      }
    }

    if (sonataCruds.length > 0) {
      text += `\nSonata Admin classes (${sonataCruds.length}):\n`;
      for (const c of sonataCruds) {
        text += `  ${c.class.padEnd(45)} entity: ${c.entity ?? '?'}\n`;
      }
    }

    const unsecuredDash = dashboards.filter((d) => !d.isGranted);
    if (unsecuredDash.length > 0) {
      text += `\n⚠ Dashboard${unsecuredDash.length > 1 ? 's' : ''} without #[IsGranted]: ${unsecuredDash.map((d) => d.class).join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getEasyAdminStats(appPath: string): McpToolResult {
  try {
    const { dashboards, cruds } = scanAdmin(appPath);
    const bundles = detectAdminBundles(appPath);

    let text = `Admin Panel Statistics\n${'='.repeat(40)}\n\n`;
    text += `Bundle detected:   ${bundles.length > 0 ? 'yes' : 'no'}\n`;
    text += `Dashboards:        ${dashboards.length}\n`;
    text += `CRUD controllers:  ${cruds.filter((c) => c.kind === 'easyadmin').length}\n`;
    text += `Sonata admins:     ${cruds.filter((c) => c.kind === 'sonata').length}\n`;
    text += `With #[IsGranted]: ${[...dashboards, ...cruds].filter((c) => c.isGranted).length}\n`;
    text += `Unsecured dash:    ${dashboards.filter((d) => !d.isGranted).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getEasyAdminTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_easyadmin_config',
      description: 'List EasyAdmin/SonataAdmin configuration: dashboard controllers, CRUD controllers per entity, custom fields/actions/filters, security (#[IsGranted]) audit',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_easyadmin_stats',
      description: 'Show admin panel statistics: dashboard count, CRUD controller count, secured vs unsecured dashboards, Sonata admin count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
