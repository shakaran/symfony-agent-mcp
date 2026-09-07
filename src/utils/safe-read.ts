// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Reading a file the application asked for, and nothing else.
 *
 * Every analyser walks a tree it was pointed at and reads what it finds, and
 * every one of them needs the same two answers: is this path still inside the
 * application, and what happens when the read fails. That check used to be
 * copied into each module — 258 of them, in five spellings — which meant the
 * one piece of security-relevant code in the tools was the least reviewed.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Reads a file, provided it resolves inside `base`.
 *
 * A path that escapes the application (through `..`, a symlink, or a
 * configuration value that was never meant to be a path) returns null rather
 * than being read, and so does a read that fails.
 */
export function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}
