#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Proves the build is reproducible, rather than asserting it.
 *
 * Builds twice from a clean tree and compares a digest over every emitted
 * file. A claim of reproducibility that nobody re-checks quietly stops being
 * true the first time a timestamp, an absolute path or a hash-ordered map
 * leaks into the output — so this runs in CI.
 *
 * Usage: pnpm run verify:reproducible
 */

import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** One digest over every emitted file, path included so a rename is caught. */
function digest() {
  const h = crypto.createHash('sha256');
  for (const f of walk(dist)) {
    h.update(path.relative(dist, f));
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex');
}

function build(label) {
  fs.rmSync(dist, { recursive: true, force: true });
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
  const d = digest();
  console.log(`  ${label}: ${d}`);
  return d;
}

console.log('Building twice from a clean tree...');
const first = build('build 1');
const second = build('build 2');

if (first !== second) {
  console.error('\nBuild is NOT reproducible: the two builds differ.');
  console.error('Something non-deterministic reached the output — a timestamp,');
  console.error('an absolute path, or iteration order over an unsorted map.');
  process.exit(1);
}

console.log(`\nReproducible: ${walk(dist).length} files, identical across both builds.`);
