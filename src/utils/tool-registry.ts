/**
 * ToolRegistry — singleton that holds all 819 tool definitions, assigns
 * categories, and provides search + category-query functionality.
 *
 * Initialized once at server startup from the raw allTools array.
 * All subsequent reads (ListTools, search, activate) go through here.
 */

import { ToolCategory, CATEGORY_DESCRIPTIONS, CATEGORY_TAGS, categorizeToolName } from './tool-categories.js';
import { estimateToolTokens } from './token-counter.js';

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface CategorizedTool extends ToolDefinition {
  _category: ToolCategory;
}

export interface CategoryInfo {
  key: ToolCategory;
  description: string;
  tags: string[];
  toolCount: number;
  estimatedTokens: number;
}

// Simple inverted index entry
interface IndexEntry {
  toolName: string;
  score: number;
}

class ToolRegistry {
  private static instance: ToolRegistry;

  private tools: CategorizedTool[] = [];
  private byCategory: Map<ToolCategory, CategorizedTool[]> = new Map();
  private byName: Map<string, CategorizedTool> = new Map();
  private invertedIndex: Map<string, Set<string>> = new Map(); // token → tool names
  private initialized = false;

  static getInstance(): ToolRegistry {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry();
    }
    return ToolRegistry.instance;
  }

  init(rawTools: ToolDefinition[]): void {
    if (this.initialized) return;

    this.tools = rawTools.map(t => ({
      ...t,
      _category: categorizeToolName(t.name),
    }));

    for (const tool of this.tools) {
      this.byName.set(tool.name, tool);

      const list = this.byCategory.get(tool._category) ?? [];
      list.push(tool);
      this.byCategory.set(tool._category, list);

      this.indexTool(tool);
    }

    this.initialized = true;
  }

  private indexTool(tool: CategorizedTool): void {
    const tokens = this.tokenize(
      [tool.name, tool.description ?? '', tool._category].join(' ')
    );

    for (const token of tokens) {
      const entry = this.invertedIndex.get(token) ?? new Set<string>();
      entry.add(tool.name);
      this.invertedIndex.set(token, entry);
    }
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/_/g, ' ')
      .split(/[\s,./-]+/)
      .filter(t => t.length > 2);
  }

  getAllTools(): CategorizedTool[] {
    return this.tools;
  }

  getByCategory(cat: ToolCategory): CategorizedTool[] {
    return this.byCategory.get(cat) ?? [];
  }

  getByName(name: string): CategorizedTool | undefined {
    return this.byName.get(name);
  }

  search(query: string, limit = 10): CategorizedTool[] {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return [];

    const scores = new Map<string, number>();

    for (const token of queryTokens) {
      // Exact token match
      const exact = this.invertedIndex.get(token);
      if (exact) {
        for (const name of exact) {
          scores.set(name, (scores.get(name) ?? 0) + 3);
        }
      }
      // Prefix match (weaker)
      for (const [indexed, names] of this.invertedIndex) {
        if (indexed.startsWith(token) && indexed !== token) {
          for (const name of names) {
            scores.set(name, (scores.get(name) ?? 0) + 1);
          }
        }
      }
    }

    // Boost: tool name itself contains the full query (substring match)
    const queryFlat = query.toLowerCase().replace(/\s+/g, '_');
    for (const tool of this.tools) {
      if (tool.name.includes(queryFlat) || (tool.description ?? '').toLowerCase().includes(query.toLowerCase())) {
        scores.set(tool.name, (scores.get(tool.name) ?? 0) + 5);
      }
    }

    const sorted: IndexEntry[] = [];
    for (const [name, score] of scores) {
      sorted.push({ toolName: name, score });
    }
    sorted.sort((a, b) => b.score - a.score);

    return sorted
      .slice(0, limit)
      .map(e => this.byName.get(e.toolName))
      .filter((t): t is CategorizedTool => t !== undefined);
  }

  getCategoryInfo(): CategoryInfo[] {
    const categories = Array.from(this.byCategory.keys());
    return categories
      .filter(c => c !== 'discovery')
      .map(cat => {
        const tools = this.byCategory.get(cat) ?? [];
        return {
          key: cat,
          description: CATEGORY_DESCRIPTIONS[cat],
          tags: CATEGORY_TAGS[cat],
          toolCount: tools.length,
          estimatedTokens: estimateToolTokens(tools),
        };
      })
      .sort((a, b) => b.toolCount - a.toolCount);
  }

  getTotalTokenEstimate(): number {
    return estimateToolTokens(this.tools);
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

export const toolRegistry = ToolRegistry.getInstance();
