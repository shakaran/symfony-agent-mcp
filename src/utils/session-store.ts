// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * SessionStore — tracks which tool categories are activated per MCP session.
 *
 * In stdio transport there is one client per process, so the 'default'
 * session covers all tool activations. HTTP transport can pass a session ID
 * via the X-Session-Id header or _meta.sessionId.
 *
 * Token budget: activation is blocked when the session would exceed
 * SYMFONY_MCP_TOKEN_BUDGET (default 40 000). Pass force=true to override.
 */

import { ToolCategory } from './tool-categories.js';
import { toolRegistry } from './tool-registry.js';
import { estimateToolTokens } from './token-counter.js';

export const DEFAULT_SESSION = 'default';
export const DEFAULT_TOKEN_BUDGET = 40_000;

export function getTokenBudget(): number {
  const v = parseInt(process.env['SYMFONY_MCP_TOKEN_BUDGET'] ?? '', 10);
  return isNaN(v) ? DEFAULT_TOKEN_BUDGET : v;
}

export interface ActivationResult {
  ok: boolean;
  added: number;
  totalTokens: number;
  budgetWarning?: string;
  message: string;
}

interface SessionState {
  activeCategories: Set<ToolCategory>;
  activatedAt: Map<ToolCategory, number>;
}

class SessionStore {
  private static instance: SessionStore;
  private sessions = new Map<string, SessionState>();

  static getInstance(): SessionStore {
    if (!SessionStore.instance) {
      SessionStore.instance = new SessionStore();
    }
    return SessionStore.instance;
  }

  private getOrCreate(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { activeCategories: new Set(), activatedAt: new Map() };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  activateCategory(sessionId: string, category: ToolCategory, force = false): ActivationResult {
    const state = this.getOrCreate(sessionId);

    if (state.activeCategories.has(category)) {
      const tools = toolRegistry.getByCategory(category);
      return {
        ok: true,
        added: 0,
        totalTokens: this.estimateSessionTokens(sessionId),
        message: `Category '${category}' is already active (${tools.length} tools).`,
      };
    }

    const newTools = toolRegistry.getByCategory(category);
    const currentTokens = this.estimateSessionTokens(sessionId);
    const addedTokens = estimateToolTokens(newTools);
    const projectedTotal = currentTokens + addedTokens;
    const budget = getTokenBudget();

    if (!force && projectedTotal > budget) {
      return {
        ok: false,
        added: 0,
        totalTokens: currentTokens,
        budgetWarning: `Activating '${category}' (${newTools.length} tools, ~${addedTokens} tokens) would bring the session total to ~${projectedTotal} tokens, exceeding the ${budget} token budget. Call activate_category with force=true to override.`,
        message: `Token budget would be exceeded. Use force=true to activate anyway.`,
      };
    }

    state.activeCategories.add(category);
    state.activatedAt.set(category, Date.now());

    return {
      ok: true,
      added: newTools.length,
      totalTokens: projectedTotal,
      budgetWarning: projectedTotal > budget ? `Session tokens (~${projectedTotal}) exceed the configured budget (${budget}).` : undefined,
      message: `Activated '${category}': ${newTools.length} tools added. Session total: ~${projectedTotal} tokens.`,
    };
  }

  deactivateCategory(sessionId: string, category: ToolCategory): { ok: boolean; removed: number; message: string } {
    const state = this.sessions.get(sessionId);
    if (!state || !state.activeCategories.has(category)) {
      return { ok: false, removed: 0, message: `Category '${category}' is not active.` };
    }
    state.activeCategories.delete(category);
    state.activatedAt.delete(category);

    const tools = toolRegistry.getByCategory(category);
    return {
      ok: true,
      removed: tools.length,
      message: `Deactivated '${category}': ${tools.length} tools removed from session.`,
    };
  }

  getActiveCategories(sessionId: string): ToolCategory[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    return Array.from(state.activeCategories);
  }

  getActiveTools(sessionId: string) {
    const state = this.sessions.get(sessionId);
    if (!state || state.activeCategories.size === 0) return [];

    const result = [];
    for (const cat of state.activeCategories) {
      result.push(...toolRegistry.getByCategory(cat));
    }
    return result;
  }

  estimateSessionTokens(sessionId: string): number {
    return estimateToolTokens(this.getActiveTools(sessionId));
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  activateAll(sessionId: string): ActivationResult {
    const state = this.getOrCreate(sessionId);
    const infos = toolRegistry.getCategoryInfo();
    let added = 0;
    for (const info of infos) {
      if (!state.activeCategories.has(info.key)) {
        state.activeCategories.add(info.key);
        state.activatedAt.set(info.key, Date.now());
        added += info.toolCount;
      }
    }
    const totalTokens = this.estimateSessionTokens(sessionId);
    return {
      ok: true,
      added,
      totalTokens,
      message: `All categories activated (${added} new tools). Session total: ~${totalTokens} tokens.`,
    };
  }
}

export const sessionStore = SessionStore.getInstance();
