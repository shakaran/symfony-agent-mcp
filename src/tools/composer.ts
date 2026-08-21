/**
 * Composer Inspector Tool
 * Reads composer.json and composer.lock to introspect installed packages,
 * Symfony version, and project dependencies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ComposerPackage {
  name: string;
  version: string;
  description?: string;
  type?: string;
  isSymfony: boolean;
}

interface ComposerJson {
  name?: string;
  description?: string;
  type?: string;
  license?: string;
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
  scripts?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  autoload?: Record<string, unknown>;
  authors?: Array<{ name: string; email?: string }>;
}

interface LockPackage {
  name: string;
  version: string;
  description?: string;
  type?: string;
}

interface ComposerLock {
  packages?: LockPackage[];
  'packages-dev'?: LockPackage[];
}

export function getComposerInfo(appPath: string): McpToolResult {
  try {
    const composerJson = readComposerJson(appPath);

    if (!composerJson) {
      return { content: [{ type: 'text', text: 'composer.json not found in the application root.' }] };
    }

    const requireCount = Object.keys(composerJson.require || {}).length;
    const requireDevCount = Object.keys(composerJson['require-dev'] || {}).length;

    let text = `Composer Project Information
============================
Name:         ${composerJson.name || '(unnamed)'}
Description:  ${composerJson.description || '(none)'}
Type:         ${composerJson.type || 'project'}
License:      ${composerJson.license || '(unset)'}
`;

    if (composerJson.authors && composerJson.authors.length > 0) {
      text += `Authors:      ${composerJson.authors.map((a) => a.name).join(', ')}\n`;
    }

    text += `\nDependencies: ${requireCount} runtime, ${requireDevCount} dev\n`;

    // Symfony-specific require extras
    const extra = composerJson.extra || {};
    if (extra['symfony']) {
      const symfonyExtra = extra['symfony'] as Record<string, unknown>;
      if (symfonyExtra['allow-contrib']) {
        text += `Symfony contrib: allowed\n`;
      }
      if (symfonyExtra['require']) {
        text += `Symfony runtime: ${JSON.stringify(symfonyExtra['require'])}\n`;
      }
    }

    // Scripts summary
    const scriptNames = Object.keys(composerJson.scripts || {});
    if (scriptNames.length > 0) {
      text += `\nComposer scripts: ${scriptNames.join(', ')}`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading composer.json: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getInstalledPackages(appPath: string, type?: string): McpToolResult {
  try {
    const packages = readInstalledPackages(appPath);

    if (packages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No packages found. Make sure composer.lock exists (run composer install).',
        }],
      };
    }

    let filtered = packages;
    if (type === 'symfony') {
      filtered = packages.filter((p) => p.isSymfony);
    } else if (type === 'dev') {
      // dev packages are marked in the lock - we read them separately
      filtered = readDevPackages(appPath);
    } else if (type) {
      filtered = packages.filter((p) => p.type === type);
    }

    if (filtered.length === 0) {
      return { content: [{ type: 'text', text: `No packages found for type: ${type}` }] };
    }

    const lines = filtered.map(
      (p) => `  ${p.name.padEnd(45)} ${p.version.padEnd(20)} ${p.description?.slice(0, 50) || ''}`
    );

    const header = `${'Package'.padEnd(45)} ${'Version'.padEnd(20)} Description\n${'─'.repeat(100)}`;
    const title = type ? `Installed packages (${type}): ${filtered.length}` : `Installed packages: ${filtered.length}`;

    return {
      content: [{
        type: 'text',
        text: `${title}\n\n${header}\n${lines.join('\n')}`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading packages: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyVersion(appPath: string): McpToolResult {
  try {
    // Method 1: Read from composer.lock (most accurate)
    const lockPath = path.join(appPath, 'composer.lock');
    if (fs.existsSync(lockPath)) {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as ComposerLock;
      const allPackages = [...(lock.packages || []), ...(lock['packages-dev'] || [])];

      const symfonyVersion = findSymfonyVersion(allPackages);
      if (symfonyVersion) {
        const components = allPackages
          .filter((p) => p.name.startsWith('symfony/'))
          .map((p) => `  ${p.name.padEnd(40)} ${p.version}`)
          .join('\n');

        return {
          content: [{
            type: 'text',
            text: `Symfony Version: ${symfonyVersion}\n\nInstalled Symfony Components:\n${components}`,
          }],
        };
      }
    }

    // Method 2: Read from composer.json require section
    const composerJson = readComposerJson(appPath);
    if (composerJson?.require?.['symfony/framework-bundle']) {
      return {
        content: [{
          type: 'text',
          text: `Symfony Version (from composer.json require): ${composerJson.require['symfony/framework-bundle']}\n(Run composer install to get exact installed version)`,
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: 'Could not determine Symfony version. Make sure composer.lock exists and composer install has been run.',
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error detecting Symfony version: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// Internal helpers

function readComposerJson(appPath: string): ComposerJson | null {
  const composerPath = path.join(appPath, 'composer.json');
  if (!fs.existsSync(composerPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as ComposerJson;
  } catch {
    return null;
  }
}

function readInstalledPackages(appPath: string): ComposerPackage[] {
  const lockPath = path.join(appPath, 'composer.lock');
  if (!fs.existsSync(lockPath)) {
    // Fall back to composer.json require section
    return readPackagesFromComposerJson(appPath);
  }

  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as ComposerLock;
    return (lock.packages || []).map(lockPackageToComposerPackage);
  } catch {
    return [];
  }
}

function readDevPackages(appPath: string): ComposerPackage[] {
  const lockPath = path.join(appPath, 'composer.lock');
  if (!fs.existsSync(lockPath)) return [];
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as ComposerLock;
    return (lock['packages-dev'] || []).map(lockPackageToComposerPackage);
  } catch {
    return [];
  }
}

function readPackagesFromComposerJson(appPath: string): ComposerPackage[] {
  const composerJson = readComposerJson(appPath);
  if (!composerJson?.require) return [];

  return Object.entries(composerJson.require)
    .filter(([name]) => !name.startsWith('php') && !name.startsWith('ext-'))
    .map(([name, version]) => ({
      name,
      version,
      isSymfony: name.startsWith('symfony/'),
    }));
}

function lockPackageToComposerPackage(p: LockPackage): ComposerPackage {
  return {
    name: p.name,
    version: p.version,
    description: p.description,
    type: p.type,
    isSymfony: p.name.startsWith('symfony/'),
  };
}

function findSymfonyVersion(packages: LockPackage[]): string | null {
  // symfony/framework-bundle is the canonical Symfony version indicator
  const framework = packages.find((p) => p.name === 'symfony/framework-bundle');
  if (framework) return framework.version;

  // Fallback: symfony/http-kernel
  const httpKernel = packages.find((p) => p.name === 'symfony/http-kernel');
  if (httpKernel) return httpKernel.version;

  return null;
}

export function getComposerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };

  return [
    {
      name: 'get_composer_info',
      description: 'Get project information from composer.json: name, description, license, dependency counts, and scripts',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_installed_packages',
      description: 'List installed Composer packages from composer.lock. Filter by type: symfony, dev, or a package type like "library"',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          type: {
            type: 'string',
            description: 'Filter packages by type: "symfony" (symfony/* only), "dev" (require-dev), or a package type like "library"',
          },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_symfony_version',
      description: 'Get the exact Symfony version installed (from composer.lock) with a list of all symfony/* components',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
