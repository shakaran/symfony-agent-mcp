# Category: serializer

Serializer, validation, forms, constraints, DTOs, normalizers, transformers.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### serializer-groups

**Source:** `src/tools/serializer-groups.ts`
**Functions:** `list_serializer_groups`, `get_serializer_group_stats`

All serialization groups with the classes/properties using them. Reads `#[Groups]` PHP 8
attributes plus YAML serialization metadata. Groups are counted: how many properties belong
to each, how many entities use it. Flags groups used only once (possible over-engineering)
and properties with no group (always serialized).

---

### symfony-serializer-context

**Source:** `src/tools/symfony-serializer-context.ts`
**Functions:** `list_serializer_contexts`, `get_serializer_context_stats`

Reads `#[Context]` attribute on entity properties and `AbstractNormalizer::GROUPS` /
`AbstractObjectNormalizer::SKIP_NULL_VALUES` / `AbstractNormalizer::OBJECT_TO_POPULATE` usage.
Detects missing `CIRCULAR_REFERENCE_HANDLER`, `MAX_DEPTH` without `ENABLE_MAX_DEPTH`, and
groups at call-site vs entity.

---

### symfony-serializer-groups

**Source:** `src/tools/symfony-serializer-groups.ts`
**Functions:** `list_symfony_serializer_groups`, `get_symfony_serializer_group_stats`

API Platform + Symfony serializer group analysis: reads `normalizationContext`/
`denormalizationContext` per operation; detects entities without groups (all fields exposed),
groups used in no operation, `write_groups` containing sensitive fields.

---

### symfony-serializer-circular-reference

**Source:** `src/tools/symfony-serializer-circular-reference.ts`
**Functions:** `list_serializer_circular_reference`, `get_serializer_circular_reference_stats`

Detects circular reference handling in serializer configuration: reads `circular_reference_handler`
from serializer config, detects `AbstractNormalizer::CIRCULAR_REFERENCE_HANDLER` context key,
bi-directional entity relations without `#[MaxDepth]` or exclusion groups.

---

### symfony-serializer-max-depth

**Source:** `src/tools/symfony-serializer-max-depth.ts`
**Functions:** `list_serializer_max_depth`, `get_serializer_max_depth_stats`

Reads `#[MaxDepth]` attribute usage and `enable_max_depth` context; warns on deeply nested
relations without `#[MaxDepth]`, `enable_max_depth` not set in context, large `#[MaxDepth]`
values causing deep serialization.

---

### symfony-serializer-name-converter

**Source:** `src/tools/symfony-serializer-name-converter.ts`
**Functions:** `list_serializer_name_converters`, `get_serializer_name_converter_stats`

Detects `CamelCaseToSnakeCaseNameConverter`, `MetadataAwareNameConverter`, custom
`NameConverterInterface`; warns on name converter configured but `#[SerializedName]` also
used (conflicts), converter not applied to all normalizers.

---

### symfony-serializer-discriminator

**Source:** `src/tools/symfony-serializer-discriminator.ts`
**Functions:** `list_serializer_discriminator`, `get_serializer_discriminator_stats`

Reads `#[DiscriminatorMap]` on base classes. Detects subclasses missing from map, duplicate
type values, invalid subclass mapping.

---

### symfony-serializer-denormalization

**Source:** `src/tools/symfony-serializer-denormalization.ts`
**Functions:** `list_serializer_denormalization`, `get_serializer_denormalization_stats`

`OBJECT_TO_POPULATE`, `IGNORED_ATTRIBUTES`, `AbstractNormalizer::CONSTRUCTOR_ARGUMENTS`,
missing DTO constructor.

---

### symfony-serializer-encoders

**Source:** `src/tools/symfony-serializer-encoders.ts`
**Functions:** `list_serializer_encoders`, `get_serializer_encoder_stats`

Detects registered `EncoderInterface`/`DecoderInterface` implementations; warns on duplicate
formats, encoders not tagged as `serializer.encoder`.

---

### symfony-serializer-transform

**Source:** `src/tools/symfony-serializer-transform.ts`
**Functions:** `list_serializer_transform`, `get_serializer_transform_stats`

Detects `AbstractNormalizer::FILTER_BOOL_VALUES`, `TransformingNormalizerInterface`,
`DataTransformerInterface`; warns on data transformers not registered as services.

---

### symfony-object-mapper

**Source:** `src/tools/symfony-object-mapper.ts`
**Functions:** `list_object_mapper`, `get_object_mapper_stats`

Symfony 7.1 `ObjectMapper` component: `#[Map]`, `#[MapFrom]`, `#[MapTo]`, `MapperInterface`.

---

### symfony-var-exporter

**Source:** `src/tools/symfony-var-exporter.ts`
**Functions:** `list_var_exporter_usage`, `get_var_exporter_stats`

