/**
 * server.json and package.json must agree.
 *
 * The MCP Registry verifies ownership by matching the `mcpName` inside the
 * published npm tarball against the `name` in server.json, and rejects a
 * publish whose version does not exist on npm. Three values therefore have to
 * be bumped together at every release, in two files, by hand — exactly the
 * shape of mistake that only shows up as a failed publish long after the fact.
 */

import * as fs from 'fs';
import * as path from 'path';

const root = (f: string): string => path.resolve(__dirname, '../..', f);
const read = (f: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(root(f), 'utf-8')) as Record<string, unknown>;

const pkg = read('package.json');
const server = read('server.json');
const npmPackage = (server['packages'] as Array<Record<string, unknown>>)[0];

describe('registry metadata', () => {
  test('server.json name matches package.json mcpName', () => {
    expect(server['name']).toBe(pkg['mcpName']);
  });

  test('the namespace is one GitHub auth can vouch for', () => {
    // Publishing with GitHub authentication only works under io.github.<user>/.
    expect(server['name']).toMatch(/^io\.github\.[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
  });

  test('every version agrees with package.json', () => {
    expect(server['version']).toBe(pkg['version']);
    expect(npmPackage['version']).toBe(pkg['version']);
  });

  test('the npm identifier is the package that actually ships', () => {
    expect(npmPackage['identifier']).toBe(pkg['name']);
    expect(npmPackage['registryType']).toBe('npm');
  });

  test('the description fits the registry limit', () => {
    // maxLength 100 in the official schema; a longer one is rejected at publish.
    expect((server['description'] as string).length).toBeLessThanOrEqual(100);
    expect((server['title'] as string).length).toBeLessThanOrEqual(100);
  });

  test('the transport matches how the binary is actually launched', () => {
    expect((npmPackage['transport'] as Record<string, unknown>)['type']).toBe('stdio');
    expect(pkg['bin']).toHaveProperty('symfony-agent-mcp');
  });

  test('no environment variable is marked required', () => {
    // The server starts with no configuration at all; anything flagged
    // required here would make clients prompt for a value they do not need.
    const envs = npmPackage['environmentVariables'] as Array<Record<string, unknown>>;

    expect(envs.length).toBeGreaterThan(0);
    expect(envs.filter((e) => e['isRequired'] === true)).toEqual([]);
  });

  test('glama.json names the repository owner as maintainer', () => {
    const glama = read('glama.json');
    expect(glama['maintainers']).toContain('shakaran');
  });
});
