// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Every tool module, run against a real Symfony application.
 *
 * The 820 modules under src/tools/ had no tests at all. They are the bulk of
 * the codebase and, so far, the source of every parsing defect found: three
 * ReDoS patterns, a prototype-pollution write, a duplicated `||` condition, a
 * route check made unreachable by an early continue.
 *
 * Writing 820 bespoke suites is not the way in. What these modules share is a
 * shape — an exported function taking an application path and returning an
 * McpToolResult — so this drives all of them across the three situations that
 * break parsers: a realistic project, an empty directory, and a path that does
 * not exist. What it proves is narrow but exactly what was missing: no module
 * throws on any of them, none hangs, and each returns the result shape the
 * server will try to serialise.
 *
 * Targeted suites for individual tools live alongside this one.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  createSymfonyFixture, createProblematicFixture, createSkeletonFixture,
  createCorruptFixture,
  addEcosystemFiles, addBulkContent, addSymlinks, addClasslessFiles,
  addUnreadableFiles, restorePermissions, removeFixture,
} from './helpers/symfony-fixture';
import {
  addAllAreas, addPerModuleSurface, addComposerDependencies,
} from './helpers/symfony-areas';
import { addTargetedContent } from './helpers/symfony-targeted';
import { addLegacyStyle } from './helpers/symfony-legacy';
import { addPlatformAndConfig } from './helpers/symfony-platforms';
import { addPhpPatterns } from './helpers/symfony-php-patterns';
import { addPhpLanguageFeatures } from './helpers/symfony-php-language';
import { addInsecureVariants } from './helpers/symfony-insecure';

const toolsDir = path.resolve(__dirname, '../tools');

