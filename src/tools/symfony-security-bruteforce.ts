import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface BruteforceProtectionInfo {
  source: string;
  type: 'login-throttle' | 'rate-limit' | 'captcha' | 'custom';
  pattern: string;
  issues: string[];
}

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

function readFileSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function buildSymfonySecurityBruteforceInfos(appPath: string): BruteforceProtectionInfo[] {
  const results: BruteforceProtectionInfo[] = [];

  // Check security.yaml for login_throttling
  const securityYaml = path.join(appPath, 'config', 'packages', 'security.yaml');
  if (fs.existsSync(securityYaml)) {
    const content = readFileSafe(securityYaml);
    if (content.includes('login_throttling')) {
      const attemptsMatch = content.match(/max_attempts:\s*(\d+)/);
      const maxAttempts = attemptsMatch ? parseInt(attemptsMatch[1], 10) : 0;
      const issues: string[] = [];
      if (maxAttempts > 20) {
        issues.push(`login_throttling.max_attempts=${maxAttempts} is high — consider 5-10 attempts per minute/hour for production security`);
      }
      results.push({ source: 'config/packages/security.yaml', type: 'login-throttle', pattern: 'login_throttling configured', issues });
    } else if (content.includes('form_login')) {
      results.push({ source: 'config/packages/security.yaml', type: 'login-throttle', pattern: 'form_login without login_throttling', issues: ["Login firewall without login_throttling — brute force protection disabled; add login_throttling: max_attempts: 5 interval: '1 minute' (requires symfony/rate-limiter)"] });
    }
  }

  // Check rate limiter in services.yaml or framework.yaml
  const rateLimiterFiles = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'services.yaml'),
  ];
  let hasRateLimiter = false;
  for (const cfgFile of rateLimiterFiles) {
    if (!fs.existsSync(cfgFile)) continue;
    const content = readFileSafe(cfgFile);
    if (content.includes('rate_limiter')) {
      hasRateLimiter = true;
      results.push({ source: path.relative(appPath, cfgFile), type: 'rate-limit', pattern: 'rate_limiter configured', issues: [] });
      break;
    }
  }
  if (!hasRateLimiter) {
    results.push({ source: 'config', type: 'rate-limit', pattern: 'no rate limiter', issues: ['No rate limiter configured for login — add a rate limiter to prevent brute force attacks on authentication endpoints'] });
  }

  // Scan PHP files for captcha integration
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const captchaBundles = ['friendsofsymfony/captcha-bundle', 'karser/recaptcha-bundle', 'EWZ\\Bundle\\RecaptchaBundle'];
    for (const file of getAllPhpFiles(srcDir)) {
      const content = safeRead(file, appPath);
      if (content === null) continue;
      for (const bundle of captchaBundles) {
        if (content.includes(bundle)) {
          results.push({ source: path.relative(appPath, file), type: 'captcha', pattern: bundle, issues: [] });
          break;
        }
      }
    }
  }

  // Also check composer.json for captcha bundles
  const composerJson = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerJson)) {
    const content = readFileSafe(composerJson);
    if (content.includes('karser/recaptcha-bundle') || content.includes('friendsofsymfony/captcha-bundle')) {
      results.push({ source: 'composer.json', type: 'captcha', pattern: 'captcha bundle in composer.json', issues: [] });
    }
  }

  return results;
}

export function listSymfonySecurityBruteforce(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonySecurityBruteforceInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No brute force protection configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Security Brute Force Protection Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySecurityBruteforceStats(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonySecurityBruteforceInfos(appPath);
    let text = `Symfony Security Brute Force Statistics\n${'='.repeat(40)}\n\n`;
    text += `Login-throttle:  ${infos.filter((i) => i.type === 'login-throttle').length}\n`;
    text += `Rate-limit:      ${infos.filter((i) => i.type === 'rate-limit').length}\n`;
    text += `Captcha:         ${infos.filter((i) => i.type === 'captcha').length}\n`;
    text += `Custom:          ${infos.filter((i) => i.type === 'custom').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySecurityBruteforceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_security_bruteforce', description: 'Analyze Symfony brute force protection: login_throttling configuration, rate limiters, captcha integration, missing protections', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_security_bruteforce_stats', description: 'Statistics for brute force protection: counts by type (login-throttle/rate-limit/captcha/custom) and total issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
