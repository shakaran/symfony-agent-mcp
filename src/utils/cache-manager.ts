// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * LRU Cache Manager with TTL and optional file-mtime invalidation.
 *
 * Used to cache expensive entity parsing and config reads so repeated
 * tool calls don't re-read and re-parse the same files.
 *
 * Configuration:
 *   SYMFONY_MCP_CACHE_TTL_MS   — Per-entry TTL in ms (default: 300 000 = 5 min)
 *   SYMFONY_MCP_CACHE_MAX_SIZE — Max entries per namespace (default: 200)
 *   SYMFONY_MCP_CACHE=false    — Disable caching entirely
 */

import * as fs from 'fs';

const DEFAULT_TTL_MS = parseInt(process.env['SYMFONY_MCP_CACHE_TTL_MS'] ?? '300000', 10) || 300_000;
const MAX_CACHE_SIZE = parseInt(process.env['SYMFONY_MCP_CACHE_MAX_SIZE'] ?? '200', 10) || 200;
const CACHE_ENABLED = process.env['SYMFONY_MCP_CACHE'] !== 'false';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  fileMtimes?: Map<string, number>;
}

class LRUCacheManager {
  private readonly caches = new Map<string, Map<string, CacheEntry<unknown>>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  private getNamespaceCache(namespace: string): Map<string, CacheEntry<unknown>> {
    if (!this.caches.has(namespace)) {
      this.caches.set(namespace, new Map());
    }
    return this.caches.get(namespace)!;
  }

  get<T>(namespace: string, key: string, watchFiles?: string[]): T | null {
    if (!CACHE_ENABLED) return null;

    const cache = this.getNamespaceCache(namespace);
    const entry = cache.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      this.misses++;
      return null;
    }

    // File mtime invalidation: if any watched file changed, invalidate
    if (watchFiles && entry.fileMtimes) {
      for (const file of watchFiles) {
        try {
          const mtime = fs.statSync(file).mtimeMs;
          if (entry.fileMtimes.get(file) !== mtime) {
            cache.delete(key);
            this.misses++;
            return null;
          }
        } catch {
          cache.delete(key);
          this.misses++;
          return null;
        }
      }
    }

    // LRU: move to end on access
    cache.delete(key);
    cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set<T>(namespace: string, key: string, value: T, watchFiles?: string[], ttlMs?: number): void {
    if (!CACHE_ENABLED) return;

    const cache = this.getNamespaceCache(namespace);

    // Evict oldest when at capacity (LRU = first inserted = first removed)
    if (cache.size >= MAX_CACHE_SIZE) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) {
        cache.delete(firstKey);
        this.evictions++;
      }
    }

    const fileMtimes = watchFiles ? new Map<string, number>() : undefined;
    if (watchFiles && fileMtimes) {
      for (const file of watchFiles) {
        try {
          fileMtimes.set(file, fs.statSync(file).mtimeMs);
        } catch {
          // If file is unreadable, skip tracking it
        }
      }
    }

    cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? DEFAULT_TTL_MS),
      fileMtimes,
    });
  }

  invalidate(namespace: string, key?: string): void {
    if (key === undefined) {
      this.caches.delete(namespace);
    } else {
      this.getNamespaceCache(namespace).delete(key);
    }
  }

  clear(): void {
    this.caches.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  getStats(): {
    enabled: boolean;
    hits: number;
    misses: number;
    hitRate: number;
    evictions: number;
    totalEntries: number;
    namespaces: Record<string, number>;
    ttlMs: number;
    maxSize: number;
  } {
    const total = this.hits + this.misses;
    const namespaces: Record<string, number> = {};
    let totalEntries = 0;
    for (const [ns, cache] of this.caches) {
      namespaces[ns] = cache.size;
      totalEntries += cache.size;
    }
    return {
      enabled: CACHE_ENABLED,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 100) : 0,
      evictions: this.evictions,
      totalEntries,
      namespaces,
      ttlMs: DEFAULT_TTL_MS,
      maxSize: MAX_CACHE_SIZE,
    };
  }
}

export const cacheManager = new LRUCacheManager();
