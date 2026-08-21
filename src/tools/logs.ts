/**
 * Logs Inspector Tool
 * Provides access to Symfony log files
 */

import { listLogFiles, readLogFile } from '../utils/symfony-parser.js';
import { sanitizeLogOutput } from '../utils/security.js';
import { McpToolResult } from '../server.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Lists available log files
 * @param appPath - Root path of Symfony application
 * @param environment - Optional specific environment
 * @returns List of log files
 */
export function listLogs(appPath: string, environment?: string): McpToolResult {
  try {
    const logFiles = listLogFiles(appPath, environment);

    if (logFiles.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No log files found',
          },
        ],
      };
    }

    // Get file sizes and last modified times
    const logPath = path.join(appPath, 'var', 'log');
    const fileInfo = logFiles.map((file) => {
      const filePath = path.join(logPath, file);
      try {
        const stats = fs.statSync(filePath);
        const sizeKB = (stats.size / 1024).toFixed(2);
        const modified = stats.mtime.toISOString();

        return `${file.padEnd(40)} ${sizeKB.padStart(10)}KB  (${modified})`;
      } catch {
        return `${file.padEnd(40)} [error reading stats]`;
      }
    });

    return {
      content: [
        {
          type: 'text',
          text: `Log Files (${logFiles.length} total):\n\n${fileInfo.join('\n')}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error listing logs: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tails a log file (reads last N lines)
 * @param appPath - Root path of Symfony application
 * @param fileName - Name of log file to read
 * @param lines - Number of lines to read
 * @returns Last N lines of the log file
 */
export function tailLog(appPath: string, fileName: string, lines: number = 50): McpToolResult {
  try {
    // Security: validate filename to prevent directory traversal
    if (fileName.includes('..') || fileName.includes('/')) {
      return {
        content: [
          {
            type: 'text',
            text: 'Invalid log file name',
          },
        ],
        isError: true,
      };
    }

    const logContent = readLogFile(appPath, fileName, lines);

    if (logContent.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No content in log file: ${fileName}`,
          },
        ],
      };
    }

    const sanitized = logContent.map((line) => sanitizeLogOutput(line)).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Last ${Math.min(lines, logContent.length)} lines of ${fileName}:\n\n${sanitized}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error tailing log: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Searches log file for specific patterns
 * @param appPath - Root path of Symfony application
 * @param fileName - Name of log file to search
 * @param searchTerm - Term to search for
 * @returns Matching log lines
 */
export function searchLog(appPath: string, fileName: string, searchTerm: string): McpToolResult {
  try {
    if (fileName.includes('..') || fileName.includes('/')) {
      return {
        content: [
          {
            type: 'text',
            text: 'Invalid log file name',
          },
        ],
        isError: true,
      };
    }

    const logContent = readLogFile(appPath, fileName, 1000); // Read more lines for searching
    const lowerSearch = searchTerm.toLowerCase();

    const matching = logContent.filter((line) => line.toLowerCase().includes(lowerSearch));

    if (matching.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No matches found for "${searchTerm}" in ${fileName}`,
          },
        ],
      };
    }

    const sanitized = matching.map((line) => sanitizeLogOutput(line)).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Found ${matching.length} matches for "${searchTerm}" in ${fileName}:\n\n${sanitized}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error searching logs: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Gets error summary from logs
 * @param appPath - Root path of Symfony application
 * @param fileName - Name of log file to analyze
 * @returns Summary of errors and warnings
 */
export function getErrorSummary(appPath: string, fileName: string): McpToolResult {
  try {
    if (fileName.includes('..') || fileName.includes('/')) {
      return {
        content: [
          {
            type: 'text',
            text: 'Invalid log file name',
          },
        ],
        isError: true,
      };
    }

    const logContent = readLogFile(appPath, fileName, 1000);

    const errorCount = logContent.filter((line) =>
      /\[ERROR\]|\[CRITICAL\]|\bERROR\b|\bCRITICAL\b/i.test(line)
    ).length;

    const warningCount = logContent.filter((line) =>
      /\[WARNING\]|\bWARNING\b/i.test(line)
    ).length;

    const noticeCount = logContent.filter((line) =>
      /\[NOTICE\]|\[INFO\]|\bNOTICE\b|\bINFO\b/i.test(line)
    ).length;

    const summary = `
Log Summary for ${fileName}:
===========================
Errors: ${errorCount}
Warnings: ${warningCount}
Notices/Info: ${noticeCount}
Total Lines Analyzed: ${logContent.length}
    `.trim();

    return {
      content: [
        {
          type: 'text',
          text: summary,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error analyzing logs: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Clears a specific log file (returns info only, doesn't actually delete)
 * @param appPath - Root path of Symfony application
 * @returns Info about clearing logs
 */
export function getLogClearInfo(_appPath: string): McpToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `To clear log files, run one of the following commands:

# Clear all logs for current environment:
php bin/console log:clear

# Clear specific environment logs:
php bin/console log:clear --env=dev
php bin/console log:clear --env=prod

# Clear all logs (all environments):
rm -rf var/log/*

Note: This MCP provides read-only access to logs.`,
      },
    ],
  };
}

/**
 * Gets logs by environment
 * @param appPath - Root path of Symfony application
 * @param environment - Environment name (dev, prod, test)
 * @returns Log files for specific environment
 */
export function getEnvironmentLogs(appPath: string, environment: string): McpToolResult {
  try {
    const logFiles = listLogFiles(appPath, environment);

    if (logFiles.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No log files found for environment: ${environment}`,
          },
        ],
      };
    }

    const logPath = path.join(appPath, 'var', 'log');
    const fileInfo = logFiles.map((file) => {
      const filePath = path.join(logPath, file);
      try {
        const stats = fs.statSync(filePath);
        const sizeKB = (stats.size / 1024).toFixed(2);

        return `${file} (${sizeKB}KB)`;
      } catch {
        return file;
      }
    });

    return {
      content: [
        {
          type: 'text',
          text: `Log files for ${environment}:\n${fileInfo.map((f) => `  - ${f}`).join('\n')}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting environment logs: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Get tool definition for MCP
 */
export function getLogTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return [
    {
      name: 'list_logs',
      description: 'List all available log files in var/log directory with file sizes and modification times',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
          environment: {
            type: 'string',
            description: 'Optional: filter logs by environment (dev, prod, test)',
          },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'tail_log',
      description: 'Read the last N lines from a log file',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
          file_name: {
            type: 'string',
            description: 'Name of the log file to read',
          },
          lines: {
            type: 'number',
            description: 'Number of lines to read (default 50)',
            default: 50,
          },
        },
        required: ['app_path', 'file_name'],
      },
    },
    {
      name: 'search_log',
      description: 'Search a log file for lines containing a specific term',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
          file_name: {
            type: 'string',
            description: 'Name of the log file to search',
          },
          search_term: {
            type: 'string',
            description: 'Term to search for in the log file',
          },
        },
        required: ['app_path', 'file_name', 'search_term'],
      },
    },
    {
      name: 'get_error_summary',
      description: 'Get a summary of errors, warnings, and notices in a log file',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
          file_name: {
            type: 'string',
            description: 'Name of the log file to analyze',
          },
        },
        required: ['app_path', 'file_name'],
      },
    },
    {
      name: 'get_environment_logs',
      description: 'Get log files for a specific environment (dev, prod, test)',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: {
            type: 'string',
            description: 'Root path of the Symfony application',
          },
          environment: {
            type: 'string',
            description: 'Environment name (dev, prod, test)',
          },
        },
        required: ['app_path', 'environment'],
      },
    },
  ];
}
