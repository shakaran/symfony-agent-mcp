# Category: cache-sessions

Cache pools, HTTP cache, sessions, rate limiter, lock, cache warmers, OPcache.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### cache-inspector

**Source:** `src/tools/cache-inspector.ts`
**Functions:** (cache pool inspection and MCP internal cache)

Symfony cache pools and MCP internal cache inspection. Reports pool types, adapters, hit/miss
rates, and current pool contents.

---

### cache-pools

**Source:** `src/tools/cache-pools.ts`
**Functions:** `list_cache_pools`, `get_cache_pool_stats`

Reads `framework.cache` from `config/packages/cache.yaml` (or `framework.yaml`). Extracts the
app and system adapters, default Redis/Memcached DSN (masked), prefix\_seed, and all named pools
with their adapter, provider, tag-awareness, and default\_lifetime. Classifies pools as
application, system, or Doctrine. Maps adapter IDs to human-readable labels (Redis/APCu/
Filesystem/etc.). Warns on pools without an explicit TTL (risk of unbounded memory accumulation)
and missing prefix\_seed (collision risk on shared infrastructure).

---

### http-cache

**Source:** `src/tools/http-cache.ts`
**Functions:** `list_http_cache_config`, `get_http_cache_stats`

`#[Cache]` attributes on controller actions (maxAge, sharedMaxAge, public, Vary), Symfony HTTP
Cache proxy config, trusted proxies, ESI detection. Scans `src/` for `#[Cache(...)]` PHP 8
attributes and `Response::setMaxAge()` calls. Reads `config/packages/framework.yaml` for
`http_cache` and `trusted_proxies`. Parses numeric TTL values and displays them in
human-readable format (s/min/h/d).

---

### session-config

**Source:** `src/tools/session-config.ts`
**Functions:** `list_session_config`, `get_session_stats`

Reads `framework.session` from `config/packages/framework.yaml`. Extracts `handler_id`
(Redis/DB/Filesystem/native), cookie settings (`cookie_secure`, `cookie_samesite`,
`cookie_httponly`, `cookie_lifetime`, `cookie_domain`), garbage collection parameters
(`gc_maxlifetime`, `gc_probability`/`gc_divisor`), and session cookie name. Security audit
with severity-rated issues: critical if `cookie_secure: false` or `cookie_httponly: false`;
warning if `samesite: none`, `gc_maxlifetime >= 86400` (24h), or native PHP file handler.

---

### rate-limiter

**Source:** `src/tools/rate-limiter.ts`
**Functions:** `list_rate_limiters`, `list_rate_limiter_pools`, `get_rate_limiter_usage`, `get_rate_limiter_stats`

All limiters from `rate_limiter.yaml` with policy, limit, interval, cache pool, and which
services use each. Scans `src/` for `#[RateLimiter('pool')]` attribute usage on controller
methods and `RateLimiterFactory` constructor injection. Policies explained: sliding_window
(smooth distribution), token_bucket (burst-friendly), fixed_window (boundary reset), no_limit
(tracking only).

---

### lock

**Source:** `src/tools/lock.ts`
**Functions:** `list_lock_config`, `get_lock_stats`

Configured lock stores (Redis/flock/PDO/semaphore) with DSN masked, `LockFactory` usages in
`src/` with resource name and TTL, deadlock-risk warnings for locks without TTL. Reads
`framework.lock` from `config/packages/lock.yaml` or `framework.yaml`. Scans `src/` for
`->createLock('resource', ttl)` calls. Warns when no TTL is specified (deadlock risk on
process crash).

---

### cache-warmers

**Source:** `src/tools/cache-warmers.ts`
**Functions:** `list_cache_warmers`, `get_cache_warmer_stats`

Scans `src/` for classes implementing `CacheWarmerInterface` or `WarmableInterface`. Detects
`isOptional()` return value (required vs optional warmers), priority from `#[AsTaggedItem]`,
and heavy constructor dependencies (EntityManager, HttpClient, etc.) that may slow test boots.

---

### doctrine-slc

**Source:** `src/tools/doctrine-slc.ts`
**Functions:** `list_doctrine_slc`, `get_doctrine_slc_stats`

SLC enabled flag, configured cache regions (name/lifetime/maxEntries), entities with
`#[ORM\Cache]` by usage mode, query-level result caching. Reads
`doctrine.orm.second_level_cache` from `config/packages/doctrine.yaml`. Scans `src/` for
`#[ORM\Cache]` entity-level attributes and `enableResultCache()` / `setCacheable()` /
`setCacheRegion()` in repositories.

---

### symfony-cache-tags

