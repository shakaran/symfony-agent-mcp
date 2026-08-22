import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface GrpcIntegrationInfo {
  file: string;
  type: 'proto' | 'service' | 'tls' | 'interceptor' | 'config';
  directive: string;
  value: string;
  issues: string[];
}


function buildGrpcIntegrationInfos(appPath: string): GrpcIntegrationInfo[] {
  const results: GrpcIntegrationInfo[] = [];

  const protoDir = path.join(appPath, 'proto');
  const altProtoDir = path.join(appPath, 'protobuf');
  const protoDirs = [protoDir, altProtoDir].filter((d) => fs.existsSync(d));

  for (const protoSearchDir of protoDirs) {
    try {
      const protoFiles: string[] = [];
      const findProto = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) findProto(path.join(dir, e.name));
          else if (e.name.endsWith('.proto')) protoFiles.push(path.join(dir, e.name));
        }
      };
      findProto(protoSearchDir);

      for (const protoFile of protoFiles) {
        let content = '';
        try { content = fs.readFileSync(protoFile, 'utf-8'); } catch { continue; }
        const relFile = path.relative(appPath, protoFile);
        const issues: string[] = [];

        const hasSyntax3 = content.includes('syntax = "proto3"') || content.includes("syntax = 'proto3'");
        if (!hasSyntax3) {
          issues.push(`Proto file "${relFile}" not using proto3 — proto2 has complex required/optional field semantics; migrate to proto3 for simpler null semantics and better language support`);
        }

        const hasDeprecated = content.includes('[deprecated = true]');
        if (hasDeprecated) {
          issues.push(`Proto file "${relFile}" has deprecated fields — deprecated fields should be reserved with reserved keyword instead of kept in schema to prevent accidental reuse of field numbers`);
        }

        const hasSnakeCase = /\s+[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\s*=/.test(content);
        if (hasSnakeCase) {
          issues.push(`Proto file "${relFile}" may have camelCase field names — protobuf convention requires snake_case for field names; generated code in different languages will vary otherwise`);
        }

        results.push({ file: relFile, type: 'proto', directive: 'proto file', value: path.basename(protoFile), issues });
      }
    } catch { /* skip */ }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            if (!content.includes('Grpc\\') && !content.includes('grpc') && !content.includes('ChannelCredentials') && !content.includes('ServerStreamingCall')) return;

            const relFile = path.relative(appPath, full);
            const issues: string[] = [];

            const hasTls = content.includes('createSsl()') || content.includes('ChannelCredentials::createSsl') || content.includes('withCallCredentials');
            if (!hasTls) {
              const hasInsecure = content.includes('createInsecure()') || content.includes('ChannelCredentials::createInsecure');
              if (hasInsecure) {
                issues.push(`gRPC client in "${relFile}" uses insecure channel — ChannelCredentials::createInsecure() disables TLS; use ChannelCredentials::createSsl() for production deployments`);
              }
            }

            const hasTimeout = content.includes('timeout') || content.includes('deadline') || content.includes('withDeadline');
            if (!hasTimeout) {
              issues.push(`gRPC client in "${relFile}" without deadline/timeout — without a deadline gRPC calls wait indefinitely; set withDeadline(new DateTime('+5 seconds')) on each call to prevent hanging`);
            }

            const hasMetadata = content.includes('Metadata') || content.includes('metadata') || content.includes('authorization');
            if (!hasMetadata) {
              issues.push(`gRPC client in "${relFile}" without authentication metadata — pass Bearer token or API key in Metadata array for each gRPC call`);
            }

            results.push({ file: relFile, type: 'service', directive: 'gRPC client', value: 'PHP code', issues });
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listGrpcIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildGrpcIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No gRPC integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `gRPC Integration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGrpcIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildGrpcIntegrationInfos(appPath);
    let text = `gRPC Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Proto files:  ${infos.filter((i) => i.type === 'proto').length}\n`;
    text += `Services:     ${infos.filter((i) => i.type === 'service').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGrpcIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_grpc_integration', description: 'Analyze gRPC integration in Symfony; warns on proto2 syntax, deprecated fields not reserved, camelCase field names, insecure gRPC channel, missing call deadline, no authentication metadata', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_grpc_integration_stats', description: 'Statistics for gRPC integration: proto/service count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
