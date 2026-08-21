/**
 * Tool Discovery meta-tools.
 *
 * These 5 tools are ALWAYS included in tools/list, regardless of session state.
 * They allow the LLM to explore and activate the remaining 819 tools on demand
 * instead of receiving all definitions at once.
 *
 * Flow:
 *   1. list_tool_categories()  → understand what groups exist
 *   2. search_tools(query)     → find the 5-10 most relevant tools for a task
 *   3. activate_category(cat)  → activate all tools in a category for this session
 *   4. get_active_tools()      → confirm what is currently exposed
 *   5. deactivate_category()   → free up context budget when done
 */

import { McpToolResult } from '../server.js';
import { toolRegistry } from '../utils/tool-registry.js';
import { sessionStore, DEFAULT_SESSION } from '../utils/session-store.js';
import { ToolCategory } from '../utils/tool-categories.js';
import { estimateToolTokens } from '../utils/token-counter.js';

// ── Tool schema definitions ───────────────────────────────────────────────────

export function getToolDiscoveryTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return [
    {
      name: 'list_tool_categories',
      description:
        'List all available tool categories with descriptions, tool counts, and estimated token cost. ' +
        'Use this first to understand what groups of tools exist before activating them. ' +
        'Only the categories you activate will be shown in subsequent tools/list calls.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'search_tools',
      description:
        'Search for specific tools by describing what you want to do. Returns the top matching tool ' +
        'definitions (name + description + input schema) ready to call immediately — no activation needed ' +
        'for one-off use. For repeated use of a group, call activate_category instead.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language description of what you want to do, e.g. "detect N+1 queries" or "list Symfony routes".',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of tools to return (default 8, max 20).',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'activate_category',
      description:
        'Activate all tools in a category for this session. After activation the MCP client will ' +
        'receive the full tool definitions on the next tools/list refresh. ' +
        'Use list_tool_categories to see available categories and their token costs. ' +
        'Pass force=true to override the token budget guard.',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Category key from list_tool_categories, e.g. "database", "api", "security".',
          },
          force: {
            type: 'boolean',
            description: 'Override token budget warning and activate anyway (default false).',
          },
        },
        required: ['category'],
      },
    },
    {
      name: 'get_active_tools',
      description:
        'Show which tool categories are currently active in this session, how many tools are exposed, ' +
        'and the estimated token cost. Use this to understand your current context budget.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'deactivate_category',
      description:
        'Remove a previously activated category from this session to free up context budget. ' +
        'Useful when switching between different areas of the codebase.',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Category key to deactivate, e.g. "database".',
          },
        },
        required: ['category'],
      },
    },
  ];
}

// ── Tool implementations ──────────────────────────────────────────────────────

export function listToolCategories(): McpToolResult {
  const infos = toolRegistry.getCategoryInfo();
  const totalTools = infos.reduce((s, i) => s + i.toolCount, 0);
  const totalTokens = toolRegistry.getTotalTokenEstimate();

  const rows = infos.map(info =>
    `  ${info.key.padEnd(16)} │ ${String(info.toolCount).padStart(4)} tools │ ~${String(info.estimatedTokens).padStart(6)} tokens │ ${info.description}`
  );

  const lines = [
    `Available tool categories (${infos.length} categories, ${totalTools} tools total, ~${totalTokens} tokens if all active)`,
    '',
    `  ${'Category'.padEnd(16)} │ Tools │ Est. tokens │ Description`,
    `  ${'─'.repeat(16)}─┼─${'─'.repeat(10)}─┼─${'─'.repeat(13)}─┼─${'─'.repeat(55)}`,
    ...rows,
    '',
    'To activate a category: call activate_category(category: "<key>")',
    'To search for specific tools: call search_tools(query: "what you want to do")',
  ];

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

export function searchTools(query: string, limit: number): McpToolResult {
  if (!query || query.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: query is required.' }],
      isError: true,
    };
  }

  const clampedLimit = Math.min(Math.max(1, limit || 8), 20);
  const results = toolRegistry.search(query, clampedLimit);

  if (results.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `No tools found matching "${query}".\n\nTry listing categories with list_tool_categories() to explore what is available.`,
        },
      ],
    };
  }

  const tokenCost = estimateToolTokens(results);

  const blocks = results.map(t => {
    const schema = JSON.stringify(t.inputSchema, null, 2);
    return [
      `### ${t.name}  [${t._category}]`,
      t.description ?? '',
      '',
      'Input schema:',
      '```json',
      schema,
      '```',
    ].join('\n');
  });

  const lines = [
    `Found ${results.length} tools matching "${query}" (~${tokenCost} tokens):`,
    '',
    ...blocks.flatMap(b => [b, '']),
    'These tools are ready to call directly. For repeated use, activate the full category:',
    `  activate_category(category: "${results[0]._category}")`,
  ];

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

