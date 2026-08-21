# Category: messaging

Messaging tools — Messenger, Notifier, Webhooks, Mercure, Mailer, transports, stamps, failure handling.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### messenger-handlers

**Source:** `src/tools/messenger-handlers.ts`
**Functions:** `list_messenger_handlers`, `get_messenger_handler_stats`

Deep `#[AsMessageHandler]` attribute scan: extracts bus assignment, priority, `from_transport`,
and the handled message class (from `__invoke` / `handle` type hint). Builds a complete
message → handler(s) mapping and flags fan-out patterns (one message dispatched to multiple
handlers). Reads `config/packages/messenger.yaml` for transport retry strategies (max\_retries,
delay, multiplier, failed transport). Stats report handler count, distinct message count, buses
used, and handlers with explicit priority or transport assignment.

---

### messenger-middleware

**Source:** `src/tools/messenger-middleware.ts`
**Functions:** `list_messenger_middleware`, `get_messenger_middleware_stats`

Per-bus middleware chain (built-in labeled + custom marked), custom `MiddlewareInterface`
classes, custom `StampInterface` implementations. Reads
`framework.messenger.buses[*].middleware` from `config/packages/messenger.yaml`. Labels
built-in middleware (send_message, handle_message, validation, etc.).

---

### messenger

**Source:** `src/tools/messenger.ts`
**Functions:** (messenger transport and routing inspection)

Transports, routing, message classes. Complete Messenger configuration overview including
all bus definitions, transport DSNs, and message class bindings.

---

### symfony-messenger-failures

**Source:** `src/tools/symfony-messenger-failures.ts`
**Functions:** `list_messenger_failure_config`, `get_messenger_failure_stats`

Reads `messenger.yaml`: global `failure_transport`, per-transport `failure_transport` override,
`retry_strategy` (max\_retries, delay, multiplier, max\_delay, custom service). Detects async
transports without failure coverage, high retry counts (> 10), and dead-letter transports that
nothing routes to.

---

### symfony-messenger-stamps

**Source:** `src/tools/symfony-messenger-stamps.ts`
**Functions:** `list_messenger_stamps`, `get_stamp_stats`

Scans `BusNameStamp`, `DelayStamp`, `DispatchAfterCurrentBusStamp`, `HandledStamp` usage.
Custom `StampInterface`; warns: `HandledStamp` outside tests, `DelayStamp` > 24h.

---

### symfony-message-buses

**Source:** `src/tools/symfony-message-buses.ts`
**Functions:** `list_message_buses`, `get_bus_stats`

Reads `messenger.yaml buses:`, `default_bus`, middleware per bus, `allow_no_handlers`. CQRS
pattern: `CommandBusInterface`/`QueryBusInterface`/`EventBusInterface` aliases.

---

### symfony-messenger-retry

**Source:** `src/tools/symfony-messenger-retry.ts`
**Functions:** `list_messenger_retry_config`, `get_messenger_retry_stats`

Reads `retry_strategy:` per transport. Detects `RetryStrategyInterface`/`NullRetryStrategy`.
Warns on transport without retry, unbounded `max_delay`, `NullRetryStrategy`.

---

### symfony-messenger-worker

**Source:** `src/tools/symfony-messenger-worker.ts`
**Functions:** `list_messenger_worker_config`, `get_messenger_worker_stats`

Scans supervisor/systemd/docker-compose/Procfile/Makefile for `messenger:consume`. Warns on
missing `--memory-limit`, missing `--time-limit`.

---

### symfony-messenger-transport-options

**Source:** `src/tools/symfony-messenger-transport-options.ts`
**Functions:** `list_messenger_transport_options`, `get_messenger_transport_option_stats`

Reads Messenger transport DSN and options from YAML. Detects driver type
(AMQP/Redis/Doctrine/SQS). Warns on in-memory/sync (dev-only), AMQP without `prefetch_count`,
high `max_retries`.

---

### symfony-messenger-transport-dsn

**Source:** `src/tools/symfony-messenger-transport-dsn.ts`
**Functions:** `list_symfony_messenger_transport_dsns`, `get_symfony_messenger_transport_dsn_stats`

Reads `messenger.yaml` transport DSNs; warns on plaintext credentials in DSN, `sync://`
transport in production, missing retry strategy, doctrine transport without dedicated connection.

