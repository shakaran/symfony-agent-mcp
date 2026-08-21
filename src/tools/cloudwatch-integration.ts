import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface CloudwatchIntegrationInfo {
  source: string;
  type: 'handler' | 'metric' | 'alarm' | 'retention' | 'tracing';
  pattern: string;
  issues: string[];
}

function findInfraFiles(appPath: string): string[] {
  const files: string[] = [];
  const dirs = ['.', 'infrastructure', 'infra', 'terraform', 'cloudformation', 'aws'];
  const extensions = ['.tf', '.json', '.yaml', '.yml'];
  for (const dir of dirs) {
    const dirPath = path.join(appPath, dir);
    if (!fs.existsSync(dirPath)) continue;
    try {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (extensions.some((ext) => entry.name.endsWith(ext))) {
          files.push(path.join(dirPath, entry.name));
        }
      }
    } catch { /* skip */ }
  }
  return files;
}

function buildCloudwatchIntegrationInfos(appPath: string): CloudwatchIntegrationInfo[] {
  const results: CloudwatchIntegrationInfo[] = [];
  let hasAwsIntegration = false;

  // 1. Check composer.json for AWS SDK
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    let content = '';
    try { content = fs.readFileSync(composerPath, 'utf-8'); } catch { /* skip */ }

    if (content.includes('aws/aws-sdk-php')) {
      hasAwsIntegration = true;
      if (content.includes('maxbanton/cwh') || /CloudWatch/i.test(content)) {
        results.push({ source: 'composer.json', type: 'handler', pattern: 'AWS CloudWatch handler package found', issues: [] });
      } else {
        results.push({ source: 'composer.json', type: 'handler', pattern: 'aws/aws-sdk-php found', issues: [] });
      }
    }

    if (content.includes('maxbanton/cwh')) {
      hasAwsIntegration = true;
      results.push({ source: 'composer.json', type: 'handler', pattern: 'maxbanton/cwh CloudWatch handler', issues: [] });
    }
  }

  // 2. Check monolog.yaml for CloudWatch handler
  const monologPaths = [
    path.join(appPath, 'config', 'packages', 'monolog.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'monolog.yaml'),
  ];
  let hasCloudwatchHandler = false;
  for (const mPath of monologPaths) {
    if (!fs.existsSync(mPath)) continue;
    let content = '';
    try { content = fs.readFileSync(mPath, 'utf-8'); } catch { continue; }
    const relPath = path.relative(appPath, mPath);

    if (/cloudwatch|cloud_watch/i.test(content)) {
      hasCloudwatchHandler = true;
      hasAwsIntegration = true;
      results.push({ source: relPath, type: 'handler', pattern: 'Monolog CloudWatch handler configured', issues: [] });
    } else if (!/datadog|sentry|loggly|papertrail|elasticsearch/i.test(content)) {
      results.push({
        source: relPath,
        type: 'handler',
        pattern: 'No centralized log aggregation handler',
        issues: ['No centralized log aggregation configured — for AWS deployments, configure CloudWatch Logs handler for centralized log management'],
      });
    }
    break;
  }

  if (!hasCloudwatchHandler && monologPaths.every((p) => !fs.existsSync(p))) {
    results.push({
      source: 'config/packages/monolog.yaml',
      type: 'handler',
      pattern: 'No monolog config found',
      issues: ['No centralized log aggregation configured — for AWS deployments, configure CloudWatch Logs handler for centralized log management'],
    });
  }

  // 3. Check .env for AWS credentials
  const envPath = path.join(appPath, '.env');
  if (fs.existsSync(envPath)) {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf-8'); } catch { /* skip */ }

    if (/AWS_DEFAULT_REGION=\S+/.test(content)) {
      hasAwsIntegration = true;
      results.push({ source: '.env', type: 'metric', pattern: 'AWS_DEFAULT_REGION configured', issues: [] });
    }

    if (/AWS_ACCESS_KEY_ID=\S+/.test(content)) {
      results.push({
        source: '.env',
        type: 'metric',
        pattern: 'AWS_ACCESS_KEY_ID in .env',
        issues: ['AWS credentials in plain .env — use IAM instance roles instead of static credentials for Lambda/ECS; never commit AWS keys'],
      });
    }
  }

  // 4. Check infrastructure files for CloudWatch alarms and log retention
  for (const infFile of findInfraFiles(appPath)) {
    let content = '';
    try { content = fs.readFileSync(infFile, 'utf-8'); } catch { continue; }
    const relPath = path.relative(appPath, infFile);

    if (/cloudwatch_metric_alarm|CloudWatch::Alarm|aws_cloudwatch_metric_alarm/i.test(content)) {
      hasAwsIntegration = true;
      results.push({ source: relPath, type: 'alarm', pattern: 'CloudWatch metric alarm defined', issues: [] });
    }

    if (/retentionInDays|retention_in_days/i.test(content)) {
      results.push({ source: relPath, type: 'retention', pattern: 'Log group retention configured', issues: [] });
    }
  }

  // 5. Check for X-Ray tracing
  const xrayEnvPath = path.join(appPath, '.env');
  let envContent = '';
  try { if (fs.existsSync(xrayEnvPath)) envContent = fs.readFileSync(xrayEnvPath, 'utf-8'); } catch { /* skip */ }
  let composerContent = '';
  if (fs.existsSync(composerPath)) {
    try { composerContent = fs.readFileSync(composerPath, 'utf-8'); } catch { /* skip */ }
  }

  if (/XRAY_DAEMON_ADDRESS/.test(envContent) || /aws\/xray-sdk-php/.test(composerContent)) {
    hasAwsIntegration = true;
    results.push({ source: 'xray-config', type: 'tracing', pattern: 'AWS X-Ray tracing configured', issues: [] });
  }

  if (!hasAwsIntegration && results.length === 0) {
    results.push({
      source: 'project',
      type: 'handler',
      pattern: 'No CloudWatch integration detected',
      issues: [],
    });
  }

  return results;
}

export function listCloudwatchIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildCloudwatchIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No CloudWatch integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `CloudWatch Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCloudwatchIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildCloudwatchIntegrationInfos(appPath);
    let text = `CloudWatch Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Handler:   ${infos.filter((i) => i.type === 'handler').length}\n`;
    text += `Metric:    ${infos.filter((i) => i.type === 'metric').length}\n`;
    text += `Alarm:     ${infos.filter((i) => i.type === 'alarm').length}\n`;
    text += `Retention: ${infos.filter((i) => i.type === 'retention').length}\n`;
    text += `Tracing:   ${infos.filter((i) => i.type === 'tracing').length}\n`;
    text += `Issues:    ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCloudwatchIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_cloudwatch_integration',
      description: 'Analyse AWS CloudWatch integration: Monolog handlers, static AWS credentials in .env, CloudWatch alarms in Terraform/CloudFormation, log retention settings, and X-Ray tracing configuration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_cloudwatch_integration_stats',
      description: 'Statistics for CloudWatch integration: counts by type (handler/metric/alarm/retention/tracing) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