Reads PHP classes using `VarExporter::export()`, `Hydrator`, `LazyProxyTrait`; warns on
export of objects with closures or resources.

---

### symfony-mime-parts

**Source:** `src/tools/symfony-mime-parts.ts`
**Functions:** `list_mime_parts`, `get_mime_part_stats`

Scans `MimeMessage`, `AbstractPart`, `TextPart`, `DataPart`, `FormDataPart` usage;
warns on `DataPart::fromPath()` without `file_exists()` check.

---

### symfony-mime-message-headers

**Source:** `src/tools/symfony-mime-message-headers.ts`
**Functions:** `list_mime_message_headers`, `get_mime_message_header_stats`

Detects MIME message header manipulation: `HeaderSet::addTextHeader()`, `addDateHeader()`,
`addIdHeader()`; warns on custom `Message-ID` without proper domain suffix, `Date` header set
to future date, non-RFC-5322 header names.

---

### symfony-mime-types

**Source:** `src/tools/symfony-mime-types.ts`
**Functions:** `list_mime_types`, `get_mime_type_stats`

Detects `MimeTypes::getDefault()` usage and `guessMimeType()` call sites; warns on
file-extension guessing without magic bytes fallback, MIME type used for file security
decisions without content validation.

---

### symfony-string-slugger

**Source:** `src/tools/symfony-string-slugger.ts`
**Functions:** `list_string_slugger_usage`, `get_string_slugger_stats`

Scans for `SluggerInterface` injection and `->slug()` call sites; warns on non-ASCII input
without `AsciiSlugger`, slug used as URL path without url-encoding, `->slug()` without locale.

---

### symfony-html-sanitizer

**Source:** `src/tools/symfony-html-sanitizer.ts`
**Functions:** `list_html_sanitizer`, `get_html_sanitizer_stats`

Reads `html_sanitizer.yaml` sanitizer configs (allowed elements, allowed attributes, custom
extensions). Scans PHP for `HtmlSanitizerInterface::sanitize()` calls. Warns: `sanitizeFor()`
not used, `*` wildcard in allowed elements, allowed `<script>`/`<object>`/`<embed>` tags,
`allow_safe_elements` without custom restrictions.

---

### symfony-property-info

**Source:** `src/tools/symfony-property-info.ts`
**Functions:** `list_property_info`, `get_property_info_stats`

Detects PropertyInfo extractors registered (PhpDoc, PhpStan, Reflection, Doctrine,
Serializer), `PropertyInfoExtractorInterface` usage; warns on missing TypeInfo extractor for
union types, accessing property metadata without extractor cache.

---

### symfony-property-access

**Source:** `src/tools/symfony-property-access.ts`
**Functions:** `list_property_access_usage`, `get_property_access_stats`

Scans for `PropertyAccessor::getValue()`/`setValue()`, `PropertyPath` instantiation; warns on
`->getValue()` without `isReadable()` guard, `->setValue()` without `isWritable()` guard,
`PropertyPath` in hot loop without caching.

---

### symfony-json-encoder

**Source:** `src/tools/symfony-json-encoder.ts`
**Functions:** `list_symfony_json_encoder`, `get_symfony_json_encoder_stats`

Symfony 7.1 `JsonEncoder` (not `json_encode`): `#[Encodable]`, `#[EncodedName]`, type hooks,
stream support.

---

### input-dtos

**Source:** `src/tools/input-dtos.ts`
**Functions:** `list_input_dtos`, `get_input_dto_stats`

Classes in `src/Dto/` or with `Dto` suffix: constructor property types, validation constraints,
API Platform `input:` binding. Warns: DTOs with no validation constraints, DTOs bound to
multiple operations with conflicting groups.

---

### validation

**Source:** `src/tools/validation.ts`
**Functions:** `list_constraints`, `get_validation_stats`

All constraint usages via PHP attributes (`#[Assert\*]`) and config YAML in `config/validator/`;
includes constraint class, target property/class, groups. Detects custom
`ConstraintValidatorInterface` implementations. Warns on `Callback` constraints (hard to test),
entities with no constraints at all.

---

### symfony-validator-cascade

**Source:** `src/tools/symfony-validator-cascade.ts`
**Functions:** `list_validator_cascade`, `get_validator_cascade_stats`

Reads `#[Valid]` usage; warns on cascade on nullable relations (NullPointerException risk),
cascade without groups, missing `#[Valid]` on API Platform write DTOs.

---

### symfony-validator-group-sequence

**Source:** `src/tools/symfony-validator-group-sequence.ts`
**Functions:** `list_validator_group_sequences`, `get_validator_group_sequence_stats`

Reads `#[GroupSequence]` attributes and `GroupSequenceProviderInterface`; warns on group
sequences not including `Default`, circular group dependencies, unused groups in sequence.

---

