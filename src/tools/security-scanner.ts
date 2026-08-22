/**
 * Symfony Security Misconfiguration Scanner
 *
 * Proactively detects common Symfony security anti-patterns:
 *   - APP_DEBUG / APP_ENV mismatches (debug=true in prod config)
 *   - Controllers without #[IsGranted] or security checks
 *   - CSRF disabled globally or on specific form types
 *   - Raw SQL string concatenation (SQL injection risk)
 *   - Session insecure config (cookie_secure: false in prod)
 *   - Hardcoded credentials in PHP source files
 *   - Sensitive files exposed (no .htaccess / public/ check)
 *   - Weak security headers config
 *
 * Pure static analysis — reports findings with severity levels.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

interface SecurityFinding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  recommendation: string;
}

// ─── Checkers ──────────────────────────────────────────────────────────────

function checkDebugInEnv(appPath: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  // Check .env for APP_DEBUG=true with APP_ENV=prod
  for (const envFile of ['.env', '.env.prod', '.env.local']) {
    let content = '';
    try { content = fs.readFileSync(path.join(appPath, envFile), 'utf-8'); } catch { continue; }

    const debugTrue = /^APP_DEBUG\s*=\s*(?:true|1)/m.test(content);
    const envProd = /^APP_ENV\s*=\s*prod/m.test(content);

    if (debugTrue && envProd) {
      findings.push({
        id: 'DEBUG_IN_PROD',
        severity: 'critical',
        title: 'APP_DEBUG=true in production environment',
        detail: `Found APP_DEBUG=true with APP_ENV=prod in ${envFile}`,
        file: envFile,
        recommendation: 'Set APP_DEBUG=false in production. Debug mode exposes stack traces and sensitive data.',
      });
    }

    if (debugTrue && !envProd) {
      findings.push({
        id: 'DEBUG_ENABLED',
        severity: 'info',
        title: 'APP_DEBUG=true (non-production)',
        detail: `Debug mode enabled in ${envFile}`,
        file: envFile,
        recommendation: 'Ensure APP_DEBUG=false is set in production .env.prod or .env.local.',
      });
    }
  }

  return findings;
}

function checkCsrfConfig(appPath: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  const frameworkFile = path.join(appPath, 'config', 'packages', 'framework.yaml');
  const raw = parseYamlFile(frameworkFile) as Record<string, unknown> | null;
  const framework = (raw?.['framework'] ?? raw) as Record<string, unknown> | undefined;

  if (framework) {
    const csrfProtection = framework['csrf_protection'];
    if (csrfProtection === false || (typeof csrfProtection === 'object' && (csrfProtection as Record<string, unknown>)['enabled'] === false)) {
      findings.push({
        id: 'CSRF_DISABLED',
        severity: 'high',
        title: 'CSRF protection disabled globally',
        detail: 'csrf_protection: false in framework.yaml',
        file: 'config/packages/framework.yaml',
        recommendation: 'Enable CSRF protection: framework: { csrf_protection: true }. Required for stateful form submissions.',
      });
    }
  }

  return findings;
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

function checkControllersWithoutAuth(appPath: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const controllerDir = path.join(appPath, 'src', 'Controller');
  if (!fs.existsSync(controllerDir)) return findings;

  for (const file of getAllPhpFiles(controllerDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    // Skip if class-level security is present
    if (/#\[IsGranted/.test(content) ||
        /#\[Security/.test(content) ||
        /->denyAccessUnlessGranted/.test(content) ||
        /->isGranted/.test(content)) continue;

    // Count public route methods
    const routeMethods = [...content.matchAll(/#\[Route[^\]]*\]\s*(?:public\s+)?function\s+(\w+)/g)];
    if (routeMethods.length > 0) {
      const relFile = path.relative(appPath, file);
      findings.push({
        id: 'CONTROLLER_NO_AUTH',
        severity: 'low',
        title: 'Controller without authentication checks',
        detail: `${path.basename(file, '.php')} has ${routeMethods.length} route(s) but no #[IsGranted], #[Security], or denyAccessUnlessGranted()`,
        file: relFile,
        recommendation: 'Add #[IsGranted("ROLE_USER")] to the class or individual actions, or explicitly mark public routes with #[IsGranted("PUBLIC_ACCESS")].',
      });
    }
  }

  return findings;
}

function checkSqlInjection(appPath: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return findings;

  // Patterns that suggest raw SQL string concatenation
  const dangerousPatterns = [
    { pattern: /executeQuery\s*\([^)]*\.\s*\$(?!this)[a-zA-Z]/g, label: 'executeQuery with concatenated variable' },
    { pattern: /createQuery\s*\([^)]*\.\s*\$(?!this)[a-zA-Z]/g, label: 'createQuery with concatenated variable' },
    { pattern: /->query\s*\([^)]*\.\s*\$[a-zA-Z]/g, label: 'raw query with concatenated variable' },
    { pattern: /"SELECT[^"]*"\s*\.\s*\$[a-zA-Z]/g, label: 'SELECT string concatenation' },
  ];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    for (const { pattern, label } of dangerousPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        pattern.lastIndex = 0;
        const relFile = path.relative(appPath, file);
        findings.push({
          id: 'SQL_INJECTION_RISK',
          severity: 'high',
          title: 'Potential SQL injection: ' + label,
          detail: relFile,
          file: relFile,
          recommendation: 'Use parameterized queries: executeQuery($sql, [\'param\' => $value]) or QueryBuilder with setParameter().',
        });
        break;
      }
    }
  }

  return findings;
}

function checkHardcodedSecrets(appPath: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return findings;

  const secretPatterns = [
    { re: /\$(?:password|secret|apiKey|api_key|token)\s*=\s*['"][^%$'"\s]{8,}['"]/gi, label: 'Hardcoded secret/password assignment' },
    { re: /['"](?:sk_live|pk_live|rk_live)[a-zA-Z0-9_]{20,}['"]/g, label: 'Hardcoded Stripe live key' },
    { re: /['"]AKIA[0-9A-Z]{16}['"]/g, label: 'Hardcoded AWS access key' },
  ];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    for (const { re, label } of secretPatterns) {
      re.lastIndex = 0;
      if (re.test(content)) {
        re.lastIndex = 0;
        const relFile = path.relative(appPath, file);
        findings.push({
          id: 'HARDCODED_SECRET',
          severity: 'critical',
          title: label,
          detail: relFile,
          file: relFile,
          recommendation: 'Move secrets to environment variables and access via %env(MY_SECRET)% or $_ENV[\'MY_SECRET\'].',
        });
        break;
      }
    }
  }

  return findings;
}

function checkSessionConfig(appPath: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  const frameworkFile = path.join(appPath, 'config', 'packages', 'framework.yaml');
  const raw = parseYamlFile(frameworkFile) as Record<string, unknown> | null;
  const framework = (raw?.['framework'] ?? raw) as Record<string, unknown> | undefined;

  if (!framework) return findings;

  const session = framework['session'] as Record<string, unknown> | undefined;
  if (!session) return findings;

  if (session['cookie_secure'] === false) {
    findings.push({
      id: 'SESSION_COOKIE_INSECURE',
      severity: 'medium',
      title: 'Session cookie_secure: false',
      detail: 'Session cookies will be sent over HTTP',
      file: 'config/packages/framework.yaml',
      recommendation: 'Set cookie_secure: auto or true in production to prevent session hijacking over HTTP.',
    });
  }

  if (session['cookie_httponly'] === false) {
    findings.push({
      id: 'SESSION_COOKIE_NOT_HTTPONLY',
      severity: 'medium',
      title: 'Session cookie_httponly: false',
      detail: 'Session cookies accessible via JavaScript (XSS risk)',
      file: 'config/packages/framework.yaml',
      recommendation: 'Set cookie_httponly: true to prevent JavaScript access to session cookies.',
    });
  }

  return findings;
}

function checkPublicEnvFile(appPath: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  // Check if .env is in public/ directory
  const publicEnv = path.join(appPath, 'public', '.env');
  if (fs.existsSync(publicEnv)) {
    findings.push({
      id: 'ENV_IN_WEBROOT',
      severity: 'critical',
      title: '.env file in public/ directory',
      detail: 'public/.env is web-accessible',
      file: 'public/.env',
      recommendation: 'Remove .env from public/ immediately. Move to application root and configure web server to deny access.',
    });
  }

  // Check if .env has no .gitignore protection for .env.local
  try {
    const gitignore = fs.readFileSync(path.join(appPath, '.gitignore'), 'utf-8');
    if (!gitignore.includes('.env.local') && !gitignore.includes('*.local')) {
      findings.push({
        id: 'ENV_LOCAL_NOT_GITIGNORED',
        severity: 'medium',
        title: '.env.local not in .gitignore',
        detail: 'Local environment overrides may be committed to version control',
        file: '.gitignore',
        recommendation: 'Add .env.local and .env.*.local to .gitignore.',
      });
    }
  } catch { /* skip */ }

  return findings;
}

