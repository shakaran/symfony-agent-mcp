// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Services Container Tool
 * Provides introspection into Symfony DI container
 */

import { parseServices, searchServices, SymfonyService } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

/**
 * Lists all services in the DI container
 * @param appPath - Root path of Symfony application
 * @returns List of all services
 */
export function listServices(appPath: string): McpToolResult {
  try {
    const services = parseServices(appPath);

    return {
      content: [
        {
          type: 'text',
          text: `Found ${services.length} services:\n\n${formatServices(services)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error listing services: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Gets detailed information about a specific service
 * @param appPath - Root path of Symfony application
 * @param serviceId - ID of the service to inspect
 * @returns Service details
 */
export function getServiceDetails(appPath: string, serviceId: string): McpToolResult {
  try {
    const services = parseServices(appPath);
    const service = services.find((s) => s.id === serviceId);

    if (!service) {
      return {
        content: [
          {
            type: 'text',
            text: `Service "${serviceId}" not found`,
          },
        ],
        isError: true,
      };
    }

    let details = `Service ID: ${service.id}
Class: ${service.class}`;

    if (service.tags.length > 0) {
      details += `\nTags: ${service.tags.join(', ')}`;
    }

    if (service.alias) {
      details += `\nAlias: ${service.alias}`;
    }

    if (service.factory) {
      details += `\nFactory: ${service.factory}`;
    }

    if (service.arguments && service.arguments.length > 0) {
      details += `\nArguments: ${JSON.stringify(service.arguments, null, 2)}`;
    }

    if (service.calls && service.calls.length > 0) {
      details += `\nMethod Calls: ${JSON.stringify(service.calls, null, 2)}`;
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
          text: `Error getting service details: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Searches services by ID, class, or tag
 * @param appPath - Root path of Symfony application
 * @param query - Search query
 * @param type - Type of search (id, class, tag, all)
 * @returns Matching services
 */
export function searchServicesCommand(
  appPath: string,
  query: string,
  type: 'id' | 'class' | 'tag' | 'all' = 'all'
): McpToolResult {
  try {
    const services = parseServices(appPath);
    const results = searchServices(services, query, type);

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No services found matching "${query}" (search type: ${type})`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Found ${results.length} matching services:\n\n${formatServices(results)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error searching services: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Lists services by tag
 * @param appPath - Root path of Symfony application
 * @param tag - Tag to filter by
 * @returns Services with the specified tag
 */
export function listServicesByTag(appPath: string, tag: string): McpToolResult {
  try {
    const services = parseServices(appPath);
    const filtered = services.filter((s) => s.tags.includes(tag));

    if (filtered.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No services found with tag "${tag}"`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Found ${filtered.length} services with tag "${tag}":\n\n${formatServices(filtered)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error listing services by tag: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Lists all available tags in services
 * @param appPath - Root path of Symfony application
 * @returns All tags with counts
 */
export function listAvailableTags(appPath: string): McpToolResult {
  try {
    const services = parseServices(appPath);
    const tagStats: Record<string, number> = {};

    for (const service of services) {
      for (const tag of service.tags) {
        tagStats[tag] = (tagStats[tag] || 0) + 1;
      }
    }

    const summary = Object.entries(tagStats)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => `${tag}: ${count} services`)
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Available Service Tags:\n${summary}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error listing tags: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Formats services for display
 * @param services - Array of services to format
 * @returns Formatted string
 */
function formatServices(services: SymfonyService[]): string {
  return services
    .map((service) => {
      let line = `${service.id.padEnd(40)} -> ${service.class}`;

      if (service.tags.length > 0) {
        line += ` [${service.tags.join(', ')}]`;
      }

      return line;
    })
    .join('\n');
}

/**
 * Get tool definition for MCP
 */
export function getServiceTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return [
    {
      name: 'list_services',
      description: 'List all services in the Symfony DI container with their IDs and classes',
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
      name: 'get_service_details',
      description: 'Get detailed information about a specific service including class, tags, and configuration',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
          service_id: {
            type: 'string',
            description: 'ID of the service to inspect',
          },
        },
        required: ['app_path', 'service_id'],
      },
    },
    {
      name: 'search_services',
      description: 'Search services by ID, class name, tag, or all fields',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
          query: {
            type: 'string',
            description: 'Search query string',
          },
          type: {
            type: 'string',
            enum: ['id', 'class', 'tag', 'all'],
            description: 'Type of search to perform',
            default: 'all',
          },
        },
        required: ['app_path', 'query'],
      },
    },
    {
      name: 'list_services_by_tag',
      description: 'List all services with a specific tag',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
          tag: {
            type: 'string',
            description: 'Tag name to filter services',
          },
        },
        required: ['app_path', 'tag'],
      },
    },
    {
      name: 'list_available_tags',
      description: 'List all available service tags in the application with counts',
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
