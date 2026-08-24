// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine Metadata Loader
 *
 * Parses Doctrine entity mapping files from:
 *   - XML mappings: config/doctrine/*.xml
 *   - YAML mappings: config/doctrine/*.orm.yml, src/Entity/*.orm.yaml
 *   - PHP attribute mappings: src/Entity/*.php (delegated to symfony-parser)
 *
 * This supplements the regex-based entity parser with structured metadata
 * from explicit Doctrine mapping files when they exist.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from './symfony-parser.js';
import { cacheManager } from './cache-manager.js';

export interface DoctrineMappedEntity {
  name: string;
  shortName: string;
  tableName: string;
  repositoryClass?: string;
  readOnly: boolean;
  properties: DoctrineMappedProperty[];
  relationships: DoctrineMappedRelation[];
  indexes: DoctrineMappedIndex[];
  uniqueConstraints: DoctrineMappedIndex[];
  inheritanceType?: string;
  discriminatorColumn?: string;
  source: 'xml' | 'yaml' | 'attributes';
}

export interface DoctrineMappedProperty {
  fieldName: string;
  columnName: string;
  type: string;
  nullable: boolean;
  unique: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  isId: boolean;
  generatedValue?: string;
  enumType?: string;
}

export interface DoctrineMappedRelation {
  fieldName: string;
  type: 'ManyToOne' | 'OneToMany' | 'OneToOne' | 'ManyToMany';
  targetEntity: string;
  mappedBy?: string;
  inversedBy?: string;
  joinColumn?: { name: string; referencedColumnName: string };
  joinTable?: { name: string };
  orphanRemoval: boolean;
  cascade: string[];
  fetch: string;
}

export interface DoctrineMappedIndex {
  name?: string;
  columns: string[];
}

export interface DoctrineMapping {
  entities: DoctrineMappedEntity[];
  embeddables: string[];
  superclasses: string[];
}

const CACHE_NS = 'doctrine-metadata';

/**
 * Loads Doctrine metadata from all available mapping formats for a Symfony app.
 */
export function loadDoctrineMetadata(appPath: string): DoctrineMapping {
  const cacheKey = appPath;
  const cached = cacheManager.get<DoctrineMapping>(CACHE_NS, cacheKey);
  if (cached) return cached;

  const mapping: DoctrineMapping = { entities: [], embeddables: [], superclasses: [] };

  const xmlDirs = [
    path.join(appPath, 'config', 'doctrine'),
    path.join(appPath, 'src', 'Entity', 'doctrine'),
  ];

  for (const dir of xmlDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.xml'));
      for (const file of files) {
        const entity = parseXmlMappingFile(path.join(dir, file));
        if (entity) mapping.entities.push(entity);
      }
    } catch {
      // Skip unreadable directory
    }
  }

  const yamlDirs = [
    path.join(appPath, 'config', 'doctrine'),
    path.join(appPath, 'src', 'Entity'),
  ];

  for (const dir of yamlDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(
        (f) => f.endsWith('.orm.yml') || f.endsWith('.orm.yaml')
      );
      for (const file of files) {
        const entity = parseYamlMappingFile(path.join(dir, file));
        if (entity) mapping.entities.push(entity);
      }
    } catch {
      // Skip unreadable directory
    }
  }

  cacheManager.set(CACHE_NS, cacheKey, mapping);
  return mapping;
}

function parseXmlAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /(\w[\w-]*)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function classToSnake(name: string): string {
  return name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

function parseXmlMappingFile(filePath: string): DoctrineMappedEntity | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Read the <entity> opening tag as a whole and pull its attributes out
    // with the shared parser. A bare /entity[^>]+class="([^"]+)"/ backtracks
    // to the *last* class= in the tag, which is the one inside
    // repository-class= — so every mapping that declares a repository used to
    // report the repository as the entity's own class name.
    const entityTagMatch = /<entity\s([^>]*)>/.exec(content);
    if (!entityTagMatch) return null;

    const entityAttrs = parseXmlAttributes(entityTagMatch[1]);
    const fullClass = entityAttrs['class'] ?? entityAttrs['name'];
    if (!fullClass) return null;

    const shortName = fullClass.split('\\').pop() ?? fullClass;
    const tableName = entityAttrs['table'];
    const repositoryClass = entityAttrs['repository-class'];
    const inheritanceType = entityAttrs['inheritance-type'];
    const discColMatch = /discriminator-column[^>]+name="([^"]+)"/.exec(content);

    const properties: DoctrineMappedProperty[] = [];

    // Parse <id ...> fields
    for (const m of content.matchAll(/<id\s([^>]*?)(?:\/>|>([\s\S]*?)<\/id>)/g)) {
      const attrs = parseXmlAttributes(m[1]);
      const idBody = m[2] ?? '';
      properties.push({
        fieldName: attrs['name'] ?? '',
        columnName: attrs['column'] ?? attrs['name'] ?? '',
        type: attrs['type'] ?? 'integer',
        nullable: false,
        unique: true,
        isId: true,
        generatedValue: /<generator\b/.test(idBody) ? 'AUTO' : undefined,
      });
    }

    // Parse <field ...> fields
    for (const m of content.matchAll(/<field\s([^>]+?)(?:\/>|>)/gs)) {
      const attrs = parseXmlAttributes(m[1]);
      properties.push({
        fieldName: attrs['name'] ?? '',
        columnName: attrs['column'] ?? attrs['name'] ?? '',
        type: attrs['type'] ?? 'string',
        nullable: attrs['nullable'] === 'true',
        unique: attrs['unique'] === 'true',
        length: attrs['length'] ? parseInt(attrs['length'], 10) : undefined,
        precision: attrs['precision'] ? parseInt(attrs['precision'], 10) : undefined,
        scale: attrs['scale'] ? parseInt(attrs['scale'], 10) : undefined,
        isId: false,
        enumType: attrs['enumType'],
      });
    }

    const relationships: DoctrineMappedRelation[] = [];
    const relTypes: Array<{ xml: string; ts: DoctrineMappedRelation['type'] }> = [
      { xml: 'many-to-one', ts: 'ManyToOne' },
      { xml: 'one-to-many', ts: 'OneToMany' },
      { xml: 'one-to-one', ts: 'OneToOne' },
      { xml: 'many-to-many', ts: 'ManyToMany' },
    ];

    for (const { xml, ts } of relTypes) {
      const pattern = new RegExp(`<${xml}\\s([^>]+?)>`, 'gs');
      for (const m of content.matchAll(pattern)) {
        const attrs = parseXmlAttributes(m[1]);
        // Extract join-column info
        const joinColMatch = new RegExp(`<join-column[^>]+name="([^"]+)"[^>]+referenced-column-name="([^"]+)"`).exec(content);
        relationships.push({
          fieldName: attrs['field'] ?? attrs['name'] ?? '',
          type: ts,
          targetEntity: attrs['target-entity'] ?? '',
          mappedBy: attrs['mapped-by'],
          inversedBy: attrs['inversed-by'],
          orphanRemoval: attrs['orphan-removal'] === 'true',
          cascade: [],
          fetch: attrs['fetch'] ?? 'LAZY',
          joinColumn: joinColMatch
            ? { name: joinColMatch[1], referencedColumnName: joinColMatch[2] }
            : undefined,
        });
      }
    }

    const indexes: DoctrineMappedIndex[] = [];
    for (const m of content.matchAll(/<index\s([^>]+?)(?:\/>|>)/gs)) {
      const attrs = parseXmlAttributes(m[1]);
      indexes.push({
        name: attrs['name'],
        columns: (attrs['columns'] ?? '').split(',').map((c) => c.trim()).filter(Boolean),
      });
    }

    const uniqueConstraints: DoctrineMappedIndex[] = [];
    for (const m of content.matchAll(/<unique-constraint\s([^>]+?)(?:\/>|>)/gs)) {
      const attrs = parseXmlAttributes(m[1]);
      uniqueConstraints.push({
        name: attrs['name'],
        columns: (attrs['columns'] ?? '').split(',').map((c) => c.trim()).filter(Boolean),
      });
    }

    return {
      name: fullClass,
      shortName,
      tableName: tableName ?? classToSnake(shortName),
      repositoryClass,
      readOnly: content.includes('read-only="true"'),
      properties,
      relationships,
      indexes,
      uniqueConstraints,
      inheritanceType,
      discriminatorColumn: discColMatch ? discColMatch[1] : undefined,
      source: 'xml',
    };
  } catch {
    return null;
  }
}

