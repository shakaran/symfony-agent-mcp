/**
 * Token estimation utility.
 * Uses a simple byte-length / 4 heuristic (GPT-4 / Claude approximation for English text).
 * Not exact, but good enough for budget guards and audit logging.
 */

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export function estimateToolTokens(tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): number {
  return tools.reduce((sum, t) => sum + estimateTokens(t), 0);
}

