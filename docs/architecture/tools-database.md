# Category: database

Database tools — entities, migrations, Doctrine ORM, relationships, query patterns, indexes, DBAL.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### repository-analyzer

**Source:** `src/tools/repository-analyzer.ts`
**Functions:** `list_repositories`, `search_repositories`, `get_repository_stats`

All Doctrine repositories extending `ServiceEntityRepository`: entity class, custom method
signatures (return type hint, DQL/QB patterns), injected services. Detects N+1-prone patterns
(query inside loop, lazy association in `foreach`). Cross-checks whether each entity has a
corresponding repository and whether repositories are registered as services.

---

### doctrine-embeddable

**Source:** `src/tools/doctrine-embeddable.ts`
**Functions:** `list_embeddables`, `get_embeddable_stats`

Classes with `#[Embeddable]`, entities with `#[Embedded(class:)]`. Reports column prefix and
nullable flag. Detects embeddables with no containing entity (orphaned), and entities
embedding the same class twice without distinct prefix (column collision).

---

### migrations-analysis

**Source:** `src/tools/migrations-analysis.ts`
**Functions:** `list_migrations`, `get_migration_stats`

All Doctrine migration files in `migrations/` with version (timestamp), whether the `down()`
method is a no-op, detection of non-reversible operations (DROP TABLE/COLUMN, TRUNCATE),
estimated number of SQL statements. Warns on migrations with only `up()` (no rollback possible)
and migrations modifying more than 3 tables (complex change, consider splitting).

---

### doctrine-lifecycle

**Source:** `src/tools/doctrine-lifecycle.ts`
**Functions:** `list_lifecycle_callbacks`, `get_doctrine_lifecycle_stats`

Entity `#[PostLoad]`, `#[PrePersist]`, `#[PostPersist]`, `#[PreUpdate]`, `#[PostUpdate]`,
`#[PreRemove]`, `#[PostRemove]` callbacks, plus all `#[HasLifecycleCallbacks]` markers.
Detects lifecycle listeners (`#[AsDoctrineListener]`, `getSubscribedEvents`). Warns on heavy
operations in lifecycle callbacks (`flush()` inside `PreUpdate` — triggers infinite loop),
EntityManager injection in listener.

---

### doctrine-event-manager

**Source:** `src/tools/doctrine-event-manager.ts`
**Functions:** `list_doctrine_event_listeners`, `get_doctrine_event_stats`

Detects `EventSubscriberInterface` and `EventListener` with `getSubscribedEvents()` returning
Doctrine events; warns on `postLoad` loading related entities (N+1), listener calling `flush()`
inside `preUpdate`.

---

### doctrine-event-subscribers

**Source:** `src/tools/doctrine-event-subscribers.ts`
**Functions:** `list_doctrine_event_subscribers`, `get_doctrine_event_subscriber_stats`

Reads `EventSubscriberInterface` classes with Doctrine events; warns on subscriber not
tagged `doctrine.event_subscriber`, subscriber loading relations in `postLoad`.

---

### doctrine-orm-config

**Source:** `src/tools/doctrine-orm-config.ts`
**Functions:** `list_doctrine_orm_config`, `get_doctrine_orm_config_stats`

Reads `doctrine.yaml` ORM section: `auto_generate_proxy_classes`, `proxy_dir`, naming strategy,
type overrides, `resolve_target_entities`, second-level cache global config. Warns on
`auto_generate_proxy_classes: true` in production, missing `cache_driver`, default naming
strategy colliding with custom types.

---

### doctrine-dbal-config

**Source:** `src/tools/doctrine-dbal-config.ts`
**Functions:** `list_doctrine_dbal_config`, `get_doctrine_dbal_config_stats`

Reads `doctrine.yaml` DBAL connection(s): driver (mysql/pgsql/sqlite), charset, server_version,
`DATABASE_URL` presence (masked), multiple connections. Warns on missing `server_version`
(disables features/optimizations), mismatched `server_version` with actual DB, no charset set.

