import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SentryPerformanceTracingInfo {
  source: string;
  type: 'config' | 'env' | 'php';
  key: string;
  value: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecrets(value: string): string {
  return value.replace(/([A-Za-z_][A-Za-z0-9_]*\s*=\s*)[^\s$#'"]{8,}/g, '$1***');
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildSentryPerformanceTracingInfos(appPath: string): SentryPerformanceTracingInfo[] {
  const results: SentryPerformanceTracingInfo[] = [];

  // config/packages/sentry.yaml
  const sentryYamlPath = path.join(appPath, 'config', 'packages', 'sentry.yaml');
  const sentryYamlContent = safeRead(sentryYamlPath, appPath);
  if (sentryYamlContent) {
    const relFile = path.relative(appPath, sentryYamlPath);

    const tracingEnabledM = /tracing\s*:\s*\n[^\n]{0,100}enabled\s*:\s*([^\n]{1,50})/.exec(sentryYamlContent);
    if (tracingEnabledM) {
      results.push({
        source: relFile,
        type: 'config',
        key: 'tracing.enabled',
        value: tracingEnabledM[1].trim(),
        issue: null,
      });
    }

    const tracesSampleRateM = /traces_sample_rate\s*:\s*([^\n]{1,50})/.exec(sentryYamlContent);
    if (tracesSampleRateM) {
      const val = tracesSampleRateM[1].trim();
      const numVal = parseFloat(val.replace(/[^0-9.]/g, ''));
      results.push({
        source: relFile,
        type: 'config',
        key: 'traces_sample_rate',
        value: val,
        issue: numVal >= 1.0
          ? `traces_sample_rate: ${val} means 100% of transactions are traced — this causes significant performance overhead in production; use 0.1–0.2 (10–20%) unless debugging`
          : null,
      });
    }

    const profilesSampleRateM = /profiles_sample_rate\s*:\s*([^\n]{1,50})/.exec(sentryYamlContent);
    if (profilesSampleRateM) {
      const val = profilesSampleRateM[1].trim();
      const tracingEnabled = sentryYamlContent.includes('tracing') && (
        sentryYamlContent.includes('enabled: true') ||
        sentryYamlContent.includes('traces_sample_rate')
      );
      results.push({
        source: relFile,
        type: 'config',
        key: 'profiles_sample_rate',
        value: val,
        issue: !tracingEnabled
          ? 'profiles_sample_rate is set but tracing does not appear enabled — profiling requires tracing to be enabled (traces_sample_rate > 0) to function'
          : null,
      });
    }
  }

  // Also check sentry.yaml in environment-specific config dirs
  const envConfigDirs = ['config/packages/prod', 'config/packages/dev', 'config/packages/test'];
  for (const subDir of envConfigDirs) {
    const fpath = path.join(appPath, subDir, 'sentry.yaml');
    const content = safeRead(fpath, appPath);
    if (!content) continue;
    const relFile = path.relative(appPath, fpath);

    const tracesSampleRateM = /traces_sample_rate\s*:\s*([^\n]{1,50})/.exec(content);
    if (tracesSampleRateM) {
      const val = tracesSampleRateM[1].trim();
      const numVal = parseFloat(val.replace(/[^0-9.]/g, ''));
      const isProd = subDir.includes('prod');
      results.push({
        source: relFile,
        type: 'config',
        key: 'traces_sample_rate',
        value: val,
        issue: isProd && numVal >= 1.0
          ? `traces_sample_rate: ${val} in production config means 100% tracing overhead — reduce to 0.1–0.2 for production`
          : null,
      });
    }
  }

  // .env* files
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const sentryVars: Array<{ pattern: RegExp; name: string; sensitive: boolean }> = [
      { pattern: /SENTRY_DSN\s*=\s*([^\n]{1,200})/, name: 'SENTRY_DSN', sensitive: true },
      { pattern: /SENTRY_TRACES_SAMPLE_RATE\s*=\s*([^\n]{1,200})/, name: 'SENTRY_TRACES_SAMPLE_RATE', sensitive: false },
      { pattern: /SENTRY_ENVIRONMENT\s*=\s*([^\n]{1,200})/, name: 'SENTRY_ENVIRONMENT', sensitive: false },
    ];

    for (const varDef of sentryVars) {
      const m = varDef.pattern.exec(content);
      if (!m) continue;
      const raw = m[1].trim();
      const display = varDef.sensitive ? maskSecrets(`${varDef.name}=${raw}`) : `${varDef.name}=${raw}`;
      let issue: string | null = null;
      if (varDef.name === 'SENTRY_TRACES_SAMPLE_RATE') {
        const numVal = parseFloat(raw);
        if (!isNaN(numVal) && numVal >= 1.0 && fname.includes('prod')) {
          issue = `SENTRY_TRACES_SAMPLE_RATE=${raw} in ${fname} — 100% sampling causes significant overhead in production; use 0.1–0.2`;
        }
      }
      results.push({ source: fname, type: 'env', key: varDef.name, value: display, issue });
    }
  }

  // src/**/*.php — Sentry tracing usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasSentryTracing =
      content.includes('\\Sentry\\startTransaction(') ||
      content.includes('\\Sentry\\startSpan(') ||
      content.includes('SentrySdk::getCurrentHub()->getTransaction(') ||
      content.includes('->setContext(') ||
      content.includes('->setTag(') ||
      content.includes('->setUser(');

    if (!hasSentryTracing) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.includes('\\Sentry\\startTransaction(')) {
        // Check if ->finish() is called later in the file
        const hasFinish = content.includes('->finish()') || content.includes('->finish(');
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          key: '\\Sentry\\startTransaction()',
          value: line.trim().slice(0, 100),
          issue: !hasFinish
            ? 'Manual Sentry transaction started but ->finish() not found in file — always call $transaction->finish() to complete the transaction and send data to Sentry'
            : null,
        });
      }

      if (line.includes('\\Sentry\\startSpan(')) {
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          key: '\\Sentry\\startSpan()',
          value: line.trim().slice(0, 100),
          issue: null,
        });
      }

      if (line.includes('SentrySdk::getCurrentHub()->getTransaction(')) {
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          key: 'SentrySdk::getCurrentHub()->getTransaction()',
          value: line.trim().slice(0, 100),
          issue: null,
        });
      }

      if (line.includes('->setUser(')) {
        // Check for PII beyond id
        const contextStart = Math.max(0, i - 1);
        const contextEnd = Math.min(lines.length - 1, i + 5);
        const context = lines.slice(contextStart, contextEnd + 1).join('\n');
        const hasPii =
          /['"]email['"]\s*=>/.test(context) ||
          /['"]name['"]\s*=>/.test(context) ||
          /['"]username['"]\s*=>/.test(context) ||
          /['"]ip_address['"]\s*=>/.test(context);
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          key: '->setUser()',
          value: line.trim().slice(0, 100),
          issue: hasPii
            ? '->setUser() includes PII beyond user id (email/name/username/ip_address detected) — in GDPR-sensitive contexts, only send user id; scrub or omit personal data unless you have explicit consent and a DPA with Sentry'
            : null,
        });
      }

      if (line.includes('->setContext(')) {
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          key: '->setContext()',
          value: line.trim().slice(0, 100),
          issue: null,
        });
      }

      if (line.includes('->setTag(')) {
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          key: '->setTag()',
          value: line.trim().slice(0, 100),
          issue: null,
        });
      }
    }
  }

  return results;
}

