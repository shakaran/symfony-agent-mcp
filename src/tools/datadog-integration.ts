import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DatadogIntegrationInfo {
  file: string;
  type: 'tracer' | 'span' | 'log' | 'metric' | 'config' | 'env';
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

function buildDatadogInfos(appPath: string): DatadogIntegrationInfo[] {
  const results: DatadogIntegrationInfo[] = [];

  let hasDdtrace = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['datadog/dd-trace'] || req['datadog/opentelemetry-shim'] || req['symfony/datadog-bundle']) hasDdtrace = true;
    } catch { /* ignore */ }
  }

  const envFiles = ['.env', '.env.local', '.env.production'];
  const ddEnvVars = new Set<string>();
  for (const envFile of envFiles) {
    const envPath = path.join(appPath, envFile);
    if (!fs.existsSync(envPath)) continue;
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf-8'); } catch { continue; }
    const ddLines = content.split('\n').filter((l) => l.startsWith('DD_'));
    for (const line of ddLines) {
      const key = line.split('=')[0] ?? '';
      if (key) ddEnvVars.add(key);
    }
  }

  if (ddEnvVars.size > 0) {
    const issues: string[] = [];
    if (!ddEnvVars.has('DD_SERVICE')) {
      issues.push('DD_SERVICE env var not set — all traces appear under the default "unnamed-php-service" in Datadog APM');
    }
    if (!ddEnvVars.has('DD_ENV')) {
      issues.push('DD_ENV not set — Datadog cannot separate staging/production traces in the Service Catalog');
    }
    if (!ddEnvVars.has('DD_VERSION')) {
      issues.push('DD_VERSION not set — error tracking cannot correlate errors to deployment versions');
    }
    const apiKeySet = ddEnvVars.has('DD_API_KEY');
    if (apiKeySet) {
      issues.push('DD_API_KEY found in env file — API key should be injected via the Datadog Agent or secrets manager, not stored in .env files');
    }
    results.push({ file: '.env', type: 'env', pattern: `${ddEnvVars.size} DD_ vars`, issues });
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      const content = safeRead(file, appPath) ?? '';
      if (!content) continue;

      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      const hasTracer = content.includes('DDTrace\\') || content.includes('\\DDTrace') ||
        content.includes('GlobalTracer::get()') || content.includes('dd_trace_serialize_closed_spans');

      if (!hasTracer) continue;

      if (content.includes('startSpan(') || content.includes('startActiveSpan(')) {
        const hasFinish = content.includes('->finish(') || content.includes('->deactivate(') || content.includes('try {');
        if (!hasFinish) {
          issues.push('Span started but ->finish() not found — spans that never finish accumulate memory; always close spans in a finally block');
        }
        results.push({ file: relFile, type: 'span', pattern: 'manual span', issues });
      }

      if (content.includes('setTag(') || content.includes('setMeta(')) {
        const piiPatterns = ['email', 'password', 'token', 'secret', 'credit_card', 'ssn', 'phone'];
        const matchedPii = piiPatterns.filter((p) => content.toLowerCase().includes(`'${p}'`) || content.toLowerCase().includes(`"${p}"`));
        if (matchedPii.length > 0) {
          issues.push(`Span tags may include PII fields: ${matchedPii.join(', ')} — Datadog ingests and stores tags; use obfuscation rules or remove PII from traces`);
          results.push({ file: relFile, type: 'span', pattern: 'span with PII tags', issues });
        }
      }

      if (content.includes('trace_id') || content.includes('span_id')) {
        const inLog = content.includes('Logger') || content.includes('logger') || content.includes('$log');
        if (inLog) {
          results.push({ file: relFile, type: 'log', pattern: 'trace correlation in log', issues: [] });
        }
      }
    }
  }

  if (!hasDdtrace && ddEnvVars.size === 0 && results.length === 0) {
    results.push({ file: 'composer.json', type: 'config', pattern: 'no datadog', issues: ['No Datadog APM integration found (no datadog/dd-trace package, no DD_ env vars)'] });
  }

  return results;
}

export function listDatadogIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildDatadogInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Datadog APM integration found (no ddtrace package or DD_ environment variables).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Datadog APM Integration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDatadogIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildDatadogInfos(appPath);
    let text = `Datadog Statistics\n${'='.repeat(40)}\n\n`;
    text += `Tracer usages: ${infos.filter((i) => i.type === 'tracer').length}\n`;
    text += `Custom spans:  ${infos.filter((i) => i.type === 'span').length}\n`;
    text += `Log correl.:   ${infos.filter((i) => i.type === 'log').length}\n`;
    text += `Env vars:      ${infos.filter((i) => i.type === 'env').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDatadogIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_datadog_integration', description: 'Detect Datadog APM ddtrace usage; warns on missing DD_SERVICE/DD_ENV/DD_VERSION, API key in .env, spans not finished, PII in span tags', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_datadog_integration_stats', description: 'Statistics for Datadog: tracer/span/log/env count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