---

### symfony-messenger-competing-consumers

**Source:** `src/tools/symfony-messenger-competing-consumers.ts`
**Functions:** `list_symfony_messenger_competing_consumers`, `get_symfony_messenger_competing_consumers_stats`

Competing consumer and parallel worker configuration: transport concurrency in `messenger.yaml`,
worker definitions in supervisord/docker-compose; flags single worker for high-load transports.

---

### symfony-messenger-batch-handler

**Source:** `src/tools/symfony-messenger-batch-handler.ts`
**Functions:** `list_messenger_batch_handler`, `get_messenger_batch_handler_stats`

Detects `BatchHandlerInterface` / `BatchHandlerTrait` implementations; warns on batch handler
without `shouldFlush()` implementation, batch size not configured, batch handler mixed with
non-batch messages in same transport.

---

### symfony-messenger-priority

**Source:** `src/tools/symfony-messenger-priority.ts`
**Functions:** `list_messenger_priority`, `get_messenger_priority_stats`

Reads `messenger.yaml` transport config for priority queues; warns on multiple transports
without priority ordering, high-priority transport sharing worker with low-priority, missing
dead-letter transport for priority queue.

---

### symfony-messenger-in-memory

**Source:** `src/tools/symfony-messenger-in-memory.ts`
**Functions:** `list_in_memory_transport`, `get_in_memory_transport_stats`

Reads `messenger.yaml` for `in-memory://` transports; warns on in-memory transport not scoped
to `test` environment, in-memory transport used in `prod` config, missing `reset_on_message: true`.

---

### symfony-messenger-envelope

**Source:** `src/tools/symfony-messenger-envelope.ts`
**Functions:** `list_messenger_envelopes`, `get_messenger_envelope_stats`

Scans `Envelope::wrap()`, stamp manipulation; warns on `last(HandledStamp)` without null check,
`DelayStamp` with very long delay.

---

### symfony-messenger-dispatch-after

**Source:** `src/tools/symfony-messenger-dispatch-after.ts`
**Functions:** `list_dispatch_after_current_bus`, `get_dispatch_after_stats`

Detects dispatch inside message handlers; warns on inner dispatch without
`DispatchAfterCurrentBus` stamp, middleware not in stack.

---

### symfony-messenger-scheduler

**Source:** `src/tools/symfony-messenger-scheduler.ts`
**Functions:** `list_messenger_scheduler`, `get_messenger_scheduler_stats`

Reads `scheduler.yaml`, scans `RecurringMessage::cron()`/`::every()` and
`ScheduleProviderInterface`; warns on scheduler without timezone, `* * * * *` every-minute
cron, missing transport, `ScheduleProviderInterface` without `#[AsSchedule]`.

---

### symfony-messenger-circuit-breaker

**Source:** `src/tools/symfony-messenger-circuit-breaker.ts`
**Functions:** `list_symfony_messenger_circuit_breaker`, `get_symfony_messenger_circuit_breaker_stats`

Detects circuit breaker patterns in Messenger; warns on missing timeout/threshold/half-open
state, handlers without circuit breaker, no `retry_strategy`.

---

### symfony-messenger-sagas

**Source:** `src/tools/symfony-messenger-sagas.ts`
**Functions:** `list_symfony_messenger_sagas`, `get_symfony_messenger_sagas_stats`

Analyzes saga/process manager patterns; warns on missing persistent storage, no compensation
handlers, no timeout, non-idempotent handlers, non-UUID correlation IDs.

---

### symfony-messenger-graceful-shutdown

**Source:** `src/tools/symfony-messenger-graceful-shutdown.ts`
**Functions:** `list_symfony_messenger_graceful_shutdown`, `get_symfony_messenger_graceful_shutdown_stats`

Detects Messenger worker graceful shutdown configuration (`SIGTERM`, `StopWorkerOnSignalListener`,
`messenger:stop-workers`); warns on workers without graceful shutdown, missing signal handler in
Docker/Kubernetes.

---

### symfony-messenger-monitoring

**Source:** `src/tools/symfony-messenger-monitoring.ts`
**Functions:** `list_symfony_messenger_monitoring`, `get_symfony_messenger_monitoring_stats`

`failure_transport`, `retry_strategy`, supervisor config, monitoring bundles.

---

