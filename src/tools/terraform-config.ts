import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface TerraformConfigInfo {
  file: string;
  resource: string;
  provider: string;
  issues: string[];
}

function safeReadFile(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function safeReadDir(dir: string, base: string): string[] {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return [];
  try { return fs.readdirSync(resolved); } catch { return []; }
}

const SECRET_VALUE_PATTERN = /=\s*["'][A-Za-z0-9+/]{20,}["']/;
const SECRET_KEY_PATTERN = /password|secret|private_key|access_key|token|credential/i;

function collectTfFiles(dir: string, base: string): string[] {
  const files: string[] = [];
  const entries = safeReadDir(dir, base);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(fullPath); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      // Avoid deep recursion into .terraform
      if (entry === '.terraform' || entry === 'node_modules') continue;
      files.push(...collectTfFiles(fullPath, base));
    } else if (entry.endsWith('.tf')) {
      files.push(fullPath);
    }
  }
  return files;
}

function parseTerraformFile(content: string, relPath: string): TerraformConfigInfo[] {
  const results: TerraformConfigInfo[] = [];

  // terraform block — required_version
  const terraformBlockMatch = content.match(/\bterraform\s*\{([^}]{0,2000})\}/s);
  if (terraformBlockMatch) {
    const tfBlock = terraformBlockMatch[1];

    // required_version
    if (!/required_version/.test(tfBlock)) {
      results.push({
        file: relPath,
        resource: 'terraform',
        provider: 'global',
        issues: ['No required_version constraint in terraform block — add required_version = ">= 1.0" to prevent incompatible version usage'],
      });
    } else {
      results.push({ file: relPath, resource: 'terraform', provider: 'global', issues: [] });
    }

    // backend — local state detection
    if (!/\bbackend\s+"/.test(tfBlock)) {
      results.push({
        file: relPath,
        resource: 'backend',
        provider: 'global',
        issues: ['No backend configured — Terraform will use local state; configure a remote backend (S3, GCS, Terraform Cloud) for team collaboration'],
      });
    }

    // required_providers
    const reqProvMatch = tfBlock.match(/required_providers\s*\{([^}]{0,1000})\}/s);
    if (reqProvMatch) {
      const provBlock = reqProvMatch[1];
      const provPattern = /(\w[\w-]{0,40})\s*=\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = provPattern.exec(provBlock)) !== null) {
        results.push({ file: relPath, resource: 'required_provider', provider: m[1], issues: [] });
      }
    }
  }

  // resource blocks
  const resourcePattern = /\bresource\s+"([^"]{1,80})"\s+"([^"]{1,80})"\s*\{([^{}]{0,3000}(?:\{[^{}]{0,500}\}[^{}]{0,500}){0,5})\}/gs;
  let m: RegExpExecArray | null;
  while ((m = resourcePattern.exec(content)) !== null) {
    const resourceType = m[1];
    const resourceName = m[2];
    const resourceBody = m[3];
    const info: TerraformConfigInfo = {
      file: relPath,
      resource: `${resourceType}.${resourceName}`,
      provider: resourceType.split('_')[0],
      issues: [],
    };

    // Hardcoded secrets in resource body
    const lines = resourceBody.split('\n');
    for (const line of lines) {
      const attrMatch = line.match(/^\s*(\w[\w_]{0,60})\s*=/);
      if (!attrMatch) continue;
      const attrName = attrMatch[1];
      if (SECRET_KEY_PATTERN.test(attrName) && SECRET_VALUE_PATTERN.test(line)) {
        info.issues.push(`Possible hardcoded secret in resource "${resourceType}.${resourceName}" attribute "${attrName}" — use var.* or data sources (SSM/Vault)`);
      }
    }

    results.push(info);
  }

  // variable blocks
  const varPattern = /\bvariable\s+"([^"]{1,80})"\s*\{([^}]{0,500})\}/gs;
  while ((m = varPattern.exec(content)) !== null) {
    const varName = m[1];
    const varBody = m[2];
    const info: TerraformConfigInfo = { file: relPath, resource: `variable.${varName}`, provider: 'input', issues: [] };
    // Variable with default that looks like a secret
    const defaultMatch = varBody.match(/default\s*=\s*["']([^"']{8,})["']/);
    if (defaultMatch && SECRET_KEY_PATTERN.test(varName)) {
      info.issues.push(`Variable "${varName}" has a hardcoded default that looks like a secret — do not commit secrets as variable defaults`);
    }
    results.push(info);
  }

  return results;
}

function buildTerraformConfigInfos(appPath: string): TerraformConfigInfo[] {
  const results: TerraformConfigInfo[] = [];
  const searchDirs = ['terraform', 'infra', 'infrastructure'];

  for (const dir of searchDirs) {
    const dirPath = path.join(appPath, dir);
    const tfFiles = collectTfFiles(dirPath, appPath);
    for (const tfFile of tfFiles) {
      const content = safeReadFile(tfFile, appPath);
      if (content === null) continue;
      const relPath = path.relative(appPath, tfFile);
      results.push(...parseTerraformFile(content, relPath));
    }
  }

  // Also check root-level .tf files
  const rootEntries = safeReadDir(appPath, appPath);
  for (const entry of rootEntries) {
    if (!entry.endsWith('.tf')) continue;
    const fullPath = path.join(appPath, entry);
    const content = safeReadFile(fullPath, appPath);
    if (content === null) continue;
    results.push(...parseTerraformFile(content, entry));
  }

  return results;
}

export function listTerraformConfig(appPath: string): McpToolResult {
  try {
    const infos = buildTerraformConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Terraform .tf files found (searched terraform/, infra/, infrastructure/ and root).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Terraform Configuration Analysis\n${'='.repeat(55)}\n\nResources: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.provider.toUpperCase()}] ${info.resource}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTerraformConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildTerraformConfigInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    const files = [...new Set(infos.map((i) => i.file))];
    const providers = [...new Set(infos.map((i) => i.provider).filter((p) => p !== 'global' && p !== 'input'))];
    let text = `Terraform Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `TF files analyzed:   ${files.length}\n`;
    text += `Resources:           ${infos.filter((i) => i.resource.includes('.')).length}\n`;
    text += `Providers used:      ${providers.join(', ') || 'none'}\n`;
    text += `Secret issues:       ${infos.filter((i) => i.issues.some((x) => x.includes('secret') || x.includes('hardcoded'))).length}\n`;
    text += `Backend issues:      ${infos.filter((i) => i.resource === 'backend').length}\n`;
    text += `Version issues:      ${infos.filter((i) => i.issues.some((x) => x.includes('required_version'))).length}\n`;
    text += `Total issues:        ${totalIssues}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTerraformConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_terraform_config',
      description: 'Analyse Terraform .tf files under terraform/, infra/, infrastructure/ for hardcoded secrets, missing backend configuration, missing required_version, and provider declarations',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_terraform_config_stats',
      description: 'Statistics for Terraform configuration: file count, resource/provider counts, secret/backend/version issues, and total issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
