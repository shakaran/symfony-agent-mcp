/**
 * Doctrine Repository Pattern Inspector
 *
 * Distinct from doctrine-orm-config.ts (config), entities.ts (entity structure),
 * and doctrine-query-builder.ts (query construction).
 * Focuses on how repositories are declared and injected:
 *
 * Patterns:
 *
 * 1. ServiceEntityRepository (recommended):
 *    class PostRepository extends ServiceEntityRepository
 *    {
 *      public function __construct(ManagerRegistry $registry)
 *      { parent::__construct($registry, Post::class); }
 *    }
 *
 * 2. Interface-based injection (recommended in Symfony 7.x):
 *    interface PostRepositoryInterface { public function findActive(): array; }
 *    class PostRepository extends ServiceEntityRepository implements PostRepositoryInterface { }
 *    // services.yaml: PostRepositoryInterface: '@App\Repository\PostRepository'
 *
 * 3. EntityRepository (legacy — no auto-wiring):
 *    class PostRepository extends EntityRepository { }
 *
 * 4. Entity-embedded repository (legacy — getRepository() in services):
 *    #[ORM\Entity(repositoryClass: PostRepository::class)]
 *
 * 5. Direct EntityManagerInterface injection (bypasses repository abstraction):
 *    $em->getRepository(Post::class)->findBy([...])
 *
 * Analysis:
 *   - EntityRepository (not ServiceEntityRepository) — not auto-wirable
 *   - ServiceEntityRepository without interface — harder to mock in tests
 *   - EntityManagerInterface::getRepository() usage in non-repository files
 *   - Repositories injected as concrete class, not via interface
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface RepositoryInfo {
  class: string;
  file: string;
  extendsType: 'ServiceEntityRepository' | 'EntityRepository' | 'None';
  implementsInterface: boolean;
  interfaceNames: string[];
  entityClass: string;
  issues: string[];
}

interface DirectEmUsage {
  file: string;
  usages: number;
}

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

function parseRepository(filePath: string, appPath: string): RepositoryInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isRepo = content.includes('extends ServiceEntityRepository') ||
                 content.includes('extends EntityRepository') ||
                 (filePath.includes('Repository') && content.includes('class '));
  if (!isRepo) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\')) return null;

  const classM   = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const extendsType: RepositoryInfo['extendsType'] =
    content.includes('extends ServiceEntityRepository') ? 'ServiceEntityRepository'
      : content.includes('extends EntityRepository') ? 'EntityRepository' : 'None';

  if (extendsType === 'None') return null;

  // Detect interface implementation
  const implementsM = /class\s+\w+[^{]*implements\s+([^{]+)/.exec(content);
  const interfaceNames: string[] = [];
  const implementsInterface = !!implementsM;
  if (implementsM) {
    for (const iface of implementsM[1].split(',')) {
      interfaceNames.push(iface.trim());
    }
  }

  // Extract entity class from parent::__construct
  const entityM = /parent::__construct\s*\([^,]+,\s*([A-Za-z0-9_\\]+)::class\s*\)/.exec(content);
  const entityClass = entityM?.[1] ?? 'unknown';

  const issues: string[] = [];
  if (extendsType === 'EntityRepository') {
    issues.push('EntityRepository is legacy — use ServiceEntityRepository for auto-wiring support');
  }
  if (extendsType === 'ServiceEntityRepository' && !implementsInterface) {
    issues.push('Repository without interface — harder to mock in tests; consider PostRepositoryInterface');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    extendsType,
    implementsInterface,
    interfaceNames,
    entityClass,
    issues,
  };
}

function scanDirectEmUsage(appPath: string): DirectEmUsage[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const result: DirectEmUsage[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    if (file.includes('Repository')) continue; // Expected in repo classes
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const count = [...content.matchAll(/->getRepository\s*\(/g)].length;
    if (count > 0) result.push({ file: path.relative(appPath, file), usages: count });
  }
  return result;
}

export function listRepositoryPatterns(appPath: string): McpToolResult {
  try {
    const repoDir = path.join(appPath, 'src', 'Repository');
    const srcDir  = path.join(appPath, 'src');

    const searchDir = fs.existsSync(repoDir) ? repoDir : srcDir;
    const repos: RepositoryInfo[] = [];

    for (const file of getAllPhpFiles(searchDir)) {
      const r = parseRepository(file, appPath);
      if (r) repos.push(r);
    }

    const directEm = scanDirectEmUsage(appPath);
    const totalIssues = repos.reduce((s, r) => s + r.issues.length, 0);

    if (repos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine repository classes found.\n\nCreate with:\n  symfony console make:repository Post\n\nThis generates:\n  class PostRepository extends ServiceEntityRepository\n  {\n    public function __construct(ManagerRegistry $registry)\n    { parent::__construct($registry, Post::class); }\n  }',
        }],
      };
    }

    let text = `Doctrine Repository Patterns\n${'='.repeat(55)}\n`;
    text += `\nRepositories: ${repos.length}  Issues: ${totalIssues}  Direct getRepository() calls: ${directEm.reduce((s, e) => s + e.usages, 0)}\n`;
    text += `  ServiceEntityRepository:  ${repos.filter((r) => r.extendsType === 'ServiceEntityRepository').length}\n`;
    text += `  EntityRepository:         ${repos.filter((r) => r.extendsType === 'EntityRepository').length}\n`;
    text += `  With interface:           ${repos.filter((r) => r.implementsInterface).length}\n`;

    for (const r of repos.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
      const ifaces = r.interfaceNames.length > 0 ? `  implements: ${r.interfaceNames.join(', ')}` : '';
      text += `\n  ${r.class}  entity: ${r.entityClass}  ${r.extendsType}${ifaces}  (${r.file})\n`;
      for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
    }

    if (directEm.length > 0) {
      text += `\nDirect getRepository() calls outside repository classes:\n`;
      for (const e of directEm) text += `  ${e.file}  (${e.usages} call(s))\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRepositoryPatternStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const repos: RepositoryInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseRepository(file, appPath);
        if (r) repos.push(r);
      }
    }
    const directEm = scanDirectEmUsage(appPath);

    let text = `Repository Pattern Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total repositories:        ${repos.length}\n`;
    text += `  ServiceEntityRepository: ${repos.filter((r) => r.extendsType === 'ServiceEntityRepository').length}\n`;
    text += `  EntityRepository:        ${repos.filter((r) => r.extendsType === 'EntityRepository').length}\n`;
    text += `  With interface:          ${repos.filter((r) => r.implementsInterface).length}\n`;
    text += `Direct getRepository():    ${directEm.reduce((s, e) => s + e.usages, 0)}\n`;
    text += `Issues:                    ${repos.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRepositoryPatternTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_repository_patterns',
      description: 'Show Doctrine repository patterns: ServiceEntityRepository vs EntityRepository detection, interface implementation (PostRepositoryInterface), entity class, direct getRepository() calls outside repositories, legacy EntityRepository warning, no-interface warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_repository_pattern_stats',
      description: 'Show repository statistics: total count, ServiceEntityRepository vs EntityRepository split, interface adoption, direct getRepository() call count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
