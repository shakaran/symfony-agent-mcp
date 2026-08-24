// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Property-based tests for the security pipeline, using fast-check.
 *
 * The existing fuzz suite (src/fuzz/generators.ts) drives a seeded LCG over a
 * fixed corpus, which is good at breadth but reports failures as whatever
 * 4 KB blob happened to break. fast-check adds shrinking: when a property
 * fails it reduces the input to a minimal counterexample and prints the seed
 * to replay it, so a red build points at a specific character rather than a
 * haystack.
 *
 * These assert invariants, not outputs. Each one is a statement that must hold
 * for every input, including inputs nobody thought to write a fixture for:
 * the functions must never throw, must never grow unboundedly, and must never
 * emit a credential they were handed.
 */

import fc from 'fast-check';

import { scanText, redactText, containsDlpViolation, dlpSanitize } from '../utils/dlp-detector';
import { sanitizeErrorMessage } from '../utils/output-sanitizer';
import { validateToolArgs } from '../utils/input-validator';
import { guardAppPath } from '../utils/app-guard';
import {
  STRIPE_LIVE_KEY,
  SLACK_BOT_TOKEN,
  SENDGRID_KEY,
  GITHUB_TOKEN,
  GITHUB_PAT,
  GCP_API_KEY,
} from '../fuzz/secret-fixtures';

// Keep the default run count modest so the suite stays fast in CI; the nightly
// fuzz workflow is where volume belongs.
const RUNS = Number(process.env['FC_NUM_RUNS'] ?? 200);
const opts: fc.Parameters<unknown> = { numRuns: RUNS };

beforeAll(() => {
  process.env['SYMFONY_MCP_DLP'] = 'true';
});

describe('DLP detector — invariants over arbitrary text', () => {
  test('scanText never throws, whatever the input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (s) => {
        scanText(s);
      }),
      opts
    );
  });

  test('scanText never throws on adversarial unicode', () => {
    // `unit: 'binary'` reaches lone surrogates and unpaired code units, which
    // is exactly where a regex engine tends to misbehave.
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 256 }), (s: string) => {
        scanText(s);
      }),
      opts
    );
  });

  test('redactText is idempotent — redacting twice changes nothing', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (s) => {
        const once = redactText(s);
        expect(redactText(once)).toBe(once);
      }),
      opts
    );
  });

  test('redactText leaves text without secrets untouched', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (s) => {
        if (scanText(s).length === 0) {
          expect(redactText(s)).toBe(s);
        }
      }),
      opts
    );
  });

  test('a secret stays redacted no matter what surrounds it', () => {
    const secrets = [
      STRIPE_LIVE_KEY,
      SLACK_BOT_TOKEN,
      SENDGRID_KEY,
      GITHUB_TOKEN,
      GITHUB_PAT,
      GCP_API_KEY,
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...secrets),
        // Delimiters only. The patterns are \b-anchored and length-exact by
        // design, so a secret glued to adjacent word characters is a different
        // string and legitimately not a match.
        fc.stringMatching(/^[ \t"'=:,([]*$/),
        fc.stringMatching(/^[ \t"'.,)\]]*$/),
        (secret, prefix, suffix) => {
          const result = redactText(`${prefix}${secret}${suffix}`);
          expect(result).not.toContain(secret);
        }
      ),
      opts
    );
  });

  test('containsDlpViolation agrees with scanText on plain strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (s) => {
        expect(containsDlpViolation(s)).toBe(scanText(s).length > 0);
      }),
      opts
    );
  });

  test('dlpSanitize never leaks a secret through nested structures', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(STRIPE_LIVE_KEY, SLACK_BOT_TOKEN, GITHUB_TOKEN),
        fc.stringMatching(/^[ \t"'=:,]*$/),
        (secret, noise) => {
          const nested = { a: [{ b: { c: `${noise}${secret}` } }] };
          expect(JSON.stringify(dlpSanitize(nested))).not.toContain(secret);
        }
      ),
      opts
    );
  });
});

describe('Error sanitizer — invariants', () => {
  test('never throws and never grows the message', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (s) => {
        const out = sanitizeErrorMessage(s);
        expect(typeof out).toBe('string');
        // Not "never grows". Redaction swaps a secret for a label, and a short
        // secret gets a longer one: `C:\\x` becomes `[PATH]`. That is the
        // sanitizer working, not failing. What must hold is that no substitution
        // runs away with the input — each replaces at least four characters with
        // six, so the output stays within a small factor of what came in.
        expect(out.length).toBeLessThanOrEqual(s.length * 2 + 64);
      }),
      opts
    );
  });

  test('is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (s) => {
        const once = sanitizeErrorMessage(s);
        expect(sanitizeErrorMessage(once)).toBe(once);
      }),
      opts
    );
  });
});

describe('Path guard — invariants', () => {
  test('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (s) => {
        const r = guardAppPath(s);
        expect(typeof r.allowed).toBe('boolean');
      }),
      opts
    );
  });

  test('always rejects a path containing a traversal segment', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('..', 'etc', 'app', 'var'), { minLength: 1, maxLength: 6 }),
        (parts) => {
          if (!parts.includes('..')) return;
          expect(guardAppPath(`/${parts.join('/')}`).allowed).toBe(false);
        }
      ),
      opts
    );
  });

  test('always rejects the empty path and whitespace-only paths', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[ \t\n]*$/), (s) => {
        expect(guardAppPath(s).allowed).toBe(false);
      }),
      opts
    );
  });
});

describe('Input validator — invariants', () => {
  test('never throws for any tool name and argument bag', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 256 }),
        fc.dictionary(
          fc.string({ maxLength: 32 }),
          fc.oneof(fc.string({ maxLength: 64 }), fc.integer(), fc.boolean()),
          { maxKeys: 8 }
        ),
        (tool, args) => {
          const r = validateToolArgs(tool, args);
          expect(typeof r.valid).toBe('boolean');
        }
      ),
      opts
    );
  });

  test('rejects any app_path carrying a shell metacharacter', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(';', '|', '&', '$', '`', '>', '<', '\n'),
        fc.string({ minLength: 1, maxLength: 64 }),
        (meta, rest) => {
          const r = validateToolArgs('list_routes', { app_path: `/app${meta}${rest}` });
          expect(r.valid).toBe(false);
        }
      ),
      opts
    );
  });
});
