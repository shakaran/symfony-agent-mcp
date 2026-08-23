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

import { execFileSync } from 'node:child_process';
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

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'mcpb', 'manifest.json'), 'utf-8'));
manifest.version = pkg.version;

// Deliberately no `tools` array. Declaring the advertised tools here looked
// like the fix for Smithery's empty listing, but the two schemas contradict
// each other: MCPB rejects `inputSchema` inside a tool entry ("Unrecognized
// key(s)"), and Smithery rejects a tool entry without it — 400, one error per
// tool. Until they agree, the listing has to come from elsewhere.
fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

run('npx', ['--yes', '@anthropic-ai/mcpb@2.1.2', 'validate', 'manifest.json'], staging);
run('npx', ['--yes', '@anthropic-ai/mcpb@2.1.2', 'pack', '.', path.join(root, 'build', `symfony-agent-mcp-${pkg.version}.mcpb`)], staging);

console.log(`\nbuild/symfony-agent-mcp-${pkg.version}.mcpb`);
console.log(`Publish with: smithery mcp publish ./build/symfony-agent-mcp-${pkg.version}.mcpb -n shakaran/symfony-agent-mcp`);
