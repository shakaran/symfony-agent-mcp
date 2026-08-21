# Category: api

API tools — API Platform, OpenAPI, GraphQL, REST patterns, versioning, rate limits, Nelmio.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### api-platform

**Source:** `src/tools/api-platform.ts`
**Functions:** `list_api_resources`, `get_api_resource_details`, `get_api_platform_stats`

All `#[ApiResource]` classes with operations, groups, filters, security. Full resource: per-operation
groups, paths, guards, pagination. Scans `src/Entity/`, `src/ApiResource/`, `src/Dto/`, `src/Model/`.
Parses PHP 8 attributes: `#[ApiResource]`, `#[Get]`, `#[Post]`, `#[Put]`, `#[Patch]`, `#[Delete]`,
`#[GetCollection]`, `#[ApiFilter]`. Also reads `config/packages/api_platform.yaml` for global config.

---

### openapi

**Source:** `src/tools/openapi.ts`
**Functions:** `list_openapi_config`, `get_openapi_stats`

Detects NelmioApiDocBundle from `config/packages/nelmio_api_doc.yaml`: areas, Swagger UI path,
security schemes. Scans `src/` for `#[OA\Get]`/`#[OA\Post]`/… on controllers, `#[OA\Schema]`/
`#[OA\Property]` on DTOs, `#[OA\Tag]` groupings. Flags controllers with HTTP verbs but missing
`#[OA\Response]` (incomplete documentation).

---

### nelmio-api-doc

**Source:** `src/tools/nelmio-api-doc.ts`
**Functions:** `list_nelmio_config`, `get_nelmio_stats`

Reads `nelmio_api_doc.yaml`: areas (name, path/host patterns), cache flag. Scans PHP source for
`#[OA\...]` attributes counting annotated files. Detects missing `OA\Info`, security scheme
definitions, and controllers without a 404 response annotation.

---

### graphql

**Source:** `src/tools/graphql.ts`
**Functions:** `list_graphql_config`, `get_graphql_stats`

Loads OverblogGraphQLBundle type definitions from `config/graphql/types/*.yaml`: Query/Mutation/
Subscription/Object/Input/Enum/Union/Interface types with field counts and deprecated-field
detection (`deprecationReason`). Detects API Platform GraphQL layer (`api_platform.graphql.enabled`
or `webonyx/graphql-php` in composer). Scans `src/` for resolver classes implementing
`QueryInterface`, `MutationInterface`, `ResolverInterface`, `TypeConfigDecoratorInterface`, or
using `#[GQL\*]` attributes.

---

### api-versioning

**Source:** `src/tools/api-versioning.ts`
**Functions:** `list_api_versions`, `get_api_version_stats`

Detects URL-prefix versioning (`/v1/`, `/v2/` in `#[Route]` attributes and YAML routes),
versioned serializer groups (`v1:read`, `v2:write`), FOSRestBundle versioning config. Gap
analysis: warns when an older version has more endpoints than the latest (incomplete migration).

---

### api-platform-filters

**Source:** `src/tools/api-platform-filters.ts`
**Functions:** `list_api_platform_filters`, `get_api_platform_filter_stats`

Scans `#[ApiFilter]` declarations per entity: SearchFilter, OrderFilter, DateFilter,
RangeFilter, BooleanFilter, ExistsFilter, NumericFilter, PropertyFilter. Extracts properties
and strategy. Scans custom `AbstractFilter` / `AbstractContextAwareFilter` subclasses.

---

### api-platform-security

**Source:** `src/tools/api-platform-security.ts`
**Functions:** `list_api_platform_security`, `get_api_platform_security_stats`

Security audit of API Platform resources: `#[Get]` / `#[Post]` / `#[Put]` / `#[Patch]` /
`#[Delete]` without `security` or `securityPostDenormalize`, unsecured write operations, public
DELETE warning, POST without `securityPostDenormalize` (owner check on new resource), missing
`normalizationContext` (all fields serialized), sensitive field names in normalization groups.

---

### api-platform-state

**Source:** `src/tools/api-platform-state.ts`
**Functions:** `list_api_state_providers`, `get_api_state_stats`

Scans `ProviderInterface` and `ProcessorInterface` implementations (API Platform 3 state layer).
Detects `#[AsDecorator]` decorators, resource binding, pagination/flush/mailer flags, and
deprecated AP v2 `DataProviderInterface`/`DataPersisterInterface` style.

---

### api-platform-state-processors