**Source:** `src/tools/symfony-cache-tags.ts`
**Functions:** `list_cache_tag_config`, `get_cache_tag_stats`

Scans `TagAwareCacheInterface` usage: `$item->tag()` call sites (static and dynamic),
`invalidateTags()` call sites, and `Cache-Tags` / `X-Cache-Tags` HTTP headers. Reports broad
tags (`all`, `*`), dynamic tag variables, and tags that are set but never invalidated within
`src/`.

---

### symfony-cache-chain

**Source:** `src/tools/symfony-cache-chain.ts`
**Functions:** `list_cache_chain_config`, `get_cache_chain_stats`

Reads `framework.yaml` cache pools with `ChainAdapter`/`TagAwareAdapter`. Warns on adapters
with mismatched TTL, `TagAwareAdapter` wrapping non-tag-aware adapter, memory adapter not first.

---

### symfony-cache-psr16

**Source:** `src/tools/symfony-cache-psr16.ts`
**Functions:** `list_symfony_cache_psr16`, `get_symfony_cache_psr16_stats`

Detects PSR-16 `SimpleCache` usage vs PSR-6 `CacheItemPool`; warns on PSR-16 used for complex
scenarios (tags, deferred saves), mixing PSR-6 and PSR-16 adapters for the same pool.

---

### symfony-cache-invalidation

**Source:** `src/tools/symfony-cache-invalidation.ts`
**Functions:** `list_symfony_cache_invalidation`, `get_symfony_cache_invalidation_stats`

Detects cache invalidation patterns (`cache.invalidateTags()`, `CacheItemPoolInterface::deleteItem()`);
warns on cache cleared without tag targeting (full flush), invalidation missing on entity update
events.

---

### symfony-cache-stampede

**Source:** `src/tools/symfony-cache-stampede.ts`
**Functions:** `list_cache_stampede`, `get_cache_stampede_stats`

Reads pool `early_expiration_handler` config; warns on high-traffic pools without stampede
protection, very short TTL.

---

### symfony-cache-pool-prune

**Source:** `src/tools/symfony-cache-pool-prune.ts`
**Functions:** `list_cache_pool_prune`, `get_cache_pool_prune_stats`

Detects `PruneableInterface` implementations and scheduled prune commands; warns on
filesystem/PDO pools without scheduled pruning.

---

### symfony-cache-early-expiry

**Source:** `src/tools/symfony-cache-early-expiry.ts`
**Functions:** `list_symfony_cache_early_expiry`, `get_symfony_cache_early_expiry_stats`

Detects `CacheItem::tag()`, `TagAwareCacheInterface`, early expiry callbacks; warns on tagged
cache without `TagAwareCacheInterface`, early expiry without probabilistic sampling, cache items
tagged but pool not tag-aware.

---

### symfony-cache-redis-sentinel

**Source:** `src/tools/symfony-cache-redis-sentinel.ts`
**Functions:** `list_symfony_cache_redis_sentinel`, `get_symfony_cache_redis_sentinel_stats`

Redis Sentinel high-availability configuration: `redis+sentinel://` DSN patterns in `.env` and
`cache.yaml`; flags missing password, no failover timeout, single sentinel (no HA). Passwords
masked in output.

---

### symfony-cache-namespace

**Source:** `src/tools/symfony-cache-namespace.ts`
**Functions:** `list_symfony_cache_namespace`, `get_symfony_cache_namespace_stats`

Cache pool namespace/prefix collision detection: parses `cache.yaml` pools section for adapter,
namespace, and provider; flags Redis-backed pools without namespace, very short namespaces
(collision risk), multiple pools sharing the same DSN without distinct prefixes.

---

### http-response-cache

**Source:** `src/tools/http-response-cache.ts`
**Functions:** `list_response_cache_headers`, `get_response_cache_stats`

Scans controllers for `#[Cache]`, `setPublic`/`setMaxAge`/`setEtag`/`setLastModified`. Warns on
`public` without `Vary:Cookie`, caching authenticated responses, `Vary:*`.

---

### symfony-http-cache-validation

**Source:** `src/tools/symfony-http-cache-validation.ts`
**Functions:** `list_http_cache_validation`, `get_http_cache_validation_stats`

Scans controllers for `Response::setEtag()`, `setLastModified()`, `isNotModified()`,
`setMaxAge()`, `setSharedMaxAge()`; warns on `setEtag()` without `isNotModified()` check,
`setMaxAge()` without `setSharedMaxAge()` for public resources, missing `Cache-Control` on
API endpoints.

---

### symfony-http-cache-store