### symfony-messenger-pause-resume

**Source:** `src/tools/symfony-messenger-pause-resume.ts`
**Functions:** `list_symfony_messenger_pause_resume`, `get_symfony_messenger_pause_resume_stats`

Worker pause/resume strategies: `StopWorkerOnMessageLimitMiddleware`,
`StopWorkerOnTimeLimitMiddleware`, `StopWorkerOnFailureLimitMiddleware`; flags missing SIGTERM
handling, very low limits.

---

### messenger-serializer

**Source:** `src/tools/messenger-serializer.ts`
**Functions:** `list_messenger_serializer`, `get_messenger_serializer_stats`

Detects `MessageSerializerInterface`, configured serializer from `messenger.yaml`. Warns on
native PHP serializer usage.

---

### notifier

**Source:** `src/tools/notifier.ts`
**Functions:** `list_notifier_transports`, `list_notifications`, `get_notifier_stats`

All transports from `notifier.yaml` by channel type (email, SMS, chat, push) with masked DSNs
and channel policies, custom `Notification` subclasses in `src/` with declared channels and
urgency. Categorises transport DSNs by protocol (smtp→email, twilio→sms, slack/telegram/
discord→chat, firebase→push). Detects `getChannels()` return values and `URGENCY_URGENT` usage.

---

### symfony-notifier-channels

**Source:** `src/tools/symfony-notifier-channels.ts`
**Functions:** `list_notifier_channels`, `get_notifier_channel_stats`

Reads `notifier.yaml`: channel type assignments (chat/sms/email/push), `channel_policy` urgency
levels (urgent/high/medium/low), `admin_recipients`. Scans Notification classes:
`getChannels()` override, `setImportance()`, `asSms()` / `asEmail()` / `asChat()` overrides.
Warns on channels without transports, urgent notifications with no admin recipients.

---

### notifier-transport-config

**Source:** `src/tools/notifier-transport-config.ts`
**Functions:** `list_notifier_transport_config`, `get_notifier_transport_stats`

Reads notifier transport DSNs from `notifier.yaml`. Detects SMS/chat/push/email type. Masks
credentials. Warns on hardcoded credentials.

---

### symfony-notifier-message-types

**Source:** `src/tools/symfony-notifier-message-types.ts`
**Functions:** `list_notifier_message_types`, `get_notifier_message_type_stats`

Detects `ChatMessage`/`SmsMessage`/`PushMessage`/`EmailMessage` usage counts. Warns on
`SmsMessage` with `subject()` and `ChatMessage` without content.

---

### symfony-notifier-sms

**Source:** `src/tools/symfony-notifier-sms.ts`
**Functions:** `list_symfony_notifier_sms`, `get_symfony_notifier_sms_stats`

Detects SMS notifier transport configuration (Twilio/Vonage/Bandwidth); warns on hardcoded
credentials, missing sender ID configuration.

---

### symfony-notifier-push

**Source:** `src/tools/symfony-notifier-push.ts`
**Functions:** `list_symfony_notifier_push`, `get_symfony_notifier_push_stats`

Detects push notification transports (Firebase FCM, OneSignal, Expo); warns on hardcoded API
keys, missing access token, no topic routing.

---

### symfony-notifier-status

**Source:** `src/tools/symfony-notifier-status.ts`
**Functions:** (notifier delivery status)

Detects Symfony Notifier delivery status configuration: missing `StatusUpdateEvent` listener
for SMS/push channels, `TransportFactory` implementations not reporting final delivery status,
`FailedMessage` not handled for retry.

---

### symfony-notifier-admin

**Source:** `src/tools/symfony-notifier-admin.ts`
**Functions:** `list_notifier_admin`, `get_notifier_admin_stats`

Scans `AdminNotifier` usage and `admin_recipients` config; warns on missing admin recipients,
notifications without `getImportance()`.

---

### symfony-chat-notifiers

**Source:** `src/tools/symfony-chat-notifiers.ts`
**Functions:** `list_symfony_chat_notifiers`, `get_symfony_chat_notifier_stats`

Slack/Telegram/Discord/Teams DSN config, literal tokens in YAML.

---

### webhooks

**Source:** `src/tools/webhooks.ts`
**Functions:** `list_webhooks`, `get_webhook_stats`

