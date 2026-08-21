/**
 * Doctrine Entities Tool
 * Provides introspection into Doctrine entities and their properties
 */

import { parseEntities, EntityProperty, EntityRelationship } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

/**
 * Lists all Doctrine entities
 * @param appPath - Root path of Symfony application
 * @returns List of entities
 */
export function listEntities(appPath: string): McpToolResult {
  try {
    const entities = parseEntities(appPath);

    if (entities.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No entities found in src/Entity directory',
          },
        ],
      };
    }

    const list = entities
      .map((entity) => `${entity.name} (${entity.properties.length} properties, ${entity.relationships.length} relationships)`)
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Found ${entities.length} entities:\n\n${list}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error listing entities: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Gets detailed information about an entity
 * @param appPath - Root path of Symfony application
 * @param entityName - Name of the entity
 * @returns Entity details
 */
export function getEntityDetails(appPath: string, entityName: string): McpToolResult {
  try {
    const entities = parseEntities(appPath);
    const entity = entities.find((e) => e.name === entityName);

    if (!entity) {
      return {
        content: [
          {
            type: 'text',
            text: `Entity "${entityName}" not found`,
          },
        ],
        isError: true,
      };
    }

    let details = `Entity: ${entity.name}
File: ${entity.file}

Properties (${entity.properties.length}):
`;

    if (entity.properties.length > 0) {
      details += entity.properties.map((prop: EntityProperty) => `  - ${prop.name}: ${prop.type}`).join('\n');
    } else {
      details += '  (none)';
    }

    details += `\n\nRelationships (${entity.relationships.length}):
`;

    if (entity.relationships.length > 0) {
      details += entity.relationships.map((rel: EntityRelationship) => `  - ${rel.name}: ${rel.type}`).join('\n');
    } else {
      details += '  (none)';
    }

    return {
      content: [
        {
          type: 'text',
          text: details,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting entity details: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Searches entities by name
 * @param appPath - Root path of Symfony application
 * @param query - Search query
 * @returns Matching entities
 */
export function searchEntities(appPath: string, query: string): McpToolResult {
  try {
    const entities = parseEntities(appPath);
    const lowerQuery = query.toLowerCase();

    const matches = entities.filter((e) => e.name.toLowerCase().includes(lowerQuery));

    if (matches.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No entities found matching "${query}"`,
          },
        ],
      };
    }

    const list = matches
      .map((entity) => `${entity.name} (${entity.properties.length} properties, ${entity.relationships.length} relationships)`)
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Found ${matches.length} entities matching "${query}":\n\n${list}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error searching entities: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Gets entities that have relationships with a specific entity
 * @param appPath - Root path of Symfony application
 * @param entityName - Name of the entity
 * @returns Related entities
 */
export function getRelatedEntities(appPath: string, entityName: string): McpToolResult {
  try {
    const entities = parseEntities(appPath);
    const entity = entities.find((e) => e.name === entityName);

    if (!entity) {
      return {
        content: [
          {
            type: 'text',
            text: `Entity "${entityName}" not found`,
          },
        ],
        isError: true,
      };
    }

    if (entity.relationships.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `Entity "${entityName}" has no relationships`,
          },
        ],
      };
    }

    const relations = entity.relationships
      .map((rel: EntityRelationship) => `${rel.name}: ${rel.type}`)
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Relationships for ${entityName}:\n\n${relations}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting related entities: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Counts entities and properties
 * @param appPath - Root path of Symfony application
 * @returns Statistics
 */
export function getEntitiesStats(appPath: string): McpToolResult {
  try {
    const entities = parseEntities(appPath);

    const totalProperties = entities.reduce((sum, e) => sum + e.properties.length, 0);
    const totalRelationships = entities.reduce((sum, e) => sum + e.relationships.length, 0);

    const stats = `
Entity Statistics:
==================
Total Entities: ${entities.length}
Total Properties: ${totalProperties}
Total Relationships: ${totalRelationships}
Average Properties per Entity: ${(totalProperties / entities.length).toFixed(1)}
    `.trim();

    return {
      content: [
        {
          type: 'text',
          text: stats,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting entity stats: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Get tool definition for MCP
 */
export function getEntityTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return [
    {
      name: 'list_entities',
      description: 'List all Doctrine entities in the application with property and relationship counts',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_entity_details',
      description: 'Get detailed information about a specific entity including properties and relationships',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
          entity_name: {
            type: 'string',
            description: 'Name of the entity (without namespace)',
          },
        },
        required: ['app_path', 'entity_name'],
      },
    },
    {
      name: 'search_entities',
      description: 'Search for entities by name',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
          query: {
            type: 'string',
            description: 'Search query to find entities by name',
          },
        },
        required: ['app_path', 'query'],
      },
    },
    {
      name: 'get_related_entities',
      description: 'Get all relationships defined on a specific entity',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
          entity_name: {
            type: 'string',
            description: 'Name of the entity to inspect',
          },
        },
        required: ['app_path', 'entity_name'],
      },
    },
    {
      name: 'get_entities_stats',
      description: 'Get statistics about entities, properties, and relationships in the application',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
        },
        required: ['app_path'],
      },
    },
  ];
}
