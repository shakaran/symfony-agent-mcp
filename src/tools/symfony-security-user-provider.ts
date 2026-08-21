/**
 * Symfony Security UserProvider Inspector
 *
 * Reads security.yaml: providers section (entity, memory, ldap, custom).
 * Scans src/ PHP for: UserProviderInterface/PasswordUpgraderInterface implementations,
 *   loadUserByIdentifier(), refreshUser(), supportsClass().
 *
 * Detects:
 *   - ChainUserProvider configuration
 *   - Entity provider with custom repository method
 *
 * Warns:
 *   - UserProviderInterface without loadUserByIdentifier() (uses deprecated loadUserByUsername)
 *   - refreshUser() that creates new object instead of using entity manager refresh
 *   - supportsClass() returning always-true (all user types accepted)
 *   - Custom provider without PasswordUpgraderInterface (missing hash migration)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';
import { parseYamlFile } from '../utils/symfony-parser.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface UserProviderInfo {
  name: string;
  type: string;
  file?: string;
  class?: string;
  hasLoadByIdentifier: boolean;
  hasRefreshUser: boolean;
  hasPasswordUpgrader: boolean;
  issues: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── Security.yaml reader ─────────────────────────────────────────────────────

interface RawProvider {
  name: string;
  type: string;
  isChain: boolean;
  entityClass?: string;
  property?: string;
  customRepository?: string;
  id?: string;
}

function loadProvidersFromYaml(appPath: string): RawProvider[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  const providers: RawProvider[] = [];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const providersRaw = (security['providers'] ?? {}) as Record<string, unknown>;

    for (const [name, pData] of Object.entries(providersRaw)) {
      const p = (pData ?? {}) as Record<string, unknown>;
      if (p['chain']) {
        providers.push({ name, type: 'chain', isChain: true });
        continue;
      }
      if (p['entity']) {
        const entity = (p['entity'] ?? {}) as Record<string, unknown>;
        providers.push({
          name,
          type: 'entity',
          isChain: false,
          entityClass: entity['class'] ? String(entity['class']) : undefined,
          property: entity['property'] ? String(entity['property']) : undefined,
          customRepository: entity['repository_method'] ? String(entity['repository_method']) : undefined,
        });
        continue;
      }
      if (p['memory']) {
        providers.push({ name, type: 'memory', isChain: false });
        continue;
      }
      if (p['ldap']) {
        providers.push({ name, type: 'ldap', isChain: false });
        continue;
      }
      if (p['id']) {
        providers.push({ name, type: 'custom', isChain: false, id: String(p['id']) });
        continue;
      }
      providers.push({ name, type: 'unknown', isChain: false });
    }
    break;
  }
  return providers;
}

// ─── PHP class analysis ────────────────────────────────────────────────────────

interface PhpProviderClass {
  file: string;
  class: string;
  hasLoadByIdentifier: boolean;
  hasLoadByUsername: boolean;
  hasRefreshUser: boolean;
  hasSupportsClass: boolean;
  hasPasswordUpgrader: boolean;
  refreshCreatesNew: boolean;
  supportsAlwaysTrue: boolean;
  issues: string[];
}

function extractMethodBody(content: string, methodName: string): string {
  const re = new RegExp(
    `function\\s+${methodName}\\s*\\([^)]{0,300}\\)[^{]{0,80}\\{([\\s\\S]{0,2000}?)\\}`,
  );
  const m = re.exec(content);
  return m ? m[1] : '';
}

function analyzePhpProviderClass(filePath: string, appPath: string): PhpProviderClass | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  const isProvider =
    content.includes('UserProviderInterface') ||
    content.includes('loadUserByIdentifier') ||
    content.includes('refreshUser') ||
    (content.includes('supportsClass') && content.includes('loadUserBy'));

  if (!isProvider) return null;

  const classM = /\bclass\s+(\w{1,80})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  const hasLoadByIdentifier = /function\s+loadUserByIdentifier\s*\(/.test(content);
  const hasLoadByUsername = /function\s+loadUserByUsername\s*\(/.test(content);
  const hasRefreshUser = /function\s+refreshUser\s*\(/.test(content);
  const hasSupportsClass = /function\s+supportsClass\s*\(/.test(content);
  const hasPasswordUpgrader = content.includes('PasswordUpgraderInterface') || /function\s+upgradePassword\s*\(/.test(content);

  // refreshUser that creates new object instead of refresh
  let refreshCreatesNew = false;
  if (hasRefreshUser) {
    const body = extractMethodBody(content, 'refreshUser');
    refreshCreatesNew = /\bnew\s+\w{1,80}\s*\(/.test(body) && !body.includes('refresh(') && !body.includes('->find(');
  }

  // supportsClass always returning true
  let supportsAlwaysTrue = false;
  if (hasSupportsClass) {
    const body = extractMethodBody(content, 'supportsClass');
    supportsAlwaysTrue = /return\s+true\s*;/.test(body) && !body.includes('===') && !body.includes('instanceof') && !body.includes('is_a(');
  }

  const issues: string[] = [];

  if (!hasLoadByIdentifier && hasLoadByUsername) {
    issues.push(
      `${className} uses deprecated loadUserByUsername() instead of loadUserByIdentifier(). ` +
      `Rename to loadUserByIdentifier() for Symfony 5.3+ compatibility.`,
    );
  }
  if (!hasLoadByIdentifier && !hasLoadByUsername) {
    issues.push(
      `${className} appears to implement UserProviderInterface but is missing loadUserByIdentifier(). ` +
      `This method is required in Symfony 5.3+.`,
    );
  }
  if (refreshCreatesNew) {
    issues.push(
      `${className}::refreshUser() creates a new object instead of using EntityManager::refresh(). ` +
      `The entity manager should refresh the user from the database to keep it managed.`,
    );
  }
  if (supportsAlwaysTrue) {
    issues.push(
      `${className}::supportsClass() always returns true — accepts all user types. ` +
      `Narrow to a specific class: return $class === MyUser::class.`,
    );
  }
  if (!hasPasswordUpgrader && (hasLoadByIdentifier || hasLoadByUsername)) {
    issues.push(
      `${className} is a custom UserProvider without PasswordUpgraderInterface. ` +
      `Implement upgradePassword() to support automatic password hash migration.`,
    );
  }

  return {
    file: filePath,
    class: className,
    hasLoadByIdentifier,
    hasLoadByUsername,
    hasRefreshUser,
    hasSupportsClass,
    hasPasswordUpgrader,
    refreshCreatesNew,
    supportsAlwaysTrue,
    issues,
  };
}

// ─── Merge YAML + PHP ─────────────────────────────────────────────────────────

function loadAll(appPath: string): UserProviderInfo[] {
  const srcDir = path.join(appPath, 'src');
  const rawProviders = loadProvidersFromYaml(appPath);

  const phpClasses: PhpProviderClass[] = [];
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      const info = analyzePhpProviderClass(file, appPath);
      if (info) phpClasses.push(info);
    }
  }

  const results: UserProviderInfo[] = [];

  // YAML-configured providers
  for (const rawP of rawProviders) {
    const info: UserProviderInfo = {
      name: rawP.name,
      type: rawP.type,
      hasLoadByIdentifier: false,
      hasRefreshUser: false,
      hasPasswordUpgrader: false,
      issues: [],
    };

    if (rawP.type === 'chain') {
      // ChainUserProvider is valid — no warnings by default
    } else if (rawP.type === 'custom' && rawP.id) {
      // Find matching PHP class
      const shortId = rawP.id.split('\\').pop() ?? rawP.id;
      const phpClass = phpClasses.find((c) => c.class === shortId || rawP.id === c.class);
      if (phpClass) {
        info.file = path.basename(phpClass.file);
        info.class = phpClass.class;
        info.hasLoadByIdentifier = phpClass.hasLoadByIdentifier;
        info.hasRefreshUser = phpClass.hasRefreshUser;
        info.hasPasswordUpgrader = phpClass.hasPasswordUpgrader;
        info.issues = phpClass.issues;
      }
    } else if (rawP.type === 'entity' && rawP.customRepository) {
      info.issues.push(
        `Entity provider "${rawP.name}" uses custom repository_method: ${rawP.customRepository}. ` +
        `Ensure that method returns a UserInterface — type mismatch will cause runtime error.`,
      );
    }

    results.push(info);
  }

  // PHP classes not linked to any YAML provider
  for (const phpClass of phpClasses) {
    const alreadyListed = results.some((r) => r.class === phpClass.class);
    if (!alreadyListed) {
      results.push({
        name: phpClass.class,
        type: 'custom',
        file: path.basename(phpClass.file),
        class: phpClass.class,
        hasLoadByIdentifier: phpClass.hasLoadByIdentifier,
        hasRefreshUser: phpClass.hasRefreshUser,
        hasPasswordUpgrader: phpClass.hasPasswordUpgrader,
        issues: [
          ...phpClass.issues,
          `${phpClass.class} implements UserProvider but is not referenced in security.yaml providers section.`,
        ],
      });
    }
  }

  return results;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listSecurityUserProviders(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No UserProvider configuration found.\n\n' +
            'Configure providers in config/packages/security.yaml:\n' +
            '  security:\n' +
            '    providers:\n' +
            '      app_user_provider:\n' +
            '        entity: { class: App\\Entity\\User, property: email }',
        }],
      };
    }

    const withIssues = items.filter((i) => i.issues.length > 0);

    let text = `Symfony Security UserProvider Analysis\n${'='.repeat(55)}\n`;
    text += `  Providers: ${items.length}\n`;
    text += `  With issues: ${withIssues.length}\n\n`;

    for (const item of items) {
      text += `${item.name}  [type: ${item.type}]`;
      if (item.class) text += `  class: ${item.class}`;
      text += '\n';
      if (item.file) text += `  file: ${item.file}\n`;
      text += `  loadUserByIdentifier: ${item.hasLoadByIdentifier ? 'yes' : 'no'}  `;
      text += `refreshUser: ${item.hasRefreshUser ? 'yes' : 'no'}  `;
      text += `PasswordUpgrader: ${item.hasPasswordUpgrader ? 'yes' : 'no'}\n`;
      for (const issue of item.issues) {
        text += `  WARN: ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSecurityUserProviderStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    let text = `Security UserProvider Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total providers:            ${items.length}\n`;
    text += `  Entity:                   ${items.filter((i) => i.type === 'entity').length}\n`;
    text += `  Memory:                   ${items.filter((i) => i.type === 'memory').length}\n`;
    text += `  LDAP:                     ${items.filter((i) => i.type === 'ldap').length}\n`;
    text += `  Chain:                    ${items.filter((i) => i.type === 'chain').length}\n`;
    text += `  Custom:                   ${items.filter((i) => i.type === 'custom').length}\n`;
    text += `Has loadUserByIdentifier:   ${items.filter((i) => i.hasLoadByIdentifier).length}\n`;
    text += `Has refreshUser:            ${items.filter((i) => i.hasRefreshUser).length}\n`;
    text += `Has PasswordUpgrader:       ${items.filter((i) => i.hasPasswordUpgrader).length}\n`;
    text += `With issues:                ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getSecurityUserProviderTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_security_user_providers',
      description: 'List Symfony security user providers from security.yaml and src/: entity/memory/ldap/chain/custom types, loadUserByIdentifier/refreshUser/PasswordUpgrader detection, deprecated loadUserByUsername warning',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_security_user_provider_stats',
      description: 'Show security user provider statistics: provider type counts, loadUserByIdentifier/refreshUser/PasswordUpgrader coverage, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
