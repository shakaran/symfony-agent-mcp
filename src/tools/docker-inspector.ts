/**
 * Docker Inspector
 *
 * Dockerfile analysis:
 *   - Base image (php:8.x-fpm, dunglas/frankenphp, etc.)
 *   - PHP extensions installed (docker-php-ext-install / pecl)
 *   - APP_ENV / APP_DEBUG ARG/ENV values
 *   - COPY / RUN composer install steps
 *   - Multi-stage build detection
 *   - User/group (www-data vs root — security flag)
 *
 * docker-compose.yml / docker-compose.override.yml:
 *   - Services: php-fpm, nginx, caddy, db (mysql/postgres/mariadb), redis, rabbitmq
 *   - Port mappings
 *   - Volume mounts (Symfony var/, public/, vendor/)
 *   - Environment variables (APP_ENV, DATABASE_URL — values masked)
 *   - Healthcheck presence per service
 *
 * Analysis:
 *   - PHP version in Dockerfile vs composer.json require.php
 *   - Running as root in production image (security risk)
 *   - vendor/ mounted as volume (overrides production build)
 *   - No healthcheck on critical services
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DockerfileInfo {
  baseImage: string;
  phpVersion?: string;
  extensions: string[];
  isMultiStage: boolean;
  runsAsRoot: boolean;
  hasComposerInstall: boolean;
  appEnv?: string;
  stages: string[];
}

interface DockerService {
  name: string;
  image?: string;
  role: string;
  ports: string[];
  volumes: string[];
  hasHealthcheck: boolean;
  envVars: string[];
  issues: string[];
}

// ─── Dockerfile parsing ───────────────────────────────────────────────────────

function parseDockerfile(appPath: string): DockerfileInfo | null {
  const candidates = ['Dockerfile', 'docker/Dockerfile', 'docker/php/Dockerfile', '.docker/Dockerfile'];
  for (const fname of candidates) {
    const filePath = path.join(appPath, fname);
    if (!fs.existsSync(filePath)) continue;

    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    // Base image (last FROM before the final stage, or first FROM)
    const fromLines = [...content.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+(\w+))?/gim)];
    const baseImage = fromLines[0]?.[1] ?? 'unknown';

    // PHP version from image tag
    const phpVerM = /php:(8\.[0-9]+(?:\.[0-9]+)?)/i.exec(baseImage) ??
                    /php-(8\.[0-9]+)/i.exec(baseImage);
    const phpVersion = phpVerM?.[1];

    // Stages
    const stages = fromLines.map((m) => m[2] ?? 'unnamed').filter(Boolean);
    const isMultiStage = fromLines.length > 1;

    // Extensions
    const extensions: string[] = [];
    for (const m of content.matchAll(/docker-php-ext-install\s+([^\n\\]+)/g)) {
      extensions.push(...m[1].trim().split(/\s+/).filter(Boolean));
    }
    for (const m of content.matchAll(/pecl\s+install\s+([^\s;&]+)/g)) {
      extensions.push(m[1]);
    }

    // Security: running as root?
    const hasUserSwitch = /^USER\s+(?!root)/im.test(content);
    const runsAsRoot = !hasUserSwitch;

    const hasComposerInstall = content.includes('composer install') || content.includes('composer update');

    // APP_ENV
    const appEnvM = /(?:ARG|ENV)\s+APP_ENV=?(\w+)?/.exec(content);
    const appEnv = appEnvM?.[1];

    return { baseImage, phpVersion, extensions: [...new Set(extensions)], isMultiStage, runsAsRoot, hasComposerInstall, appEnv, stages };
  }
  return null;
}

// ─── docker-compose parsing ───────────────────────────────────────────────────

const SERVICE_ROLES: Array<[RegExp, string]> = [
  [/php|fpm|frankenphp|swoole/i, 'PHP'],
  [/nginx|caddy|apache|httpd/i,  'Web server'],
  [/mysql|mariadb|postgres|pgsql/i, 'Database'],
  [/redis|valkey|memcached/i,    'Cache/Queue'],
  [/rabbitmq|kafka|activemq/i,   'Message broker'],
  [/elasticsearch|opensearch|meilisearch|typesense/i, 'Search'],
  [/mailhog|mailpit|smtp/i,      'Mail (dev)'],
  [/worker|consumer|messenger/i, 'Messenger worker'],
];

function detectRole(name: string, image?: string): string {
  const haystack = `${name} ${image ?? ''}`.toLowerCase();
  for (const [pattern, role] of SERVICE_ROLES) {
    if (pattern.test(haystack)) return role;
  }
  return 'other';
}

function maskEnvValue(v: string): string {
  return v.replace(/:\/\/([^:@]+):([^@]+)@/, '://***:***@')
           .replace(/(?:PASSWORD|PASSWD|PASS|SECRET|KEY|TOKEN|API_KEY|CERT|DSN|AUTH|CREDENTIAL|PRIVATE)=.+/i, (m) => m.split('=')[0] + '=***');
}

function parseDockerCompose(appPath: string): DockerService[] {
  const candidates = [
    'docker-compose.yml', 'docker-compose.yaml',
    'compose.yml', 'compose.yaml',
    'docker-compose.override.yml', 'docker-compose.override.yaml',
  ];

  const allServices = new Map<string, DockerService>();

  for (const fname of candidates) {
    const filePath = path.join(appPath, fname);
    if (!fs.existsSync(filePath)) continue;

    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    // Simple line-by-line parse for services section
    const lines = content.split('\n');
    let inServices = false;
    let currentService = '';

    for (const line of lines) {
      if (/^services\s*:/.test(line)) { inServices = true; continue; }
      if (!inServices) continue;

      // Top-level service name (2-space indent)
      const svcM = /^ {2}([a-zA-Z0-9_-]+)\s*:/.exec(line);
      if (svcM && !line.startsWith('   ')) {
        currentService = svcM[1];
        if (!allServices.has(currentService)) {
          allServices.set(currentService, {
            name: currentService,
            role: detectRole(currentService),
            ports: [],
            volumes: [],
            hasHealthcheck: false,
            envVars: [],
            issues: [],
          });
        }
        continue;
      }

      if (!currentService) continue;
      const svc = allServices.get(currentService)!;

      const trimmed = line.trim();
      if (!trimmed) continue;

      // image
      if (/^\s{4}image\s*:/.test(line)) {
        const img = /image\s*:\s*(.+)/.exec(line)?.[1]?.trim();
        if (img) {
          svc.image = img;
          svc.role = detectRole(currentService, img);
        }
      }
      // ports
      if (/^\s+-\s+"?\d+:\d+/.test(line) && content.slice(content.indexOf(line) - 200, content.indexOf(line)).includes('ports')) {
        const port = /["']?(\d+:\d+)/.exec(trimmed)?.[1];
        if (port && !svc.ports.includes(port)) svc.ports.push(port);
      }
      // volumes
      if (/^\s+-\s+[./~]/.test(line)) {
        const vol = trimmed.replace(/^-\s+/, '').replace(/['"]/g, '');
        if (!svc.volumes.includes(vol)) svc.volumes.push(vol);
      }
      // healthcheck
      if (trimmed.startsWith('healthcheck:')) svc.hasHealthcheck = true;
      // env
      const envM = /([A-Z_][A-Z0-9_]*)=(.*)/.exec(trimmed);
      if (envM) svc.envVars.push(`${envM[1]}=${maskEnvValue(envM[2])}`);
    }
  }

  // Audit
  for (const svc of allServices.values()) {
    if (!svc.hasHealthcheck && ['PHP', 'Database', 'Cache/Queue'].includes(svc.role)) {
      svc.issues.push('no healthcheck defined');
    }
    if (svc.volumes.some((v) => v.includes('vendor'))) {
      svc.issues.push('vendor/ mounted as volume — may override production build');
    }
  }

  return [...allServices.values()].sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listDockerConfig(appPath: string): McpToolResult {
  try {
    const dockerfile = parseDockerfile(appPath);
    const services   = parseDockerCompose(appPath);

    if (!dockerfile && services.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Dockerfile or docker-compose.yml found.\n\nCommon Symfony Docker setups:\n  - dunglas/symfony-docker (FrankenPHP)\n  - official php:8.3-fpm + nginx\n  - See https://symfony.com/doc/current/setup/docker.html',
        }],
      };
    }

    let text = `Docker Configuration\n${'='.repeat(55)}\n`;

    if (dockerfile) {
      text += `\nDockerfile:\n`;
      text += `  Base image:    ${dockerfile.baseImage}\n`;
      if (dockerfile.phpVersion) text += `  PHP version:   ${dockerfile.phpVersion}\n`;
      text += `  Multi-stage:   ${dockerfile.isMultiStage ? `yes (${dockerfile.stages.join(' → ')})` : 'no'}\n`;
      text += `  Composer:      ${dockerfile.hasComposerInstall ? 'yes' : 'not found'}\n`;
      text += `  Runs as root:  ${dockerfile.runsAsRoot ? '⚠ yes (add USER instruction)' : '✓ no'}\n`;
      if (dockerfile.appEnv) text += `  APP_ENV:       ${dockerfile.appEnv}\n`;
      if (dockerfile.extensions.length > 0) {
        text += `  Extensions:    ${dockerfile.extensions.join(', ')}\n`;
      }

      // PHP version mismatch check
      try {
        const composer = JSON.parse(fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8')) as Record<string, Record<string, string>>;
        const requiredPhp = composer['require']?.['php'];
        if (dockerfile.phpVersion && requiredPhp) {
          const reqClean = requiredPhp.replace(/[^0-9.]/g, '').slice(0, 3);
          if (reqClean && !requiredPhp.includes(dockerfile.phpVersion.slice(0, 3))) {
            text += `  ⚠ PHP version mismatch: Dockerfile uses ${dockerfile.phpVersion}, composer.json requires "${requiredPhp}"\n`;
          }
        }
      } catch { /* skip */ }
    }

    if (services.length > 0) {
      const withIssues = services.filter((s) => s.issues.length > 0);
      text += `\nDocker services (${services.length}):\n`;

      const byRole = new Map<string, DockerService[]>();
      for (const s of services) {
        const list = byRole.get(s.role) ?? [];
        list.push(s);
        byRole.set(s.role, list);
      }

      for (const [role, svcs] of [...byRole.entries()].sort()) {
        text += `\n  ${role}:\n`;
        for (const s of svcs) {
          const img   = s.image ? `  image: ${s.image}` : '';
          const ports = s.ports.length > 0 ? `  ports: ${s.ports.join(', ')}` : '';
          const hc    = s.hasHealthcheck ? '  ✓ healthcheck' : '';
          text += `    ${s.name}${img}${ports}${hc}\n`;
          for (const issue of s.issues) text += `      ⚠ ${issue}\n`;
        }
      }

      if (withIssues.length > 0) {
        text += `\n⚠ ${withIssues.length} service(s) with issues — review above\n`;
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

export function getDockerStats(appPath: string): McpToolResult {
  try {
    const dockerfile = parseDockerfile(appPath);
    const services   = parseDockerCompose(appPath);

    let text = `Docker Statistics\n${'='.repeat(40)}\n\n`;
    text += `Dockerfile found:    ${dockerfile ? 'yes' : 'no'}\n`;
    if (dockerfile) {
      text += `PHP version:         ${dockerfile.phpVersion ?? 'unknown'}\n`;
      text += `Multi-stage:         ${dockerfile.isMultiStage ? 'yes' : 'no'}\n`;
      text += `Runs as root:        ${dockerfile.runsAsRoot ? 'yes ⚠' : 'no'}\n`;
      text += `Extensions:          ${dockerfile.extensions.length}\n`;
    }
    text += `Compose services:    ${services.length}\n`;
    text += `With healthcheck:    ${services.filter((s) => s.hasHealthcheck).length}\n`;
    text += `Services with issues: ${services.filter((s) => s.issues.length > 0).length}\n`;
    const roles = [...new Set(services.map((s) => s.role))];
    if (roles.length > 0) text += `Roles:               ${roles.join(', ')}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDockerInspectorTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_docker_config',
      description: 'Show Docker configuration: Dockerfile base image, PHP version, extensions, multi-stage build, root-user warning; docker-compose services by role (PHP/DB/cache/broker), ports, healthcheck presence, volume issues',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_docker_stats',
      description: 'Show Docker statistics: Dockerfile found flag, PHP version, multi-stage flag, extension count, compose service count, healthcheck coverage, services with issues',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
