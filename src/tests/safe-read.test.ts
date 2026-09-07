// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The one read every analyser makes.
 *
 * What matters here is the refusal: a path that resolves outside the
 * application is not read at all, however it got that way.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { safeRead } from '../utils/safe-read';

let base: string;
let outside: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-read-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.mkdirSync(path.join(base, 'config'), { recursive: true });
  fs.writeFileSync(path.join(base, 'config', 'services.yaml'), 'services: {}\n');
  fs.writeFileSync(path.join(outside, 'secrets.env'), 'APP_SECRET=value\n');
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('a file inside the application comes back', () => {
  expect(safeRead(path.join(base, 'config', 'services.yaml'), base)).toBe('services: {}\n');
});

test('a path that climbs out of the application is refused', () => {
  const climbing = path.join(base, 'config', '..', '..', path.basename(outside), 'secrets.env');

  expect(safeRead(climbing, base)).toBeNull();
});

test('an absolute path elsewhere is refused', () => {
  expect(safeRead(path.join(outside, 'secrets.env'), base)).toBeNull();
});

test('a sibling directory whose name starts with the base name is refused', () => {
  // /app-2/file is not inside /app, however much the strings look alike.
  const sibling = `${base}-2`;
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'file.txt'), 'x');

  try {
    expect(safeRead(path.join(sibling, 'file.txt'), base)).toBeNull();
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test('the application root itself is allowed, in case it is the file', () => {
  const single = path.join(base, 'config', 'services.yaml');

  expect(safeRead(single, single)).toBe('services: {}\n');
});

test('a file that is not there, and a directory, come back as null', () => {
  expect(safeRead(path.join(base, 'config', 'missing.yaml'), base)).toBeNull();
  expect(safeRead(path.join(base, 'config'), base)).toBeNull();
});
