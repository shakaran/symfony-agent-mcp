# Category: queues

Queue management — RabbitMQ, Kafka, SQS FIFO/DLQ, Pusher, Redis pub/sub and streams.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### rabbitmq-config

**Source:** `src/tools/rabbitmq-config.ts`
**Functions:** `list_rabbitmq_config`, `get_rabbitmq_config_stats`

Analyzes RabbitMQ/AMQP Messenger transport; warns on unencrypted `amqp://`, default vhost,
no `dead_letter_exchange`, no `prefetch_count` QoS, non-durable queues, default `guest` credentials.

---

### rabbitmq-management-api

**Source:** `src/tools/rabbitmq-management-api.ts`
**Functions:** `list_rabbitmq_management_api`, `get_rabbitmq_management_api_stats`

RabbitMQ Management API patterns (distinct from `rabbitmq-config.ts` which covers DSN/transport
config): management API endpoint detection, vhost/queue/exchange analysis; flags management user
same as app user, no TLS for management API, default guest/guest credentials.

---

### kafka-integration

**Source:** `src/tools/kafka-integration.ts`
**Functions:** `list_kafka_integration`, `get_kafka_integration_stats`

Analyzes Kafka integration in Symfony Messenger; warns on PLAINTEXT transport without TLS/SASL,
missing consumer `group.id`, auto-commit risk, no topic configuration, producer without
idempotence, manual serialization without Schema Registry.

---

### kafka-schema-registry

**Source:** `src/tools/kafka-schema-registry.ts`
**Functions:** `list_kafka_schema_registry`, `get_kafka_schema_registry_stats`

Detects Confluent Schema Registry usage: `AvroSerializer` / `JsonSchemaSerializer` missing
`auto.register.schemas=false` in production (uncontrolled schema evolution), missing subject
naming strategy configuration, backward/forward compatibility mode not enforced. Flags schema ID
hardcoded in producer without registry lookup.

---

### sqs-messenger-config

**Source:** `src/tools/sqs-messenger-config.ts`
**Functions:** `list_sqs_messenger_config`, `get_sqs_messenger_config_stats`

Analyzes AWS SQS Messenger transport; warns on missing DLQ, no `visibility_timeout`, no long
polling `wait_time`, Standard vs FIFO queue, missing region, hardcoded AWS credentials.

---

### sqs-dlq-config

**Source:** `src/tools/sqs-dlq-config.ts`
**Functions:** `list_sqs_dlq_config`, `get_sqs_dlq_config_stats`

Detects AWS SQS Dead Letter Queue configuration: SQS queues without `RedrivePolicy` (messages
silently dropped on repeated failure), `maxReceiveCount` set below 3 (messages moved to DLQ
too aggressively), DLQ alarms not configured, Symfony Messenger SQS transport missing
`wait_time` setting.

---

### sqs-fifo-queues

**Source:** `src/tools/sqs-fifo-queues.ts`
**Functions:** `list_sqs_fifo_queues`, `get_sqs_fifo_queues_stats`

Scans `config/**/*.yaml`, `src/**/*.php`, `.env*` for: FIFO queue without `MessageGroupId`;
missing `MessageDeduplicationId` with content-based deduplication disabled; visibility timeout
shorter than processing time; FIFO without `fifo_queue: true` in Symfony Messenger; missing DLQ;
`MaxReceiveCount: 1` (no retry).

---

### redis-streams-config

**Source:** `src/tools/redis-streams-config.ts`
**Functions:** `list_redis_streams_config`, `get_redis_streams_config_stats`

Analyzes Redis Streams configuration for Messenger transport; warns on missing stream name,
no consumer group, no `maxlen` cap, no `delete_after_ack`/`reclaimTimeout`, Redis DSN without
password or TLS.

---

### redis-pubsub-patterns

**Source:** `src/tools/redis-pubsub-patterns.ts`
**Functions:** `list_redis_pubsub_patterns`, `get_redis_pubsub_patterns_stats`

Detects Redis PUBLISH/SUBSCRIBE usage in PHP: `Redis::subscribe()` blocking without timeout,
missing channel pattern validation (ReDoS risk with `psubscribe`), message handler not
acknowledging failures, subscriber loop without reconnect on connection drop.

---

### pusher-integration

**Source:** `src/tools/pusher-integration.ts`
**Functions:** `list_pusher_integration`, `get_pusher_integration_stats`

Pusher Channels integration: `pusher/pusher-php-server` package version check, `PUSHER_APP_*`
env vars (secrets masked), webhook HMAC validation; flags hardcoded app secret, private/presence
channels without auth endpoint, deprecated SDK versions, `debug: true` in production.
