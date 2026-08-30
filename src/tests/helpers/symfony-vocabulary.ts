// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * One module's vocabulary, as separate lines.
 *
 * The pattern generator writes every module's shapes into shared files;
 * this returns them one by one instead, so a caller can build an
 * application that holds a single one of them.
 */

import * as fs from 'fs';
import { sampleFor } from './symfony-regex-samples.js';

const CREDENTIALISH = /(secret|password|passwd|credential|api[_-]?key|private[_-]?key)/i;

/** The alternatives a pattern offers at its top level. */
function topLevelAlternatives(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { current += ch + (src[i + 1] ?? ''); i++; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === '|' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);

  return parts.slice(0, 8);
}

/** Distinct lines matching the patterns and literals of one module. */
export function samplesForModule(modulePath: string): string[] {
  let source = '';
  try { source = fs.readFileSync(modulePath, 'utf-8'); } catch { return []; }

  const lines = new Set<string>();

  // The words it searches for, on their own.
  for (const m of source.matchAll(/(?:includes|startsWith|endsWith)\(\s*(['"])([^'"]{4,70})\1\s*\)/g)) {
    const literal = m[2];
    if (CREDENTIALISH.test(literal) || /[\n]/.test(literal)) continue;
    lines.add(literal);
  }

  // The values it compares against, and the configuration keys it reads.
  for (const m of source.matchAll(/[!=]==?\s*(['"])([^'"]{3,60})\1/g)) {
    const literal = m[2];
    if (CREDENTIALISH.test(literal)) continue;
    lines.add(literal);
  }
  for (const m of source.matchAll(/\[\s*'([a-z_][a-z0-9_]{2,40})'\s*\]/gi)) {
    lines.add(`${m[1]}: value`);
  }

  // The shapes its patterns describe.
  const patternRe = /(?:=|\.test\(|\.exec\(|\.match\(|\.matchAll\(|\.replace\(|\.split\(|return)\s*\/((?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+)\/[gimsuy]*/g;
  for (const m of source.matchAll(patternRe)) {
    if (m[1].length > 300) continue;
    for (const alternative of topLevelAlternatives(m[1])) {
    let sample: string | null = null;
    try { sample = sampleFor(alternative); } catch { sample = null; }
    if (sample) {
      const cleaned = sample.replace(/[\r\n]+/g, ' ').trim();
      const usable = cleaned.length >= 4 && cleaned.length <= 200 && !CREDENTIALISH.test(cleaned);
      let matches = false;
      try { matches = new RegExp(m[1]).test(cleaned); } catch { matches = false; }
      if (usable && matches) lines.add(cleaned);
    }
    }
  }

  return [...lines];
}
