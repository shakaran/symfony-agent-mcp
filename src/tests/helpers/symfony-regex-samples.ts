// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Text built from the patterns the analysers match with.
 *
 * The generated reference files hold the words a module searches for; this
 * holds the shapes. Most of what a module actually reads is matched by
 * regular expression — an attribute with its arguments, a builder call, a
 * DSN — and a bare word never satisfies one. Here each pattern in each
 * module is turned back into one string that matches it, which is what the
 * parsing half of the module needs in order to run at all.
 *
 * The generator is deliberately small: literals, escapes, classes, groups
 * and bounded repetition. Anything it cannot make sense of is skipped, so a
 * pattern either produces a plausible line or nothing.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const CLASS_SAMPLE: Record<string, string> = {
  'd': '4', 'w': 'value', 's': ' ', 'S': 'x', 'D': 'x', 'W': ' ',
};

/** One string matching `src`, or null when the pattern is beyond this. */
export function sampleFor(src: string): string | null {
  let out = '';
  let i = 0;
  let guard = 0;

  while (i < src.length) {
    if (guard++ > 4000) return null;
    const ch = src[i];

    if (ch === '\\') {
      const next = src[i + 1];
      if (next === undefined) return null;
      if (next === 'b' || next === 'B') { i += 2; continue; }
      out += CLASS_SAMPLE[next] ?? next;
      i += 2;
      i = skipQuantifier(src, i, () => { /* already emitted once */ });
      continue;
    }

    if (ch === '^' || ch === '$') { i++; continue; }

    if (ch === '(') {
      // Lookarounds and non-capturing markers.
      const rest = src.slice(i);
      if (/^\(\?[=!<]/.test(rest)) {
        const end = matchingParen(src, i);
        if (end === -1) return null;
        i = end + 1;
        i = skipQuantifier(src, i, () => { /* nothing emitted */ });
        continue;
      }
      const end = matchingParen(src, i);
      if (end === -1) return null;
      let inner = src.slice(i + 1, end);
      if (inner.startsWith('?:')) inner = inner.slice(2);
      const first = topLevelAlternatives(inner)[0] ?? '';
      const sample = sampleFor(first);
      if (sample === null) return null;
      out += sample;
      i = end + 1;
      i = skipQuantifier(src, i, () => { /* one repetition is enough */ });
      continue;
    }

    if (ch === '[') {
      const end = classEnd(src, i);
      if (end === -1) return null;
      const body = src.slice(i + 1, end);
      const sample = sampleFromClass(body);
      if (sample === null) return null;
      out += sample;
      i = end + 1;
      i = skipQuantifier(src, i, () => { /* one character is enough */ });
      continue;
    }

    if (ch === '.') {
      out += 'x';
      i++;
      i = skipQuantifier(src, i, () => { /* one character */ });
      continue;
    }

    if (ch === '|') {
      // Only the first alternative of the whole pattern is produced.
      return out;
    }

    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      // A quantifier with nothing before it that we emitted: skip it.
      i = skipQuantifier(src, i, () => { /* nothing */ });
      if (src[i - 1] === ch) i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function skipQuantifier(src: string, i: number, _emit: () => void): number {
  const ch = src[i];
  if (ch === '*' || ch === '+' || ch === '?') {
    let j = i + 1;
    if (src[j] === '?') j++;
    return j;
  }
  if (ch === '{') {
    const end = src.indexOf('}', i);
    if (end === -1) return i;
    let j = end + 1;
    if (src[j] === '?') j++;
    return j;
  }
  return i;
}

function matchingParen(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '[') { const e = classEnd(src, i); if (e === -1) return -1; i = e; continue; }
    if (src[i] === '(') depth++;
    if (src[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function classEnd(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === ']' && i > start + 1) return i;
  }
  return -1;
}

function topLevelAlternatives(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { current += ch + (src[i + 1] ?? ''); i++; continue; }
    if (ch === '[') { const e = classEnd(src, i); if (e !== -1) { current += src.slice(i, e + 1); i = e; continue; } }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === '|' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);

  return parts;
}

function sampleFromClass(body: string): string | null {
  if (body.startsWith('^')) {
    // A negated class: anything not in it. A letter, unless letters are what
    // it excludes.
    for (const candidate of ['a', 'x', '1', '_', '-', ' ']) {
      if (!classMatches(body.slice(1), candidate)) return candidate;
    }
    return null;
  }
  for (const candidate of ['a', 'A', '1', '_', '-', '.', '/', ' ', ':']) {
    if (classMatches(body, candidate)) return candidate;
  }
  // A class of literal characters we did not guess: take its first.
  const first = body.replace(/\\(.)/g, '$1')[0];

  return first ?? null;
}

function classMatches(body: string, candidate: string): boolean {
  try {
    return new RegExp(`[${body}]`).test(candidate);
  } catch {
    return false;
  }
}

/** Every regular expression literal in a module's source. */
function regexesOf(source: string): string[] {
  const found: string[] = [];
  const re = /(?:=|\.test\(|\.exec\(|\.match\(|\.matchAll\(|\.replace\(|\.split\(|return)\s*\/((?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+)\/[gimsuy]*/g;
  for (const m of source.matchAll(re)) found.push(m[1]);

  return found;
}

/**
 * Write, for every module, the lines its own patterns match.
 *
 * Modules are grouped a few to a file so the fixture does not grow by eight
 * hundred files, and the groups keep each module's shapes together.
 */
export function addPatternSamples(root: string, toolsDir: string): void {
  const credentialish = /(secret|password|passwd|credential|api[_-]?key|private[_-]?key)/i;
  const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.ts')).sort();

  const perModule: Array<[string, string[]]> = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(toolsDir, file), 'utf-8');
    const lines = new Set<string>();
    for (const pattern of regexesOf(source)) {
      if (pattern.length > 300) continue;
      let sample: string | null = null;
      try { sample = sampleFor(pattern); } catch { sample = null; }
      if (!sample) continue;
      const cleaned = sample.replace(/[\r\n]+/g, ' ').trim();
      if (cleaned.length < 4 || cleaned.length > 200) continue;
      if (credentialish.test(cleaned)) continue;
      // It has to match what it was built from, or it is noise.
      try { if (!new RegExp(pattern).test(cleaned)) continue; } catch { continue; }
      lines.add(cleaned);
    }
    if (lines.size > 0) perModule.push([file.replace(/\.ts$/, ''), [...lines]]);
  }

  const groupSize = 4;
  for (let i = 0; i < perModule.length; i += groupSize) {
    const group = perModule.slice(i, i + groupSize);
    const body: string[] = [
      '<?php',
      '',
      '/**',
      ' * Lines matching the patterns of a few analysers, for the tool test-suite.',
      ' *',
      ' * Generated from the analysers themselves: each pattern turned back into',
      ' * one string that matches it. A fixture — never executed.',
      ' */',
      '',
      'namespace App\\Samples;',
      '',
    ];
    for (const [name, lines] of group) {
      body.push(`// ${name}`);
      for (const line of lines) body.push(line);
      body.push('');
    }
    const fileName = `Samples${String(i / groupSize).padStart(3, '0')}.php`;
    put(root, `src/Samples/${fileName}`, body.join('\n') + '\n');
  }

  // The same lines where a module reads templates and configuration.
  const all = perModule.flatMap(([, lines]) => lines);
  const twigLines = all.filter((l) => /\{\{|\{%|<[a-z]|\||twig/i.test(l)).slice(0, 400);
  put(root, 'templates/generated_patterns.html.twig', [
    '{# Lines matching the template patterns of the analysers. A fixture. #}',
    ...twigLines.map((l) => (/\{\{|\{%/.test(l) ? l : `{# ${l.replace(/[#{}]/g, '')} #}`)),
  ].join('\n') + '\n');

  const yamlLines = all.filter((l) => /^[a-z_]{3,40}\s*:/i.test(l)).slice(0, 400);
  put(root, 'config/packages/generated_patterns.yaml', [
    '# Lines matching the configuration patterns of the analysers. A fixture.',
    'generated_patterns:',
    ...yamlLines.map((l) => `    ${JSON.stringify(l)}: ~`),
  ].join('\n') + '\n');
}
