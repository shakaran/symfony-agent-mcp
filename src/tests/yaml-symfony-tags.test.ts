// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The YAML schema behind every configuration file the tools read.
 *
 * js-yaml refuses a tag it does not know, and Symfony writes several of its
 * own, so a single !tagged_iterator used to make a whole services.yaml
 * unreadable. What is checked here is that each shape a tag can take comes
 * back with the tag as a key, that merge keys still work, and that the schema
 * is safe to dump with.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { parseYamlFile, SYMFONY_YAML_SCHEMA } from '../utils/symfony-parser';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-tags-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function parse(name: string, content: string): unknown {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return parseYamlFile(file);
}

describe('the tags Symfony writes', () => {
  test('a tag on a mapping keeps its name and its pairs', () => {
    const parsed = parse('locator.yaml', `services:
    App\\Handler\\HandlerLocator:
        arguments:
            - !tagged_locator { tag: app.handler, index_by: alias }
`) as { services: Record<string, { arguments: Array<Record<string, unknown>> }> };

    const arg = parsed.services['App\\Handler\\HandlerLocator'].arguments[0];

    expect(arg['!tagged_locator']).toEqual({ tag: 'app.handler', index_by: 'alias' });
  });

  test('a tag on a sequence keeps its name and its items', () => {
    const parsed = parse('iterator.yaml', `services:
    App\\Registry:
        arguments:
            - !tagged_iterator
                - app.first
                - app.second
`) as { services: Record<string, { arguments: Array<Record<string, unknown>> }> };

    const arg = parsed.services['App\\Registry'].arguments[0];

    expect(arg['!tagged_iterator']).toEqual(['app.first', 'app.second']);
  });

  test('a tag on a scalar keeps its name and its text', () => {
    const parsed = parse('const.yaml', `parameters:
    app.mode: !php/const App\\Kernel::MODE_STRICT
    app.services: !tagged_iterator app.handler
`) as { parameters: Record<string, Record<string, unknown>> };

    expect(parsed.parameters['app.mode']['!php/const']).toBe('App\\Kernel::MODE_STRICT');
    expect(parsed.parameters['app.services']['!tagged_iterator']).toBe('app.handler');
  });

  test('a repeated key inside a tagged mapping is rejected, not merged', () => {
    const parsed = parse('duplicate.yaml', `services:
    App\\Thing:
        arguments:
            - !tagged_locator { tag: app.handler, tag: app.other }
`);

    // The duplicate is what makes the document invalid; nothing comes back.
    expect(parsed).toBeNull();
  });

  test('a merge key still merges, including out of a tagged mapping', () => {
    const parsed = parse('merge.yaml', `defaults: &defaults
    autowire: true
    autoconfigure: true

tagged: &tagged !tagged_locator
    tag: app.handler

services:
    App\\First:
        <<: *defaults
        class: App\\First
    App\\Second:
        <<: *tagged
        class: App\\Second
`) as { services: Record<string, Record<string, unknown>> };

    expect(parsed.services['App\\First']).toEqual({
      autowire: true, autoconfigure: true, class: 'App\\First',
    });
    expect(parsed.services['App\\Second']['!tagged_locator']).toEqual({ tag: 'app.handler' });
    expect(parsed.services['App\\Second']['class']).toBe('App\\Second');
  });

  test('an unreadable or absent file comes back as null rather than throwing', () => {
    expect(parseYamlFile(path.join(dir, 'nothing-here.yaml'))).toBeNull();
    expect(parse('broken.yaml', 'services: [unclosed\n')).toBeNull();
  });

  test('the schema can still write YAML back out', () => {
    const dumped = yaml.dump(
      { services: { 'App\\Thing': { arguments: ['@logger'], tags: ['app.handler'] } } },
      { schema: SYMFONY_YAML_SCHEMA },
    );

    expect(dumped).toContain('App\\Thing');
    expect(dumped).toContain('app.handler');
    expect(yaml.load(dumped, { schema: SYMFONY_YAML_SCHEMA })).toEqual({
      services: { 'App\\Thing': { arguments: ['@logger'], tags: ['app.handler'] } },
    });
  });
});
