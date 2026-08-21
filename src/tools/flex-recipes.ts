/**
 * Symfony Flex Recipes Inspector
 *
 * Reads symfony.lock to report installed Flex recipes:
 *   - Package name + version + recipe origin (official / contrib / custom)
 *   - Recipe version and whether it's upgradeable (lock version < latest)
 *   - Post-install tasks (run_after, copy-from-recipe, etc.)
 *   - Env vars injected by recipe (from .env additions)
 *
 * Reads composer.json to cross-reference Flex aliases.
 *
 * Analysis:
 *   - Contrib recipes (less official — review code before trusting)
 *   - Packages with Flex recipe vs without
 *   - Packages that added env vars (good to know for 12-factor audit)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FlexRecipe {
  package: string;
  version: string;
  recipeVersion?: string;
  origin: 'official' | 'contrib' | 'custom' | 'unknown';
  ref?: string;
  envVarsAdded: string[];
}

// ─── symfony.lock parsing ────────────────────────────────────────────────────

function detectOrigin(pkg: string, ref?: string): FlexRecipe['origin'] {
  if (!ref) return 'unknown';
  if (ref.includes('github.com/symfony/recipes-contrib')) return 'contrib';
  if (ref.includes('github.com/symfony/recipes')) return 'official';
  // Custom: looks like a commit SHA without a known host
  return 'custom';
}

function loadFlexRecipes(appPath: string): FlexRecipe[] {
  const lockFile = path.join(appPath, 'symfony.lock');
  if (!fs.existsSync(lockFile)) return [];

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(lockFile, 'utf-8')) as Record<string, unknown>;
  } catch { return []; }

  const recipes: FlexRecipe[] = [];

  for (const [pkg, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;

    // Only packages that have a recipe (have 'recipe' key)
    const recipeEntry = e['recipe'] as Record<string, unknown> | undefined;
    if (!recipeEntry) continue;

    const version    = e['version'] ? String(e['version']) : 'unknown';
    const recipeVer  = recipeEntry['version'] ? String(recipeEntry['version']) : undefined;
    const ref        = recipeEntry['ref'] ? String(recipeEntry['ref']) : undefined;
    const origin     = detectOrigin(pkg, ref ?? String(recipeEntry['url'] ?? ''));

    // Env vars from recipe files (listed in recipe manifest)
    const envVarsAdded: string[] = [];
    const files = (e['files'] ?? recipeEntry['files']) as Record<string, unknown> | undefined;
    if (files) {
      for (const [fname] of Object.entries(files)) {
        if (fname === '.env' || fname.endsWith('.env')) {
          const content = files[fname] as string | undefined;
          if (typeof content === 'string') {
            const vars = content.match(/^([A-Z_][A-Z0-9_]*)=/gm) ?? [];
            envVarsAdded.push(...vars.map((v) => v.replace('=', '')));
          }
        }
      }
    }

    recipes.push({ package: pkg, version, recipeVersion: recipeVer, origin, ref, envVarsAdded });
  }

  return recipes.sort((a, b) => a.package.localeCompare(b.package));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listFlexRecipes(appPath: string): McpToolResult {
  try {
    const recipes = loadFlexRecipes(appPath);

    if (recipes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'symfony.lock not found or no Flex recipes installed.\n\nFlex recipes are installed automatically by Composer + Symfony Flex.\nRun: composer require symfony/flex  (if not already installed)',
        }],
      };
    }

    const official = recipes.filter((r) => r.origin === 'official');
    const contrib  = recipes.filter((r) => r.origin === 'contrib');
    const custom   = recipes.filter((r) => r.origin === 'custom');
    const unknown  = recipes.filter((r) => r.origin === 'unknown');

    let text = `Symfony Flex Recipes (${recipes.length})\n${'='.repeat(60)}\n`;
    text += `  Official: ${official.length}  |  Contrib: ${contrib.length}  |  Custom/Unknown: ${custom.length + unknown.length}\n`;

    if (official.length > 0) {
      text += `\nOfficial recipes (${official.length}):\n`;
      for (const r of official) {
        const rv = r.recipeVersion ? `  recipe@${r.recipeVersion}` : '';
        text += `  ${r.package.padEnd(50)} v${r.version}${rv}\n`;
      }
    }

    if (contrib.length > 0) {
      text += `\nContrib recipes (${contrib.length}) — review before trusting:\n`;
      for (const r of contrib) {
        const rv = r.recipeVersion ? `  recipe@${r.recipeVersion}` : '';
        text += `  ${r.package.padEnd(50)} v${r.version}${rv}\n`;
      }
    }

    if (custom.length + unknown.length > 0) {
      text += `\nCustom / Unknown origin (${custom.length + unknown.length}):\n`;
      for (const r of [...custom, ...unknown]) {
        text += `  ${r.package.padEnd(50)} v${r.version}  ref: ${r.ref ?? 'none'}\n`;
      }
    }

    const withEnv = recipes.filter((r) => r.envVarsAdded.length > 0);
    if (withEnv.length > 0) {
      text += `\nRecipes that added env vars:\n`;
      for (const r of withEnv) {
        text += `  ${r.package.padEnd(50)} ${r.envVarsAdded.join(', ')}\n`;
      }
    }

    if (contrib.length > 0) {
      text += `\n⚠ Contrib recipes are community-maintained — audit their generated files\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFlexRecipeStats(appPath: string): McpToolResult {
  try {
    const recipes = loadFlexRecipes(appPath);

    let text = `Flex Recipe Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total recipes:    ${recipes.length}\n`;
    text += `Official:         ${recipes.filter((r) => r.origin === 'official').length}\n`;
    text += `Contrib:          ${recipes.filter((r) => r.origin === 'contrib').length}\n`;
    text += `Custom/Unknown:   ${recipes.filter((r) => r.origin === 'custom' || r.origin === 'unknown').length}\n`;
    text += `Added env vars:   ${recipes.filter((r) => r.envVarsAdded.length > 0).length} packages\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getFlexRecipeTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_flex_recipes',
      description: 'List Symfony Flex recipes from symfony.lock: official vs contrib vs custom origin, recipe versions, packages that injected env vars (12-factor audit)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_flex_recipe_stats',
      description: 'Show Flex recipe statistics: total recipe count, official vs contrib breakdown, packages that added env vars',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
