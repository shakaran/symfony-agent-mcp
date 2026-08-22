import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ContractTestingInfo {
  source: string;
  type: 'consumer' | 'provider' | 'broker' | 'mock-server';
  pattern: string;
  issues: string[];
}

function buildApiContractTestingInfos(appPath: string): ContractTestingInfo[] {
  const results: ContractTestingInfo[] = [];

  const pactsDir = path.join(appPath, 'pacts');
  if (fs.existsSync(pactsDir)) {
    try {
      const pactFiles = fs.readdirSync(pactsDir).filter((f) => f.endsWith('.json'));
      if (pactFiles.length > 0) {
        results.push({
          source: 'pacts/',
          type: 'consumer',
          pattern: `${pactFiles.length} pact contract file(s) found`,
          issues: [],
        });
      }
    } catch { /* skip */ }
  }

  const pactJsonPaths = [
    path.join(appPath, 'pact.json'),
    path.join(appPath, '.pact'),
  ];
  for (const pactPath of pactJsonPaths) {
    if (fs.existsSync(pactPath)) {
      results.push({
        source: path.relative(appPath, pactPath),
        type: 'consumer',
        pattern: 'pact configuration file',
        issues: [],
      });
    }
  }

  const composerJson = path.join(appPath, 'composer.json');
  let hasPactDep = false;
  let hasApiCalls = false;

  if (fs.existsSync(composerJson)) {
    let content = '';
    try { content = fs.readFileSync(composerJson, 'utf-8'); } catch { /* skip */ }
    hasPactDep = content.includes('pact-foundation/pact-php') || content.includes('pact-foundation');
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkForApiCalls = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkForApiCalls(full);
          else if (e.name.endsWith('.php')) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            if (
              content.includes('HttpClient') ||
              content.includes('Guzzle') ||
              content.includes('GuzzleHttp') ||
              content.includes('HttpClientInterface') ||
              content.includes('->request(') ||
              content.includes('curl_exec')
            ) {
              hasApiCalls = true;
            }
          }
        }
      } catch { /* skip */ }
    };
    checkForApiCalls(srcDir);
  }

  if (hasApiCalls && !hasPactDep && results.filter((r) => r.type === 'consumer').length === 0) {
    results.push({
      source: 'composer.json',
      type: 'consumer',
      pattern: 'external API calls without contract testing',
      issues: [
        'External API calls without contract testing — consumer-driven contract tests prevent breaking API changes; install pact-foundation/pact-php',
      ],
    });
  }

  const testsDir = path.join(appPath, 'tests');
  if (fs.existsSync(testsDir)) {
    const checkTestFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkTestFiles(full);
          else if (e.name.endsWith('.php')) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            const relFile = path.relative(appPath, full);

            if (content.includes('PactBuilder') || content.includes('ConsumerPactBuilder')) {
              results.push({
                source: relFile,
                type: 'consumer',
                pattern: 'PactBuilder consumer contract test',
                issues: [],
              });
            }
            if (content.includes('ProviderVerifier') || content.includes('PactVerifier')) {
              results.push({
                source: relFile,
                type: 'provider',
                pattern: 'ProviderVerifier contract verification test',
                issues: [],
              });
            }
            if (content.includes('MockServer') || content.includes('MockService')) {
              results.push({
                source: relFile,
                type: 'mock-server',
                pattern: 'Pact mock server usage',
                issues: [],
              });
            }
          }
        }
      } catch { /* skip */ }
    };
    checkTestFiles(testsDir);
  }

  const ciPaths = [
    path.join(appPath, '.github', 'workflows'),
    path.join(appPath, '.gitlab-ci.yml'),
    path.join(appPath, '.github', 'workflows', 'ci.yml'),
    path.join(appPath, '.github', 'workflows', 'test.yml'),
  ];

  let hasPactBrokerInCI = false;
  for (const ciPath of ciPaths) {
    if (!fs.existsSync(ciPath)) continue;
    let content = '';
    try {
      if (fs.statSync(ciPath).isDirectory()) {
        for (const f of fs.readdirSync(ciPath)) {
          try {
            content += fs.readFileSync(path.join(ciPath, f), 'utf-8') + '\n';
          } catch { /* skip */ }
        }
      } else {
        content = fs.readFileSync(ciPath, 'utf-8');
      }
    } catch { continue; }

    if (content.includes('PACT_BROKER_URL') || content.includes('pact-broker') || content.includes('pactflow')) {
      hasPactBrokerInCI = true;
      results.push({
        source: path.relative(appPath, ciPath),
        type: 'broker',
        pattern: 'Pact broker configured in CI',
        issues: [],
      });
    }
  }

  if (hasPactDep && !hasPactBrokerInCI) {
    results.push({
      source: '.github/workflows',
      type: 'broker',
      pattern: 'no Pact broker verification in CI',
      issues: [
        'No Pact broker verification in CI — consumer contracts may drift from provider implementation; add provider verification step to pipeline',
      ],
    });
  }

  return results;
}

export function listApiContractTesting(appPath: string): McpToolResult {
  try {
    const infos = buildApiContractTestingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No contract testing patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `API Contract Testing Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiContractTestingStats(appPath: string): McpToolResult {
  try {
    const infos = buildApiContractTestingInfos(appPath);
    let text = `API Contract Testing Statistics\n${'='.repeat(40)}\n\n`;
    text += `Consumer:    ${infos.filter((i) => i.type === 'consumer').length}\n`;
    text += `Provider:    ${infos.filter((i) => i.type === 'provider').length}\n`;
    text += `Broker:      ${infos.filter((i) => i.type === 'broker').length}\n`;
    text += `Mock-server: ${infos.filter((i) => i.type === 'mock-server').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiContractTestingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_contract_testing', description: 'Analyze API contract testing setup; warns on external API calls without Pact, no Pact broker verification in CI pipeline', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_contract_testing_stats', description: 'Statistics for API contract testing: counts by type, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
