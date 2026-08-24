#!/usr/bin/env node
/**
 * Adds SPDX copyright and licence headers to every source file.
 *
 * OpenSSF gold asks that each file state its copyright holder and licence, so
 * a file that travels on its own — pasted into an issue, vendored, extracted
 * from a tarball — still says what it is and who owns it. SPDX is the machine
 * -readable form, which is what scanners look for.
 *
 * Idempotent: a file that already carries the header is left alone, so this
 * can run in CI to prove none went missing.
 *
 * Usage: pnpm run headers          (adds them)
 *        pnpm run headers:check    (fails if any file lacks one)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const YEAR = '2026';
const HOLDER = 'Ángel Guzmán Maeso <angel@guzmanmaeso.com>';
const HEADER = `// SPDX-FileCopyrightText: ${YEAR} ${HOLDER}\n// SPDX-License-Identifier: MIT\n`;

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.ts') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const files = sources(path.join(root, 'src')).concat(sources(path.join(root, 'scripts')));
let added = 0;
const missing = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf-8');
  if (text.includes('SPDX-License-Identifier')) continue;

  if (check) {
    missing.push(path.relative(root, file));
    continue;
  }

  // A shebang has to stay on line 1 or the file stops being executable.
  const lines = text.split('\n');
  const out = lines[0].startsWith('#!')
    ? `${lines[0]}\n${HEADER}${lines.slice(1).join('\n')}`
    : HEADER + text;

  fs.writeFileSync(file, out);
  added++;
}

if (check) {
  if (missing.length) {
    console.error(`${missing.length} file(s) without an SPDX header:`);
    for (const m of missing.slice(0, 20)) console.error(`  ${m}`);
    if (missing.length > 20) console.error(`  ... and ${missing.length - 20} more`);
    process.exit(1);
  }
  console.log(`All ${files.length} source files carry an SPDX header.`);
} else {
  console.log(`Added headers to ${added} file(s); ${files.length - added} already had one.`);
}
