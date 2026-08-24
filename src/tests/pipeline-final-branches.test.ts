// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The remaining reachable branches.
 *
 * Recursion depth guards, the entity parser's flag resets between class
 * members, the DLP scan deadline, and the anomaly detector's bounded event
 * buffer. Each is a decision the code makes to protect itself, and none had
 * ever been exercised.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parseEntities, readLogFile } from '../utils/symfony-parser';
import { dlpSanitize, scanText, getDlpScanTimeoutMs } from '../utils/dlp-detector';
import {
  checkAnomaly, recordAuthFailure,
  resetAnomalyCounters, resetScanTracking, resetCorrelationTracking,
  getRecentAnomalyEvents,
} from '../utils/anomaly-detector';
import { cacheManager } from '../utils/cache-manager';

const ENV_KEYS = ['SYMFONY_MCP_DLP', 'SYMFONY_MCP_DLP_TIMEOUT_MS', 'SYMFONY_MCP_ANOMALY'];

let saved: Record<string, string | undefined>;
let appDir: string;
let stderrSpy: jest.SpyInstance;

const write = (rel: string, body: string): void => {
  const full = path.join(appDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-branches-'));
  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  cacheManager.clear();
  resetAnomalyCounters();
  resetScanTracking();
  resetCorrelationTracking();
});

afterEach(() => {
  stderrSpy.mockRestore();
  resetAnomalyCounters();
  resetScanTracking();
  resetCorrelationTracking();
  fs.rmSync(appDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('dlpSanitize — recursion depth', () => {
  test('stops descending past the depth guard instead of recursing forever', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 15; i++) deep = { nested: deep };

    expect(() => dlpSanitize(deep)).not.toThrow();
  });

  test('a deeply nested secret above the guard is still redacted', () => {
    const secret = 'AKIA' + 'IOSFODNN7EXAMPLE';
    let nested: unknown = secret;
    for (let i = 0; i < 3; i++) nested = { level: nested };

    expect(JSON.stringify(dlpSanitize(nested))).not.toContain(secret);
  });
});

describe('DLP scan deadline', () => {
  test('reports the configured timeout', () => {
    process.env['SYMFONY_MCP_DLP_TIMEOUT_MS'] = '750';
    expect(getDlpScanTimeoutMs()).toBe(750);
  });

  test('falls back to a default when the timeout is unparseable', () => {
    process.env['SYMFONY_MCP_DLP_TIMEOUT_MS'] = 'soon';
    expect(getDlpScanTimeoutMs()).toBeGreaterThan(0);
  });

  test('abandons a scan that runs past its deadline and warns', () => {
    // 0 and negatives are clamped back to the 500 ms default, so 1 ms is the
    // smallest budget the code will actually honour.
    process.env['SYMFONY_MCP_DLP_TIMEOUT_MS'] = '1';
    const haystack = Array.from(
      { length: 8000 },
      (_, i) => `user${i}@example.com AKIAIOSFODNN7EXAMP${i % 10}`
    ).join(' ');

    const matches = scanText(haystack);

    expect(Array.isArray(matches)).toBe(true);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/exceeded timeout/i));
  });
});

describe('Luhn — lengths outside the card range', () => {
  test('a 12-digit run is too short to be a card', () => {
    expect(scanText('payment 123456789012 done').some((m) => /CARD/i.test(m.type))).toBe(false);
  });

  test('a 20-digit run is too long to be a card', () => {
    expect(scanText('ref 12345678901234567890 ok').some((m) => /CARD/i.test(m.type))).toBe(false);
  });
});

describe('entity parser — flags reset between members', () => {
  test('an ORM attribute does not leak onto the next property', () => {
    write('src/Entity/Mixed.php', `<?php
namespace App\\Entity;
use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\Table(name: 'mixed')]
class Mixed
{
    #[ORM\\Id]
    #[ORM\\Column(type: 'integer')]
    private int $id;

    public function getId(): int { return $this->id; }

    private string $notAColumn;

    #[ORM\\Column(type: 'string', name: 'real_column')]
    private string $mapped;
}
`);
    const [e] = parseEntities(appDir);

    expect(e).toBeDefined();
    // The identifier flag must not carry past the method onto later members.
    expect(e.properties.filter((p) => p.isId)).toHaveLength(1);
    // An unannotated member is not reported as a column.
    expect(e.properties.map((p) => p.name)).not.toContain('notAColumn');
    expect(e.properties.find((p) => p.name === 'mapped')?.columnName).toBe('real_column');
  });

  test('a file with no type declaration is skipped', () => {
    // Deliberately free of the word the name regex looks for: it matches
    // inside comments too, so a comment mentioning it would be picked up as
    // the entity name.
    write('src/Entity/Broken.php', `<?php
namespace App\\Entity;
use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
// nothing declared below
`);
    expect(parseEntities(appDir)).toEqual([]);
  });

  test('a class with no body is handled without throwing', () => {
    write('src/Entity/Headless.php', "<?php\nnamespace App\\Entity;\nuse Doctrine\\ORM\\Mapping as ORM;\n#[ORM\\Entity]\nclass Headless\n");
    expect(() => parseEntities(appDir)).not.toThrow();
  });
});

describe('readLogFile — unreadable file', () => {
  test('returns nothing when the log path is a directory', () => {
    fs.mkdirSync(path.join(appDir, 'var', 'log', 'dev.log'), { recursive: true });
    expect(readLogFile(appDir, 'dev.log')).toEqual([]);
  });
});

describe('anomaly detector — bounded state', () => {
  test('the recent-event buffer does not grow without limit', () => {
    for (let i = 0; i < 150; i++) checkAnomaly('list_routes', `../../../etc/passwd${i}`);

    const events = getRecentAnomalyEvents(1000);
    expect(events.length).toBeLessThanOrEqual(100);
  });

  test('a client with no recorded scan history yields an empty set', () => {
    // A first call for an unseen client must not throw on missing state.
    expect(() => checkAnomaly('never_seen_tool', '/var/www/app')).not.toThrow();
  });

  test('auth failures accumulate into a spike and then reset', () => {
    let spike = null;
    for (let i = 0; i < 8; i++) spike = recordAuthFailure('bad signature') ?? spike;

    expect(spike).not.toBeNull();

    resetAnomalyCounters();
    expect(recordAuthFailure('bad signature')).toBeNull();
  });
});