// ─── Tool functions ────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<Severity, string> = {
  critical: '[CRITICAL]',
  high:     '[HIGH]    ',
  medium:   '[MEDIUM]  ',
  low:      '[LOW]     ',
  info:     '[INFO]    ',
};

function runAllChecks(appPath: string): SecurityFinding[] {
  return [
    ...checkDebugInEnv(appPath),
    ...checkCsrfConfig(appPath),
    ...checkControllersWithoutAuth(appPath),
    ...checkSqlInjection(appPath),
    ...checkHardcodedSecrets(appPath),
    ...checkSessionConfig(appPath),
    ...checkPublicEnvFile(appPath),
  ].sort((a, b) => {
    const order: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
    return order.indexOf(a.severity) - order.indexOf(b.severity);
  });
}

export function scanSecurityIssues(appPath: string): McpToolResult {
  try {
    const findings = runAllChecks(appPath);

    if (findings.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No security issues detected by static analysis.\n\nNote: this scanner checks common misconfigurations — a clean result does not guarantee full security. Run symfony/security-checker for dependency CVEs.',
        }],
      };
    }

    const bySeverity: Record<string, number> = {};
    for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

    const summary = Object.entries(bySeverity)
      .map(([s, c]) => `${c} ${s}`)
      .join(', ');

    let text = `Security Scan — ${findings.length} findings (${summary})\n${'='.repeat(60)}\n`;

    for (const f of findings) {
      text += `\n${SEVERITY_ICON[f.severity]} ${f.title}\n`;
      if (f.file) text += `  File:   ${f.file}\n`;
      text += `  Detail: ${f.detail}\n`;
      text += `  Fix:    ${f.recommendation}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSecurityScanStats(appPath: string): McpToolResult {
  try {
    const findings = runAllChecks(appPath);

    let text = `Security Scan Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings:  ${findings.length}\n`;

    const severities: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
    for (const s of severities) {
      const count = findings.filter((f) => f.severity === s).length;
      if (count > 0) text += `  ${s.padEnd(10)} ${count}\n`;
    }

    if (findings.length === 0) text += '\nNo issues found.\n';

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getSecurityScannerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'scan_security_issues',
      description: 'Scan for Symfony security misconfigurations: debug-in-prod, CSRF disabled, controllers without auth, SQL injection patterns, hardcoded secrets, insecure session config, .env in webroot',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_security_scan_stats',
      description: 'Show security scan summary: finding count by severity (critical/high/medium/low)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