---

### doctrine-types

**Source:** `src/tools/doctrine-types.ts`
**Functions:** `list_doctrine_custom_types`, `get_doctrine_type_stats`

Classes extending `Type` registered in `doctrine.yaml dbal.types:`. Detects missing
`getName()`, `requiresSQLCommentHint()` for non-standard types, types registered under
wrong alias. Also reports built-in type overrides.

---

### doctrine-dql-functions

**Source:** `src/tools/doctrine-dql-functions.ts`
**Functions:** `list_dql_functions`, `get_dql_function_stats`

Custom DQL functions registered under `orm.dql.numeric_functions`, `string_functions`, and
`datetime_functions` in `doctrine.yaml`. Detects `FunctionNode` subclasses. Warns on
function names shadowing SQL reserved words.

---

### doctrine-filters

**Source:** `src/tools/doctrine-filters.ts`
**Functions:** `list_doctrine_filters`, `get_doctrine_filter_stats`

Reads `doctrine.yaml` ORM `filters:` section: filter class, enabled flag, parameters. Detects
`SQLFilter` subclasses. Warns on filter enabled globally without parameter set (may fail on
missing parameter), filter not checking `hasParameter()`.

---

### doctrine-inheritance

**Source:** `src/tools/doctrine-inheritance.ts`
**Functions:** `list_doctrine_inheritance`, `get_doctrine_inheritance_stats`

Entities with `#[InheritanceType]` (`SINGLE_TABLE`/`JOINED`/`TABLE_PER_CLASS`) and
`#[DiscriminatorMap]`. Reports discriminator values and child classes. Warns on single-table
inheritance with large discriminator maps (> 10 types — performance), joined inheritance
without index on discriminator column.

---

### doctrine-discriminator

**Source:** `src/tools/doctrine-discriminator.ts`
**Functions:** `list_doctrine_discriminator`, `get_doctrine_discriminator_stats`

Reads `#[DiscriminatorMap]` and `#[DiscriminatorColumn]`; warns on subclass not in map,
duplicate discriminator values, discriminator column not indexed.

---

### doctrine-indexes

**Source:** `src/tools/doctrine-indexes.ts`
**Functions:** `list_entity_indexes`, `get_index_stats`

All `#[Index]`, `#[UniqueConstraint]` on entities plus field-level `unique: true`. Reports
index name, columns, unique flag. Cross-checks: foreign key columns without index, `OrderBy`
in repository methods on columns without index, `unique: true` field without corresponding
`#[UniqueEntity]` constraint.

---

### doctrine-migrations-history

**Source:** `src/tools/doctrine-migrations-history.ts`
**Functions:** `list_migration_history`, `get_migration_history_stats`

Reads `migrations/` directory: lists all migration version files, detects gaps in timestamp
sequence (skipped migration), checks `doctrine_migration_versions` table sync (no DB connection;
infers from version file count vs any tracked count in config). Warns on migration files with
identical timestamps.

---

### doctrine-migration-rollback

**Source:** `src/tools/doctrine-migration-rollback.ts`
**Functions:** `list_doctrine_migration_rollback`, `get_doctrine_migration_rollback_stats`

Reads migration files for `down()` method; detects no-op `down()` (empty body or just
comment), non-reversible SQL in `up()` without `throwIrreversibleMigrationException()` call,
`down()` not inverting `up()` for column additions.

---

### doctrine-migration-graph

**Source:** `src/tools/doctrine-migration-graph.ts`
**Functions:** `list_migration_graph`, `get_migration_graph_stats`

