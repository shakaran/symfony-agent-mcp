// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Routes Inspector Tool
 * Provides introspection into Symfony routing configuration
 */

import { parseRoutes, searchRoutes, SymfonyRoute } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

/**
 * Lists all routes in the Symfony application
 * @param appPath - Root path of Symfony application
 * @returns List of all routes
 */
export function listRoutes(appPath: string): McpToolResult {
  try {
    const routes = parseRoutes(appPath);

    return {
      content: [
        {
          type: 'text',
          text: `Found ${routes.length} routes:\n\n${formatRoutes(routes)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error listing routes: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Gets detailed information about a specific route
 * @param appPath - Root path of Symfony application
 * @param routeName - Name of the route to inspect
 * @returns Route details
 */
export function getRouteDetails(appPath: string, routeName: string): McpToolResult {
  try {
    const routes = parseRoutes(appPath);
    const route = routes.find((r) => r.name === routeName);

    if (!route) {
      return {
        content: [
          {
            type: 'text',
            text: `Route "${routeName}" not found`,
          },
        ],
        isError: true,
      };
    }

    const details = `
Route: ${route.name}
Path: ${route.path}
Methods: ${route.methods.join(', ')}
Controller: ${route.controller}
${route.requirements ? `Requirements: ${JSON.stringify(route.requirements, null, 2)}` : ''}
${route.defaults ? `Defaults: ${JSON.stringify(route.defaults, null, 2)}` : ''}
${route.options ? `Options: ${JSON.stringify(route.options, null, 2)}` : ''}
    `.trim();

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
          text: `Error getting route details: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Searches routes by name, path, or controller
 * @param appPath - Root path of Symfony application
 * @param query - Search query
 * @param type - Type of search (name, path, controller, all)
 * @returns Matching routes
 */
export function searchRoutesCommand(
  appPath: string,
  query: string,
  type: 'name' | 'path' | 'controller' | 'all' = 'all'
): McpToolResult {
  try {
    const routes = parseRoutes(appPath);
    const results = searchRoutes(routes, query, type);

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No routes found matching "${query}" (search type: ${type})`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Found ${results.length} matching routes:\n\n${formatRoutes(results)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error searching routes: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Lists all HTTP methods used in routes
 * @param appPath - Root path of Symfony application
 * @returns Summary of HTTP methods
 */
export function listHttpMethods(appPath: string): McpToolResult {
  try {
    const routes = parseRoutes(appPath);
    const methodStats: Record<string, number> = {};
    const allMethods = new Set<string>();

    for (const route of routes) {
      for (const method of route.methods) {
        methodStats[method] = (methodStats[method] || 0) + 1;
        allMethods.add(method);
      }
    }

    const summary = Object.entries(methodStats)
      .map(([method, count]) => `${method}: ${count} routes`)
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `HTTP Methods Summary:\n${summary}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error listing HTTP methods: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Formats routes for display
 * @param routes - Array of routes to format
 * @returns Formatted string
 */
function formatRoutes(routes: SymfonyRoute[]): string {
  return routes
    .map(
      (route) =>
        `${route.name.padEnd(30)} ${route.methods.join(',').padEnd(10)} ${route.path.padEnd(40)} -> ${route.controller}`
    )
    .join('\n');
}

/**
 * Get tool definition for MCP
 */
export function getRouteTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return [
    {
      name: 'list_routes',
      description: 'List all routes in the Symfony application with their paths, methods, and controllers',
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
      name: 'get_route_details',
      description: 'Get detailed information about a specific route including requirements, defaults, and options',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
          route_name: {
            type: 'string',
            description: 'Name of the route to inspect',
          },
        },
        required: ['app_path', 'route_name'],
      },
    },
    {
      name: 'search_routes',
      description: 'Search routes by name, path, controller, or all fields',
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
            enum: ['name', 'path', 'controller', 'all'],
            description: 'Type of search to perform',
            default: 'all',
          },
        },
        required: ['app_path', 'query'],
      },
    },
    {
      name: 'list_http_methods',
      description: 'Show summary of all HTTP methods used in the application routes',
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
