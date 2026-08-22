/**
 * Utilities for parsing Symfony configuration files
 * Handles YAML, PHP, and environment variable parsing
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { cacheManager } from './cache-manager.js';

export interface SymfonyRoute {
  name: string;
  path: string;
  methods: string[];
  controller: string;
  requirements?: Record<string, string>;
  defaults?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface SymfonyService {
  id: string;
  class: string;
  tags: string[];
  arguments?: unknown[];
  calls?: Array<[string, unknown[]]>;
  factory?: string;
  alias?: string;
}

export interface SymfonyConfig {
  app_env: string;
  app_debug: boolean;
  app_version: string;
  database_url?: string;
  services?: Record<string, SymfonyService>;
  parameters?: Record<string, unknown>;
}

export interface EntityProperty {
  name: string;
  type: string;
  nullable: boolean;
  isId: boolean;
  columnName?: string;
}

export interface EntityRelationship {
  name: string;
  type: 'OneToMany' | 'ManyToOne' | 'OneToOne' | 'ManyToMany';
  targetEntity: string;
  mappedBy?: string;
  inversedBy?: string;
}

export interface ParsedEntity {
  name: string;
  file: string;
  namespace: string;
  tableName?: string;
  properties: EntityProperty[];
  relationships: EntityRelationship[];
}

export function parseYamlFile(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return yaml.load(content);
  } catch {
    return null;
  }
}

export function parseEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};

  try {
    if (!fs.existsSync(filePath)) {
      return env;
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1);

      // Strip inline comments (only after unquoted values)
      if (!value.startsWith('"') && !value.startsWith("'")) {
        const commentIdx = value.indexOf(' #');
        if (commentIdx !== -1) value = value.slice(0, commentIdx);
      }

      // Strip surrounding quotes
      value = value.replace(/^["']|["']$/g, '').trim();

      if (key) env[key] = value;
    }
  } catch {
    // Silent - missing env files are normal
  }

  return env;
}

export function loadEnvironmentVariables(appPath: string): Record<string, string> {
  const env: Record<string, string> = {};

  // Symfony loads .env files in order; later ones override earlier ones
  const envFiles = ['.env', '.env.local', '.env.dev', '.env.prod', '.env.test'];

  for (const file of envFiles) {
    const filePath = path.join(appPath, file);
    Object.assign(env, parseEnvFile(filePath));
  }

  return env;
}

/**
 * Parses routes from all Symfony routing configuration sources:
 * - config/routes.yaml
 * - config/routes/*.yaml (routes directory)
 * - PHP attributes on controllers (src/Controller)
 */
export function parseRoutes(appPath: string): SymfonyRoute[] {
  const cacheKey = appPath;
  const watchFiles = [
    path.join(appPath, 'config', 'routes.yaml'),
    path.join(appPath, 'config', 'routes'),
  ];
  const cached = cacheManager.get<SymfonyRoute[]>('routes', cacheKey, watchFiles);
  if (cached) return cached;

  const routes: SymfonyRoute[] = [];
  const seen = new Set<string>();

  // 1. Parse config/routes.yaml
  const routesFile = path.join(appPath, 'config', 'routes.yaml');
  const routesConfig = parseYamlFile(routesFile);
  if (routesConfig && typeof routesConfig === 'object') {
    extractRoutesFromConfig(routesConfig as Record<string, unknown>, routes, seen);
  }

  // 2. Parse config/routes/*.yaml
  const routesDir = path.join(appPath, 'config', 'routes');
  if (fs.existsSync(routesDir)) {
    try {
      const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
      for (const file of files) {
        const cfg = parseYamlFile(path.join(routesDir, file));
        if (cfg && typeof cfg === 'object') {
          extractRoutesFromConfig(cfg as Record<string, unknown>, routes, seen);
        }
      }
    } catch {
      // Directory may not exist or be readable
    }
  }

  // 3. Scan controllers for PHP 8 attribute routes
  const controllerRoutes = parseControllerAttributeRoutes(appPath);
  for (const route of controllerRoutes) {
    if (!seen.has(route.name)) {
      seen.add(route.name);
      routes.push(route);
    }
  }

  cacheManager.set('routes', cacheKey, routes, watchFiles);
  return routes;
}