### symfony-validator-expression

**Source:** `src/tools/symfony-validator-expression.ts`
**Functions:** `list_validator_expression_constraints`, `get_validator_expression_stats`

Scans `#[Assert\Expression]` usage; warns on expressions using `this.` instead of `this`
(invalid PHP), expression without `message` property, complex expression better replaced with
custom constraint.

---

### symfony-validator-unique-entity

**Source:** `src/tools/symfony-validator-unique-entity.ts`
**Functions:** (UniqueEntity constraint analysis)

Detects `#[UniqueEntity]` constraints in entities; warns on `UniqueEntity` on fields without
DB `unique: true` index (inconsistent guarantee), `repositoryMethod` pointing to non-existent
method, `UniqueEntity` on `nullable: true` field without `ignoreNull: false`.

---

### symfony-validator-payload

**Source:** `src/tools/symfony-validator-payload.ts`
**Functions:** `list_validator_payload_usage`, `get_validator_payload_stats`

Reads `payload:` parameter in `#[Assert\*]` constraints; warns on payload used for severity
levels with no corresponding UI handling, missing payload on `ConstraintViolation` checks.

---

### symfony-validator-sequence-provider

**Source:** `src/tools/symfony-validator-sequence-provider.ts`
**Functions:** `list_validator_sequence_providers`, `get_validator_sequence_provider_stats`

Detects `GroupSequenceProviderInterface` implementations; warns on `getGroupSequence()` not
returning `GroupSequence` instance, provider on entity without `#[GroupSequenceProvider]`
attribute.

---

### symfony-validator-auto-mapping

**Source:** `src/tools/symfony-validator-auto-mapping.ts`
**Functions:** `list_validator_auto_mapping`, `get_validator_auto_mapping_stats`

Reads `framework.validation.auto_mapping` config; warns on auto-mapping without manual review,
conflicting manual + auto constraints, auto-mapping on abstract classes.

---

### symfony-custom-constraints

**Source:** `src/tools/symfony-custom-constraints.ts`
**Functions:** `list_custom_constraints`, `get_custom_constraint_stats`

Detects custom `Constraint` + `ConstraintValidator` pairs; warns on validator not tagged
`validator.constraint_validator`, missing `validatedBy()`, constructor injections in validator
(not recommended — use `ConstraintValidatorFactory`).

---

### symfony-constraint-validator-tests

**Source:** `src/tools/symfony-constraint-validator-tests.ts`
**Functions:** `list_constraint_validator_tests`, `get_constraint_validator_test_stats`

Reads `ConstraintValidatorTestCase` subclasses; warns on validators without test coverage,
tests that mock the validator instead of using the test case.

---

### symfony-compound-constraints

**Source:** `src/tools/symfony-compound-constraints.ts`
**Functions:** `list_compound_constraints`, `get_compound_constraint_stats`

Detects `Compound` constraint subclasses; reads `getConstraints()` return values; warns on
`Compound` with a single constraint (use original directly), nested `Compound` (hard to debug).

---

### forms

**Source:** `src/tools/forms.ts`
**Functions:** `list_form_types`, `get_form_type_stats`

All classes extending `AbstractType` with `configureOptions` (data class, validation groups)
and registered fields via `buildForm` (field types, options, constraints). Reads `src/Form/`.
Detects compound types (at least one `FormType`-field child), detects custom `TypeExtension`
classes, and flags types without any constraints on the `data_class`.

---

### symfony-form-events

**Source:** `src/tools/symfony-form-events.ts`
**Functions:** `list_form_events`, `get_form_event_stats`

Detects `FormEvents::PRE_SET_DATA`, `POST_SET_DATA`, `PRE_SUBMIT`, `SUBMIT`, `POST_SUBMIT`
listeners; warns on `POST_SUBMIT` modifying form data (too late), `PRE_SUBMIT` data cast
missing, missing `$event->setData()` after transformation.

---

### symfony-form-pre-set-data

**Source:** `src/tools/symfony-form-pre-set-data.ts`
**Functions:** (form PRE_SET_DATA analysis)

Detects `FormEvents::PRE_SET_DATA` listeners that conditionally add/remove fields; warns on
`PRE_SET_DATA` without null check on `$event->getData()` (initial form render has null data),
adding fields with wrong type (type mismatch with entity), `$form->add()` call missing
`auto_initialize: false` in nested forms.

---

### symfony-form-type-extensions

**Source:** `src/tools/symfony-form-type-extensions.ts`
**Functions:** `list_form_type_extensions`, `get_form_type_extension_stats`

Detects `AbstractTypeExtension` subclasses; reads `getExtendedTypes()` targets; warns on
extension targeting too many types (`FormType::class` catch-all performance), missing `static`
on `getExtendedTypes()`, extension with empty `configureOptions()`.

---

### symfony-form-data-mapper

