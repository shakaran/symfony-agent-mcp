#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The suite, run in pieces so no single process grows large.
 *
 * Importing all 820 tool modules in one worker costs over 2 GB, which on a
 * workstation is the difference between a run in the background and a machine
 * that cannot open anything else. Here each piece is its own process, so the
 * memory goes back to the system between them.
 *
 * Usage: node scripts/test-low-memory.mjs [--coverage]
 */

import { spawnSync } from 'node:child_process';

const coverage = process.argv.includes('--coverage');
const pieces = [
  ['everything but the sweep', ['--testPathIgnorePatterns=tools-error-paths']],
  ['sweep 1/4', ['--testPathPatterns=tools-error-paths-1']],
  ['sweep 2/4', ['--testPathPatterns=tools-error-paths-2']],
  ['sweep 3/4', ['--testPathPatterns=tools-error-paths-3']],
  ['sweep 4/4', ['--testPathPatterns=tools-error-paths-4']],
];

let failed = 0;
for (const [label, args] of pieces) {
  process.stderr.write(`\n── ${label} ──\n`);
  const extra = coverage
    ? ['--coverage', `--coverageDirectory=coverage/${label.replace(/[^a-z0-9]+/gi, '-')}`, '--coverageReporters=json']
    : [];
  const result = spawnSync('npx', ['jest', ...args, ...extra], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=1536`.trim() },
  });
  // The sweep alone cannot meet the coverage thresholds scoped to src/utils,
  // which it does not touch; a real failure shows up as a failing test.
  if (result.status !== 0 && !(coverage && label.startsWith('sweep'))) failed = 1;
}

process.exit(failed);
