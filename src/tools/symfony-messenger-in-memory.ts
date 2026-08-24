// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface InMemoryTestUsage {
  file: string;
  hasCountAssertion: boolean;
  hasClassAssertion: boolean;
  hasReset: boolean;
  issues: string[];
}

interface InMemoryTransportInfo {
  configuredInTest: boolean;
  configuredInProd: boolean;
  testUsages: InMemoryTestUsage[];
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

function isInMemoryDsn(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('in-memory://');
}

function checkYamlForInMemory(filePath: string): boolean {
  const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
  if (!raw) return false;
  const text = JSON.stringify(raw);
  return text.includes('in-memory://');
}

function parseTestUsage(filePath: string, appPath: string): InMemoryTestUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('InMemoryTransport') && !content.includes('getSent') && !content.includes('transport->get')) return null;
  if (!filePath.includes('/tests') && !filePath.includes('/Test') && !filePath.endsWith('Test.php')) return null;

  const hasCountAssertion = /count\s*\(\s*\$transport->(?:get|getSent)\s*\(\s*\)\s*\)/.test(content) ||
    /assertCount/.test(content) && content.includes('transport');
  const hasClassAssertion = /assertInstanceOf|instanceof/.test(content) && content.includes('transport');
  const hasReset = content.includes('->reset(') || content.includes('transport->reset');

  const issues: string[] = [];

  if (!hasCountAssertion && content.includes('dispatch')) {
    issues.push('In-memory transport test dispatches without asserting message count — dispatch tested but messages not verified');
  }

  if (!hasReset) {
    issues.push('Transport not reset between tests — state may leak across test cases (call $transport->reset())');
  }

  if (hasClassAssertion && !hasCountAssertion) {
    issues.push('Asserting message class without asserting message count/data — partial assertion may miss missing dispatches');
  }

  if (content.includes('->get()') && !content.includes('dispatch')) {
    issues.push('Asserting $transport->get() without dispatching — will always return empty result');
  }

  return {
    file: path.relative(appPath, filePath),
    hasCountAssertion,
    hasClassAssertion,
    hasReset,
    issues,
  };
}

function loadInMemoryTransportInfo(appPath: string): InMemoryTransportInfo {
  // Check test-specific messenger config
  const testMessengerYaml = path.join(appPath, 'config', 'packages', 'test', 'messenger.yaml');
  const prodMessengerYaml = path.join(appPath, 'config', 'packages', 'messenger.yaml');

  const configuredInTest = checkYamlForInMemory(testMessengerYaml);

  // Check prod for in-memory (bad)
  let configuredInProd = false;
  const prodRaw = parseYamlFile(prodMessengerYaml) as Record<string, unknown> | null;
  if (prodRaw) {
    const framework = (prodRaw['framework'] ?? prodRaw) as Record<string, unknown>;
    const messenger = (framework['messenger'] ?? prodRaw['messenger'] ?? {}) as Record<string, unknown>;
    const transports = (messenger['transports'] ?? {}) as Record<string, unknown>;
    for (const [, def] of Object.entries(transports)) {
      const d = (def ?? {}) as Record<string, unknown>;
      if (isInMemoryDsn(d['dsn']) || isInMemoryDsn(def)) {
        configuredInProd = true;
        break;
      }
    }
  }

  // Scan tests/
  const testsDir = path.join(appPath, 'tests');
  const testUsages: InMemoryTestUsage[] = [];
  if (fs.existsSync(testsDir)) {
    for (const file of getAllPhpFiles(testsDir)) {
      const u = parseTestUsage(file, appPath);
      if (u) testUsages.push(u);
    }
  }

  const issues: string[] = [];
  if (configuredInProd) {
    issues.push('in-memory:// transport configured in non-test environment — messages are silently dropped in production');
  }
  if (!configuredInTest && testUsages.length > 0) {
    issues.push('Tests use InMemoryTransport but it is not configured in config/packages/test/messenger.yaml');
  }

  return { configuredInTest, configuredInProd, testUsages, issues };
}

export function listInMemoryTransport(appPath: string): McpToolResult {
  try {
    const info = loadInMemoryTransportInfo(appPath);
    const totalIssues = info.issues.length + info.testUsages.reduce((s, u) => s + u.issues.length, 0);

    if (!info.configuredInTest && !info.configuredInProd && info.testUsages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No in-memory transport usage found.\n\nExample (config/packages/test/messenger.yaml):\n  framework:\n    messenger:\n      transports:\n        async:\n          dsn: \'in-memory://\'',
        }],
      };
    }

    let text = `Messenger In-Memory Transport\n${'='.repeat(55)}\n\n`;
    text += `Configured in test env:  ${info.configuredInTest ? 'yes' : 'no'}\n`;
    text += `Configured in prod env:  ${info.configuredInProd ? 'YES (warning)' : 'no'}\n`;
    text += `Test usages found:       ${info.testUsages.length}\n`;
    text += `Total issues:            ${totalIssues}\n`;

    for (const issue of info.issues) text += `\n⚠ ${issue}\n`;

    if (info.testUsages.length > 0) {
      text += `\nTest usages:\n`;
      for (const u of info.testUsages.sort((a, b) => b.issues.length - a.issues.length)) {
        text += `\n  ${u.file}\n`;
        text += `    count assertion: ${u.hasCountAssertion ? 'yes' : 'no'}\n`;
        text += `    class assertion: ${u.hasClassAssertion ? 'yes' : 'no'}\n`;
        text += `    reset():         ${u.hasReset ? 'yes' : 'no'}\n`;
        for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getInMemoryTransportStats(appPath: string): McpToolResult {
  try {
    const info = loadInMemoryTransportInfo(appPath);

    let text = `In-Memory Transport Statistics\n${'='.repeat(40)}\n\n`;
    text += `Configured in test env:   ${info.configuredInTest ? 'yes' : 'no'}\n`;
    text += `Configured in prod env:   ${info.configuredInProd ? 'yes (warning)' : 'no'}\n`;
    text += `Test usages:              ${info.testUsages.length}\n`;
    text += `  With count assertion:   ${info.testUsages.filter((u) => u.hasCountAssertion).length}\n`;
    text += `  With class assertion:   ${info.testUsages.filter((u) => u.hasClassAssertion).length}\n`;
    text += `  With reset():           ${info.testUsages.filter((u) => u.hasReset).length}\n`;
    text += `Issues:                   ${info.issues.length + info.testUsages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getInMemoryTransportTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_in_memory_transport',
      description: 'Show in-memory:// transport config and test usage: configured environment, test assertion coverage, reset() calls; warns on prod configuration (messages dropped), dispatch without assertion, missing reset between tests',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_in_memory_transport_stats',
      description: 'Show in-memory transport statistics: test/prod config status, test usage count, assertion/reset coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
