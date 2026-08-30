// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface OtelInfo {
  detected: boolean;
  bundle?: string;
  exporters: string[];
  spanProcessors: string[];
  instrumentations: string[];
  hasSampler: boolean;
  issues: string[];
}

function detectOtelBundle(appPath: string): string | undefined {
  const composerPath = path.join(appPath, 'composer.json');
  try {
    const content = fs.readFileSync(composerPath, 'utf-8');
    const composer = JSON.parse(content) as Record<string, unknown>;
    const require = (composer['require'] ?? {}) as Record<string, unknown>;
    if (require['open-telemetry/opentelemetry-auto-symfony']) return 'opentelemetry-auto-symfony';
    if (require['glpichon/opentelemetry-bundle']) return 'glpichon/opentelemetry-bundle';
    if (require['opentelemetry-php/contrib-auto-symfony']) return 'opentelemetry contrib';
    for (const pkg of Object.keys(require)) {
      if (pkg.includes('opentelemetry') || pkg.includes('open-telemetry')) return pkg;
    }
  } catch { /* skip */ }
  return undefined;
}

function loadOtelConfig(appPath: string): OtelInfo {
  const bundle = detectOtelBundle(appPath);
  const exporters: string[] = [];
  const spanProcessors: string[] = [];
  const instrumentations: string[] = [];
  let hasSampler = false;
  const issues: string[] = [];
  const candidates = [
    path.join(appPath, 'config', 'packages', 'open_telemetry.yaml'),
    path.join(appPath, 'config', 'packages', 'open_telemetry.yml'),
    path.join(appPath, 'config', 'packages', 'opentelemetry.yaml'),
    path.join(appPath, 'config', 'packages', 'opentelemetry.yml'),
    path.join(appPath, 'config', 'opentelemetry.yaml'),
    path.join(appPath, 'config', 'opentelemetry.yml'),
  ];
  let configFound = false;
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    configFound = true;
    const otel = (raw['open_telemetry'] ?? raw['opentelemetry'] ?? raw) as Record<string, unknown>;
    const exporterConf = (otel['exporters'] ?? otel['exporter'] ?? {}) as Record<string, unknown>;
    exporters.push(...Object.keys(exporterConf));
    const processorConf = (otel['processors'] ?? otel['span_processors'] ?? {}) as Record<string, unknown>;
    spanProcessors.push(...Object.keys(processorConf));
    hasSampler = !!(otel['sampler'] ?? otel['sampling']);
    const instrConf = (otel['instrumentations'] ?? {}) as Record<string, unknown>;
    instrumentations.push(...Object.keys(instrConf));
  }
  if (!bundle && !configFound) {
    issues.push('No OpenTelemetry bundle or config found — add open-telemetry/opentelemetry-auto-symfony for distributed tracing');
  }
  if (bundle && exporters.length === 0) issues.push('OpenTelemetry bundle found but no exporter configured — traces are discarded');
  if (exporters.some(e => e.includes('jaeger')) && exporters.some(e => e.includes('zipkin'))) {
    issues.push('Multiple trace exporters (Jaeger + Zipkin) — prefer OTLP exporter for vendor-neutral export');
  }
  if (bundle && !hasSampler) issues.push('No sampler configured — defaults to always-on sampling (100%); configure ratio sampler for production');
  return { detected: !!(bundle ?? configFound), bundle, exporters, spanProcessors, instrumentations, hasSampler, issues };
}

export function listOpenTelemetryConfig(appPath: string): McpToolResult {
  try {
    const info = loadOtelConfig(appPath);
    if (!info.detected) return { content: [{ type: 'text', text: 'OpenTelemetry not detected.\n\nInstall:\n  composer require open-telemetry/opentelemetry-auto-symfony\n  composer require open-telemetry/exporter-otlp' }] };
    let text = `OpenTelemetry Configuration\n${'='.repeat(55)}\n\nBundle: ${info.bundle ?? 'env-based'}  Issues: ${info.issues.length}\n`;
    text += `\nExporters: ${info.exporters.length > 0 ? info.exporters.join(', ') : 'none configured'}\n`;
    text += `Span processors: ${info.spanProcessors.length > 0 ? info.spanProcessors.join(', ') : 'default'}\n`;
    text += `Instrumentations: ${info.instrumentations.length > 0 ? info.instrumentations.join(', ') : 'auto'}\n`;
    text += `Sampler: ${info.hasSampler ? 'configured' : 'default (always-on)'}\n`;
    for (const i of info.issues) text += `\n⚠ ${i}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getOpenTelemetryStats(appPath: string): McpToolResult {
  try {
    const info = loadOtelConfig(appPath);
    let text = `OpenTelemetry Statistics\n${'='.repeat(40)}\n\n`;
    text += `Detected: ${info.detected ? 'yes' : 'no'}\nBundle: ${info.bundle ?? 'none'}\nExporters: ${info.exporters.length}\nSpan processors: ${info.spanProcessors.length}\nInstrumentations: ${info.instrumentations.length}\nSampler: ${info.hasSampler ? 'yes' : 'no'}\nIssues: ${info.issues.length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getOpenTelemetryTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_opentelemetry_config', description: 'Detect OpenTelemetry configuration: bundle detection, exporters (Jaeger/Zipkin/OTLP), span processors, instrumentations, sampler, missing exporter/sampler warnings', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_opentelemetry_stats', description: 'OpenTelemetry statistics: detected, exporter/processor/instrumentation counts, sampler configured, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