function parseYamlMappingFile(filePath: string): DoctrineMappedEntity | null {
  try {
    const config = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!config) return null;

    const entityClass = Object.keys(config)[0];
    if (!entityClass) return null;

    const entityConfig = config[entityClass] as Record<string, unknown>;
    const shortName = entityClass.split('\\').pop() ?? entityClass;

    const properties: DoctrineMappedProperty[] = [];
    const relationships: DoctrineMappedRelation[] = [];
    const indexes: DoctrineMappedIndex[] = [];
    const uniqueConstraints: DoctrineMappedIndex[] = [];

    // id fields
    const idConfig = entityConfig['id'] as Record<string, unknown> | undefined;
    if (idConfig) {
      for (const [fieldName, fieldDef] of Object.entries(idConfig)) {
        const def = (fieldDef ?? {}) as Record<string, unknown>;
        properties.push({
          fieldName,
          columnName: (def['column'] as string) ?? fieldName,
          type: (def['type'] as string) ?? 'integer',
          nullable: false,
          unique: true,
          isId: true,
          generatedValue: def['generator'] ? 'AUTO' : undefined,
        });
      }
    }

    // regular fields
    const fieldsConfig = entityConfig['fields'] as Record<string, unknown> | undefined;
    if (fieldsConfig) {
      for (const [fieldName, fieldDef] of Object.entries(fieldsConfig)) {
        const def = (fieldDef ?? {}) as Record<string, unknown>;
        properties.push({
          fieldName,
          columnName: (def['column'] as string) ?? fieldName,
          type: (def['type'] as string) ?? 'string',
          nullable: Boolean(def['nullable']),
          unique: Boolean(def['unique']),
          length: def['length'] ? Number(def['length']) : undefined,
          precision: def['precision'] ? Number(def['precision']) : undefined,
          scale: def['scale'] ? Number(def['scale']) : undefined,
          isId: false,
          enumType: def['enumType'] as string | undefined,
        });
      }
    }

    // relationships
    const relMappings: Array<{ key: string; type: DoctrineMappedRelation['type'] }> = [
      { key: 'manyToOne', type: 'ManyToOne' },
      { key: 'oneToMany', type: 'OneToMany' },
      { key: 'oneToOne', type: 'OneToOne' },
      { key: 'manyToMany', type: 'ManyToMany' },
    ];

    for (const { key, type } of relMappings) {
      const relConfig = entityConfig[key] as Record<string, unknown> | undefined;
      if (!relConfig) continue;
      for (const [fieldName, relDef] of Object.entries(relConfig)) {
        const def = (relDef ?? {}) as Record<string, unknown>;
        const jc = def['joinColumn'] as Record<string, string> | undefined;
        const jt = def['joinTable'] as Record<string, string> | undefined;
        relationships.push({
          fieldName,
          type,
          targetEntity: (def['targetEntity'] as string) ?? '',
          mappedBy: def['mappedBy'] as string | undefined,
          inversedBy: def['inversedBy'] as string | undefined,
          orphanRemoval: Boolean(def['orphanRemoval']),
          cascade: (def['cascade'] as string[]) ?? [],
          fetch: (def['fetch'] as string) ?? 'LAZY',
          joinColumn: jc ? { name: jc['name'] ?? '', referencedColumnName: jc['referencedColumnName'] ?? 'id' } : undefined,
          joinTable: jt ? { name: jt['name'] ?? '' } : undefined,
        });
      }
    }

    // indexes
    const indexesConfig = entityConfig['indexes'] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(indexesConfig)) {
      for (const idx of indexesConfig) {
        indexes.push({
          name: idx['name'] as string | undefined,
          columns: (idx['columns'] as string[]) ?? [],
        });
      }
    }

    const ucConfig = entityConfig['uniqueConstraints'] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(ucConfig)) {
      for (const uc of ucConfig) {
        uniqueConstraints.push({
          name: uc['name'] as string | undefined,
          columns: (uc['columns'] as string[]) ?? [],
        });
      }
    }

    return {
      name: entityClass,
      shortName,
      tableName: (entityConfig['table'] as string) ?? classToSnake(shortName),
      repositoryClass: entityConfig['repositoryClass'] as string | undefined,
      readOnly: Boolean(entityConfig['readOnly']),
      properties,
      relationships,
      indexes,
      uniqueConstraints,
      inheritanceType: entityConfig['inheritanceType'] as string | undefined,
      discriminatorColumn: entityConfig['discriminatorColumn'] as string | undefined,
      source: 'yaml',
    };
  } catch {
    /* istanbul ignore next -- parseYamlFile already returns null on malformed
       input, and every lookup above is a safe property read, so nothing here
       throws in practice. */
    return null;
  }
}

/**
 * Returns statistics about available Doctrine mapping files.
 */
export function getDoctrineMetadataStats(appPath: string): {
  entities: number;
  mappingFiles: { xml: number; yaml: number };
  mappingDirs: string[];
} {
  const mapping = loadDoctrineMetadata(appPath);

  const searchDirs = [
    path.join(appPath, 'config', 'doctrine'),
    path.join(appPath, 'src', 'Entity', 'doctrine'),
    path.join(appPath, 'src', 'Entity'),
  ];

  let xmlCount = 0;
  let yamlCount = 0;
  const existingDirs: string[] = [];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    existingDirs.push(dir);
    try {
      const files = fs.readdirSync(dir);
      xmlCount += files.filter((f) => f.endsWith('.xml')).length;
      yamlCount += files.filter((f) => f.endsWith('.orm.yml') || f.endsWith('.orm.yaml')).length;
    } catch {
      // Skip
    }
  }

  return {
    entities: mapping.entities.length,
    mappingFiles: { xml: xmlCount, yaml: yamlCount },
    mappingDirs: existingDirs,
  };
}