**Source:** `src/tools/api-platform-state-processors.ts`
**Functions:** `list_api_platform_state_processors`, `get_api_platform_state_processor_stats`

Detects API Platform `ProcessorInterface` implementations. Checks persist/flush/remove
operations, transaction management. Warns on persist without flush and missing `process()` method.

---

### api-platform-operations

**Source:** `src/tools/api-platform-operations.ts`
**Functions:** `list_api_operations`, `get_api_operation_stats`

Per-resource operation analysis: Get/Post/Patch/Delete/GetCollection, security expression,
normalizationContext groups, input/output classes. Warns: write ops without security.

---

### api-platform-pagination

**Source:** `src/tools/api-platform-pagination.ts`
**Functions:** `list_api_pagination`, `get_api_pagination_stats`

Reads API Platform pagination config: `pagination_enabled`, `pagination_items_per_page`,
`pagination_maximum_items_per_page`, `pagination_client_enabled`, cursor-based pagination.
Per-resource overrides via `#[ApiResource(paginationEnabled:...)]`. Warns: unlimited page size,
client-controlled page size without maximum, cursor pagination on non-ordered collections.

---

### api-platform-serialization-context

**Source:** `src/tools/api-platform-serialization-context.ts`
**Functions:** `list_api_platform_serialization_contexts`, `get_api_platform_serialization_context_stats`

Reads `normalizationContext`/`denormalizationContext` per operation. Warns on missing groups
(all-properties serialized/writable risk).

---

### api-platform-validation-context

**Source:** `src/tools/api-platform-validation-context.ts`
**Functions:** `list_api_platform_validation_contexts`, `get_api_platform_validation_context_stats`

Reads per-operation `validationContext` groups. Warns on write operations (Post/Put/Patch)
without validation groups.

---

### api-platform-resource-metadata

**Source:** `src/tools/api-platform-resource-metadata.ts`
**Functions:** `list_api_platform_resource_metadata`, `get_api_platform_resource_metadata_stats`

Reads `shortName`, `description`, JSON-LD `types`, `uriTemplate` from `#[ApiResource]`.
Warns on missing description and non-prefixed IRI types.

---

### api-platform-query-extensions

**Source:** `src/tools/api-platform-query-extensions.ts`
**Functions:** `list_api_query_extensions`, `get_api_query_extension_stats`

Detects `QueryCollectionExtensionInterface`/`QueryItemExtensionInterface`, resourceClass check,
`applyToCollection`/`applyToItem`.

---

### api-platform-custom-normalizers

**Source:** `src/tools/api-platform-custom-normalizers.ts`
**Functions:** `list_api_custom_normalizers`, `get_api_custom_normalizer_stats`

Detects `NormalizerInterface`/`DenormalizerInterface`, `supportsNormalization`, `getSupportedTypes`
cache.

---

### api-platform-iri-converter

**Source:** `src/tools/api-platform-iri-converter.ts`
**Functions:** `list_api_iri_converter`, `get_api_iri_converter_stats`

Detects `IriConverterInterface` implementations, `getIriFromResource`/`getResourceFromIri`,
`uriTemplate`.

---

### api-platform-subresources

**Source:** `src/tools/api-platform-subresources.ts`
**Functions:** `list_api_subresources`, `get_api_subresource_stats`

Detects multi-variable `uriTemplate` patterns, deprecated `@ApiSubresource`, state provider
presence.

---

### api-platform-dto-output

**Source:** `src/tools/api-platform-dto-output.ts`
**Functions:** `list_api_dto_output`, `get_api_dto_output_stats`

Detects `output:` DTO classes in `#[ApiResource]`, `OutputDataTransformerInterface`,
`output:false` with normalization_context warning.

---

### api-platform-error-handling

**Source:** `src/tools/api-platform-error-handling.ts`
**Functions:** `list_api_platform_error_handling`, `get_api_platform_error_handling_stats`

Reads `error_formats`/`exception_to_status` from `api_platform.yaml`. Scans for custom
`ErrorNormalizerInterface`. Warns on HTML format (exposes stack traces), 5xx mappings.

---

### api-platform-openapi-context

**Source:** `src/tools/api-platform-openapi-context.ts`
**Functions:** `list_api_open_api_context`, `get_api_open_api_context_stats`

Scans `#[ApiProperty]` for `openapi_context`/`schema`: description, deprecated, example, enum.
Warns on missing description, deprecated without reason.

---

### api-platform-mercure-push