**Source:** `src/tools/symfony-form-data-mapper.ts`
**Functions:** `list_form_data_mappers`, `get_form_data_mapper_stats`

Detects `DataMapperInterface` implementations; warns on mapper without `mapFormsToData()` or
`mapDataToForms()`, mapper with hard-coded property names (use `PropertyPath`), missing null
check for empty data.

---

### symfony-form-choice-loaders

**Source:** `src/tools/symfony-form-choice-loaders.ts`
**Functions:** `list_form_choice_loaders`, `get_form_choice_loader_stats`

Detects `ChoiceLoaderInterface` implementations: `loadChoiceList()`, `loadChoicesForValues()`,
`loadValuesForChoices()`. Warns on `loadChoiceList()` querying DB without cache, choice value
not unique, loader not implementing `AbstractChoiceLoader`.

---

### symfony-form-transformers

**Source:** `src/tools/symfony-form-transformers.ts`
**Functions:** `list_form_transformers`, `get_form_transformer_stats`

Detects `DataTransformerInterface` implementations; warns on `reverseTransform()` not throwing
`TransformationFailedException` on invalid input, `transform()` that can return `null`
(conflicts with required field).

---

### symfony-form-compound-types

**Source:** `src/tools/symfony-form-compound-types.ts`
**Functions:** `list_symfony_form_compound_types`, `get_symfony_form_compound_types_stats`

Detects compound form types (contains child types); warns on compound type without `data_class`,
all-inherited fields (use inheritance instead), missing `inheritData: true` for embedded forms.

---

### symfony-form-collections

**Source:** `src/tools/symfony-form-collections.ts`
**Functions:** `list_form_collections`, `get_form_collection_stats`

Detects `CollectionType` form fields: `allow_add`, `allow_delete`, `entry_type`. Warns on
collection without `by_reference: false` (mutation silently ignored), `allow_add` without
`allow_delete` (orphan rows), collection with no delete button in template.

---

### symfony-form-honeypot

**Source:** `src/tools/symfony-form-honeypot.ts`
**Functions:** `list_form_honeypot`, `get_form_honeypot_stats`

Detects anti-bot honeypot patterns: `HoneypotType`, hidden fields named `email`/`phone`/
`name`/`website`, `EWZRecaptchaBundle`, `friendsofsymfony/captcha-bundle`; warns on public
forms without any CAPTCHA or honeypot protection.

---

### symfony-form-choice-value

**Source:** `src/tools/symfony-form-choice-value.ts`
**Functions:** `list_form_choice_values`, `get_form_choice_value_stats`

Detects `choice_value` option in `ChoiceType`/`EntityType` fields; warns on choice value using
auto-increment ID (fragile to data migrations), choice value returning object (serialization
error), missing `choice_value` on `EntityType` (Doctrine default may change).

---

### symfony-controller-map-payload

**Source:** `src/tools/symfony-controller-map-payload.ts`
**Functions:** `list_map_request_payload`, `get_map_request_payload_stats`

Scans `#[MapRequestPayload]`/`#[MapQueryParameter]` on controller arguments; warns on using
`MapRequestPayload` without validation groups, using it on non-DTO types, missing `type:`
in `MapQueryParameter`.

---

### symfony-value-resolver

**Source:** `src/tools/symfony-value-resolver.ts`
**Functions:** `list_value_resolvers`, `get_value_resolver_stats`

Reads `ValueResolverInterface`/`ArgumentValueResolverInterface` implementations; warns on
resolvers not tagged `controller.argument_value_resolver`, missing `supports()` method,
resolver making DB query (should be cached).

---

### symfony-request-mapping

**Source:** `src/tools/symfony-request-mapping.ts`
**Functions:** `list_request_mappings`, `get_request_mapping_stats`

Scans `#[MapQueryString]`, `#[MapRequestPayload]`, `#[MapQueryParameter]` usage; warns on
missing `type:` declaration, using request mapping on GET with body, nested DTOs without
`#[Assert\Valid]`.

---

### symfony-options-resolver

**Source:** `src/tools/symfony-options-resolver.ts`
**Functions:** `list_options_resolver_usage`, `get_options_resolver_stats`

Detects `OptionsResolver` instances; reads `defineOptions()`, `setRequired()`, `setAllowed*()`,
`setDefault()`, `setNormalizer()`; warns on no `setAllowedTypes()` or `setAllowedValues()` for
any option, `setDefault()` before `setRequired()` (shadows required), resolver instantiated
per-call instead of cached.

---

### symfony-type-info

**Source:** `src/tools/symfony-type-info.ts`
**Functions:** `list_symfony_type_info`, `get_symfony_type_info_stats`

Symfony 7.1 TypeInfo component: `Type::builtin()`, `Type::union()`, `TypeFactoryTrait`, type
resolvers.
