// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Controllers Inspector Tool
 * Scans src/Controller/ to list controllers and their actions (routes).
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ControllerAction {
  method: string;
  visibility: string;
  routePath?: string;
  routeName?: string;
  httpMethods: string[];
}

interface ControllerInfo {
  name: string;
  file: string;
  namespace: string;
  parentClass?: string;
  actions: ControllerAction[];
  isAbstract: boolean;
}

export function listControllers(appPath: string): McpToolResult {
  try {
    const controllers = parseControllers(appPath);

    if (controllers.length === 0) {
      return {
        content: [{ type: 'text', text: 'No controllers found in src/Controller/' }],
      };
    }

    const lines = controllers.map((c) => {
      const abstract = c.isAbstract ? ' [abstract]' : '';
      const parent = c.parentClass ? ` extends ${c.parentClass}` : '';
      return `  ${c.name}${parent}${abstract}  (${c.actions.length} actions)`;
    });

    return {
      content: [{
        type: 'text',
        text: `Controllers (${controllers.length} found in src/Controller/):\n\n${lines.join('\n')}`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error listing controllers: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getControllerActions(appPath: string, controllerName: string): McpToolResult {
  try {
    const controllers = parseControllers(appPath);
    const controller = controllers.find(
      (c) => c.name === controllerName || c.name === controllerName + 'Controller'
    );

    if (!controller) {
      const names = controllers.map((c) => c.name).join(', ');
      return {
        content: [{
          type: 'text',
          text: `Controller "${controllerName}" not found.\nAvailable: ${names || 'none'}`,
        }],
        isError: true,
      };
    }

    let text = `Controller: ${controller.name}\nFile: ${controller.file}\nNamespace: ${controller.namespace}\n`;
    if (controller.parentClass) text += `Extends: ${controller.parentClass}\n`;

    if (controller.actions.length === 0) {
      text += '\nNo public action methods found.';
    } else {
      text += `\nActions (${controller.actions.length}):\n`;
      for (const action of controller.actions) {
        text += `\n  ${action.method}()`;
        if (action.routePath) text += `\n    Route: ${action.httpMethods.join('|')} ${action.routePath}`;
        if (action.routeName) text += `\n    Name:  ${action.routeName}`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error getting controller: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function searchControllers(appPath: string, query: string): McpToolResult {
  try {
    const controllers = parseControllers(appPath);
    const lowerQuery = query.toLowerCase();

    const matches = controllers.filter(
      (c) =>
        c.name.toLowerCase().includes(lowerQuery) ||
        c.namespace.toLowerCase().includes(lowerQuery) ||
        c.actions.some(
          (a) =>
            a.method.toLowerCase().includes(lowerQuery) ||
            (a.routePath || '').toLowerCase().includes(lowerQuery)
        )
    );

    if (matches.length === 0) {
      return { content: [{ type: 'text', text: `No controllers found matching "${query}"` }] };
    }

    const lines = matches.map(
      (c) => `  ${c.name}  (${c.actions.length} actions)`
    );

    return {
      content: [{
        type: 'text',
        text: `Found ${matches.length} controllers matching "${query}":\n\n${lines.join('\n')}`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error searching controllers: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

function parseControllers(appPath: string): ControllerInfo[] {
  const controllerDir = path.join(appPath, 'src', 'Controller');
  if (!fs.existsSync(controllerDir)) return [];

  const phpFiles = findPhpFiles(controllerDir);
  const controllers: ControllerInfo[] = [];

  for (const file of phpFiles) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.length > 500_000) continue;
      const info = parseControllerFile(content, path.relative(path.join(appPath, 'src'), file));
      if (info) controllers.push(info);
    } catch {
      // Skip
    }
  }

  return controllers.sort((a, b) => a.name.localeCompare(b.name));
}

function parseControllerFile(content: string, relFile: string): ControllerInfo | null {
  const classMatch = /(?:(abstract)\s+)?class\s+(\w+)(?:\s+extends\s+([\w\\]+))?/.exec(content);
  if (!classMatch) return null;

  const isAbstract = !!classMatch[1];
  const className = classMatch[2];
  const parentClass = classMatch[3] ? classMatch[3].replace(/^.*\\/, '') : undefined;

  // Only consider classes that look like controllers
  if (!className.endsWith('Controller') && !content.includes('AbstractController')) {
    // Still include if parent is AbstractController or similar
    if (!parentClass?.includes('Controller')) return null;
  }

  const namespaceMatch = /^namespace\s+([\w\\]+)\s*;/m.exec(content);
  const namespace = namespaceMatch ? namespaceMatch[1] : '';

  const actions = parseControllerActionMethods(content, className);

  return {
    name: className,
    file: relFile,
    namespace,
    parentClass,
    actions,
    isAbstract,
  };
}

function parseControllerActionMethods(content: string, _className: string): ControllerAction[] {
  const actions: ControllerAction[] = [];

  // Match Route attributes followed by method declarations
  // #[Route('/path', name: 'name', methods: ['GET'])]
  // public function methodName(...)
  const methodRegex =
    /(?:(#\[Route\([^)]*\)\])\s*)?(?:\/\*\*[\s\S]*?\*\/\s*)?(public|protected)\s+function\s+(\w+)\s*\(/g;

  let match;
  while ((match = methodRegex.exec(content)) !== null) {
    const routeAttr = match[1];
    const visibility = match[2];
    const methodName = match[3];

    // Skip magic methods, constructors, and non-action methods
    if (methodName.startsWith('__') || methodName === 'getSubscribedEvents') continue;
    // Skip getter/setter patterns
    if (/^(get|set|is|has|add|remove)[A-Z]/.test(methodName) && !routeAttr) continue;

    const action: ControllerAction = {
      method: methodName,
      visibility,
      httpMethods: ['GET'],
    };

    if (routeAttr) {
      const pathMatch = /Route\(\s*['"](\/[^'"]+)['"]/u.exec(routeAttr);
      if (pathMatch) action.routePath = pathMatch[1];

      const nameMatch = /name\s*:\s*['"]([\w._-]+)['"]/u.exec(routeAttr);
      if (nameMatch) action.routeName = nameMatch[1];

      const methodsMatch = /methods\s*:\s*\[([^\]]+)\]/u.exec(routeAttr);
      if (methodsMatch) {
        action.httpMethods = methodsMatch[1]
          .split(',')
          .map((m) => m.replace(/['"]/g, '').trim())
          .filter(Boolean);
      }
    }

    // Only include public actions that look like route handlers
    if (visibility === 'public' || routeAttr) {
      actions.push(action);
    }
  }

  return actions;
}

function findPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...findPhpFiles(fullPath));
      } else if (entry.name.endsWith('.php')) {
        files.push(fullPath);
      }
    }
  } catch {
    // Skip
  }
  return files;
}

export function getControllerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };

  return [
    {
      name: 'list_controllers',
      description: 'List all controller classes in src/Controller/ with their action count and parent class',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_controller_actions',
      description: 'Get all action methods and routes for a specific controller class',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          controller_name: {
            type: 'string',
            description: 'Controller class name (e.g., "UserController" or "User")',
          },
        },
        required: ['app_path', 'controller_name'],
      },
    },
    {
      name: 'search_controllers',
      description: 'Search controllers by class name, namespace, method name, or route path',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          query: { type: 'string', description: 'Search query' },
        },
        required: ['app_path', 'query'],
      },
    },
  ];
}