**Source:** `src/tools/symfony-http-cache-store.ts`
**Functions:** `list_symfony_http_cache_store`, `get_symfony_http_cache_store_stats`

HTTP cache store configuration: `Store` implementations in PHP and config files; flags default
filesystem `Store` in load-balanced environments, temp-directory cache paths in production, and
missing cache-store configuration.

---

### symfony-lock-store-config

**Source:** `src/tools/symfony-lock-store-config.ts`
**Functions:** `list_symfony_lock_store_config`, `get_symfony_lock_store_config_stats`

Symfony Lock component store backend analysis: FlockStore, Redis, PDO, Semaphore, Zookeeper,
InMemory, Combined configurations; flags InMemoryStore in production, FlockStore on multi-server
deployments, missing distributed lock for queued jobs.

---

### symfony-lock-resources

**Source:** `src/tools/symfony-lock-resources.ts`
**Functions:** `list_lock_resources`, `get_lock_resource_stats`

Named lock resources in `framework.yaml lock:`, store type classification (flock/semaphore/
redis/db). `LockFactory` usage, TTL detection, missing `release()` warning.

---

### symfony-semaphore

**Source:** `src/tools/symfony-semaphore.ts`
**Functions:** `list_semaphore_usage`, `get_semaphore_stats`

Reads `framework.yaml` semaphore config. Scans for `SemaphoreInterface`/`acquire()`/`release()`.
Warns on missing `release()` in finally, `maxCount: 1` (use Lock instead).

---

### redis-config-analysis

**Source:** `src/tools/redis-config-analysis.ts`
**Functions:** `list_redis_config`, `get_redis_config_stats`

Scans cache/session/messenger/framework YAML for Redis DSNs. Detects redis/rediss/sentinel/
cluster. Warns on missing TLS, missing authentication.

---

### symfony-rate-limiter-algorithms

**Source:** `src/tools/symfony-rate-limiter-algorithms.ts`
**Functions:** `list_symfony_rate_limiter_algorithms`, `get_symfony_rate_limiter_algorithms_stats`

Rate limiter algorithm comparison: token_bucket, sliding_window, fixed_window, no_limit policies
from `rate_limiter.yaml`; flags `no_limit` in prod, very high limits, `token_bucket` without
burst config.

---

### symfony-rate-limiter-storage

**Source:** `src/tools/symfony-rate-limiter-storage.ts`
**Functions:** `list_rate_limiter_storage`, `get_rate_limiter_storage_stats`

Reads `rate_limiter.yaml`; detects storage backend (cache pool, Redis, in-memory); warns on
in-memory storage for rate limiting (resets on restart, no cross-process limiting), missing
policy, rate limiter without explicit `limit` and `interval`.

---

### dbal-connection-pool

**Source:** `src/tools/dbal-connection-pool.ts`
**Functions:** `list_dbal_connection_pool`, `get_dbal_connection_pool_stats`

Reads DBAL connection options from `doctrine.yaml`: `PDO::ATTR_PERSISTENT` (PHP-FPM leak risk),
`connect_timeout`, `pool_size`.

---

### symfony-twig-cache-config

**Source:** `src/tools/symfony-twig-cache-config.ts`
**Functions:** `list_symfony_twig_cache_config`, `get_symfony_twig_cache_config_stats`

Twig environment cache configuration: `twig.yaml` per environment; flags `cache: false` in
prod, `auto_reload` in prod, missing cache configuration.

---

### symfony-translation-cache

**Source:** `src/tools/symfony-translation-cache.ts`
**Functions:** `list_symfony_translation_cache`, `get_symfony_translation_cache_stats`

Analyzes translation catalogue caching; warns on missing `enabled_locales` (slow startup), deep
fallback chains, `trans()` inside loops, too many locales/domains without restriction.

---

### api-rate-limits

**Source:** `src/tools/api-rate-limits.ts`
**Functions:** `list_api_rate_limits`, `get_api_rate_limit_stats`

Distinct from `rate-limiter.ts` (Symfony component). Focuses on HTTP-layer rate limiting:
nginx `limit_req_zone` / `limit_req` directives in Docker nginx config, Caddy `rate_limit`
directives in `Caddyfile`, `RateLimiterFactory` injection in controllers, custom rate-limit
attributes (`#[RateLimit]`, `#[Throttle]`). Audits controller coverage (warns if most
controllers have no apparent rate limiting).

---

### memcached-integration

**Source:** `src/tools/memcached-integration.ts`
**Functions:** `list_memcached_integration`, `get_memcached_integration_stats`

`MemcachedAdapter`, SASL auth, session handler, key namespace.
