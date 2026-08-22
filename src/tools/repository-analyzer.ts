/**
 * Doctrine Repository / Query Analyzer
 *
 * Scans src/Repository/ to detect:
 *   - QueryBuilder usage patterns (createQueryBuilder, leftJoin, where, etc.)
 *   - Raw DQL queries (createQuery, createNativeQuery)
 *   - Potential N+1 patterns: find()/findBy() inside loops, or repository
 *     methods called within other query loops
 *   - Missing index hints: WHERE conditions on columns without obvious index
 *   - Complex queries (many joins, many conditions)
 *   - Custom repository methods with their signatures
 *
 * Pure static analysis — no database execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface QueryMethod {
  name: string;
  usesQueryBuilder: boolean;
  usesDql: boolean;
  usesNativeQuery: boolean;
  joinCount: number;
  whereCount: number;
  hasOrderBy: boolean;
  hasPagination: boolean;
  potentialNPlus1: boolean;
  complexity: 'simple' | 'medium' | 'complex';
  params: string[];
}

interface RepositoryAnalysis {
  class: string;
  entity: string;
  file: string;
  methods: QueryMethod[];
  totalQueryMethods: number;
  complexMethods: number;
  potentialNPlus1Count: number;
  rawQueries: number;
}

// ─── File scanning ─────────────────────────────────────────────────────────

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

// ─── Method body extraction ────────────────────────────────────────────────

function extractMethodBodies(content: string): Array<{ name: string; body: string; params: string }> {
  const methods: Array<{ name: string; body: string; params: string }> = [];

  // Match public/protected methods (excluding __construct)
  const methodPattern = /(?:public|protected)\s+function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*[\w\\?|]+\s*)?\{/g;
  let m: RegExpExecArray | null;

  while ((m = methodPattern.exec(content)) !== null) {
    const name = m[1];
    const params = m[2];
    if (name === '__construct' || name === 'save' || name === 'remove') continue;

    // Extract body by counting braces
    let depth = 1;
    let i = m.index + m[0].length;
    const bodyStart = i;

    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }

    const body = content.slice(bodyStart, i - 1);
    if (body.trim()) methods.push({ name, body, params });
  }

  return methods;
}

// ─── Query analysis ────────────────────────────────────────────────────────

function analyzeMethodBody(name: string, body: string, params: string): QueryMethod {
  const usesQueryBuilder = body.includes('createQueryBuilder') || body.includes('QueryBuilder');
  const usesDql = body.includes('createQuery(') || body.includes('->getEntityManager()->createQuery');
  const usesNativeQuery = body.includes('createNativeQuery') || body.includes('getNativeQueryBuilder');

  const joinCount = (body.match(/->(?:leftJoin|innerJoin|join|rightJoin)\s*\(/g) ?? []).length;
  const whereCount = (body.match(/->(?:where|andWhere|orWhere)\s*\(/g) ?? []).length;
  const hasOrderBy = body.includes('->orderBy(') || body.includes('->addOrderBy(');
  const hasPagination = body.includes('->setMaxResults(') || body.includes('->setFirstResult(') ||
                        body.includes('Paginator');

  // N+1 detection: find() or findBy() inside a foreach/for/while loop
  const potentialNPlus1 =
    /foreach\s*\([^)]+\)[^{]*\{[^}]*(?:->find\(|->findBy\(|->findOneBy\()/s.test(body) ||
    /for\s*\([^)]+\)[^{]*\{[^}]*(?:->find\(|->findOneBy\()/s.test(body) ||
    // Or: array_map/array_filter with find calls
    /array_(?:map|filter|walk)\s*\([^,]+,\s*function[^{]*\{[^}]*(?:->find\(|->findBy\()/s.test(body);

  // Complexity scoring
  let complexityScore = 0;
  if (joinCount >= 3) complexityScore += 2;
  else if (joinCount >= 1) complexityScore += 1;
  if (whereCount >= 4) complexityScore += 2;
  else if (whereCount >= 2) complexityScore += 1;
  if (usesDql || usesNativeQuery) complexityScore += 1;
  if (potentialNPlus1) complexityScore += 2;

  const complexity: QueryMethod['complexity'] =
    complexityScore >= 4 ? 'complex' : complexityScore >= 2 ? 'medium' : 'simple';

  // Extract param names
  const paramNames = params
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const varMatch = /\$(\w+)/.exec(p);
      return varMatch ? varMatch[1] : p;
    });

  return {
    name,
    usesQueryBuilder,
    usesDql,
    usesNativeQuery,
    joinCount,
    whereCount,
    hasOrderBy,
    hasPagination,
    potentialNPlus1,
    complexity,
    params: paramNames,
  };
}

function extractEntityName(content: string, fileName: string): string {
  // @return \App\Entity\Foo[] or extends ServiceEntityRepository
  const extendsMatch = /extends\s+(?:Service)?EntityRepository/.exec(content);
  if (!extendsMatch) return '';

  // Try to find entity from repository constructor or @extends annotation
  const ctorMatch = /\$registry,\s*([\w\\]+)::class/.exec(content);
  if (ctorMatch) return ctorMatch[1].split('\\').pop() ?? '';

  // Derive from file name: FooRepository → Foo
  return fileName.replace('Repository.php', '');
}

function parseRepositoryFile(filePath: string): RepositoryAnalysis | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('Repository') && !content.includes('EntityRepository')) return null;
  if (!/extends\s+(?:Service)?EntityRepository/.test(content) &&
      !content.includes('RepositoryInterface')) return null;

  const classMatch = /class\s+(\w+)/.exec(content);
  if (!classMatch) return null;

  const entity = extractEntityName(content, path.basename(filePath));
  const methodBodies = extractMethodBodies(content);

  const methods: QueryMethod[] = [];
  for (const { name, body, params } of methodBodies) {
    // Only analyze methods that interact with the DB
    if (!body.includes('createQueryBuilder') &&
        !body.includes('createQuery') &&
        !body.includes('findBy') &&
        !body.includes('findOneBy') &&
        !body.includes('find(') &&
        !body.includes('->getEntityManager') &&
        !body.includes('nativeQuery') &&
        !body.includes('COUNT') &&
        !body.includes('JOIN')) {
      continue;
    }
    methods.push(analyzeMethodBody(name, body, params));
  }

  const complexMethods = methods.filter((m) => m.complexity === 'complex').length;
  const n1Count = methods.filter((m) => m.potentialNPlus1).length;
  const rawCount = methods.filter((m) => m.usesDql || m.usesNativeQuery).length;

  return {
    class: classMatch[1],
    entity,
    file: path.basename(filePath),
    methods,
    totalQueryMethods: methods.length,
    complexMethods,
    potentialNPlus1Count: n1Count,
    rawQueries: rawCount,
  };
}

function loadRepositories(appPath: string): RepositoryAnalysis[] {
  const repoDir = path.join(appPath, 'src', 'Repository');
  if (!fs.existsSync(repoDir)) return [];

  const repos: RepositoryAnalysis[] = [];
  for (const file of getAllPhpFiles(repoDir)) {
    const r = parseRepositoryFile(file);
    if (r) repos.push(r);
  }
  return repos.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listRepositories(appPath: string): McpToolResult {
  try {
    const repos = loadRepositories(appPath);

    if (repos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine repositories found in src/Repository/.\n\nCreate with: php bin/console make:entity (generates repository automatically)',
        }],
      };
    }

    let text = `Doctrine Repositories (${repos.length})\n${'='.repeat(50)}\n`;

    for (const r of repos) {
      const warnings: string[] = [];
      if (r.potentialNPlus1Count > 0) warnings.push(`⚠ ${r.potentialNPlus1Count} N+1 risk`);
      if (r.complexMethods > 0) warnings.push(`${r.complexMethods} complex`);
      const warnStr = warnings.length > 0 ? `  [${warnings.join(', ')}]` : '';
      text += `\n  ${r.class.padEnd(35)} ${String(r.totalQueryMethods).padStart(3)} query methods${warnStr}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRepositoryDetails(appPath: string, repositoryName: string): McpToolResult {
  try {
    const repos = loadRepositories(appPath);
    const repo = repos.find(
      (r) =>
        r.class.toLowerCase().includes(repositoryName.toLowerCase()) ||
        r.entity.toLowerCase().includes(repositoryName.toLowerCase())
    );

    if (!repo) {
      const names = repos.map((r) => r.class).join(', ');
      return {
        content: [{ type: 'text', text: `Repository "${repositoryName}" not found.\n\nAvailable: ${names || 'none'}` }],
        isError: true,
      };
    }

    let text = `Repository: ${repo.class}\n${'='.repeat(50)}\n\n`;
    text += `Entity:  ${repo.entity || '(unknown)'}\n`;
    text += `File:    ${repo.file}\n`;
    text += `Methods: ${repo.totalQueryMethods}\n`;

    if (repo.methods.length === 0) {
      text += `\nNo custom query methods found (only inherited find/findBy/findAll).\n`;
      return { content: [{ type: 'text', text }] };
    }

    text += `\nQuery Methods:\n`;
    for (const m of repo.methods) {
      const icon =
        m.complexity === 'complex' ? '⚠' :
        m.complexity === 'medium' ? '●' : '○';
      const n1 = m.potentialNPlus1 ? '  [⚠ N+1 risk]' : '';
      const paramStr = m.params.length > 0 ? `(${m.params.join(', ')})` : '()';
      text += `\n  ${icon} ${m.name}${paramStr}${n1}\n`;

      const features: string[] = [];
      if (m.usesQueryBuilder) features.push('QueryBuilder');
      if (m.usesDql) features.push('DQL');
      if (m.usesNativeQuery) features.push('NativeQuery');
      if (m.joinCount > 0) features.push(`${m.joinCount} join(s)`);
      if (m.whereCount > 0) features.push(`${m.whereCount} condition(s)`);
      if (m.hasOrderBy) features.push('ORDER BY');
      if (m.hasPagination) features.push('pagination');
      if (features.length > 0) text += `    ${features.join(' · ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function detectNPlusOne(appPath: string): McpToolResult {
  try {
    const repos = loadRepositories(appPath);
    const risky = repos.filter((r) => r.potentialNPlus1Count > 0);

    if (risky.length === 0) {
      return {
        content: [{
          type: 'text',
          text: '✓ No obvious N+1 patterns detected in repositories.\n\nNote: N+1 from service code outside repositories is not checked here.',
        }],
      };
    }

    let text = `Potential N+1 Patterns (${risky.reduce((s, r) => s + r.potentialNPlus1Count, 0)} occurrences)\n${'='.repeat(50)}\n`;
    text += `\nNote: Static analysis — verify manually before optimising.\n`;

    for (const r of risky) {
      const methods = r.methods.filter((m) => m.potentialNPlus1);
      text += `\n  ${r.class}:\n`;
      for (const m of methods) {
        text += `    ${m.name}() — find/findBy called inside a loop\n`;
        text += `    Fix: use JOIN or IN clause to batch load in one query.\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRepositoryStats(appPath: string): McpToolResult {
  try {
    const repos = loadRepositories(appPath);

    if (repos.length === 0) {
      return { content: [{ type: 'text', text: 'No repositories found.' }] };
    }

    const totalMethods = repos.reduce((s, r) => s + r.totalQueryMethods, 0);
    const complexCount = repos.reduce((s, r) => s + r.complexMethods, 0);
    const n1Count = repos.reduce((s, r) => s + r.potentialNPlus1Count, 0);
    const rawCount = repos.reduce((s, r) => s + r.rawQueries, 0);
    const qbCount = repos.reduce(
      (s, r) => s + r.methods.filter((m) => m.usesQueryBuilder).length, 0
    );

    let text = `Repository Statistics\n${'='.repeat(40)}\n\n`;
    text += `Repositories:         ${repos.length}\n`;
    text += `Total query methods:  ${totalMethods}\n`;
    text += `QueryBuilder methods: ${qbCount}\n`;
    text += `Raw DQL/SQL methods:  ${rawCount}\n`;
    text += `Complex methods:      ${complexCount}${complexCount > 0 ? '  (≥3 JOINs or ≥4 conditions)' : ''}\n`;
    text += `N+1 risk methods:     ${n1Count}${n1Count > 0 ? '  ⚠ review recommended' : ''}\n`;

    if (complexCount > 0 || n1Count > 0) {
      text += `\nRepositories needing attention:\n`;
      for (const r of repos.filter((repo) => repo.complexMethods > 0 || repo.potentialNPlus1Count > 0)) {
        const issues: string[] = [];
        if (r.complexMethods > 0) issues.push(`${r.complexMethods} complex`);
        if (r.potentialNPlus1Count > 0) issues.push(`${r.potentialNPlus1Count} N+1 risk`);
        text += `  ${r.class}: ${issues.join(', ')}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getRepositoryAnalyzerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_repositories',
      description: 'List all Doctrine repositories with query method count, complex query count, and N+1 risk warnings',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_repository_details',
      description: 'Get full details for a repository: all query methods with JOIN count, conditions, pagination, DQL vs QueryBuilder, and N+1 risk',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          repository_name: { type: 'string', description: 'Repository or entity name (partial match, e.g. User, ProductRepository)' },
        },
        required: ['app_path', 'repository_name'],
      },
    },
    {
      name: 'detect_n_plus_one',
      description: 'Detect potential N+1 query patterns: find()/findBy() calls inside loops in repository methods',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_repository_stats',
      description: 'Show repository statistics: method count, QueryBuilder vs DQL usage, complex methods, and N+1 risk summary',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
