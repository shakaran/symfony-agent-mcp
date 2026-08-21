/**
 * Example Client for symfony-agent-mcp
 * Shows how to use the MCP server programmatically
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

function print(message: string): void {
  process.stdout.write(message + '\n');
}

function printResult(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

/**
 * Example: Initialize client and call tools
 */
async function exampleUsage(): Promise<void> {
  // Spawn the MCP server as a child process
  const serverProcess = spawn('node', ['dist/index.js'], {
    cwd: __dirname,
  });

  // Create client with stdio transport
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
  });

  const client = new Client(
    { name: 'example-client', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    // Connect to server
    await client.connect(transport);

    const appPath = '/path/to/symfony/app';

    // Example 1: List all routes
    print('\n--- Listing Routes ---');
    const routesResult = await client.callTool({
      name: 'list_routes',
      arguments: { app_path: appPath },
    });
    printResult(routesResult);

    // Example 2: Get route details
    print('\n--- Get Route Details ---');
    const routeDetailsResult = await client.callTool({
      name: 'get_route_details',
      arguments: {
        app_path: appPath,
        route_name: 'app_homepage',
      },
    });
    printResult(routeDetailsResult);

    // Example 3: Search routes
    print('\n--- Search Routes ---');
    const searchRoutesResult = await client.callTool({
      name: 'search_routes',
      arguments: {
        app_path: appPath,
        query: 'user',
        type: 'path',
      },
    });
    printResult(searchRoutesResult);

    // Example 4: List services
    print('\n--- Listing Services ---');
    const servicesResult = await client.callTool({
      name: 'list_services',
      arguments: { app_path: appPath },
    });
    printResult(servicesResult);

    // Example 5: Search services by tag
    print('\n--- Services by Tag ---');
    const tagServicesResult = await client.callTool({
      name: 'list_services_by_tag',
      arguments: {
        app_path: appPath,
        tag: 'controller.service_arguments',
      },
    });
    printResult(tagServicesResult);

    // Example 6: Get app environment
    print('\n--- App Environment ---');
    const envResult = await client.callTool({
      name: 'get_app_environment',
      arguments: { app_path: appPath },
    });
    printResult(envResult);

    // Example 7: List environment variables
    print('\n--- Environment Variables ---');
    const varsResult = await client.callTool({
      name: 'list_environment_variables',
      arguments: { app_path: appPath },
    });
    printResult(varsResult);

    // Example 8: Get database config
    print('\n--- Database Config ---');
    const dbConfigResult = await client.callTool({
      name: 'get_database_config',
      arguments: { app_path: appPath },
    });
    printResult(dbConfigResult);

    // Example 9: List logs
    print('\n--- Log Files ---');
    const logsResult = await client.callTool({
      name: 'list_logs',
      arguments: { app_path: appPath },
    });
    printResult(logsResult);

    // Example 10: Tail log
    print('\n--- Tail Log ---');
    const tailResult = await client.callTool({
      name: 'tail_log',
      arguments: {
        app_path: appPath,
        file_name: 'dev.log',
        lines: 20,
      },
    });
    printResult(tailResult);

    // Example 11: List entities
    print('\n--- Entities ---');
    const entitiesResult = await client.callTool({
      name: 'list_entities',
      arguments: { app_path: appPath },
    });
    printResult(entitiesResult);

    // Example 12: List database tables
    print('\n--- Database Tables ---');
    const tablesResult = await client.callTool({
      name: 'list_tables',
      arguments: { app_path: appPath },
    });
    printResult(tablesResult);

    print('\n✓ All examples completed');
  } finally {
    await client.close();
    serverProcess.kill();
  }
}

// Run examples
exampleUsage().catch((error) => {
  process.stderr.write(`Error running examples: ${error}\n`);
  process.exit(1);
});