**Source:** `src/tools/api-platform-mercure-push.ts`
**Functions:** `list_mercure_push_config`, `get_mercure_push_stats`

Detects `#[ApiResource(mercure: true)]` and `mercure: ['private' => true]` on resources. Scans
for `HubInterface::publish()` calls. Reads hub URL from `api_platform.yaml`/`.env`. Warns:
mercure enabled without hub configured, private topics without JWT config, static topic string,
`publish()` without try/catch.

---

### api-platform-security-expressions

**Source:** `src/tools/api-platform-security-expressions.ts`
**Functions:** `list_api_security_expressions`, `get_api_security_expression_stats`

Reads `security:`/`securityPostDenormalize:` expressions from `#[ApiResource]`. Detects
`is_granted`/`user`/`object`/`previous_object` usage. Warns on `PUBLIC_ACCESS`, write-without-user.

---

### fos-rest-bundle

**Source:** `src/tools/fos-rest-bundle.ts`
**Functions:** (FOSRest bundle inspection)

Detects FOSRestBundle configuration: missing `body_listener` for automatic request body
deserialization, `routing_loader.include_format` set to `true` without format negotiation,
missing `view.view_response_listener` causing inconsistent response wrapping, `exception.codes`
mapping gaps for common HTTP status codes.

---

### api-hateoas

**Source:** `src/tools/api-hateoas.ts`
**Functions:** `list_api_hateoas`, `get_api_hateoas_stats`

Analyzes API HATEOAS hypermedia link implementation; warns on API controllers without `_links`,
collection endpoints without pagination links, API Platform resources without self link in
serialization groups.

---

### api-problem-details

**Source:** `src/tools/api-problem-details.ts`
**Functions:** `list_api_problem_details`, `get_api_problem_details_stats`

Detects RFC 7807 Problem Details usage (`application/problem+json`); warns on missing `type`
field, wrong `Content-Type`, contradictory HTTP/body status codes, stack trace in response body.

---

### api-json-ld-context

**Source:** `src/tools/api-json-ld-context.ts`
**Functions:** `list_api_json_ld_context`, `get_api_json_ld_context_stats`

Detects JSON-LD `@context` patterns in API Platform resources; warns on `ApiResource` without
IRI types, HTTP schema.org IRIs (use HTTPS), missing `@vocab`, invalid `.jsonld` context files.

---

### api-idempotency

**Source:** `src/tools/api-idempotency.ts`
**Functions:** `list_api_idempotency`, `get_api_idempotency_stats`

Detects idempotency key handling (`Idempotency-Key` header); warns on key stored but not
replayed, storage without TTL, empty key not validated, idempotency key on GET requests.

---

### api-openapi-security-schemes

**Source:** `src/tools/api-openapi-security-schemes.ts`
**Functions:** `list_api_open_api_security_schemes`, `get_api_open_api_security_schemes_stats`

Analyzes OpenAPI security scheme definitions in `nelmio_api_doc.yaml`; warns on ApiKey in
query parameter (log leakage), OAuth2 implicit flow (deprecated), missing `bearerFormat`,
`openIdConnect` without discovery URL.

---

### api-cursor-pagination

**Source:** `src/tools/api-cursor-pagination.ts`
**Functions:** `list_api_cursor_pagination`, `get_api_cursor_pagination_stats`

Analyzes API pagination implementation; warns on offset pagination with expensive COUNT, high
OFFSET performance degradation, cursor without encoding, one-directional cursor, API Platform
without max items per page.

---

### api-jsonapi-format

**Source:** `src/tools/api-jsonapi-format.ts`
**Functions:** `list_api_jsonapi_format`, `get_api_jsonapi_format_stats`

JSON:API format config, content-type, pagination, error structure.

---

### api-graphql-security

**Source:** `src/tools/api-graphql-security.ts`
**Functions:** `list_api_graphql_security`, `get_api_graphql_security_stats`

Introspection in prod, depth/complexity limits, N+1 resolvers, mutation auth.

---

### api-response-compression

**Source:** `src/tools/api-response-compression.ts`
**Functions:** `list_api_response_compression`, `get_api_response_compression_stats`

gzip/brotli config, `gzip_min_length`, binary format exclusion, `Vary` header.

---

### api-contract-testing

**Source:** `src/tools/api-contract-testing.ts`
**Functions:** `list_api_contract_testing`, `get_api_contract_testing_stats`

Pact consumer/provider setup, broker config, CI verification.