Symfony 6.3+ webhook endpoints (parser, secret presence, detected provider), custom
`RequestParserInterface` classes, `#[AsWebhookConsumer]` classes. Reads
`framework.webhook.routing` from `config/packages/webhook.yaml`. Detects 10 known external
providers by name pattern. Flags endpoints configured without a secret.

---

### webhook-consumers

**Source:** `src/tools/webhook-consumers.ts`
**Functions:** `list_webhook_consumers`, `get_webhook_consumer_stats`

Detects `AbstractRequestParser`/`RequestParserInterface`, HMAC/SHA signature, `hash_equals()`
timing-safe compare, replay protection (timestamp/nonce).

---

### symfony-webhook-security

**Source:** `src/tools/symfony-webhook-security.ts`
**Functions:** `list_symfony_webhook_security`, `get_symfony_webhook_security_stats`

Audits Symfony webhook handlers; warns on missing HMAC verification, `===` comparison (timing
attack — use `hash_equals()`), no replay protection (timestamp/nonce), raw body not read for
signing, no event type validation, null webhook secret in `webhook.yaml`.

---

### mercure

**Source:** `src/tools/mercure.ts`
**Functions:** `list_mercure_config`, `get_mercure_stats`

Hub config (URL masked, JWT presence/algorithm, public flag), `new Update(topics, data)` call
sites in `src/` with topic names and private flag. Reads `mercure.hubs` from
`config/packages/mercure.yaml`. Masks hub URLs and JWT secrets. Warns when no JWT secret is
configured.

---

### mailer

**Source:** `src/tools/mailer.ts`
**Functions:** `get_mailer_config`, `list_email_classes`, `list_email_templates`, `get_mailer_stats`

`MAILER_DSN` transport type, host, global headers; null-transport warning. Custom
`Email`/`TemplatedEmail` subclasses with template paths. Twig email templates in
`templates/emails/` and `templates/mail/`. Reads `.env`, `.env.local`, and
`config/packages/mailer.yaml`. Parses MAILER_DSN to detect transport type (SMTP, SendGrid,
Mailgun, SES, Postmark, Gmail, null). Credentials masked.

---

### symfony-mailer-transport

**Source:** `src/tools/symfony-mailer-transport.ts`
**Functions:** `list_mailer_transports`, `get_mailer_transport_stats`

Reads Mailer DSN from `config/packages/mailer.yaml` and `.env` files. Detects transport scheme
(smtp/mailgun/postmark/amazon-ses/null/test/failover/roundrobin). Masks credentials in output.
Warns: hardcoded credentials in DSN, `null://` in prod, smtp without TLS port.

---

### symfony-mailer-events

**Source:** `src/tools/symfony-mailer-events.ts`
**Functions:** `list_mailer_events`, `get_mailer_event_stats`

Scans `MessageEvent`/`SentMessageEvent`/`FailedMessageEvent` listeners. Reports send rejection
calls, header modifications, and listener priority. Classifies custom `TemplatedEmail`/`Email`/
`NotificationEmail` subclasses. Detects async Messenger routing for mailer transport. Warns
when no `FailedMessageEvent` handler is present.

---

### mailer-dkim-config

**Source:** `src/tools/mailer-dkim-config.ts`
**Functions:** `list_mailer_dkim_config`, `get_mailer_dkim_stats`

Reads mailer DSN(s) from `mailer.yaml`. Detects DKIM, Return-Path, envelope-sender. Warns on
missing DKIM, missing bounce address.

---

### symfony-mailer-attachments

**Source:** `src/tools/symfony-mailer-attachments.ts`
**Functions:** `list_mailer_attachments`, `get_mailer_attachment_stats`

Scans `attachFromPath()`/`attach()`/`embed()` calls; warns on missing `file_exists()` check,
`embed()` without `$cid` reference in template.

---

### symfony-mailer-dsn-analysis

**Source:** `src/tools/symfony-mailer-dsn-analysis.ts`
**Functions:** `list_mailer_dsn_config`, `get_mailer_dsn_config_stats`

Reads `mailer.yaml` / env vars for DSN; parses scheme (smtp/sendmail/null/api); warns on
`null://null` in non-test environments, missing TLS, SMTP without authentication, API transport
without API key env var.

---

### symfony-mailer-inliner

