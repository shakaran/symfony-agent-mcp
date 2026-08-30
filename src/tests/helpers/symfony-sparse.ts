// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * A copy of an assembled fixture with every configuration file cut back to
 * its opening section.
 *
 * The section is there, so the analysers get past "nothing configured" and
 * into the checks proper — and then every option they look for is missing.
 * That is the half of each module that reports what an application forgot
 * to set, which a complete fixture never reaches and an empty directory
 * never gets near.
 */

import * as fs from 'fs';
import * as path from 'path';

const YAMLISH = /\.(ya?ml|neon)$/i;
const JSONISH = /\.(json|avsc)$/i;

function trimYaml(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let seenTopLevel = 0;

  for (const line of lines) {
    if (/^[A-Za-z_"'[]/.test(line)) {
      seenTopLevel++;
      if (seenTopLevel > 2) break;
      kept.push(line);
      continue;
    }
    // One level of nesting under each top-level key, and nothing below it.
    if (kept.length > 0 && /^\s{1,4}\S/.test(line) && !/^\s*[-#]/.test(line)) kept.push(line);
  }

  return kept.join('\n') + '\n';
}

function trimJson(content: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return content; }
  if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) return content;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    out[k] = (v !== null && typeof v === 'object') ? (Array.isArray(v) ? [] : {}) : v;
  }

  return JSON.stringify(out, null, 2) + '\n';
}

function copySparse(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { copySparse(src, dst); continue; }
    if (!entry.isFile()) continue;

    let content = '';
    try { content = fs.readFileSync(src, 'utf-8'); } catch { continue; }

    if (YAMLISH.test(entry.name)) fs.writeFileSync(dst, trimYaml(content));
    else if (JSONISH.test(entry.name)) fs.writeFileSync(dst, trimJson(content));
    else fs.writeFileSync(dst, content);
  }
}

/**
 * Copy `source` into `target` with each configuration file cut back to its
 * opening section, and return the new path.
 */
export function createSparseFixture(source: string, target: string): string {
  copySparse(source, target);

  return target;
}