export function listSentryPerformanceTracing(appPath: string): McpToolResult {
  try {
    const infos = buildSentryPerformanceTracingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Sentry performance tracing configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Sentry Performance Tracing Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  ${info.source}\n`;
      text += `    ${info.key}: ${info.value}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSentryPerformanceTracingStats(appPath: string): McpToolResult {
  try {
    const infos = buildSentryPerformanceTracingInfos(appPath);
    const configEntries = infos.filter((i) => i.type === 'config');
    const envEntries = infos.filter((i) => i.type === 'env');
    const phpEntries = infos.filter((i) => i.type === 'php');
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Sentry Performance Tracing Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config entries: ${configEntries.length}\n`;
    text += `Env entries:    ${envEntries.length}\n`;
    text += `PHP patterns:   ${phpEntries.length}\n`;
    text += `Issues:         ${issues.length}\n`;
    if (issues.length > 0) {
      text += `\nIssue breakdown:\n`;
      for (const info of issues) {
        text += `  - [${info.source}] ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSentryPerformanceTracingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_sentry_performance_tracing',
      description: 'Scan for Sentry performance monitoring and distributed tracing: config/packages/sentry.yaml tracing.enabled/traces_sample_rate/profiles_sample_rate, .env* SENTRY_DSN (masked)/SENTRY_TRACES_SAMPLE_RATE/SENTRY_ENVIRONMENT, PHP startTransaction/startSpan/getTransaction/setContext/setTag/setUser. Flags 100% sample rate in production, profiling without tracing, PII in setUser(), missing transaction finish().',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_sentry_performance_tracing_stats',
      description: 'Statistics for Sentry performance tracing: config/env/PHP entry counts and issue breakdown.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
