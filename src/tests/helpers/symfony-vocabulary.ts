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
    const sample = sampleFor(alternative);
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

const SKIP_PATH = /^(\/|\.\.|node_modules|vendor)/;

/**
 * The paths one module reads, taken from its own source.
 *
 * A module that opens `.circleci/config.yml` and nothing else sees nothing in
 * an application built from a list of paths somebody guessed. These are the
 * ones it names itself: every `path.join(appPath, ...)` it builds and every
 * literal in it shaped like a file name.
 */
export function pathsForModule(modulePath: string): string[] {
  let source = '';
  try { source = fs.readFileSync(modulePath, 'utf-8'); } catch { return []; }

  const out = new Set<string>();

  for (const m of source.matchAll(/path\.join\(\s*appPath\s*,([^)]{0,200})\)/g)) {
    const parts = [...m[1].matchAll(/'([^']{1,60})'/g)].map((p) => p[1]);
    if (parts.length > 0) out.add(parts.join('/'));
  }

  const named = /'([A-Za-z0-9._][A-Za-z0-9._/-]{2,60}\.(?:ya?ml|json|neon|xml|toml|ini|conf|php|js|ts|env|dist|properties|hcl|proto|avsc|lock|md|feature|twig|sh|tf))'/g;
  for (const m of source.matchAll(named)) out.add(m[1]);

  return [...out].filter((p) => !SKIP_PATH.test(p) && !p.includes('..') && !p.includes('*'));
}

/**
 * The environment variables one module reads, from its own source.
 *
 * A name mentioned in a comment is not an environment variable; several
 * dozen modules do nothing until they find one set.
 */
export function envNamesForModule(modulePath: string): string[] {
  let source = '';
  try { source = fs.readFileSync(modulePath, 'utf-8'); } catch { return []; }

  const out = new Set<string>();
  for (const m of source.matchAll(/'([A-Z][A-Z0-9_]{3,50})'/g)) out.add(m[1]);
  for (const m of source.matchAll(/\b([A-Z][A-Z0-9_]{3,50})\s*=/g)) out.add(m[1]);

  return [...out].filter((n) => !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(n)).slice(0, 60);
}

/**
 * The Composer packages one module gates on.
 *
 * An integration analyser reads composer.json first, does not find the
 * package it is about, and returns before anything else it does can run.
 */
export function packagesForModule(modulePath: string): string[] {
  let source = '';
  try { source = fs.readFileSync(modulePath, 'utf-8'); } catch { return []; }

  const notAPackage = /\.(php|ya?ml|json|xml|twig|ini|conf|toml|lock|md|js|ts)$/;
  const pathPrefix = /^(src|config|var|bin|public|templates|tests|docker|vendor|node_modules)\//;
  const mimeish = /^(application|text|image|audio|video|multipart|message|font)\//;

  const out = new Set<string>();
  for (const m of source.matchAll(/'([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)'/g)) {
    const name = m[1];
    if (notAPackage.test(name) || pathPrefix.test(name) || mimeish.test(name)) continue;
    out.add(name);
  }

  return [...out].slice(0, 60);
}