function extractRoutesFromConfig(
  config: Record<string, unknown>,
  routes: SymfonyRoute[],
  seen: Set<string>
): void {
  for (const [key, value] of Object.entries(config)) {
    if (!value || typeof value !== 'object') continue;

    const routeConfig = value as Record<string, unknown>;

    // Skip resource/prefix imports (they're not direct routes)
    if (routeConfig['resource']) continue;

    const name = key;
    if (seen.has(name)) continue;
    seen.add(name);

    let methods: string[] = ['GET'];
    if (routeConfig['methods']) {
      const m = routeConfig['methods'];
      methods = Array.isArray(m) ? m.map(String) : [String(m)];
    }

    routes.push({
      name,
      path: (routeConfig['path'] as string) || '',
      methods,
      controller: (routeConfig['controller'] as string) || '',
      requirements: routeConfig['requirements'] as Record<string, string> | undefined,
      defaults: routeConfig['defaults'] as Record<string, unknown> | undefined,
      options: routeConfig['options'] as Record<string, unknown> | undefined,
    });
  }
}

/**
 * Parses PHP 8 attribute-based routes from controller files.
 * Handles #[Route('/path', name: 'route_name', methods: ['GET'])]
 */
function parseControllerAttributeRoutes(appPath: string): SymfonyRoute[] {
  const routes: SymfonyRoute[] = [];
  const controllerPath = path.join(appPath, 'src', 'Controller');

  if (!fs.existsSync(controllerPath)) return routes;

  const files = findPhpFiles(controllerPath);

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const controllerClass = extractClassName(content);
      const namespace = extractNamespace(content);
      const fqn = namespace ? `${namespace}\\${controllerClass}` : controllerClass;

      // Class-level prefix route
      const classPrefix = extractClassRoutePrefix(content);

      // Method-level routes
      const methodRoutes = extractMethodRoutes(content, fqn, classPrefix);
      routes.push(...methodRoutes);
    } catch {
      // Skip unreadable files
    }
  }

  return routes;
}

function extractClassRoutePrefix(content: string): string {
  // Match class-level #[Route('/prefix')] before the class declaration
  const classRouteRegex = /#\[Route\(\s*['"](\/[^'"]*)['"]/;
  const classBodyStart = content.indexOf('class ');
  if (classBodyStart === -1) return '';

  const beforeClass = content.slice(0, classBodyStart);
  const match = classRouteRegex.exec(beforeClass);
  return match ? match[1] : '';
}

function extractMethodRoutes(content: string, controllerFqn: string, prefix: string): SymfonyRoute[] {
  const routes: SymfonyRoute[] = [];

  // Match method-level Route attributes
  // #[Route('/path', name: 'name', methods: ['GET', 'POST'])]
  const routeAttrRegex = /#\[Route\(([^)]*)\)\]\s*(?:public|protected|private)?\s*function\s+(\w+)/g;
  let match;

  while ((match = routeAttrRegex.exec(content)) !== null) {
    const attrContent = match[1];
    const methodName = match[2];

    const routePath = extractAttrValue(attrContent, 0) || extractAttrValue(attrContent, 'path') || '';
    const routeName = extractAttrValue(attrContent, 'name') || `${controllerFqn}::${methodName}`;
    const methods = extractAttrMethods(attrContent);

    routes.push({
      name: routeName,
      path: prefix + routePath,
      methods,
      controller: `${controllerFqn}::${methodName}`,
    });
  }

  return routes;
}