**Source:** `src/tools/symfony-mailer-inliner.ts`
**Functions:** `list_symfony_mailer_inliner`, `get_symfony_mailer_inliner_stats`

Detects CSS inliner usage in emails (`SymfonyCssInlinerExtension`, `CssInlinerPlugin`); warns
on emails with `<link rel="stylesheet">` not inlined, Twig email templates missing
`{# apply inline_css #}`.

---

### symfony-mailer-queuing

**Source:** `src/tools/symfony-mailer-queuing.ts`
**Functions:** `list_symfony_mailer_queuing`, `get_symfony_mailer_queuing_stats`

Analyzes Symfony Mailer + Messenger async queuing; warns on synchronous SMTP blocking requests,
email sent in controller without dispatch, bulk email loop, Messenger routing without
`failure_transport`, null/log transport in production.

---

### symfony-mailer-bounce-handling

**Source:** `src/tools/symfony-mailer-bounce-handling.ts`
**Functions:** `list_symfony_mailer_bounce_handling`, `get_symfony_mailer_bounce_handling_stats`

Bounce webhooks, `MessageListener`, VERP, missing bounce handling.

---

### symfony-mailer-html-to-text

**Source:** `src/tools/symfony-mailer-html-to-text.ts`
**Functions:** (Mailer HTML-to-text conversion)

Detects Symfony Mailer HTML-to-text conversion gaps: `TemplatedEmail`/`Email` without `text()`
or `textTemplate()` (missing plaintext fallback — spam filter risk); `HtmlToTextConverter` used
without `league/html-to-markdown` package; `inlineCSS()` called without CSS inliner installed.

---

### symfony-mailer-smtp-fallback

**Source:** `src/tools/symfony-mailer-smtp-fallback.ts`
**Functions:** (Mailer SMTP failover inspection)

Detects Symfony Mailer transport resilience issues: single transport DSN without `failover://`
or `roundrobin://` wrapper in production; old `failover+smtp://` syntax (use `failover(...)`);
insufficient transports in failover (only one listed); `roundrobin://` with fewer than 2
transports; `async` transport without sync fallback. Credentials masked in output.

---

### symfony-signed-url

**Source:** `src/tools/symfony-signed-url.ts`
**Functions:** `list_symfony_signed_url`, `get_symfony_signed_url_stats`

Analyzes signed URL and UriSigner usage; warns on URLs without expiry, missing `isValid()`
validation, hardcoded secrets, `login_link` without `max_uses` or `lifetime`.

---

### symfony-domain-events

**Source:** `src/tools/symfony-domain-events.ts`
**Functions:** `list_domain_events`, `get_domain_event_stats`

Detects domain event pattern: entities raising events via `recordEvent()`/`$this->domainEvents[]`,
event classes implementing marker interface; warns on domain events not dispatched (collected
but no dispatcher call), events raised in constructor, missing event recording in aggregate root.

---

### symfony-outbox-pattern

**Source:** `src/tools/symfony-outbox-pattern.ts`
**Functions:** `list_symfony_outbox_patterns`, `get_symfony_outbox_stats`

Detects transactional outbox pattern implementations; warns on domain events dispatched outside
transactions, missing outbox table in Doctrine schema, messenger bus dispatch inside entity
listeners.

---

### symfony-handle-trait

**Source:** `src/tools/symfony-handle-trait.ts`
**Functions:** `list_handle_trait_usage`, `get_handle_trait_stats`

Detects `HandleTrait` usage (`$this->handle()`); warns on `HandleTrait` used in controller
(anti-pattern, use `MessageBusInterface` directly), `handle()` called without catching
`HandlerFailedException`, multiple `HandleTrait` in same class.

---

### symfony-server-sent-events

**Source:** `src/tools/symfony-server-sent-events.ts`
**Functions:** `list_symfony_server_sent_events`, `get_symfony_server_sent_event_stats`

Detects `EventSourceResponse`, SSE controllers returning streaming responses; warns on SSE
without heartbeat, SSE without reconnection ID, SSE response without `Cache-Control: no-cache`.

---

### symfony-mailer-bounce

**Source:** `src/tools/symfony-mailer-bounce-handling.ts`
**Functions:** `list_symfony_mailer_bounce_handling`, `get_symfony_mailer_bounce_handling_stats`

Bounce webhooks, `MessageListener`, VERP, missing bounce handling.