Analyzes migration dependency chain: detects out-of-order timestamps (future-date migrations
already applied), orphaned migration files (not in any bundle's configured namespace).

---

### doctrine-metadata-cache

**Source:** `src/tools/doctrine-metadata-cache.ts`
**Functions:** `list_doctrine_metadata_cache`, `get_doctrine_metadata_cache_stats`

Reads `doctrine.yaml` ORM `metadata_cache_driver`, `query_cache_driver`, `result_cache_driver`;
warns on `array` driver (dev-only, resets on every request), missing cache in production,
metadata cache without warmer.

---

### doctrine-query-cache

**Source:** `src/tools/doctrine-query-cache.ts`
**Functions:** `list_query_cache`, `get_query_cache_stats`

Reads ORM `query_cache_driver`; scans for `enableResultCache()`/`setCacheable()` usage; warns
on result cache without TTL, query cache pointing to volatile adapter.

---

### doctrine-custom-hydrators

**Source:** `src/tools/doctrine-custom-hydrators.ts`
**Functions:** `list_custom_hydrators`, `get_custom_hydrator_stats`

Classes extending `AbstractHydrator`; reads registered hydrators in `doctrine.yaml`; warns
on hydrator not registered, hydrator calling `$this->em` (EM not available in hydrators).

---

### doctrine-result-cache

**Source:** `src/tools/doctrine-result-cache.ts`
**Functions:** `list_doctrine_result_cache`, `get_doctrine_result_cache_stats`

Scans `->enableResultCache()` usage across repositories; warns on cache TTL < 60s (cache
thrashing), result cache on write queries (always stale), no cache region specified (defaults
collision).

---

### doctrine-criteria

**Source:** `src/tools/doctrine-criteria.ts`
**Functions:** `list_doctrine_criteria`, `get_doctrine_criteria_stats`

Detects `Criteria` usage: `Criteria::create()`, `CompositeExpression`, `addCriteria()` on
collections; warns on criteria with no ordering on paginated result, `matching()` without
index on criteria field.

---

### doctrine-entity-graph

**Source:** `src/tools/doctrine-entity-graph.ts`
**Functions:** `list_entity_graph`, `get_entity_graph_stats`

Builds entity relation graph from `#[ManyToOne]`, `#[OneToMany]`, `#[ManyToMany]`, `#[OneToOne]`
attributes; reports bidirectional pairs, missing inverse side, circular cascade (cascade remove
on both sides).

---

### doctrine-change-tracking

**Source:** `src/tools/doctrine-change-tracking.ts`
**Functions:** `list_doctrine_change_tracking`, `get_doctrine_change_tracking_stats`

Reads `changeTrackingPolicy` in entity `#[Entity]` or `#[ORM\ChangeTrackingPolicy]`; warns on
`NOTIFY` without `PropertyChangedListener` implementation, `DEFERRED_EXPLICIT` without
`markFieldDirty()` calls.

---

### doctrine-result-set-mapping

**Source:** `src/tools/doctrine-result-set-mapping.ts`
**Functions:** `list_result_set_mappings`, `get_result_set_mapping_stats`

Reads `ResultSetMappingBuilder` and `ResultSetMapping` usages in repositories; warns on
`addEntityResult()` without discriminator map for inheritance, scalar result not aliased.

---

### doctrine-odm

**Source:** `src/tools/doctrine-odm.ts`
**Functions:** `list_doctrine_odm`, `get_doctrine_odm_stats`

Doctrine ODM (MongoDB) `#[Document]`, `#[EmbedOne]`, `#[EmbedMany]`, `#[ReferenceOne]`,
`#[ReferenceMany]` — collection name, fields, indexes; warns on missing `_id` type, large
embedded arrays without ODM pagination.

---

### doctrine-bulk-ops

**Source:** `src/tools/doctrine-bulk-ops.ts`
**Functions:** `list_doctrine_bulk_ops`, `get_doctrine_bulk_ops_stats`

Detects batch inserts/updates via `iterateResult`, `$em->flush()` periodically,
`BulkInsertQuery`; warns on single `persist()` + `flush()` in loop (N round-trips), missing
memory clear in batch loop.

---

### doctrine-entity-state

**Source:** `src/tools/doctrine-entity-state.ts`
**Functions:** `list_doctrine_entity_states`, `get_doctrine_entity_state_stats`

Detects detached/removed/managed entity state bugs: `persist()` after `remove()`, `merge()` on
entity with pending changes, scalar ID access on proxy without hydration.

---

### doctrine-cascades

**Source:** `src/tools/doctrine-cascades.ts`
**Functions:** `list_doctrine_cascades`, `get_doctrine_cascade_stats`

Reads `cascade:` options per association; warns on `cascade: ['all']` on `#[ManyToMany]`
(accidental mass-remove), orphanRemoval without cascade persist.

---

### doctrine-orphan-removal

**Source:** `src/tools/doctrine-orphan-removal.ts`
**Functions:** `list_doctrine_orphan_removal`, `get_doctrine_orphan_removal_stats`

Reads `orphanRemoval: true` on associations; warns on orphan removal without cascade persist
(add fails), both sides with orphan removal (double-delete risk), orphan removal on
`#[ManyToMany]` (not supported).

---

### doctrine-2lc

**Source:** `src/tools/doctrine-2lc.ts`
**Functions:** `list_doctrine_2lc`, `get_doctrine_2lc_stats`

Second-level cache configuration: regions (name/lifetime), entities with `#[ORM\Cache]` usage
modes (READ_ONLY/READ_WRITE/NONSTRICT_READ_WRITE); warns on READ_WRITE without concurrency
strategy, READ_ONLY on mutable entity.

---

### doctrine-named-queries

**Source:** `src/tools/doctrine-named-queries.ts`
**Functions:** `list_named_queries`, `get_named_query_stats`

Reads `#[NamedQuery]` / `#[NamedNativeQuery]` on entities; warns on named query containing
entity class literal without full class name (breaks after rename), native query without
result set mapping.

---

### doctrine-repository-queries

**Source:** `src/tools/doctrine-repository-queries.ts`
**Functions:** `list_repository_queries`, `get_repository_query_stats`

Reads DQL strings inside repository methods; warns on SELECT without WHERE on large tables,
hardcoded table names in DQL (use entity name), `getResult()` without `setMaxResults()`.

---

### doctrine-paginator

**Source:** `src/tools/doctrine-paginator.ts`
**Functions:** `list_doctrine_paginator`, `get_doctrine_paginator_stats`

Detects `Paginator` usage; warns on `fetch_join_collection: false` with JOIN fetch (incorrect
count), `COUNT(*)` vs `COUNT(DISTINCT e.id)` mismatch on JOIN queries.

---

### doctrine-dql-walker

**Source:** `src/tools/doctrine-dql-walker.ts`
**Functions:** `list_doctrine_dql_walker`, `get_doctrine_dql_walker_stats`

Reads custom `TreeWalker` and `OutputWalker` implementations; warns on walker not extending
`SqlWalker` (missing parent), walker modifying AST in `walkSelectClause` (unstable).

---

### doctrine-dbal-middleware

**Source:** `src/tools/doctrine-dbal-middleware.ts`
**Functions:** `list_dbal_middleware`, `get_dbal_middleware_stats`

Reads `doctrine.yaml dbal.middleware:` services; detects `MiddlewareInterface` implementations;
warns on middleware not tagged `doctrine.middleware`, middleware order (logging should be
outermost).

---

### doctrine-custom-platform

**Source:** `src/tools/doctrine-custom-platform.ts`
**Functions:** `list_doctrine_custom_platform`, `get_doctrine_custom_platform_stats`

Detects custom `AbstractPlatform` subclasses; warns on platform overriding `getName()` with
reserved name, missing `getIdentifierQuoteCharacter()`.

---

### doctrine-soft-delete

**Source:** `src/tools/doctrine-soft-delete.ts`
**Functions:** `list_doctrine_soft_delete`, `get_doctrine_soft_delete_stats`

Detects `gedmo/doctrine-extensions` SoftDeleteable or `knplabs/doctrine-behaviors` SoftDeletable;
reads `#[SoftDeleteable]` fields; warns on soft-delete filter not enabled globally, filter
not applied in admin context (ghost records visible).

---

### doctrine-mapping-format

**Source:** `src/tools/doctrine-mapping-format.ts`
**Functions:** `list_doctrine_mapping_format`, `get_doctrine_mapping_format_stats`

Detects mixed mapping formats (XML/YAML/attribute) in same project; warns on deprecated YAML
mapping in Doctrine 3, XML mapping without schema validation.

---

### doctrine-timestamps

**Source:** `src/tools/doctrine-timestamps.ts`
**Functions:** `list_doctrine_timestamps`, `get_doctrine_timestamp_stats`

Reads `#[CreatedAt]`/`#[UpdatedAt]` (Gedmo Timestampable) or manual lifecycle callbacks
with `\DateTime` fields; warns on mutable DateTime columns updated in `PreUpdate` (consider
immutable).

---

### doctrine-versioned-entities

**Source:** `src/tools/doctrine-versioned-entities.ts`
**Functions:** `list_symfony_versioned_entities`, `get_symfony_versioned_entity_stats`

Doctrine optimistic locking: `#[Version]` fields; warns on version field not typed as `integer`
or `datetime`, multiple `#[Version]` fields per entity, version field modified manually.

---

### doctrine-read-replicas

**Source:** `src/tools/doctrine-read-replicas.ts`
**Functions:** `list_symfony_doctrine_read_replicas`, `get_symfony_doctrine_read_replicas_stats`

Reads `doctrine.yaml` `replica:` connections; warns on writes routed to replica, no explicit
`primary()` call before write operations, replica DSN without password (auth bypass).

---

### doctrine-raw-sql

**Source:** `src/tools/doctrine-raw-sql.ts`
**Functions:** `list_doctrine_raw_sql`, `get_doctrine_raw_sql_stats`

Detects `executeQuery()`/`executeStatement()` usage with string concatenation (SQL injection);
warns on raw SQL containing user-supplied variables without `?` / `:param` binding.

---

### doctrine-entity-manager-scope

**Source:** `src/tools/doctrine-entity-manager-scope.ts`
**Functions:** `list_symfony_doctrine_entity_manager_scope`, `get_symfony_doctrine_entity_manager_scope_stats`

Detects EntityManager scope issues: `$em` injected into long-running services (closed EM risk),
`getManager()` called after `close()` without reset, missing `resetManager()` call after
failed transaction.

---

### doctrine-entity-factory

**Source:** `src/tools/doctrine-entity-factory.ts`
**Functions:** `list_entity_factories`, `get_entity_factory_stats`

Classes with `create()` static factory or `EntityFactory` suffix; warns on factory calling
`flush()` (side effect), missing named constructor, factory not returning entity type.

---

### doctrine-entity-proxy

**Source:** `src/tools/doctrine-entity-proxy.ts`
**Functions:** `list_doctrine_entity_proxy`, `get_doctrine_entity_proxy_stats`

Detects entity proxy anti-patterns: `instanceof` checks on proxy classes, `get_class()` instead
of `::class` on proxied entity, calling `initializeProxy()` outside test context.

---

### doctrine-association-fetch

**Source:** `src/tools/doctrine-association-fetch.ts`
**Functions:** `list_doctrine_association_fetch`, `get_doctrine_association_fetch_stats`

Reads `fetch: 'EAGER'` / `fetch: 'LAZY'` / `fetch: 'EXTRA_LAZY'` on associations; warns on
EAGER on `#[ManyToMany]` (Cartesian product risk), EXTRA_LAZY without paginated access pattern.

---

### doctrine-fetch-modes

**Source:** `src/tools/doctrine-fetch-modes.ts`
**Functions:** `list_doctrine_fetch_modes`, `get_doctrine_fetch_mode_stats`

Reads per-query `setFetchMode()` or `FETCH JOIN` hints; warns on deprecated `setFetchMode()` in
Doctrine 3, mixed FETCH JOIN and result cache (cache miss on join).

---

### doctrine-multi-connection

**Source:** `src/tools/doctrine-multi-connection.ts`
**Functions:** `list_doctrine_multi_connection`, `get_doctrine_multi_connection_stats`

Reads `doctrine.yaml dbal.connections:` plural; detects entity managers per connection;
warns on cross-connection associations (not supported), entity manager not mapped to correct
connection.

---

### doctrine-dbal-event-listeners

**Source:** `src/tools/doctrine-dbal-event-listeners.ts`
**Functions:** `list_doctrine_dbal_event_listeners`, `get_doctrine_dbal_event_listener_stats`

Reads DBAL event listeners (`postConnect`, `onSchemaCreateTable`, etc.); warns on listener
making additional queries in `postConnect` (connection overhead), listener without
`\Doctrine\DBAL\Event\Listeners` namespace.

---

### doctrine-dbal-bulk-insert

**Source:** `src/tools/doctrine-dbal-bulk-insert.ts`
**Functions:** `list_doctrine_dbal_bulk_insert`, `get_doctrine_dbal_bulk_insert_stats`

Detects DBAL `executeStatement()` in loops vs batch `INSERT INTO ... VALUES (...),(...),...`;
warns on single-row inserts in loop > 100 iterations, missing transaction wrapper for bulk ops.

---

### doctrine-schema-diff

**Source:** `src/tools/doctrine-schema-diff.ts`
**Functions:** `list_doctrine_schema_diff`, `get_doctrine_schema_diff_stats`

Reads `SchemaDiff` tool usage in CI; warns on no schema diff step in migration pipeline,
ignored schema diff warnings in CI.

---

### doctrine-dbal-driver-options

**Source:** `src/tools/doctrine-dbal-driver-options.ts`
**Functions:** (DBAL driver options analysis)

Reads `doctrine.yaml` `dbal.connections[*].options:` (PDO driver options); warns on
`PDO::ATTR_EMULATE_PREPARES => true` (disables real prepared statements — security risk),
`PDO::ATTR_PERSISTENT => true` (connection leak in FPM), `PDO::ATTR_ERRMODE` not set to
`EXCEPTION`.

---

### doctrine-composite-primary-keys

**Source:** `src/tools/doctrine-composite-primary-keys.ts`
**Functions:** (composite primary key analysis)

Detects `#[ORM\Id]` on multiple fields (composite PK); warns on composite PK with association
(requires `composite_id` join column), composite PK entity used as target of a `#[OneToOne]`
(complex join), missing `equals()` method for value comparison.

---

### doctrine-full-text-search

**Source:** `src/tools/doctrine-full-text-search.ts`
**Functions:** `list_doctrine_full_text_search`, `get_doctrine_full_text_search_stats`

Detects full-text search indexes (`FULLTEXT` index in MySQL migrations, `GIN`/`GiST` in
PostgreSQL); reads custom DQL functions for full-text (MATCH AGAINST, `to_tsvector`); warns
on LIKE search on large text columns without full-text index.

---

### doctrine-column-defaults

**Source:** `src/tools/doctrine-column-defaults.ts`
**Functions:** `list_doctrine_column_defaults`, `get_doctrine_column_defaults_stats`

Reads `#[Column(options: ['default' => ...])]` values; warns on boolean columns without
explicit default, `nullable: false` string columns without default (migration will fail on
existing rows), default value mismatch between PHP entity and DB migration.

---

### doctrine-postgresql-specific

**Source:** `src/tools/doctrine-postgresql-specific.ts`
**Functions:** `list_doctrine_postgresql_specific`, `get_doctrine_postgresql_specific_stats`

PostgreSQL-specific Doctrine patterns: JSONB columns (`type: json`), `uuid` column type,
`ARRAY` type, partial indexes (`where:` in `#[Index]`), advisory locks; warns on JSONB
without GIN index, array column without dimension check.

---

### doctrine-mysql-specific

**Source:** `src/tools/doctrine-mysql-specific.ts`
**Functions:** `list_doctrine_mysql_specific`, `get_doctrine_mysql_specific_stats`

MySQL-specific Doctrine patterns: `utf8mb4` charset, `ROW_FORMAT=DYNAMIC`, `ENGINE=InnoDB`,
JSON column type; warns on `utf8` charset (3-byte, emoji truncated), missing `ENGINE=InnoDB`
for transactions, `TINYINT` mapped as boolean.

---

### doctrine-connection-retry

**Source:** `src/tools/doctrine-connection-retry.ts`
**Functions:** `list_doctrine_connection_retry`, `get_doctrine_connection_retry_stats`

Detects DBAL connection retry config: `retry_connect` option, `DriverManager::getConnection()`
with reconnect logic; warns on no retry on `Connection already closed` error, missing
`ping()`-like keepalive for long-running workers.

---

### doctrine-hydration-performance

**Source:** `src/tools/doctrine-hydration-performance.ts`
**Functions:** `list_doctrine_hydration_performance`, `get_doctrine_hydration_performance_stats`

Reads hydration mode per query: `HYDRATE_OBJECT` vs `HYDRATE_ARRAY` vs `HYDRATE_SCALAR`;
warns on HYDRATE_OBJECT on large result sets (heavy memory), HYDRATE_ARRAY misused as read
model (no type safety).

---

### doctrine-dbal-query-profiling

**Source:** `src/tools/doctrine-dbal-query-profiling.ts`
**Functions:** `list_doctrine_dbal_query_profiling`, `get_doctrine_dbal_query_profiling_stats`

Reads profiler data collectors; warns on `DebugStack` logger enabled in production,
`LoggingConnection` in production config.

---

### doctrine-upsert

**Source:** `src/tools/doctrine-upsert.ts`
**Functions:** `list_doctrine_upsert`, `get_doctrine_upsert_stats`

Detects DBAL `insert()` + `update()` pair replaced by `upsert()`; warns on `INSERT ... ON
DUPLICATE KEY UPDATE` raw SQL (MySQL) or `INSERT ... ON CONFLICT DO UPDATE` (PostgreSQL)
missing in Doctrine abstraction layer.

---

### doctrine-temporal-tables

**Source:** `src/tools/doctrine-temporal-tables.ts`
**Functions:** `list_doctrine_temporal_tables`, `get_doctrine_temporal_tables_stats`

Temporal/history table patterns: `loggable` extension, `enversBundle`, versioned entities with
full audit trail; warns on audit log without separate connection (audit data in same DB as main).

---

### doctrine-encryption

**Source:** `src/tools/doctrine-encryption.ts`
**Functions:** `list_doctrine_encryption`, `get_doctrine_encryption_stats`

Detects `DoctrineEncryptBundle` or `doctrine/doctrine-encrypted-bundle`; warns on encryption
key in `.env` without secrets vault, encrypted columns without indexing strategy (can't be
searched), IV reuse.

---

### doctrine-sharding

**Source:** `src/tools/doctrine-sharding.ts`
**Functions:** `list_doctrine_sharding`, `get_doctrine_sharding_stats`

Detects multi-tenant sharding patterns: multiple connections, tenant resolver service,
`SwitchableConnectionWrapper`; warns on sharding without transaction isolation per tenant,
cross-shard JOIN attempt.

---

### doctrine-dbal-schema-manager

**Source:** `src/tools/doctrine-dbal-schema-manager.ts`
**Functions:** `list_dbal_schema_manager`, `get_dbal_schema_manager_stats`

Reads `$em->getConnection()->createSchemaManager()` and deprecated `getSchemaManager()` usage;
warns on `getSchemaManager()` removed in DBAL 4, `listTables()` called at request time
(expensive), schema operations outside migration scripts.

---

### doctrine-dbal-transactions

**Source:** `src/tools/doctrine-dbal-transactions.ts`
**Functions:** `list_dbal_transactions`, `get_dbal_transaction_stats`

Reads `$em->wrapInTransaction()`, `$conn->beginTransaction()`, `commit()`, `rollback()`;
warns on `beginTransaction()` without matching `rollback()` in catch block, nested transaction
without savepoint, `wrapInTransaction()` returning without commit.

---

### doctrine-dbal-connection-factory

**Source:** `src/tools/doctrine-dbal-connection-factory.ts`
**Functions:** `list_dbal_connection_factory`, `get_dbal_connection_factory_stats`

Reads custom `ConnectionFactory` implementations; warns on factory not implementing
`createConnection()`, DSN overrides without preserving original driver options.

---

### pgbouncer-config

**Source:** `src/tools/pgbouncer-config.ts`
**Functions:** `list_pgbouncer_config`, `get_pgbouncer_config_stats`

`pgbouncer.ini` detection: pool_mode (transaction/session/statement), max_client_conn,
default_pool_size; warns on session mode with Doctrine (prevents connection pooling),
`max_client_conn` below 100 for prod.

---

### symfony-doctrine-profiling

**Source:** `src/tools/symfony-doctrine-profiling.ts`
**Functions:** `list_orm_profiling`, `get_orm_profiling_stats`

`DebugStack` logger, profiler collector data, Blackfire probe; warns on no query count logging
in performance tests, missing query threshold alerts.

---

### symfony-projections

**Source:** `src/tools/symfony-projections.ts`
**Functions:** `list_projections`, `get_projection_stats`

Read-model projection patterns: classes with `Projection` suffix, `ReadModel` namespace,
`#[AsMessageHandler]` on classes creating denormalized views. Warns on projections writing
to same DB as write model (should use separate read replica or DB).

---

### symfony-cqrs

**Source:** `src/tools/symfony-cqrs.ts`
**Functions:** `list_cqrs_patterns`, `get_cqrs_stats`

Command/Query bus separation: `CommandBusInterface`/`QueryBusInterface` aliases, command
classes in `Command/` namespace returning void, query classes returning typed result. Warns
on commands returning non-void (CQRS violation), queries with side effects.

---

### symfony-event-sourcing

**Source:** `src/tools/symfony-event-sourcing.ts`
**Functions:** `list_event_sourcing`, `get_event_sourcing_stats`

Event store patterns (`EventStoreInterface`, `DomainEvent`, aggregate root with
`$domainEvents` array); warns on events not implementing `Serializable`, event store without
snapshot strategy, aggregate loading all events without stream versioning.

---

### symfony-repository-patterns

**Source:** `src/tools/symfony-repository-patterns.ts`
**Functions:** `list_repository_patterns`, `get_repository_pattern_stats`

Repository design patterns: Interface-based repositories, generic `RepositoryInterface<T>`,
`find*` naming conventions; warns on repositories with public `EntityManager` injection,
fat repositories (> 20 public methods), missing `save()` method.

---

### symfony-query-builder

**Source:** `src/tools/symfony-query-builder.ts`
**Functions:** `list_query_builder_usage`, `get_query_builder_stats`

Scans `createQueryBuilder()` chain in repositories: alias, `->select()`, `->join()`,
`->where()`, `->orderBy()`, `->setMaxResults()`; warns on query builder without `setMaxResults`
(unbounded result), `->where()` before `->join()` (wrong binding scope), parameter as direct
string interpolation (SQL injection).

---

### doctrine-php-type-coverage

**Source:** `src/tools/doctrine-php-type-coverage.ts`
**Functions:** `list_php_type_coverage`, `get_php_type_coverage_stats`

Scans entity properties for PHP type declarations matching Doctrine `#[Column]` type; warns on
property typed `string` mapped to `integer` column, nullable PHP type on non-nullable column,
missing property type declaration.

---

### symfony-entity-lock

**Source:** `src/tools/symfony-entity-lock.ts`
**Functions:** `list_entity_lock`, `get_entity_lock_stats`

Doctrine pessimistic locking: `LOCK_MODE_PESSIMISTIC_WRITE`/`LOCK_MODE_OPTIMISTIC` in
`find()`/`lock()` calls; warns on pessimistic lock outside transaction, lock timeout not set.