export function activateCategory(sessionId: string, category: string, force: boolean): McpToolResult {
  if (!category) {
    return {
      content: [{ type: 'text', text: 'Error: category is required. Call list_tool_categories() to see available categories.' }],
      isError: true,
    };
  }

  // Special alias: 'all' activates every category
  if (category === 'all') {
    const result = sessionStore.activateAll(sessionId);
    return {
      content: [
        {
          type: 'text',
          text: [
            result.message,
            '',
            'All 819 tools are now active. The MCP client will reflect this on the next tools/list refresh.',
            `Total estimated tokens: ~${result.totalTokens}`,
          ].join('\n'),
        },
      ],
    };
  }

  const infos = toolRegistry.getCategoryInfo();
  const validKeys = infos.map(i => i.key);
  if (!validKeys.includes(category as ToolCategory)) {
    return {
      content: [
        {
          type: 'text',
          text: [
            `Unknown category: "${category}"`,
            '',
            'Valid categories:',
            ...validKeys.map(k => `  ${k}`),
          ].join('\n'),
        },
      ],
      isError: true,
    };
  }

  const result = sessionStore.activateCategory(sessionId, category as ToolCategory, force);

  if (!result.ok) {
    return {
      content: [{ type: 'text', text: result.budgetWarning ?? result.message }],
      isError: true,
    };
  }

  const warning = result.budgetWarning ? `\n\nWarning: ${result.budgetWarning}` : '';
  return {
    content: [
      {
        type: 'text',
        text: [
          result.message,
          '',
          'The MCP client will reflect the new tools on the next tools/list refresh.',
          'If using Claude Desktop, the tools appear automatically after activation.',
          warning,
        ].join('\n'),
      },
    ],
  };
}

export function getActiveTools(sessionId: string): McpToolResult {
  const categories = sessionStore.getActiveCategories(sessionId);
  const activeTools = sessionStore.getActiveTools(sessionId);
  const tokenEstimate = estimateToolTokens(activeTools);
  const totalAll = toolRegistry.getTotalTokenEstimate();

  if (categories.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: [
            'No tool categories are currently active.',
            '',
            `All 819 tools are available but not yet exposed (~${totalAll} total tokens).`,
            '',
            'To activate tools:',
            '  list_tool_categories()    — see all categories',
            '  search_tools("<query>")   — find tools for a specific task',
            '  activate_category("<key>")— activate a full category',
          ].join('\n'),
        },
      ],
    };
  }

  const breakdown = categories.map(cat => {
    const tools = toolRegistry.getByCategory(cat);
    return `  ${cat.padEnd(16)} │ ${tools.length} tools`;
  });

  const toolNames = activeTools.slice(0, 30).map(t => `  ${t.name}`);
  const overflow = activeTools.length > 30 ? [`  ... and ${activeTools.length - 30} more`] : [];

  return {
    content: [
      {
        type: 'text',
        text: [
          `Active tool categories (${categories.length} categories, ${activeTools.length} tools, ~${tokenEstimate} tokens):`,
          '',
          `  ${'Category'.padEnd(16)} │ Tools`,
          `  ${'─'.repeat(16)}─┼─${'─'.repeat(10)}`,
          ...breakdown,
          '',
          `Active tool names (${activeTools.length} total):`,
          ...toolNames,
          ...overflow,
          '',
          `Token estimate: ~${tokenEstimate} tokens active / ~${totalAll} tokens total`,
          'Use deactivate_category("<key>") to free up context budget.',
        ].join('\n'),
      },
    ],
  };
}

export function deactivateCategory(sessionId: string, category: string): McpToolResult {
  if (!category) {
    return {
      content: [{ type: 'text', text: 'Error: category is required.' }],
      isError: true,
    };
  }

  const result = sessionStore.deactivateCategory(sessionId, category as ToolCategory);

  return {
    content: [
      {
        type: 'text',
        text: result.message,
      },
    ],
    isError: !result.ok,
  };
}

// ── Convenience: resolve session ID from MCP request metadata ─────────────────

export function resolveSessionId(meta?: Record<string, unknown>): string {
  if (meta && typeof meta['sessionId'] === 'string' && meta['sessionId']) {
    return meta['sessionId'];
  }
  return DEFAULT_SESSION;
}
