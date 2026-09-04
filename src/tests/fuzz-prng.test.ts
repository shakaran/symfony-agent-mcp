// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The seeded generator the fuzz suite draws from.
 *
 * Two runs from the same seed must produce the same sequence, or a failing
 * case cannot be reproduced from the seed the failure prints — which is the
 * whole reason the generator is seeded rather than random.
 */

import { makePrng } from '../fuzz/generators.js';

describe('the seeded generator', () => {
  test('the same seed gives the same sequence', () => {
    const first = makePrng(1234);
    const second = makePrng(1234);

    for (let i = 0; i < 20; i++) {
      expect(second.next()).toBe(first.next());
    }
  });

  test('a different seed gives a different sequence', () => {
    const first = makePrng(1);
    const second = makePrng(2);

    const a = Array.from({ length: 10 }, () => first.next());
    const b = Array.from({ length: 10 }, () => second.next());

    expect(a).not.toEqual(b);
  });

  test('next stays inside the unit interval', () => {
    const prng = makePrng(99);

    for (let i = 0; i < 200; i++) {
      const value = prng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test('nextInt stays inside its bounds, including a single-value range', () => {
    const prng = makePrng(7);

    for (let i = 0; i < 200; i++) {
      const value = prng.nextInt(-5, 5);
      expect(value).toBeGreaterThanOrEqual(-5);
      expect(value).toBeLessThanOrEqual(5);
      expect(Number.isInteger(value)).toBe(true);
    }

    expect(prng.nextInt(3, 3)).toBe(3);
  });

  test('nextString honours the length bound and the charset', () => {
    const prng = makePrng(11);

    for (let i = 0; i < 50; i++) {
      const value = prng.nextString(12);
      expect(value.length).toBeLessThanOrEqual(12);
    }

    const fromCharset = prng.nextString(30, 'ab');
    expect(fromCharset).toMatch(/^[ab]*$/);
    expect(prng.nextString(0)).toBe('');
  });

  test('nextBytes returns the length asked for, every byte in range', () => {
    const prng = makePrng(2026);

    const buffer = prng.nextBytes(64);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBe(64);
    for (const byte of buffer) {
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }

    expect(prng.nextBytes(0).length).toBe(0);

    // And it is part of the same sequence: same seed, same bytes.
    expect(makePrng(2026).nextBytes(64)).toEqual(buffer);
  });
});