function extractAttrValue(attrContent: string, keyOrPosition: string | number): string {
  if (typeof keyOrPosition === 'number' && keyOrPosition === 0) {
    // First positional argument (the path)
    const match = /^\s*['"](\/[^'"]*)['"]/u.exec(attrContent);
    return match ? match[1] : '';
  }

  // Named argument
  const regex = new RegExp(`\\b${keyOrPosition}\\s*:\\s*['"]((?:[^'"\\\\]|\\\\.)*)['"]`);
  const match = regex.exec(attrContent);
  return match ? match[1] : '';
}

function extractAttrMethods(attrContent: string): string[] {
  const methodsMatch = /methods\s*:\s*\[([^\]]+)\]/.exec(attrContent);
  if (!methodsMatch) return ['GET'];

  return methodsMatch[1]
    .split(',')
    .map((m) => m.replace(/['"]/g, '').trim())
    .filter(Boolean);
}

/**
 * Parses services from Symfony container definition
 */
export function parseServices(appPath: string): SymfonyService[] {
  const cacheKey = appPath;
  const servicesFile = path.join(appPath, 'config', 'services.yaml');
  const cached = cacheManager.get<SymfonyService[]>('services', cacheKey, [servicesFile]);
  if (cached) return cached;

  const services: SymfonyService[] = [];
  const servicesConfig = parseYamlFile(servicesFile);

  if (!servicesConfig || typeof servicesConfig !== 'object') {
    cacheManager.set('services', cacheKey, services, [servicesFile]);
    return services;
  }

  const config = servicesConfig as Record<string, unknown>;
  if (!config['services'] || typeof config['services'] !== 'object') return services;

  const servicesObj = config['services'] as Record<string, unknown>;

  for (const [id, value] of Object.entries(servicesObj)) {
    if (value === null || value === undefined) continue;

    const serviceConfig = typeof value === 'object' ? (value as Record<string, unknown>) : { class: String(value) };

    services.push({
      id,
      class: (serviceConfig['class'] as string) || '',
      tags: parseTags(serviceConfig['tags']),
      arguments: serviceConfig['arguments'] as unknown[] | undefined,
      calls: serviceConfig['calls'] as Array<[string, unknown[]]> | undefined,
      factory: serviceConfig['factory'] as string | undefined,
      alias: serviceConfig['alias'] as string | undefined,
    });
  }

  cacheManager.set('services', cacheKey, services, [servicesFile]);
  return services;
}

function parseTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.map((tag) => (typeof tag === 'string' ? tag : (tag as Record<string, unknown>)['name'] as string || ''));
}

/**
 * Parses Doctrine entities from PHP files using attribute and annotation patterns.
 * Supports PHP 8+ attributes and older @ORM annotations.
 */
export function parseEntities(appPath: string): ParsedEntity[] {
  const cacheKey = appPath;
  const entityPath = path.join(appPath, 'src', 'Entity');
  const cached = cacheManager.get<ParsedEntity[]>('entities', cacheKey, [entityPath]);
  if (cached) return cached;

  const entities: ParsedEntity[] = [];

  if (!fs.existsSync(entityPath)) {
    cacheManager.set('entities', cacheKey, entities);
    return entities;
  }

  const files = findPhpFiles(entityPath);

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const entity = parseEntityFile(content, path.basename(file));
      if (entity) entities.push(entity);
    } catch {
      // Skip unreadable files
    }
  }

  cacheManager.set('entities', cacheKey, entities, [entityPath]);
  return entities;
}

function parseEntityFile(content: string, fileName: string): ParsedEntity | null {
  // Must be an ORM entity
  const isEntity =
    /#\[ORM\\Entity/.test(content) ||
    /#\[Entity/.test(content) ||
    /@ORM\\Entity/.test(content) ||
    /@Entity/.test(content);

  if (!isEntity) return null;

  const className = extractClassName(content);
  if (!className) return null;

  const namespace = extractNamespace(content);

  // Extract table name from #[ORM\Table(name: 'xxx')]
  const tableNameMatch = /#\[ORM\\Table\([^)]*name\s*:\s*['"]([\w_]+)['"]/i.exec(content);
  const tableName = tableNameMatch ? tableNameMatch[1] : classToTableName(className);

  const properties = parseEntityProperties(content);
  const relationships = parseEntityRelationships(content);

  return {
    name: className,
    file: fileName,
    namespace,
    tableName,
    properties,
    relationships,
  };
}

