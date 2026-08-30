// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * What every directory walker in src/tools guards against.
 *
 * Each module that scans a directory writes the same three guards: skip a
 * symlink, recurse into a subdirectory, ignore anything that is neither.
 * A flat fixture never exercises them, and there are around eight hundred
 * walkers, so this puts a symlink and a nested directory inside every
 * directory the fixture has — which is also what a real project looks like,
 * with its vendor links, its shared uploads and its per-domain subfolders.
 */

import * as fs from 'fs';
import * as path from 'path';

const SKIP = new Set(['.git', 'node_modules', 'vendor', '_walker_target']);

function directoriesOf(root: string, depth: number): string[] {
  if (depth < 0) return [];
  const found: string[] = [root];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (SKIP.has(entry.name) || entry.name.startsWith('_walker')) continue;
    found.push(...directoriesOf(path.join(root, entry.name), depth - 1));
  }

  return found;
}

/**
 * Put a symlink and a nested directory in every directory of `root`.
 */
export function addWalkerEntries(root: string, depth = 5): void {
  const target = path.join(root, 'composer.json');
  if (!fs.existsSync(target)) fs.writeFileSync(target, '{}\n');

  // The directory a symlink points at is a leaf holding one file. Pointing it
  // at the application root instead makes every walker that follows symlinks
  // descend for ever, which is how this was first written.
  const linkTarget = path.join(root, '_walker_target');
  fs.mkdirSync(linkTarget, { recursive: true });
  fs.writeFileSync(path.join(linkTarget, 'Target.php'), '<?php\n\nclass Target {}\n');

  for (const dir of directoriesOf(root, depth)) {
    const nested = path.join(dir, '_walker_nested');
    try {
      fs.mkdirSync(nested, { recursive: true });
      // Something for the recursion to find once it goes in.
      fs.writeFileSync(path.join(nested, 'Nested.php'), [
        '<?php',
        '',
        'namespace App\\Nested;',
        '',
        'class Nested',
        '{',
        '    public const KIND = "nested";',
        '}',
      ].join('\n') + '\n');
      fs.writeFileSync(path.join(nested, 'nested.yaml'), 'nested:\n    kind: nested\n');
    } catch { /* a directory the fixture made unreadable on purpose */ }

    // Symlinks, which the walkers refuse to follow.
    for (const [name, to] of [['_walker_link.php', target], ['_walker_link_dir', linkTarget]] as const) {
      const link = path.join(dir, name);
      try {
        if (!fs.existsSync(link)) fs.symlinkSync(to, link);
      } catch { /* no permission, or no symlinks on this filesystem */ }
    }
  }
}

/**
 * A cache pool big enough to be reported in megabytes rather than kilobytes.
 */
export function addLargeCacheEntry(root: string): void {
  const dir = path.join(root, 'var', 'cache', 'dev', 'pools', 'app');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'large-entry.php'), '<?php\n\nreturn "' + 'x'.repeat(2 * 1024 * 1024) + '";\n');
  } catch { /* skip */ }
}
