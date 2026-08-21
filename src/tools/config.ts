/**
 * Configuration Tool
 * Provides access to Symfony configuration and environment
 */

import {
  loadEnvironmentVariables,
  getAppConfig,
  parseYamlFile,
} from '../utils/symfony-parser.js';
import { sanitizeEnvironment, sanitizeConfig } from '../utils/security.js';
import { parseDatabaseUrl, getDisplayDatabaseUrl } from '../utils/db-connector.js';
import { McpToolResult } from '../server.js';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Gets application environment and debug configuration
 * @param appPath - Root path of Symfony application
 * @returns Application configuration
 */
export function getAppEnvironment(appPath: string): McpToolResult {
  try {
    const config = getAppConfig(appPath);

    const details = `
Application Environment Configuration:
======================================

Environment: ${config.app_env}
Debug Mode: ${config.app_debug}
Version: ${config.app_version}
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
          text: `Error getting app environment: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Lists environment variables (without sensitive values)
 * @param appPath - Root path of Symfony application
 * @returns Environment variables with sensitive values redacted
 */
export function listEnvironmentVariables(appPath: string): McpToolResult {
  try {
    const env = loadEnvironmentVariables(appPath);
    const sanitized = sanitizeEnvironment(env);

    const vars = Object.entries(sanitized)
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Environment Variables (${Object.keys(sanitized).length} total):\n\n${vars}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error listing environment variables: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Gets database configuration
 * @param appPath - Root path of Symfony application
 * @returns Database connection details
 */
export function getDatabaseConfig(appPath: string): McpToolResult {
  try {
    const dbOptions = parseDatabaseUrl(appPath);
    const displayUrl = getDisplayDatabaseUrl(dbOptions);

    const details = `
Database Configuration:
=======================

Type: ${dbOptions.type}
Host: ${dbOptions.host || 'N/A'}
Port: ${dbOptions.port || 'default'}
Database: ${dbOptions.database || 'N/A'}
Username: ${dbOptions.username || 'N/A'}
Connection URL: ${displayUrl}
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
          text: `Error getting database config: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Gets services configuration
 * @param appPath - Root path of Symfony application
 * @returns Services configuration
 */
export function getServicesConfig(appPath: string): McpToolResult {
  try {
    const servicesPath = path.join(appPath, 'config', 'services.yaml');
    const config = parseYamlFile(servicesPath);

    if (!config) {
      return {
        content: [
          {
            type: 'text',
            text: 'No services.yaml configuration found',
          },
        ],
      };
    }

    const sanitized = sanitizeConfig(config);
    const configStr = JSON.stringify(sanitized, null, 2);

    return {
      content: [
        {
          type: 'text',
          text: `Services Configuration:\n\n${configStr}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting services config: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Gets framework configuration
 * @param appPath - Root path of Symfony application
 * @returns Framework configuration
 */
export function getFrameworkConfig(appPath: string): McpToolResult {
  try {
    const frameworkPath = path.join(appPath, 'config', 'packages', 'framework.yaml');
    const config = parseYamlFile(frameworkPath) as Record<string, unknown> | null;

    if (!config || !config['framework']) {
      return {
        content: [
          {
            type: 'text',
            text: 'No framework configuration found',
          },
        ],
      };
    }

    const sanitized = sanitizeConfig(config['framework']);
    const configStr = JSON.stringify(sanitized, null, 2);

    return {
      content: [
        {
          type: 'text',
          text: `Framework Configuration:\n\n${configStr}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting framework config: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Gets security configuration
 * @param appPath - Root path of Symfony application
 * @returns Security configuration
 */
export function getSecurityConfig(appPath: string): McpToolResult {
  try {
    const securityPath = path.join(appPath, 'config', 'packages', 'security.yaml');
    const config = parseYamlFile(securityPath) as Record<string, unknown> | null;

    if (!config || !config['security']) {
      return {
        content: [
          {
            type: 'text',
            text: 'No security configuration found',
          },
        ],
      };
    }

    const sanitized = sanitizeConfig(config['security']);
    const configStr = JSON.stringify(sanitized, null, 2);

    return {
      content: [
        {
          type: 'text',
          text: `Security Configuration:\n\n${configStr}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting security config: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Lists all configuration packages from the actual config/packages directory
 * @param appPath - Root path of Symfony application
 * @returns List of configuration packages with their sizes
 */
export function listConfigPackages(appPath: string): McpToolResult {
  try {
    const packagesPath = path.join(appPath, 'config', 'packages');

    if (!fs.existsSync(packagesPath)) {
      return {
        content: [{ type: 'text', text: 'config/packages directory not found' }],
      };
    }

    const entries = fs.readdirSync(packagesPath, { withFileTypes: true });
    const packages: string[] = [];

    // Collect flat files
    for (const entry of entries) {
      if (!entry.isDirectory() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        packages.push(entry.name);
      }
    }

    // Collect environment-specific subdirectories (dev/, prod/, test/)
    const envPackages: Record<string, string[]> = {};
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const envDir = path.join(packagesPath, entry.name);
        try {
          const envFiles = fs.readdirSync(envDir)
            .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
          if (envFiles.length > 0) {
            envPackages[entry.name] = envFiles;
          }
        } catch {
          // Skip
        }
      }
    }

    let text = `Configuration Packages (${packages.length} total):\n`;
    text += packages.sort().map((p) => `  - ${p}`).join('\n');

    for (const [env, files] of Object.entries(envPackages)) {
      text += `\n\n${env}/ (${files.length} packages):\n`;
      text += files.sort().map((f) => `  - ${env}/${f}`).join('\n');
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error listing config packages: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

/**
 * Get tool definition for MCP
 */
export function getConfigTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return [
    {
      name: 'get_app_environment',
      description: 'Get application environment, debug mode, and version information',
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
      name: 'list_environment_variables',
      description: 'List all environment variables from .env and .env.local files (sensitive values redacted)',
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
      name: 'get_database_config',
      description: 'Get database configuration including type, host, database name (password redacted)',
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
      name: 'get_services_config',
      description: 'Get DI container services configuration from config/services.yaml',
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
      name: 'get_framework_config',
      description: 'Get Symfony framework configuration from config/packages/framework.yaml',
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
      name: 'get_security_config',
      description: 'Get security configuration including authentication and authorization setup',
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
      name: 'list_config_packages',
      description: 'List all available configuration packages in config/packages directory',
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
