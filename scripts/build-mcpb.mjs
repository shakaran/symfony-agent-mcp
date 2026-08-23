#!/usr/bin/env node
/**
 * Builds the .mcpb bundle Smithery distributes for local (stdio) installs.
 *
 * Smithery retired the smithery.yaml `startCommand` route for stdio servers,
 * so a local server is now published as a self-contained MCPB bundle: the
 * client downloads it and runs it, with no npm install of its own. That means
 * the bundle has to carry its production dependencies, and that the version
 * inside it has to match the release — hence injecting it from package.json
 * rather than keeping a second copy by hand.
 *
 * Usage: pnpm run build:mcpb   (expects `pnpm run build` to have run first)
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = path.join(root, 'build', 'mcpb');
const payload = path.join(staging, 'server');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });

if (!fs.existsSync(path.join(root, 'dist', 'server.js'))) {
  console.error('dist/server.js is missing — run `pnpm run build` first.');
  process.exit(1);
}

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(payload, { recursive: true });

fs.cpSync(path.join(root, 'dist'), path.join(payload, 'dist'), { recursive: true });
for (const f of ['package.json', 'README.md', 'LICENSE']) {
  fs.cpSync(path.join(root, f), path.join(payload, f));
}

// Production dependencies only: the bundle is executed, never developed in.
console.log('Installing production dependencies into the bundle...');
run('npm', ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', '--silent'], payload);

// Source maps and declarations are a third of the unpacked size and are never
// read at runtime.
let trimmed = 0;
const trim = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) trim(p);
    else if (e.name.endsWith('.map') || e.name.endsWith('.d.ts')) {
      fs.rmSync(p);
      trimmed++;
    }
  }
};
trim(path.join(payload, 'dist'));
console.log(`Removed ${trimmed} source-map and declaration files.`);

/**
 * Ask the built server what it advertises.
 *
 * Directories build their listing by scanning the server. With progressive
 * discovery that scan sees five meta-tools, and if it fails or is never run
 * the page ends up empty — which is what happened on Smithery. Declaring them
 * in the manifest gives the listing something to show without a scan, and
 * reading them from the server rather than copying them by hand means the
 * descriptions cannot drift from the ones the client actually receives.
 */
const advertisedTools = () => new Promise((resolve, reject) => {
  const proc = spawn('node', [path.join(payload, 'dist', 'server.js')], {
    env: {
      ...process.env,
      SYMFONY_MCP_STARTUP_AUDIT: 'false',
      SYMFONY_MCP_AUDIT: 'false',
      SYMFONY_MCP_ANOMALY: 'false',
      SYMFONY_MCP_RATE_LIMIT: '0',
      NODE_ENV: 'production',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const done = setTimeout(() => {
    proc.kill();
    reject(new Error('timed out asking the server for tools/list'));
  }, 30000);

  proc.stderr.on('data', () => {});
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === 2) {
          clearTimeout(done);
          proc.kill();
          resolve(msg.result.tools.map((t) => ({ name: t.name, description: t.description })));
        }
      } catch { /* partial line */ }
    }
  });

  proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'build-mcpb', version: pkg.version },
    },
  }) + '\n');
  setTimeout(() => {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  }, 900);
});

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'mcpb', 'manifest.json'), 'utf-8'));
manifest.version = pkg.version;

console.log('Asking the built server which tools it advertises...');
manifest.tools = await advertisedTools();
if (manifest.tools.length === 0) throw new Error('the server advertised no tools');
console.log(`Declared ${manifest.tools.length} tools in the manifest.`);
fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

run('npx', ['--yes', '@anthropic-ai/mcpb@2.1.2', 'validate', 'manifest.json'], staging);
run('npx', ['--yes', '@anthropic-ai/mcpb@2.1.2', 'pack', '.', path.join(root, 'build', `symfony-agent-mcp-${pkg.version}.mcpb`)], staging);

console.log(`\nbuild/symfony-agent-mcp-${pkg.version}.mcpb`);
console.log(`Publish with: smithery mcp publish ./build/symfony-agent-mcp-${pkg.version}.mcpb -n shakaran/symfony-agent-mcp`);
