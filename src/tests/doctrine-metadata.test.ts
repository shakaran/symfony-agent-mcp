// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine metadata loader tests.
 *
 * The loader reads explicit Doctrine mapping files — XML under
 * config/doctrine/, YAML under config/doctrine/ or src/Entity/ — and turns
 * them into the structured entity model the introspection tools report. It
 * had no coverage, so every regex in it was unverified against real mapping
 * syntax.
 *
 * Fixtures are written to a temp directory shaped like a Symfony project.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadDoctrineMetadata, getDoctrineMetadataStats } from '../utils/doctrine-metadata';
import { cacheManager } from '../utils/cache-manager';

let appDir: string;

/** Builds an empty Symfony-shaped app and returns its root. */
function makeApp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctrine-meta-'));
  fs.mkdirSync(path.join(dir, 'config', 'doctrine'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'Entity'), { recursive: true });
  return dir;
}

function writeXml(dir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(dir, 'config', 'doctrine', name), body);
}

function writeYaml(dir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(dir, 'config', 'doctrine', name), body);
}

beforeEach(() => {
  // The loader memoises per app path; each test gets a fresh directory and a
  // clean cache so results cannot leak between them.
  cacheManager.clear();
  appDir = makeApp();
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

const PRODUCT_XML = `<?xml version="1.0" encoding="utf-8"?>
<doctrine-mapping>
  <entity name="App\\Entity\\Product" class="App\\Entity\\Product" table="products"
          repository-class="App\\Repository\\ProductRepository">
    <id name="id" type="integer" column="id">
      <generator strategy="AUTO"/>
    </id>
    <field name="name" type="string" column="product_name" length="255" unique="true"/>
    <field name="description" type="text" nullable="true"/>
    <field name="price" type="decimal" precision="10" scale="2"/>
    <many-to-one field="category" target-entity="App\\Entity\\Category" inversed-by="products" fetch="EAGER">
      <join-column name="category_id" referenced-column-name="id"/>
    </many-to-one>
    <one-to-many field="reviews" target-entity="App\\Entity\\Review" mapped-by="product" orphan-removal="true"/>
    <index name="idx_name" columns="product_name"/>
    <unique-constraint name="uniq_sku" columns="sku,vendor_id"/>
  </entity>
</doctrine-mapping>`;

describe('XML mappings', () => {
  test('reads class, table and repository', () => {
    writeXml(appDir, 'Product.orm.xml', PRODUCT_XML);
    const [e] = loadDoctrineMetadata(appDir).entities;

    expect(e.name).toBe('App\\Entity\\Product');
    expect(e.shortName).toBe('Product');
    expect(e.tableName).toBe('products');
    expect(e.repositoryClass).toBe('App\\Repository\\ProductRepository');
    expect(e.source).toBe('xml');
  });

  test('reads the identifier, including its generator', () => {
    writeXml(appDir, 'Product.orm.xml', PRODUCT_XML);
    const id = loadDoctrineMetadata(appDir).entities[0].properties.find((p) => p.isId);

    expect(id).toMatchObject({
      fieldName: 'id',
      columnName: 'id',
      type: 'integer',
      isId: true,
      unique: true,
      nullable: false,
      generatedValue: 'AUTO',
    });
  });

  test('reads field attributes, falling back to the field name for the column', () => {
    writeXml(appDir, 'Product.orm.xml', PRODUCT_XML);
    const props = loadDoctrineMetadata(appDir).entities[0].properties;

    expect(props.find((p) => p.fieldName === 'name')).toMatchObject({
      columnName: 'product_name', type: 'string', length: 255, unique: true, nullable: false,
    });
    expect(props.find((p) => p.fieldName === 'description')).toMatchObject({
      columnName: 'description', type: 'text', nullable: true,
    });
    expect(props.find((p) => p.fieldName === 'price')).toMatchObject({
      type: 'decimal', precision: 10, scale: 2,
    });
  });

  test('reads relationships with their direction and options', () => {
    writeXml(appDir, 'Product.orm.xml', PRODUCT_XML);
    const rels = loadDoctrineMetadata(appDir).entities[0].relationships;

    expect(rels.find((r) => r.fieldName === 'category')).toMatchObject({
      type: 'ManyToOne',
      targetEntity: 'App\\Entity\\Category',
      inversedBy: 'products',
      fetch: 'EAGER',
      joinColumn: { name: 'category_id', referencedColumnName: 'id' },
    });
    expect(rels.find((r) => r.fieldName === 'reviews')).toMatchObject({
      type: 'OneToMany', mappedBy: 'product', orphanRemoval: true,
    });
  });

  test('defaults fetch to LAZY when unspecified', () => {
    writeXml(appDir, 'Simple.orm.xml', `<doctrine-mapping>
      <entity class="App\\Entity\\Simple">
        <many-to-one field="owner" target-entity="App\\Entity\\User"/>
      </entity>
    </doctrine-mapping>`);

    expect(loadDoctrineMetadata(appDir).entities[0].relationships[0].fetch).toBe('LAZY');
  });

  test('reads indexes and unique constraints, splitting the column list', () => {
    writeXml(appDir, 'Product.orm.xml', PRODUCT_XML);
    const e = loadDoctrineMetadata(appDir).entities[0];

    expect(e.indexes).toEqual([{ name: 'idx_name', columns: ['product_name'] }]);
    expect(e.uniqueConstraints).toEqual([{ name: 'uniq_sku', columns: ['sku', 'vendor_id'] }]);
  });

  test('derives a snake_case table name when none is declared', () => {
    writeXml(appDir, 'OrderLine.orm.xml',
      `<doctrine-mapping><entity class="App\\Entity\\OrderLineItem"/></doctrine-mapping>`);

    expect(loadDoctrineMetadata(appDir).entities[0].tableName).toBe('order_line_item');
  });

  test('reads inheritance and the discriminator column', () => {
    writeXml(appDir, 'Vehicle.orm.xml', `<doctrine-mapping>
      <entity class="App\\Entity\\Vehicle" inheritance-type="SINGLE_TABLE">
        <discriminator-column name="kind" type="string"/>
      </entity>
    </doctrine-mapping>`);
    const e = loadDoctrineMetadata(appDir).entities[0];

    expect(e.inheritanceType).toBe('SINGLE_TABLE');
    expect(e.discriminatorColumn).toBe('kind');
  });

  test('marks a read-only entity', () => {
    writeXml(appDir, 'Report.orm.xml',
      `<doctrine-mapping><entity class="App\\Entity\\Report" read-only="true"/></doctrine-mapping>`);

    expect(loadDoctrineMetadata(appDir).entities[0].readOnly).toBe(true);
  });

  test('skips a file with no entity element', () => {
    writeXml(appDir, 'broken.xml', '<doctrine-mapping></doctrine-mapping>');
    expect(loadDoctrineMetadata(appDir).entities).toEqual([]);
  });

  test('skips malformed content instead of throwing', () => {
    writeXml(appDir, 'garbage.xml', 'not xml at all <<<');
    expect(() => loadDoctrineMetadata(appDir)).not.toThrow();
  });

  test('also reads src/Entity/doctrine', () => {
    const dir = path.join(appDir, 'src', 'Entity', 'doctrine');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Alt.orm.xml'),
      `<doctrine-mapping><entity class="App\\Entity\\Alt" table="alts"/></doctrine-mapping>`);

    expect(loadDoctrineMetadata(appDir).entities.map((e) => e.shortName)).toContain('Alt');
  });
});

describe('YAML mappings', () => {
  const USER_YAML = `App\\Entity\\User:
  type: entity
  table: users
  repositoryClass: App\\Repository\\UserRepository
  id:
    id:
      type: integer
      generator:
        strategy: AUTO
  fields:
    email:
      type: string
      length: 180
      unique: true
      column: email_address
    bio:
      type: text
      nullable: true
    balance:
      type: decimal
      precision: 12
      scale: 4
  manyToOne:
    team:
      targetEntity: App\\Entity\\Team
      inversedBy: members
  oneToMany:
    posts:
      targetEntity: App\\Entity\\Post
      mappedBy: author
  indexes:
    - name: idx_email
      columns: [email_address]
  uniqueConstraints:
    - name: uniq_email
      columns: [email_address]
`;

  test('reads class, table and repository', () => {
    writeYaml(appDir, 'User.orm.yml', USER_YAML);
    const [e] = loadDoctrineMetadata(appDir).entities;

    expect(e.name).toBe('App\\Entity\\User');
    expect(e.shortName).toBe('User');
    expect(e.tableName).toBe('users');
    expect(e.repositoryClass).toBe('App\\Repository\\UserRepository');
    expect(e.source).toBe('yaml');
  });

  test('reads the identifier and its generator', () => {
    writeYaml(appDir, 'User.orm.yml', USER_YAML);
    const id = loadDoctrineMetadata(appDir).entities[0].properties.find((p) => p.isId);

    expect(id).toMatchObject({ fieldName: 'id', type: 'integer', isId: true, generatedValue: 'AUTO' });
  });

  test('reads fields with their column overrides and numeric options', () => {
    writeYaml(appDir, 'User.orm.yml', USER_YAML);
    const props = loadDoctrineMetadata(appDir).entities[0].properties;

    expect(props.find((p) => p.fieldName === 'email')).toMatchObject({
      columnName: 'email_address', type: 'string', length: 180, unique: true,
    });
    expect(props.find((p) => p.fieldName === 'bio')).toMatchObject({ nullable: true });
    expect(props.find((p) => p.fieldName === 'balance')).toMatchObject({ precision: 12, scale: 4 });
  });

  test('reads both relationship directions', () => {
    writeYaml(appDir, 'User.orm.yml', USER_YAML);
    const rels = loadDoctrineMetadata(appDir).entities[0].relationships;

    expect(rels.find((r) => r.fieldName === 'team')).toMatchObject({
      type: 'ManyToOne', targetEntity: 'App\\Entity\\Team', inversedBy: 'members',
    });
    expect(rels.find((r) => r.fieldName === 'posts')).toMatchObject({
      type: 'OneToMany', targetEntity: 'App\\Entity\\Post', mappedBy: 'author',
    });
  });

  test('reads indexes and unique constraints', () => {
    writeYaml(appDir, 'User.orm.yml', USER_YAML);
    const e = loadDoctrineMetadata(appDir).entities[0];

    expect(e.indexes[0]).toMatchObject({ name: 'idx_email', columns: ['email_address'] });
    expect(e.uniqueConstraints[0]).toMatchObject({ name: 'uniq_email' });
  });

  test('derives a snake_case table name when none is declared', () => {
    writeYaml(appDir, 'Cart.orm.yml', 'App\\Entity\\ShoppingCart:\n  type: entity\n');
    expect(loadDoctrineMetadata(appDir).entities[0].tableName).toBe('shopping_cart');
  });

  test('accepts the .orm.yaml extension too', () => {
    writeYaml(appDir, 'Tag.orm.yaml', 'App\\Entity\\Tag:\n  table: tags\n');
    expect(loadDoctrineMetadata(appDir).entities.map((e) => e.shortName)).toContain('Tag');
  });

  test('reads mappings placed in src/Entity', () => {
    fs.writeFileSync(path.join(appDir, 'src', 'Entity', 'Note.orm.yml'),
      'App\\Entity\\Note:\n  table: notes\n');
    expect(loadDoctrineMetadata(appDir).entities.map((e) => e.shortName)).toContain('Note');
  });

  test('skips an empty document', () => {
    writeYaml(appDir, 'empty.orm.yml', '');
    expect(loadDoctrineMetadata(appDir).entities).toEqual([]);
  });

  test('skips invalid YAML instead of throwing', () => {
    writeYaml(appDir, 'bad.orm.yml', 'App\\Entity\\X:\n  - [unclosed\n');
    expect(() => loadDoctrineMetadata(appDir)).not.toThrow();
  });
});

describe('loader behaviour', () => {
  test('returns an empty mapping for an app with no Doctrine files', () => {
    expect(loadDoctrineMetadata(appDir))
      .toEqual({ entities: [], embeddables: [], superclasses: [] });
  });

  test('does not throw on a path that does not exist', () => {
    expect(() => loadDoctrineMetadata('/nonexistent/app/path')).not.toThrow();
  });

  test('ignores files that are not mapping files', () => {
    writeXml(appDir, 'notes.txt', 'ignore me');
    writeYaml(appDir, 'services.yaml', 'services: {}');
    expect(loadDoctrineMetadata(appDir).entities).toEqual([]);
  });

  test('collects XML and YAML entities together', () => {
    writeXml(appDir, 'A.orm.xml', `<doctrine-mapping><entity class="App\\Entity\\A"/></doctrine-mapping>`);
    writeYaml(appDir, 'B.orm.yml', 'App\\Entity\\B:\n  table: bs\n');

    expect(loadDoctrineMetadata(appDir).entities.map((e) => e.shortName).sort())
      .toEqual(['A', 'B']);
  });

  test('serves a second call from cache', () => {
    writeXml(appDir, 'A.orm.xml', `<doctrine-mapping><entity class="App\\Entity\\A"/></doctrine-mapping>`);
    const first = loadDoctrineMetadata(appDir);

    // Adding a file after the first read must not appear until the cache clears.
    writeXml(appDir, 'B.orm.xml', `<doctrine-mapping><entity class="App\\Entity\\B"/></doctrine-mapping>`);
    expect(loadDoctrineMetadata(appDir).entities).toHaveLength(first.entities.length);

    cacheManager.clear();
    expect(loadDoctrineMetadata(appDir).entities).toHaveLength(2);
  });
});

describe('getDoctrineMetadataStats', () => {
  test('counts mapping files by format and lists the directories it found', () => {
    writeXml(appDir, 'A.orm.xml', `<doctrine-mapping><entity class="App\\Entity\\A"/></doctrine-mapping>`);
    writeYaml(appDir, 'B.orm.yml', 'App\\Entity\\B:\n  table: bs\n');

    const stats = getDoctrineMetadataStats(appDir);

    expect(stats.entities).toBe(2);
    expect(stats.mappingFiles.xml).toBe(1);
    expect(stats.mappingFiles.yaml).toBe(1);
    expect(stats.mappingDirs).toContain(path.join(appDir, 'config', 'doctrine'));
  });

  test('reports zeroes for an app with no mappings', () => {
    const stats = getDoctrineMetadataStats(appDir);

    expect(stats.entities).toBe(0);
    expect(stats.mappingFiles).toEqual({ xml: 0, yaml: 0 });
  });

  test('lists no directories for a path that does not exist', () => {
    expect(getDoctrineMetadataStats('/nonexistent/app').mappingDirs).toEqual([]);
  });
});