function parseEntityProperties(content: string): EntityProperty[] {
  const properties: EntityProperty[] = [];

  // Match properties with ORM\Column attribute (PHP 8+)
  // Handles: #[ORM\Column], #[ORM\Column(type: 'string')], #[ORM\Column(type: Types::STRING)]
  const lines = content.split('\n');
  let isId = false;
  let hasColumnAttr = false;
  let columnName: string | undefined;
  let columnType: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (/#\[ORM\\Id\]/.test(line) || /@ORM\\Id/.test(line)) {
      isId = true;
    }

    if (/#\[ORM\\Column/.test(line) || /@ORM\\Column/.test(line)) {
      hasColumnAttr = true;

      // Extract type from column attribute
      const typeMatch = /type\s*:\s*['"]([\w]+)['"]/i.exec(line) ||
        /type\s*:\s*Types::([\w]+)/i.exec(line);
      columnType = typeMatch ? typeMatch[1] : undefined;

      // Extract column name override
      const nameMatch = /name\s*:\s*['"]([\w_]+)['"]/i.exec(line);
      columnName = nameMatch ? nameMatch[1] : undefined;
    }

    // Detect property declaration
    const propMatch = /(?:private|protected|public)\s+(?:readonly\s+)?\??(?:([\w\\|]+)\s+)?\$(\w+)/.exec(line);

    if (propMatch && hasColumnAttr) {
      const phpType = propMatch[1] || 'mixed';
      const propName = propMatch[2];
      const nullable = line.includes('?') || line.includes('null');

      properties.push({
        name: propName,
        type: columnType || normalizePhpType(phpType),
        nullable,
        isId,
        columnName,
      });

      // Reset flags
      isId = false;
      hasColumnAttr = false;
      columnName = undefined;
      columnType = undefined;
    }

    // Reset flags if we hit another class member that's not a property
    if (/function\s+\w+/.test(line)) {
      isId = false;
      hasColumnAttr = false;
      columnName = undefined;
      columnType = undefined;
    }
  }

  return properties;
}

function parseEntityRelationships(content: string): EntityRelationship[] {
  const relationships: EntityRelationship[] = [];

  const relTypes = ['OneToMany', 'ManyToOne', 'OneToOne', 'ManyToMany'];

  for (const relType of relTypes) {
    // PHP 8 attribute: #[ORM\OneToMany(targetEntity: User::class, mappedBy: 'owner')]
    const attrRegex = new RegExp(
      `#\\[ORM\\\\${relType}\\(([^)]+)\\)\\]\\s*(?:(?:#\\[[^\\]]+\\]\\s*)*)(?:private|protected|public)\\s+(?:readonly\\s+)?\\??(?:[\\w\\\\|]+\\s+)?\\$(\\w+)`,
      'g'
    );

    let match;
    while ((match = attrRegex.exec(content)) !== null) {
      const attrArgs = match[1];
      const propName = match[2];

      const targetMatch = /targetEntity\s*:\s*(?:(\w+)::class|['"]([\w\\]+)['"])/i.exec(attrArgs);
      const targetEntity = targetMatch ? (targetMatch[1] || targetMatch[2]) : 'Unknown';

      const mappedByMatch = /mappedBy\s*:\s*['"]([\w]+)['"]/i.exec(attrArgs);
      const inversedByMatch = /inversedBy\s*:\s*['"]([\w]+)['"]/i.exec(attrArgs);

      relationships.push({
        name: propName,
        type: relType as EntityRelationship['type'],
        targetEntity,
        mappedBy: mappedByMatch ? mappedByMatch[1] : undefined,
        inversedBy: inversedByMatch ? inversedByMatch[1] : undefined,
      });
    }
  }

  return relationships;
}

function normalizePhpType(phpType: string): string {
  const typeMap: Record<string, string> = {
    'int': 'integer',
    'bool': 'boolean',
    'float': 'decimal',
    'string': 'string',
    'DateTime': 'datetime',
    'DateTimeImmutable': 'datetime_immutable',
    'DateTimeInterface': 'datetime',
    'array': 'json',
    'mixed': 'mixed',
  };
  return typeMap[phpType] || phpType;
}

/**
 * Converts a PHP class name to snake_case table name (Doctrine convention).
 * E.g., UserProfile → user_profile
 */
export function classToTableName(className: string): string {
  return className
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

export function readLogFile(appPath: string, fileName: string, lines: number = 50): string[] {
  const logDir = path.join(appPath, 'var', 'log');
  const filePath = path.join(logDir, fileName);

  // Security: prevent directory traversal
  const resolvedLog = path.resolve(logDir);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedLog)) return [];

  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    // Drop blank lines before taking the tail, not after. Every log file ends
    // with a newline, so slicing first spent one of the requested slots on the
    // resulting empty string and returned lines-1 entries.
    return content.split('\n').filter((line) => line.trim() !== '').slice(-lines);
  } catch {
    return [];
  }
}

export function listLogFiles(appPath: string, environment?: string): string[] {
  const logPath = path.join(appPath, 'var', 'log');
  const files: string[] = [];

  try {
    if (!fs.existsSync(logPath)) return files;

    const logFiles = fs.readdirSync(logPath);

    for (const file of logFiles) {
      if (environment && !file.includes(environment)) continue;
      if (file.endsWith('.log')) files.push(file);
    }
  } catch {
    // Silent
  }

  return files;
}

export function getAppConfig(appPath: string): SymfonyConfig {
  const env = loadEnvironmentVariables(appPath);

  return {
    app_env: env['APP_ENV'] || 'prod',
    app_debug: (env['APP_DEBUG'] || 'false').toLowerCase() === 'true',
    app_version: env['APP_VERSION'] || 'unknown',
    database_url: env['DATABASE_URL'],
    parameters: {},
  };
}

export function searchRoutes(
  routes: SymfonyRoute[],
  query: string,
  type: 'name' | 'path' | 'controller' | 'all' = 'all'
): SymfonyRoute[] {
  const lowerQuery = query.toLowerCase();

  return routes.filter((route) => {
    switch (type) {
      case 'name': return route.name.toLowerCase().includes(lowerQuery);
      case 'path': return route.path.toLowerCase().includes(lowerQuery);
      case 'controller': return route.controller.toLowerCase().includes(lowerQuery);
      default:
        return (
          route.name.toLowerCase().includes(lowerQuery) ||
          route.path.toLowerCase().includes(lowerQuery) ||
          route.controller.toLowerCase().includes(lowerQuery)
        );
    }
  });
}

export function searchServices(
  services: SymfonyService[],
  query: string,
  type: 'id' | 'class' | 'tag' | 'all' = 'all'
): SymfonyService[] {
  const lowerQuery = query.toLowerCase();

  return services.filter((service) => {
    switch (type) {
      case 'id': return service.id.toLowerCase().includes(lowerQuery);
      case 'class': return service.class.toLowerCase().includes(lowerQuery);
      case 'tag': return service.tags.some((tag) => tag.toLowerCase().includes(lowerQuery));
      default:
        return (
          service.id.toLowerCase().includes(lowerQuery) ||
          service.class.toLowerCase().includes(lowerQuery) ||
          service.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))
        );
    }
  });
}

// Utility functions

function findPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findPhpFiles(fullPath));
      } else if (entry.name.endsWith('.php')) {
        files.push(fullPath);
      }
    }
  } catch {
    // Skip unreadable directories
  }
  return files;
}

function extractClassName(content: string): string {
  const match = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  return match ? match[1] : '';
}

function extractNamespace(content: string): string {
  const match = /^namespace\s+([\w\\]+)\s*;/m.exec(content);
  return match ? match[1] : '';
}
