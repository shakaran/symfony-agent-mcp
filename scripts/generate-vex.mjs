#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Generates the OpenVEX document from what the auditor actually reports.
 *
 * VEX exists to say which known vulnerabilities in a project's dependencies do
 * not affect the product, so a consumer scanning the package is not left
 * guessing. Writing it by hand guarantees it goes stale the first time the
 * dependency tree moves, so it is derived from `pnpm audit --json` instead.
 *
 * Statuses follow the OpenVEX vocabulary. Anything the audit reports starts as
 * `under_investigation`: a machine cannot decide whether vulnerable code is
 * reachable, and claiming `not_affected` without that analysis would be worse
 * than saying nothing. A human then edits the statement, records the
 * justification, and the next run keeps it.
 *
 * Usage: pnpm run build:vex
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(root, 'vex.openvex.json');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));

/**
 * Build the package URL by parts rather than by substitution.
 *
 * A purl encodes a scoped npm name as `pkg:npm/%40scope/name@version`, so only
 * the leading `@` of the scope becomes %40 while the `/` stays a separator.
 * A blanket replace would leave a second `@` untouched, and encodeURIComponent
 * over the whole name would eat the separator.
 */
function packageUrl(name, version) {
  if (name.startsWith('@')) {
    const [scope, bare] = name.slice(1).split('/');
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(bare)}@${version}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

const product = packageUrl(pkg.name, pkg.version);

/** `pnpm audit` exits non-zero when it finds something; that is not an error here. */
function audit() {
  try {
    return JSON.parse(execFileSync('pnpm', ['audit', '--json'], { cwd: root, encoding: 'utf-8' }));
  } catch (err) {
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        // fall through
      }
    }
    throw new Error(`pnpm audit produced no parseable JSON: ${err.message}`);
  }
}

const report = audit();
const advisories = Object.values(report.advisories ?? {});

// Keep any human-written status from the previous document rather than
// overwriting an analysed statement with under_investigation on every run.
let previous = new Map();
try {
  // Read and handle absence, rather than checking existence and then reading:
  // between the two the file can go away, and the check buys nothing.
  const old = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  previous = new Map((old.statements ?? []).map((s) => [s.vulnerability.name, s]));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const statements = advisories.map((a) => {
  const name = a.cves?.[0] || a.github_advisory_id || `GHSA-unknown-${a.id}`;
  const kept = previous.get(name);
  if (kept) return kept;

  return {
    vulnerability: { name, description: a.title ?? '' },
    products: [{ '@id': product }],
    status: 'under_investigation',
    action_statement: `Reported against ${a.module_name}. Reachability from this package has not been analysed yet.`,
  };
});

const doc = {
  '@context': 'https://openvex.dev/ns/v0.2.0',
  '@id': `https://github.com/shakaran/symfony-agent-mcp/blob/main/vex.openvex.json`,
  author: 'Ángel Guzmán Maeso <angel@guzmanmaeso.com>',
  role: 'Project maintainer',
  timestamp: new Date().toISOString(),
  version: 1,
  tooling: 'scripts/generate-vex.mjs',
  statements,
};

fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');

console.log(`vex.openvex.json — ${statements.length} statement(s) for ${product}`);
if (statements.length === 0) {
  console.log('No advisories reported against the dependency tree.');
} else {
  for (const s of statements) console.log(`  ${s.status.padEnd(20)} ${s.vulnerability.name}`);
}