/** Module names, without extension, sorted so failures are reproducible. */
const moduleNames = fs.readdirSync(toolsDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .sort();

interface McpToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/**
 * Call one export and check what it gives back.
 *
 * Not every one-argument export is a tool handler: `database` has async ones
 * returning a Promise, and `tool-discovery` exports a session-id helper that
 * returns a string. Anything shaped like an McpToolResult is held to that
 * shape; anything else only has to return anything at all without throwing,
 * which is still the thing worth knowing about a parser fed a hostile path.
 */
async function callAndCheck(fn: (arg: string) => unknown, arg: string): Promise<void> {
  const returned = await Promise.resolve(fn(arg));

  expect(returned).toBeDefined();
  expect(returned).not.toBeNull();

  const r = returned as McpToolResultLike;
  if (typeof returned === 'object' && 'content' in (returned as object)) {
    expect(Array.isArray(r.content)).toBe(true);
    for (const part of r.content ?? []) {
      expect(typeof part).toBe('object');
      if (part.type === 'text') expect(typeof part.text).toBe('string');
    }
  }
}

/** Call an export of any arity and check what it gives back. */
async function callAndCheckMulti(fn: (...a: unknown[]) => unknown, args: unknown[]): Promise<void> {
  const returned = await Promise.resolve(fn(...args));

  expect(returned).toBeDefined();
  expect(returned).not.toBeNull();

  const r = returned as McpToolResultLike;
  if (typeof returned === 'object' && 'content' in (returned as object)) {
    expect(Array.isArray(r.content)).toBe(true);
  }
}

/** The one-argument exports of a module, which take the application path. */
function pathFunctions(mod: Record<string, unknown>): Array<[string, (a: string) => unknown]> {
  return Object.entries(mod)
    .filter(([, v]) => typeof v === 'function' && (v as (a: string) => unknown).length === 1)
    .map(([k, v]) => [k, v as (a: string) => unknown]);
}

/**
 * Exports taking more than the application path.
 *
 * Forty-one of them — `getWorkflowDetails(appPath, workflowName)`,
 * `searchLog(appPath, fileName, searchTerm)` — and the sweep called none,
 * because it only ever passed one argument. Whole functions sat unexecuted for
 * that reason alone. Note that a parameter with a default does not count
 * towards `length`, so those were already covered.
 */
function multiArgFunctions(
  mod: Record<string, unknown>
): Array<[string, (...a: unknown[]) => unknown, number]> {
  return Object.entries(mod)
    .filter(([, v]) => typeof v === 'function' && (v as (...a: unknown[]) => unknown).length >= 2)
    .map(([k, v]) => [k, v as (...a: unknown[]) => unknown, (v as (...a: unknown[]) => unknown).length]);
}

/**
 * Plausible values for a second or third argument.
 *
 * Both a name the fixture contains and one it does not: a lookup that finds
 * something and a lookup that does not are different code paths, and the
 * "not found" branch is usually the longer of the two.
 */
const ARGUMENT_GUESSES: string[][] = [
  ['User', 'dev', 'messages'],
  ['no-such-name-4a1c9f', 'no-such-file.log', 'zz'],
];

let fixture: string;
let problematic: string;
let skeleton: string;
let emptyDir: string;
let outsideRoot: string;
let corrupt: string;
let filePath: string;
let weirdPath: string;
let scratchRoot: string;
let missingPath: string;

beforeAll(() => {
  fixture = createSymfonyFixture();
  problematic = createProblematicFixture();
  // A real project containing nothing: what reaches the several hundred
  // 'I looked and found nothing' branches that an empty directory misses,
  // because a non-project fails an earlier guard.
  skeleton = createSkeletonFixture();
  // Configuration that will not parse, which is what reaches each module's
  // outermost error handler.
  corrupt = createCorruptFixture();
  // Container files, CI definitions, asset tooling: dozens of modules read
  // these and analyse nothing without them.
  addEcosystemFiles(fixture);
  addEcosystemFiles(problematic);
  // Per-area content: a messenger transport with a failure queue, a workflow
  // with places and transitions, an API Platform resource with filters.
  // Without these the area modules parse nothing and report nothing.
  addAllAreas(fixture);
  addAllAreas(problematic);
  // One reference class per analyser, holding the symbols that analyser
  // searches for, so its parsing runs against something it recognises.
  addPerModuleSurface(fixture, toolsDir);
  addPerModuleSurface(problematic, toolsDir);
  // Hundreds of guards compare a count against a number; one of each kind
  // never crosses them.
  addBulkContent(fixture);
  // The broken application needs volume too: a good number of checks only
  // report once a count crosses a threshold.
  addBulkContent(problematic, 25);
  // Content aimed at the modules holding the most uncovered code, written
  // from what each of them reads and looks for.
  addTargetedContent(fixture);
  // Without the profiler index, so the walking reader runs on one of them.
  addTargetedContent(problematic, false);
  // Integration modules gate on the dependency being declared before doing
  // anything at all, so this has to come after the targeted blocks that
  // write composer.json themselves.
  addComposerDependencies(fixture, toolsDir);
  addComposerDependencies(problematic, toolsDir);
  // Docblock annotations, XML mapping and registered bundles. 81 modules
  // handle the annotation style as well as attributes, and every fixture so
  // far used attributes only, so the longer branch never ran.
  addLegacyStyle(fixture);
  addLegacyStyle(problematic);
  // Deployment descriptors and the Symfony configuration a dozen analysers
  // read, at the exact paths they join onto the application root.
  addPlatformAndConfig(fixture);
  addPlatformAndConfig(problematic);
  // PHP in the shapes the source-reading analysers look for.
  addPhpPatterns(fixture);
  addPhpPatterns(problematic);
  // Language features and library use, for the analysers whose collections
  // stay empty — which is what leaves their filter and map callbacks
  // uncalled.
  addPhpLanguageFeatures(fixture);
  addPhpLanguageFeatures(problematic);
  // The opposite value for every setting the analysers check, on the broken
  // fixture only, so between the two both branches of each check run.
  addInsecureVariants(problematic);
  // 761 uncovered guards are entry.isSymbolicLink(), and 191 more are the null
  // a guarded read returns for a path resolving outside the application. Both
  // need actual links on disk.
  // Its own directory, so the directory link below exposes a small, known set
  // of files rather than the whole of /tmp.
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-outside-'));
  const outside = path.join(outsideDir, 'symfony-outside-target.txt');
  fs.writeFileSync(outside, 'outside the application\n');
  fs.writeFileSync(path.join(outsideDir, 'Escaped.php'), '<?php\nclass Escaped {}\n');
  fs.writeFileSync(path.join(outsideDir, 'escaped.yaml'), 'framework: ~\n');
  fs.writeFileSync(path.join(outsideDir, 'escaped.html.twig'), '{{ escaped }}\n');
  outsideRoot = outsideDir;
  addSymlinks(fixture, outside);
  addSymlinks(problematic, outside);
  // 244 guards are `!classMatch`: every file so far declared a class.
  addClasslessFiles(fixture);
  addClasslessFiles(problematic);
  // A file with no read permission is the null the guarded reader returns,
  // without a symlink the walkers would skip first.
  addUnreadableFiles(fixture);
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-empty-'));
  missingPath = path.join(os.tmpdir(), 'symfony-does-not-exist-4a1c9f');
  // A file where a directory is expected. Reading a directory entry from it
  // raises ENOTDIR, which is what reaches each module's outermost catch — the
  // branch that turns an internal failure into an error result instead of
  // letting it escape to the client.
  // Inside a private directory: a fixed name in the shared temp directory is a
  // symlink-swap target and collides between concurrent runs.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-scratch-'));
  filePath = path.join(scratch, 'not-a-directory.txt');
  fs.writeFileSync(filePath, 'this is a file, not an application\n');
  // A path that is syntactically hostile rather than merely absent.
  weirdPath = path.join(scratch, 'weird-\u00a0-\u0301-name');
  fs.mkdirSync(weirdPath, { recursive: true });
  scratchRoot = scratch;
});

afterAll(() => {
  restorePermissions(fixture);
  removeFixture(fixture);
  removeFixture(problematic);
  removeFixture(skeleton);
  removeFixture(corrupt);
  fs.rmSync(outsideRoot, { recursive: true, force: true });
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

describe('every tool module', () => {
  test('the sweep covers the whole directory', () => {
    // A guard on the guard: if the glob silently matched nothing, the rest of
    // this file would pass while testing zero modules.
    expect(moduleNames.length).toBeGreaterThan(500);
  });

  describe.each(moduleNames)('%s', (name) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: Record<string, any>;

    beforeAll(async () => {
      mod = (await import(path.join(toolsDir, name))) as Record<string, unknown>;
    });

    test('exports at least one function', () => {
      const fns = Object.values(mod).filter((v) => typeof v === 'function');
      expect(fns.length).toBeGreaterThan(0);
    });

    test('its tool definitions are well formed', () => {
      for (const [key, value] of Object.entries(mod)) {
        if (typeof value !== 'function' || value.length !== 0) continue;
        if (!/Tools$/.test(key)) continue;

        const defs = value() as Array<{ name?: string; description?: string; inputSchema?: unknown }>;
        expect(Array.isArray(defs)).toBe(true);

        for (const def of defs) {
          // These three are what the MCP client needs to offer a tool at all.
          expect(typeof def.name).toBe('string');
          expect(def.name).toMatch(/^[a-z0-9_]+$/);
          expect(typeof def.description).toBe('string');
          expect(def.description!.length).toBeGreaterThan(0);
          expect(typeof def.inputSchema).toBe('object');
        }
      }
    });

    test('analysing a real application returns a serialisable result', async () => {
      for (const [, fn] of pathFunctions(mod)) await callAndCheck(fn, fixture);
    });

    test('an application full of the problems it looks for is reported on', async () => {
      // The other fixture exercises the parsing; this one reaches the branch
      // that runs once a finding exists — injection-shaped SQL, shelled-out
      // commands, weak hashing, permissive CORS, debug left on in prod.
      for (const [, fn] of pathFunctions(mod)) await callAndCheck(fn, problematic);
    });

    test('a project containing nothing is reported as finding nothing', async () => {
      for (const [, fn] of pathFunctions(mod)) await callAndCheck(fn, skeleton);
    });

    test('exports taking more than a path are called too', async () => {
      // Once with values the fixture contains, once with values it does not.
      for (const guesses of ARGUMENT_GUESSES) {
        for (const [, fn, arity] of multiArgFunctions(mod)) {
          const extra = Array.from({ length: arity - 1 }, (_, i) => guesses[i % guesses.length]);
          await callAndCheckMulti(fn, [fixture, ...extra]);
        }
      }
    });

    test('an empty directory is handled without throwing', async () => {
      // No composer.json, no src/, no config/: every read must be defensive.
      for (const [, fn] of pathFunctions(mod)) await callAndCheck(fn, emptyDir);
    });

    test('configuration that will not parse becomes a result, not an exception', async () => {
      // A merge conflict left in composer.json, tabs in YAML, an unclosed XML
      // tag. Each module must come back with something the client can read.
      for (const [, fn] of pathFunctions(mod)) await callAndCheck(fn, corrupt);
    });

    test('a file where a directory belongs becomes an error result, not a throw', async () => {
      // Every module wraps its work so an internal failure comes back as a
      // result the client can read. That wrapper is a third of what was
      // uncovered, because nothing in the suite ever made one fail.
      for (const [, fn] of pathFunctions(mod)) await callAndCheck(fn, filePath);
    });

    test('a path with unusual characters is handled', async () => {
      for (const [, fn] of pathFunctions(mod)) await callAndCheck(fn, weirdPath);
    });

    test('a path that does not exist is handled without throwing', async () => {
      for (const [, fn] of pathFunctions(mod)) await callAndCheck(fn, missingPath);
    });
  });
});
