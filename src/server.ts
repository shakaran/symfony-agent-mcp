#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * MCP Server Implementation
 * Model Context Protocol server for Symfony applications
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { getRouteTools, listRoutes, getRouteDetails, searchRoutesCommand, listHttpMethods } from './tools/routes.js';
import { getServiceTools, listServices, getServiceDetails, searchServicesCommand, listServicesByTag, listAvailableTags } from './tools/services.js';
import { getConfigTools, getAppEnvironment, listEnvironmentVariables, getDatabaseConfig, getServicesConfig, getFrameworkConfig, getSecurityConfig, listConfigPackages } from './tools/config.js';
import { getLogTools, listLogs, tailLog, searchLog, getErrorSummary, getEnvironmentLogs } from './tools/logs.js';
import { getEntityTools, listEntities, getEntityDetails, searchEntities, getRelatedEntities, getEntitiesStats } from './tools/entities.js';
import { getDatabaseTools, listTables, getTableSchema, getDatabaseInfo, searchTables, validateSchemaMapping, getMigrationStatus } from './tools/database.js';
import { getControllerTools, listControllers, getControllerActions, searchControllers } from './tools/controllers.js';
import { getComposerTools, getComposerInfo, getInstalledPackages, getSymfonyVersion } from './tools/composer.js';
import { getMessengerTools, getMessengerInfo, listMessengerTransports, listMessengerRouting, listMessageClasses } from './tools/messenger.js';
import { getFormTools, listFormTypes, getFormTypeDetails, searchFormTypes, getFormStats } from './tools/forms.js';
import { getProfilerTools, listProfilerRequests, getProfilerDetails, getProfilerQueries, getProfilerStats } from './tools/profiler.js';
import { getCacheInspectorTools, inspectSymfonyCache, getCacheConfig, inspectMcpCache, clearMcpCache } from './tools/cache-inspector.js';
import { getEventTools, listEventListeners, getEventListenersByEvent, getEventStats } from './tools/events.js';
import { getCommandTools, listCommands, getCommandDetails, searchCommands } from './tools/commands.js';
import { getTwigTools, listTemplates, getTemplateDetails, getTemplateInheritanceTree, searchTemplates } from './tools/twig.js';
import { getTranslationTools, listTranslationFiles, findMissingTranslations, searchTranslations, getTranslationStats } from './tools/translations.js';
import { getWorkflowTools, listWorkflows, getWorkflowDetails, getWorkflowStats } from './tools/workflow.js';
import { getTestInspectorTools, listTestClasses, getTestCoverageMap, getTestStats } from './tools/tests-inspector.js';
import { getEnvDiffTools, listEnvFiles, diffEnvFiles, findSensitiveEnvKeys, getEnvStats } from './tools/env-diff.js';
import { getDeadCodeTools, detectDeadCode, detectOrphanControllersOnly, detectUnusedFormTypesOnly } from './tools/dead-code.js';
import { getApiPlatformTools, listApiResources, getApiResourceDetails, getApiPlatformStats } from './tools/api-platform.js';
import { getSerializerTools, listSerializerGroups, getClassSerializerProfile, searchSerializerGroups, getSerializerStats } from './tools/serializer.js';
import { getSecurityVoterTools, getRoleHierarchy, listSecurityVoters, getAccessControlMatrix, listFirewalls } from './tools/security-voters.js';
import { getRepositoryAnalyzerTools, listRepositories, getRepositoryDetails, detectNPlusOne, getRepositoryStats } from './tools/repository-analyzer.js';
import { getMailerTools, getMailerConfig, listEmailClasses, listEmailTemplates, getMailerStats } from './tools/mailer.js';
import { getBundleTools, listBundles, getBundleStats } from './tools/bundles.js';
import { getDoctrineLifecycleTools, listEntityLifecycles, getLifecycleByEvent, getLifecycleStats } from './tools/doctrine-lifecycle.js';
import { getHttpClientTools, listHttpClients, listHttpClientUsage, getHttpClientStats } from './tools/http-client.js';
import { getSchedulerTools, listScheduledTasks, getSchedulerStats } from './tools/scheduler.js';
import { getDiParameterTools, listDiParameters, searchDiParameters, getDiParameterStats } from './tools/di-parameters.js';
import { getNotifierTools, listNotifierTransports, listNotifications, getNotifierStats } from './tools/notifier.js';
import { getRateLimiterTools, listRateLimiters, getRateLimiterUsage, getRateLimiterStats } from './tools/rate-limiter.js';
import { getDependencyGraphTools, analyzeDependencyGraph, detectCircularDependencies, getDependencyGraphStats } from './tools/dependency-graph.js';
import { getAssetMapperTools, listAssetPipeline, listStimulusControllers, getAssetStats } from './tools/asset-mapper.js';
import { getSecurityScannerTools, scanSecurityIssues, getSecurityScanStats } from './tools/security-scanner.js';
import { getDoctrineEmbeddableTools, listEmbeddables, getEmbeddableStats } from './tools/doctrine-embeddable.js';
import { getCodeQualityTools, getCodeQualityReport, getGodClasses, getCodeQualityStats } from './tools/code-quality.js';
import { getSymfonyUxTools, listUxComponents, getUxStats } from './tools/symfony-ux.js';
import { getDoctrineExtensionTools, listDoctrineExtensions, getDoctrineExtensionStats } from './tools/doctrine-extensions.js';
import { getJwtAuthTools, getJwtConfig, getAuthStats } from './tools/jwt-auth.js';
import { getTwigExtensionTools, listTwigExtensions, getTwigExtensionStats } from './tools/twig-extensions.js';
import { getServiceDecoratorTools, listServiceDecorators, getDecoratorStats } from './tools/service-decorators.js';
import { getMigrationAnalysisTools, analyzeMigrations, getDestructiveMigrations, getMigrationAnalysisStats } from './tools/migrations-analysis.js';
import { getValidationTools, listValidationConstraints, getValidationStats } from './tools/validation.js';
import { getFixtureTools, listFixtures, getFixtureStats } from './tools/fixtures.js';
import { getSecretsVaultTools, listSecretsVault, getSecretsVaultStats } from './tools/secrets-vault.js';
import { getHttpCacheTools, listHttpCacheConfig, getHttpCacheStats } from './tools/http-cache.js';
import { getStaticAnalysisTools, getStaticAnalysisConfig, getStaticAnalysisStats } from './tools/static-analysis.js';
import { getCorsTools, listCorsConfig, getCorsStats } from './tools/cors.js';
import { getLockTools, listLockConfig, getLockStats } from './tools/lock.js';
import { getEnvConfigDiffTools, listEnvConfigDiff, getEnvConfigDiffStats } from './tools/env-config-diff.js';
import { getDoctrineSlcTools, listDoctrineSlc, getDoctrineSlcStats } from './tools/doctrine-slc.js';
import { getMessengerMiddlewareTools, listMessengerMiddleware, getMessengerMiddlewareStats } from './tools/messenger-middleware.js';
import { getMonologTools, listMonologConfig, getMonologStats } from './tools/monolog.js';
import { getDoctrineTypeTools, listDoctrineTypes, getDoctrineTypeStats } from './tools/doctrine-types.js';
import { getWebhookTools, listWebhooks, getWebhookStats } from './tools/webhooks.js';
import { getInputDtoTools, listInputDtos, getInputDtoStats } from './tools/input-dto.js';
import { getMercureTools, listMercureConfig, getMercureStats } from './tools/mercure.js';
import { getControllerSecurityTools, auditControllerSecurity, getControllerSecurityStats } from './tools/controller-security.js';
import { getPhpUnitConfigTools, listPhpUnitConfig, getPhpUnitStats } from './tools/phpunit-config.js';
import { getDoctrineOrmConfigTools, listDoctrineOrmConfig, getDoctrineOrmStats } from './tools/doctrine-orm-config.js';
import { getCompilerPassTools, listCompilerPasses, getCompilerPassStats } from './tools/compiler-passes.js';
import { getMessengerHandlerTools, listMessengerHandlers, getMessengerHandlerStats } from './tools/messenger-handlers.js';

import { withAudit, getAuditLogPath } from './utils/audit-logger.js';
import { checkRateLimit } from './utils/rate-limiter.js';
import { guardAppPath } from './utils/app-guard.js';
import { verifyRequest } from './utils/request-signer.js';
import { verifySessionToken, emitTokenInstructions, getTokenStatus } from './utils/session-token.js';
import { startHttpTransport } from './transport/http-transport.js';
import { checkAnomaly, recordAuthFailure, recordRateLimitBlock, recordToolError } from './utils/anomaly-detector.js';
import { incToolCall, incRateLimitHit, incAuthFailure, incPathGuardBlock } from './utils/security-metrics.js';
import { sanitizeToolResult, sanitizeErrorMessage } from './utils/output-sanitizer.js';
import { validateToolArgs, isInputValidationEnabled } from './utils/input-validator.js';
import { runStartupAudit } from './utils/startup-audit.js';
import { clearVaultCache } from './utils/vault-resolver.js';
import { checkToolAccess, filterAllowedTools } from './utils/tool-access-control.js';
import { withConcurrencyLimit } from './utils/concurrency-limiter.js';
import { toolRegistry } from './utils/tool-registry.js';
import { sessionStore, getTokenBudget } from './utils/session-store.js';
import { CATEGORY_DESCRIPTIONS } from './utils/tool-categories.js';
import {
  getToolDiscoveryTools,
  listToolCategories,
  searchTools,
  activateCategory,
  getActiveTools,
  deactivateCategory,
  resolveSessionId,
} from './tools/tool-discovery.js';
import { getCachePoolTools, listCachePools, getCachePoolStats } from './tools/cache-pools.js';
import { getSessionConfigTools, listSessionConfig, getSessionStats } from './tools/session-config.js';
import { getDbalConfigTools, listDbalConfig, getDbalStats } from './tools/dbal-config.js';
import { getErrorPageTools, listErrorPages, getErrorPageStats } from './tools/error-pages.js';
import { getHealthCheckTools, listHealthChecks, getHealthCheckStats } from './tools/health-checks.js';
import { getKernelAnalysisTools, listKernelConfig, getKernelStats } from './tools/kernel-analysis.js';
import { getPasswordHasherTools, listPasswordHashers, getPasswordHasherStats } from './tools/password-hashers.js';
import { getCacheWarmerTools, listCacheWarmers, getCacheWarmerStats } from './tools/cache-warmers.js';
import { getEasyAdminTools, listEasyAdminConfig, getEasyAdminStats } from './tools/easyadmin.js';
import { getBehatConfigTools, listBehatConfig, getBehatStats } from './tools/behat-config.js';
import { getContainerTagTools, listContainerTags, getContainerTagStats } from './tools/container-tags.js';
import { getFlexRecipeTools, listFlexRecipes, getFlexRecipeStats } from './tools/flex-recipes.js';
import { getOpenApiTools, listOpenApiConfig, getOpenApiStats } from './tools/openapi.js';
import { getSearchIntegrationTools, listSearchIntegration, getSearchIntegrationStats } from './tools/search-integration.js';
import { getFeatureFlagTools, listFeatureFlags, getFeatureFlagStats } from './tools/feature-flags.js';
import { getCiCdConfigTools, listCiCdConfig, getCiCdStats } from './tools/cicd-config.js';
import { getOAuthSsoTools, listOAuthConfig, getOAuthStats } from './tools/oauth-sso.js';
import { getDockerInspectorTools, listDockerConfig, getDockerStats } from './tools/docker-inspector.js';
import { getFileStorageTools, listFileStorage, getFileStorageStats } from './tools/file-storage.js';
import { getGraphQlTools, listGraphQlConfig, getGraphQlStats } from './tools/graphql.js';
import { getCustomAuthenticatorTools, listCustomAuthenticators, getAuthenticatorStats } from './tools/custom-authenticators.js';
import { getTurboTools, listTurboConfig, getTurboStats } from './tools/turbo-bundle.js';
import { getApiVersioningTools, listApiVersions, getApiVersionStats } from './tools/api-versioning.js';
import { getPsalmTools, listPsalmConfig, getPsalmStats } from './tools/psalm-config.js';
import { getCronJobTools, listCronJobs, getCronJobStats } from './tools/cron-jobs.js';
import { getWebpackEncoreTools, listWebpackConfig, getWebpackStats } from './tools/webpack-encore.js';
import { getDoctrineQueryBuilderTools, listQueryBuilderPatterns, getQueryBuilderStats } from './tools/doctrine-query-builder.js';
import { getPsrComplianceTools, listPsrCompliance, getPsrStats } from './tools/psr-compliance.js';
import { getTwigLintTools, listTwigIssues, getTwigLintStats } from './tools/twig-lint.js';
import { getMultiTenancyTools, listMultitenancyConfig, getMultitenancyStats } from './tools/multi-tenancy.js';
import { getSymfonyCliTools, listSymfonyCliConfig, getSymfonyCliStats } from './tools/symfony-cli.js';
import { getRectorTools, listRectorRules, getRectorStats } from './tools/rector-config.js';
import { getApiRateLimitsTools, listApiRateLimits, getApiRateLimitStats } from './tools/api-rate-limits.js';
import { getDeploymentConfigTools, listDeploymentConfig, getDeploymentStats } from './tools/deployment-config.js';
import { getCustomEventsTools, listCustomEvents, getCustomEventStats } from './tools/symfony-events-custom.js';
import { getAccessibilityTools, listAccessibilityIssues, getAccessibilityStats } from './tools/accessibility-audit.js';
import { getDoctrineCacheTools, listDoctrineCache, getDoctrineCacheStats } from './tools/doctrine-cache.js';
import { getMakerTools, listMakerConfig, getMakerStats } from './tools/symfony-maker-config.js';
import { getDoctrineFilterTools, listDoctrineFilters, getDoctrineFilterStats } from './tools/doctrine-filters.js';
import { getLiveComponentTools, listLiveComponents, getLiveComponentStats } from './tools/live-components.js';
import { getCsFixerTools, listCsFixerConfig, getCsFixerStats } from './tools/php-cs-fixer.js';
import { getApiPlatformFiltersTools, listApiPlatformFilters, getApiPlatformFilterStats } from './tools/api-platform-filters.js';
import { getMessengerFailureTools, listMessengerFailureConfig, getMessengerFailureStats } from './tools/symfony-messenger-failures.js';
import { getFixtureGroupTools, listFixtureGroups, getFixtureGroupStats } from './tools/database-fixture-groups.js';
import { getTranslationPluralTools, listTranslationPlurals, getPluralStats } from './tools/symfony-translation-plurals.js';
import { getApiPlatformSecurityTools, listApiPlatformSecurity, getApiPlatformSecurityStats } from './tools/api-platform-security.js';
import { getWorkflowGuardTools, listWorkflowGuards, getWorkflowGuardStats } from './tools/symfony-workflow-guards.js';
import { getDoctrineInheritanceTools, listDoctrineInheritance, getDoctrineInheritanceStats } from './tools/doctrine-inheritance.js';
import { getNotifierChannelTools, listNotifierChannels, getNotifierChannelStats } from './tools/symfony-notifier-channels.js';
import { getClockTools, listClockConfig, getClockStats } from './tools/symfony-clock.js';
import { getPhpStanTools, listPhpStanConfig, getPhpStanStats } from './tools/phpstan-config.js';
import { getDqlFunctionTools, listDqlFunctions, getDqlFunctionStats } from './tools/doctrine-dql-functions.js';
import { getLocaleConfigTools, listLocaleConfig, getLocaleStats } from './tools/symfony-locale-config.js';
import { getDataCollectorTools, listDataCollectors, getDataCollectorStats } from './tools/symfony-data-collectors.js';
import { getCsrfTools, listCsrfConfig, getCsrfStats } from './tools/symfony-csrf.js';
import { getSentryTools, listSentryConfig, getSentryStats } from './tools/sentry-integration.js';
import { getConsoleNamespaceTools, listCommandNamespaces, getCommandNamespaceStats } from './tools/symfony-console-namespaces.js';
import { getNelmioApiDocTools, listNelmioConfig, getNelmioStats } from './tools/nelmio-api-doc.js';
import { getEnvConfigOverrideTools, listEnvConfigOverrides, getEnvConfigOverrideStats } from './tools/symfony-config-environments.js';
import { getBlackfireTools, listBlackfireConfig, getBlackfireStats } from './tools/blackfire-config.js';
import { getUidTools, listUidConfig, getUidStats } from './tools/symfony-uid.js';
import { getApiStateTools, listApiStateProviders, getApiStateStats } from './tools/api-platform-state.js';
import { getExpressionLanguageTools, listExpressionFunctions, getExpressionStats } from './tools/symfony-expression-language.js';
import { getCacheTagTools, listCacheTagConfig, getCacheTagStats } from './tools/symfony-cache-tags.js';
import { getPhpEnumTools, listPhpEnums, getEnumStats } from './tools/php-enums.js';
import { getMailerEventTools, listMailerEvents, getMailerEventStats } from './tools/symfony-mailer-events.js';
import { getSecurityFirewallTools, listSecurityFirewalls, getFirewallStats } from './tools/symfony-security-firewalls.js';
import { getSecurityPassportTools, listPassportBadges, getBadgeStats } from './tools/symfony-security-passport.js';
import { getTrustedProxyTools, listTrustedProxyConfig, getTrustedProxyStats } from './tools/symfony-trusted-proxies.js';
import { getResponseCacheTools, listResponseCacheHeaders, getResponseCacheStats } from './tools/http-response-cache.js';
import { getAssetVersioningTools, listAssetConfig, getAssetVersioningStats } from './tools/symfony-assets-versioning.js';
import { getDoctrineTimestampTools, listTimestampableEntities, getTimestampStats } from './tools/doctrine-timestamps.js';
import { getDoctrineProjectionTools, listDqlProjections, getProjectionStats } from './tools/doctrine-projections.js';
import { getMigrationHistoryTools, listMigrationGaps, getMigrationHistoryStats } from './tools/doctrine-migration-history.js';
import { getMessengerStampTools, listMessengerStamps, getStampStats } from './tools/symfony-messenger-stamps.js';
import { getMessageBusTools, listMessageBuses, getBusStats } from './tools/symfony-message-buses.js';
import { getTwigGlobalTools, listTwigGlobals, getTwigGlobalStats } from './tools/twig-globals.js';
import { getTwigComponentTools, listTwigComponents, getTwigComponentStats } from './tools/twig-components.js';
import { getPhpUnitTestGroupTools, listTestGroups, getTestGroupStats } from './tools/phpunit-test-groups.js';
import { getCustomConstraintTools, listCustomConstraints, getConstraintStats } from './tools/symfony-custom-constraints.js';
import { getHttpClientScopeTools, listHttpClientScopes, getHttpClientScopeStats } from './tools/symfony-httpclient-scopes.js';
import { getEnvProcessorTools, listEnvProcessors, getEnvProcessorStats } from './tools/symfony-env-processors.js';
import { getSymfonyDebugTools, listDebugArtifacts, getDebugStats } from './tools/symfony-debug.js';
import { getLockResourceTools, listLockResources, getLockResourceStats } from './tools/symfony-lock-resources.js';
import { getKernelEventTools, listKernelEventListeners, getKernelEventStats } from './tools/symfony-kernel-events.js';
import { getPropertyInfoTools, listPropertyInfoExtractors, getPropertyInfoStats } from './tools/symfony-property-info.js';
import { getSerializerGroupTools, listSerializerGroupAttrs, getSerializerGroupStats } from './tools/symfony-serializer-groups.js';
import { getHtmlSanitizerTools, listHtmlSanitizerConfig, getSanitizerStats } from './tools/symfony-html-sanitizer.js';
import { getApiOperationTools, listApiOperations, getApiOperationStats } from './tools/api-platform-operations.js';
import { getCustomMakerTools, listCustomMakers, getMakerCommandStats } from './tools/symfony-custom-makers.js';
import { getStringSluggerTools, listStringUsage, getStringStats } from './tools/symfony-string-slugger.js';
import { getFormEventTools, listFormEvents, getFormEventStats } from './tools/symfony-form-events.js';
import { getDoctrineEventSubscriberTools, listDoctrineEventSubscribers, getDoctrineSubscriberStats } from './tools/doctrine-event-subscribers.js';
import { getConfigExtensionTools, listConfigExtensions, getConfigExtensionStats } from './tools/symfony-config-extensions.js';
import { getStopwatchTools, listStopwatchUsage, getStopwatchStats } from './tools/symfony-stopwatch.js';
import { getProcessTools, listProcessUsage, getProcessStats } from './tools/symfony-process.js';
import { getReadonlyTools, listReadonlyClasses, getReadonlyStats } from './tools/php-readonly.js';
import { getApiPaginationTools, listApiPagination, getApiPaginationStats } from './tools/api-platform-pagination.js';
import { getLazyServiceTools, listLazyServices, getLazyServiceStats } from './tools/symfony-lazy-services.js';
import { getCustomAttributeTools, listCustomPhpAttributes, getCustomAttributeStats } from './tools/php-custom-attributes.js';
import { getDoctrineIndexTools, listDoctrineIndexes, getDoctrineIndexStats } from './tools/doctrine-indexes.js';
import { getConsoleCompletionTools, listConsoleCompletion, getConsoleCompletionStats } from './tools/symfony-console-completion.js';
import { getDoctrineAssocFetchTools, listFetchModes, getFetchModeStats } from './tools/doctrine-fetch-modes.js';
import { getCompoundConstraintTools, listCompoundConstraints, getCompoundConstraintStats } from './tools/symfony-compound-constraints.js';
import { getMailerTransportTools, listMailerTransports, getMailerTransportStats } from './tools/symfony-mailer-transport.js';
import { getMercurePushTools, listMercurePushConfig, getMercurePushStats } from './tools/api-platform-mercure-push.js';
import { getRepositoryPatternTools, listRepositoryPatterns, getRepositoryPatternStats } from './tools/doctrine-repository-patterns.js';
import { getObjectMapperTools, listObjectMapperConfig, getObjectMapperStats } from './tools/symfony-object-mapper.js';
import { getVarExporterTools, listVarExporterUsage, getVarExporterStats } from './tools/symfony-var-exporter.js';
import { getTwigSandboxTools, listTwigSandbox, getTwigSandboxStats } from './tools/twig-sandbox.js';
import { getAutowireAttributeTools, listAutowireAttributes, getAutowireAttributeStats } from './tools/symfony-autowire-attributes.js';
import { getTranslationGapTools, listTranslationGaps, getTranslationGapStats } from './tools/symfony-translation-gaps.js';
import { getFormTypeExtensionTools, listFormTypeExtensions, getFormTypeExtensionStats } from './tools/symfony-form-type-extension.js';
import { getSymfonyRuntimeTools, listRuntimeConfig, getRuntimeStats } from './tools/symfony-runtime.js';
import { getMimePartsTools, listMimeParts, getMimePartsStats } from './tools/symfony-mime-parts.js';
import { getTypeCoverageTools, listTypeCoverage, getTypeCoverageStats } from './tools/php-type-coverage.js';
import { getRoleHierarchyTools, listRoleHierarchy, getRoleHierarchyStats } from './tools/symfony-role-hierarchy.js';
import { getAccessControlTools, listAccessControl, getAccessControlStats } from './tools/symfony-access-control.js';
import { getTokenStorageTools, listTokenStorageUsage, getTokenStorageStats } from './tools/symfony-token-storage.js';
import { getFormTransformerTools, listFormTransformers, getFormTransformerStats } from './tools/symfony-form-transformers.js';
import { getChoiceLoaderTools, listChoiceLoaders, getChoiceLoaderStats } from './tools/symfony-choice-loaders.js';
import { getValidationGroupTools, listValidationGroups, getValidationGroupStats } from './tools/symfony-validation-groups.js';
import { getServiceAliasTools, listServiceAliases, getServiceAliasStats } from './tools/symfony-service-aliases.js';
import { getDiFactoryTools, listDiFactories, getDiFactoryStats } from './tools/symfony-di-factories.js';
import { getOptionsResolverTools, listOptionsResolverUsage, getOptionsResolverStats } from './tools/symfony-options-resolver.js';
import { getValueResolverTools, listValueResolvers, getValueResolverStats } from './tools/symfony-value-resolver.js';
import { getRequestMappingTools, listRequestMappingAttrs, getRequestMappingStats } from './tools/symfony-request-mapping.js';
import { getFileUploadTools, listFileUploadUsage, getFileUploadStats } from './tools/symfony-file-uploads.js';
import { getHttpClientRetryTools, listHttpClientRetry, getHttpClientRetryStats } from './tools/symfony-httpclient-retry.js';
import { getWebLinkTools, listWebLinkUsage, getWebLinkStats } from './tools/symfony-weblink.js';
import { getErrorRendererTools, listErrorRenderers, getErrorRendererStats } from './tools/symfony-error-renderer.js';
import { getConsoleStyleTools, listConsoleStyleUsage, getConsoleStyleStats } from './tools/symfony-console-style.js';
import { getConsoleSignalTools, listConsoleSignals, getConsoleSignalStats } from './tools/symfony-console-signals.js';
import { getWorkflowMarkingTools, listWorkflowMarkings, getWorkflowMarkingStats } from './tools/symfony-workflow-marking.js';
import { getMessengerTransportOptionTools, listMessengerTransportOptions, getMessengerTransportOptionStats } from './tools/symfony-messenger-transport-options.js';
import { getNotifierMessageTypeTools, listNotifierMessageTypes, getNotifierMessageTypeStats } from './tools/symfony-notifier-message-types.js';
import { getSessionHandlerTools, listSessionHandlers, getSessionHandlerStats } from './tools/symfony-session-handlers.js';
import { getEventDispatcherTracingTools, listEventDispatcherTracing, getEventDispatcherTracingStats } from './tools/symfony-event-dispatcher-tracing.js';
import { getMaintenanceModeTools, listMaintenanceMode, getMaintenanceModeStats } from './tools/symfony-maintenance-mode.js';
import { getMonologProcessorTools, listMonologProcessors, getMonologProcessorStats } from './tools/symfony-monolog-processors.js';
import { getTwigTokenParserTools, listTwigTokenParsers, getTwigTokenParserStats } from './tools/twig-token-parsers.js';
import { getDoctrineSecondLevelCacheTools, listDoctrineSecondLevelCache, getDoctrineSecondLevelCacheStats } from './tools/doctrine-second-level-cache.js';
import { getDoctrineNamedQueryTools, listDoctrineNamedQueries, getDoctrineNamedQueryStats } from './tools/doctrine-named-queries.js';
import { getDoctrineRepositoryQueryTools, listDoctrineRepositoryQueries, getDoctrineRepositoryQueryStats } from './tools/doctrine-repository-queries.js';
import { getDoctrinePaginatorTools, listDoctrinePaginators, getDoctrinePaginatorStats } from './tools/doctrine-paginator.js';
import { getDoctrineCascadeTools, listDoctrineCascadeConfig, getDoctrineCascadeStats } from './tools/doctrine-cascade-config.js';
import { getDoctrineOrphanRemovalTools, listDoctrineOrphanRemoval, getDoctrineOrphanRemovalStats } from './tools/doctrine-orphan-removal.js';
import { getDoctrineDiscriminatorTools, listDoctrineDiscriminators, getDoctrineDiscriminatorStats } from './tools/doctrine-discriminator.js';
import { getDoctrineMigrationGraphTools, listDoctrineMigrationGraph, getDoctrineMigrationGraphStats } from './tools/doctrine-migration-graph.js';
import { getDoctrineEventManagerTools, listDoctrineEventManagerUsage, getDoctrineEventManagerStats } from './tools/doctrine-event-manager.js';
import { getApiPlatformStateProcessorTools, listApiPlatformStateProcessors, getApiPlatformStateProcessorStats } from './tools/api-platform-state-processors.js';
import { getApiPlatformSerializationContextTools, listApiPlatformSerializationContexts, getApiPlatformSerializationContextStats } from './tools/api-platform-serialization-context.js';
import { getApiPlatformValidationContextTools, listApiPlatformValidationContexts, getApiPlatformValidationContextStats } from './tools/api-platform-validation-context.js';
import { getApiPlatformResourceMetadataTools, listApiPlatformResourceMetadata, getApiPlatformResourceMetadataStats } from './tools/api-platform-resource-metadata.js';
import { getPhpUnitDataProviderTools, listPhpUnitDataProviders, getPhpUnitDataProviderStats } from './tools/phpunit-data-providers.js';
import { getPhpUnitMockTools, listPhpUnitMocks, getPhpUnitMockStats } from './tools/phpunit-mocks.js';
import { getBehatContextTools, listBehatContexts, getBehatContextStats } from './tools/behat-contexts.js';
import { getPestPhpTools, listPestPhpConfig, getPestPhpStats } from './tools/pest-php-config.js';
import { getPhpComplexityTools, listPhpComplexity, getPhpComplexityStats } from './tools/php-complexity.js';
import { getPhpNamespaceConsistencyTools, listPhpNamespaceConsistency, getPhpNamespaceConsistencyStats } from './tools/php-namespace-consistency.js';
import { getPhpMatchExhaustivenessTools, listPhpMatchExhaustiveness, getPhpMatchExhaustivenessStats } from './tools/php-match-exhaustiveness.js';
import { getPhpDeprecationTools, listPhpDeprecations, getPhpDeprecationStats } from './tools/php-deprecations.js';
import { getPhpArrowFunctionTools, listPhpArrowFunctions, getPhpArrowFunctionStats } from './tools/php-arrow-functions.js';
import { getPhpAttributesReaderTools, listPhpAttributesReader, getPhpAttributesReaderStats } from './tools/php-attributes-reader.js';
import { getWebserverConfigTools, listWebserverConfig, getWebserverConfigStats } from './tools/webserver-config.js';
import { getPhpArchitectureRulesTools, listPhpArchitectureRules, getPhpArchitectureRulesStats } from './tools/php-architecture-rules.js';
import { getTwigMacroTools, listTwigMacros, getTwigMacroStats } from './tools/twig-macros.js';
import { getTwigInheritanceTools, listTwigInheritance, getTwigInheritanceStats } from './tools/twig-template-inheritance.js';
import { getTwigNamespaceTools, listTwigNamespacePaths, getTwigNamespaceStats } from './tools/twig-namespace-paths.js';
import { getDoctrineHydratorTools, listDoctrineCustomHydrators, getDoctrineHydratorStats } from './tools/doctrine-custom-hydrators.js';
import { getDoctrineResultCacheTools, listDoctrineResultCache, getDoctrineResultCacheStats } from './tools/doctrine-result-cache.js';
import { getDbalMiddlewareTools, listDbalMiddleware, getDbalMiddlewareStats } from './tools/doctrine-dbal-middleware.js';
import { getDoctrineSoftDeleteTools, listDoctrineSoftDelete, getDoctrineSoftDeleteStats } from './tools/doctrine-soft-delete.js';
import { getDoctrineMappingFormatTools, listDoctrineMappingFormat, getDoctrineMappingFormatStats } from './tools/doctrine-mapping-format.js';
import { getCookieSecurityTools, listCookieSecurity, getCookieSecurityStats } from './tools/cookie-security.js';
import { getCspTools, listCspConfig, getCspStats } from './tools/content-security-policy.js';
import { getHttpSecurityHeaderTools, listHttpSecurityHeaders, getHttpSecurityHeaderStats } from './tools/http-security-headers.js';
import { getNPlusOneTools, listNPlusOnePatterns, getNPlusOneStats } from './tools/n-plus-one-queries.js';
import { getApiQueryExtensionTools, listApiQueryExtensions, getApiQueryExtensionStats } from './tools/api-platform-query-extensions.js';
import { getApiCustomNormalizerTools, listApiCustomNormalizers, getApiCustomNormalizerStats } from './tools/api-platform-custom-normalizers.js';
import { getApiIriConverterTools, listApiIriConverter, getApiIriConverterStats } from './tools/api-platform-iri-converter.js';
import { getApiSubresourceTools, listApiSubresources, getApiSubresourceStats } from './tools/api-platform-subresources.js';
import { getApiDtoOutputTools, listApiDtoOutput, getApiDtoOutputStats } from './tools/api-platform-dto-output.js';
import { getTranslationDomainTools, listTranslationDomains, getTranslationDomainStats } from './tools/translation-domains.js';
import { getIcuTranslationTools, listIcuTranslations, getIcuTranslationStats } from './tools/translation-icu-format.js';
import { getXliffFormatTools, listXliffTranslations, getXliffFormatStats } from './tools/translation-xliff-format.js';
import { getImportmapTools, listImportmapConfig, getImportmapStats } from './tools/importmap-config.js';
import { getServiceLocatorTools, listServiceLocators, getServiceLocatorStats } from './tools/service-locators.js';
import { getAbstractServiceTools, listAbstractServices, getAbstractServiceStats } from './tools/abstract-parent-services.js';
import { getExceptionSubscriberTools, listExceptionSubscribers, getExceptionSubscriberStats } from './tools/exception-subscribers.js';
import { getEventPriorityTools, listEventPriorityConflicts, getEventPriorityStats } from './tools/event-priority-conflicts.js';
import { getTwigEmailTools, listTwigEmailStructure, getTwigEmailStats } from './tools/twig-email-structure.js';
import { getMailerDkimTools, listMailerDkimConfig, getMailerDkimStats } from './tools/mailer-dkim-config.js';
import { getOpenTelemetryTools, listOpenTelemetryConfig, getOpenTelemetryStats } from './tools/opentelemetry-config.js';
import { getMonologChannelTools, listMonologChannelMapping, getMonologChannelStats } from './tools/monolog-channel-mapping.js';
import { getPhpFiberTools, listPhpFibers, getPhpFiberStats } from './tools/php-fibers.js';
import { getPhpNamedArgumentTools, listPhpNamedArguments, getPhpNamedArgumentStats } from './tools/php-named-arguments.js';
import { getPhpGenericAnnotationTools, listPhpGenericAnnotations, getPhpGenericAnnotationStats } from './tools/php-generic-annotations.js';
import { getPhpIntersectionTypeTools, listPhpIntersectionTypes, getPhpIntersectionTypeStats } from './tools/php-intersection-types.js';
import { getCustomExceptionTools, listCustomExceptionHierarchy, getCustomExceptionStats } from './tools/custom-exception-hierarchy.js';
import { getPhpUnitCoverageTools, listPhpUnitCoverageConfig, getPhpUnitCoverageStats } from './tools/phpunit-coverage-config.js';
import { getFilesystemTools, listFilesystemUsage, getFilesystemStats } from './tools/symfony-filesystem.js';
import { getFinderTools, listFinderUsage, getFinderStats } from './tools/symfony-finder.js';
import { getPropertyAccessTools, listPropertyAccessUsage, getPropertyAccessStats } from './tools/symfony-property-access.js';
import { getSerializerContextTools, listSerializerContextBuilders, getSerializerContextStats } from './tools/symfony-serializer-context.js';
import { getOpcacheApcuTools, listOpcacheApcuConfig, getOpcacheApcuStats } from './tools/opcache-apcu-config.js';
import { getRedisConfigTools, listRedisConfig, getRedisConfigStats } from './tools/redis-config-analysis.js';
import { getDbalConnectionPoolTools, listDbalConnectionPool, getDbalConnectionPoolStats } from './tools/dbal-connection-pool.js';
import { getWebhookConsumerTools, listWebhookConsumers, getWebhookConsumerStats } from './tools/webhook-consumers.js';
import { getApiSecurityExpressionTools, listApiSecurityExpressions, getApiSecurityExpressionStats } from './tools/api-platform-security-expressions.js';
import { getMessengerSerializerTools, listMessengerSerializer, getMessengerSerializerStats } from './tools/messenger-serializer.js';
import { getDbalConnectionFactoryTools, listDbalConnectionFactory, getDbalConnectionFactoryStats } from './tools/doctrine-dbal-connection-factory.js';
import { getConsoleCommandOptionTools, listConsoleCommandOptions, getConsoleCommandOptionStats } from './tools/console-command-options.js';
import { getNotifierTransportTools, listNotifierTransportConfig, getNotifierTransportStats } from './tools/notifier-transport-config.js';
import { getPhpNullsafeTools, listPhpNullsafePatterns, getPhpNullsafeStats } from './tools/php-nullsafe-patterns.js';
import { getBundleConfigTreeTools, listBundleConfigTree, getBundleConfigTreeStats } from './tools/symfony-bundle-config-tree.js';
import { getFormCollectionTools, listFormCollectionTypes, getFormCollectionStats } from './tools/symfony-form-collection-types.js';
import { getFormThemeTools, listFormThemes, getFormThemeStats } from './tools/symfony-form-themes.js';
import { getFormButtonTools, listFormButtons, getFormButtonStats } from './tools/symfony-form-button.js';
import { getDoctrineMultiConnectionTools, listDoctrineMultiConnection, getDoctrineMultiConnectionStats } from './tools/doctrine-multi-connection.js';
import { getDoctrineUowFlushTools, listDoctrineUowFlush, getDoctrineUowFlushStats } from './tools/doctrine-uow-flush.js';
import { getDoctrineEntityListenerTools, listDoctrineEntityListeners, getDoctrineEntityListenerStats } from './tools/doctrine-entity-listeners.js';
import { getDoctrineSequenceTools, listDoctrineSequenceGenerators, getDoctrineSequenceStats } from './tools/doctrine-sequence-generator.js';
import { getDoctrineColumnCharsetTools, listDoctrineColumnCharsets, getDoctrineColumnCharsetStats } from './tools/doctrine-column-charset.js';
import { getDbalPreparedStatementTools, listDbalPreparedStatements, getDbalPreparedStatementStats } from './tools/doctrine-dbal-prepared-statements.js';
import { getDoctrineMigrationsConfigTools, listDoctrineMigrationsConfig, getDoctrineMigrationsConfigStats } from './tools/doctrine-migrations-config.js';
import { getRememberMeTools, listRememberMeConfig, getRememberMeStats } from './tools/symfony-security-remember-me.js';
import { getImpersonationTools, listImpersonationConfig, getImpersonationStats } from './tools/symfony-security-impersonation.js';
import { getAccessDecisionTools, listAccessDecisionConfig, getAccessDecisionStats } from './tools/symfony-security-access-decision.js';
import { getLoginThrottleTools, listLoginThrottleConfig, getLoginThrottleStats } from './tools/symfony-security-login-throttle.js';
import { getSecurityIpAccessTools, listSecurityIpAccess, getSecurityIpAccessStats } from './tools/symfony-security-ip-access.js';
import { getLoginLinkTools, listLoginLinkConfig, getLoginLinkStats } from './tools/symfony-security-login-link.js';
import { getPasswordUpgradeTools, listPasswordUpgradeConfig, getPasswordUpgradeStats } from './tools/symfony-security-password-upgrade.js';
import { getSessionStrategyTools, listSessionStrategyConfig, getSessionStrategyStats } from './tools/symfony-security-session-strategy.js';
import { getMessengerRetryTools, listMessengerRetryConfig, getMessengerRetryStats } from './tools/symfony-messenger-retry.js';
import { getMessengerWorkerTools, listMessengerWorkerConfig, getMessengerWorkerStats } from './tools/symfony-messenger-worker.js';
import { getConsoleTableTools, listConsoleTableUsage, getConsoleTableStats } from './tools/symfony-console-table.js';
import { getConsoleQuestionTools, listConsoleQuestions, getConsoleQuestionStats } from './tools/symfony-console-question.js';
import { getCacheChainTools, listCacheChainConfig, getCacheChainStats } from './tools/symfony-cache-chain.js';
import { getTranslationProviderTools, listTranslationProviders, getTranslationProviderStats } from './tools/symfony-translation-providers.js';
import { getUxAutocompleteTools, listUxAutocomplete, getUxAutocompleteStats } from './tools/symfony-ux-autocomplete.js';
import { getFlashMessageTools, listFlashMessages, getFlashMessageStats } from './tools/symfony-flash-messages.js';
import { getRequestStackTools, listRequestStackUsage, getRequestStackStats } from './tools/symfony-request-stack.js';
import { getHttpClientEventTools, listHttpClientEvents, getHttpClientEventStats } from './tools/symfony-http-client-events.js';
import { getSemaphoreTools, listSemaphoreUsage, getSemaphoreStats } from './tools/symfony-semaphore.js';
import { getAssetPackageTools, listAssetPackages, getAssetPackageStats } from './tools/symfony-asset-packages.js';
import { getMimeTypeTools, listMimeTypeUsage, getMimeTypeStats } from './tools/symfony-mime-types.js';
import { getSerializerEncoderTools, listSerializerEncoders, getSerializerEncoderStats } from './tools/symfony-serializer-encoders.js';
import { getWorkflowEventTools, listWorkflowEventSubscriptions, getWorkflowEventStats } from './tools/symfony-workflow-events.js';
import { getApiPlatformErrorHandlingTools, listApiPlatformErrorHandling, getApiPlatformErrorHandlingStats } from './tools/api-platform-error-handling.js';
import { getApiOpenApiContextTools, listApiOpenApiContext, getApiOpenApiContextStats } from './tools/api-platform-openapi-context.js';
import { getFirstClassCallableTools, listFirstClassCallables, getFirstClassCallableStats } from './tools/php-first-class-callables.js';
import { getPhpStringHelperTools, listPhpStringHelpers, getPhpStringHelperStats } from './tools/php-string-helpers.js';
import { getPhpGeneratorTools, listPhpGenerators, getPhpGeneratorStats } from './tools/php-generators.js';
import { getPhpWeakReferenceTools, listPhpWeakReferences, getPhpWeakReferenceStats } from './tools/php-weak-references.js';
import { getPhpTypedConstantTools, listPhpTypedConstants, getPhpTypedConstantStats } from './tools/php-typed-constants.js';
import { getPhpPropertyHookTools, listPhpPropertyHooks, getPhpPropertyHookStats } from './tools/php-property-hooks.js';
import { getAsymmetricVisibilityTools, listAsymmetricVisibility, getAsymmetricVisibilityStats } from './tools/php-asymmetric-visibility.js';
import { getPhpErrorHandlingTools, listPhpErrorHandling, getPhpErrorHandlingStats } from './tools/php-error-handling.js';
import { getPhpUnitAttributeTools, listPhpUnitAttributes, getPhpUnitAttributeStats } from './tools/phpunit-attributes.js';
import { getPhpUnitExtensionTools, listPhpUnitExtensions, getPhpUnitExtensionStats } from './tools/phpunit-extensions.js';
import { getTwoFactorTools, listTwoFactorConfig, getTwoFactorStats } from './tools/symfony-security-two-factor.js';
import { getResponseTypeTools, listResponseTypes, getResponseTypeStats } from './tools/symfony-response-types.js';
import { getContentNegotiationTools, listContentNegotiation, getContentNegotiationStats } from './tools/symfony-content-negotiation.js';
import { getSubrequestTools, listSubrequestUsage, getSubrequestStats } from './tools/symfony-subrequest.js';
import { getFormDataClassTools, listFormDataClass, getFormDataClassStats } from './tools/symfony-form-data-class.js';
import { getFormRepeatedTools, listFormRepeated, getFormRepeatedStats } from './tools/symfony-form-repeated.js';
import { getFormTypeGuessTools, listFormTypeGuess, getFormTypeGuessStats } from './tools/symfony-form-guess.js';
import { getFormCallbackConstraintTools, listFormCallbackConstraints, getFormCallbackConstraintStats } from './tools/symfony-form-callback-constraint.js';
import { getRoutingRequirementTools, listRoutingRequirements, getRoutingRequirementStats } from './tools/symfony-routing-requirements.js';
import { getRoutingLoaderTools, listRoutingLoaders, getRoutingLoaderStats } from './tools/symfony-routing-loader.js';
import { getSecurityEntryPointTools, listSecurityEntryPoints, getSecurityEntryPointStats } from './tools/symfony-security-entry-point.js';
import { getSecurityPostAuthTools, listSecurityPostAuth, getSecurityPostAuthStats } from './tools/symfony-security-post-auth.js';
import { getFirewallListenerTools, listFirewallListeners, getFirewallListenerStats } from './tools/symfony-security-firewall-listeners.js';
import { getPasswordStrengthTools, listPasswordStrength, getPasswordStrengthStats } from './tools/symfony-password-strength.js';
import { getCacheStampedeTools, listCacheStampede, getCacheStampedeStats } from './tools/symfony-cache-stampede.js';
import { getCachePoolPruneTools, listCachePoolPrune, getCachePoolPruneStats } from './tools/symfony-cache-pool-prune.js';
import { getMessengerEnvelopeTools, listMessengerEnvelopes, getMessengerEnvelopeStats } from './tools/symfony-messenger-envelope.js';
import { getDispatchAfterTools, listDispatchAfterCurrentBus, getDispatchAfterStats } from './tools/symfony-messenger-dispatch-after.js';
import { getObjectNormalizerTools, listObjectNormalizerUsage, getObjectNormalizerStats } from './tools/symfony-object-normalizer.js';
import { getValidatorCascadeTools, listValidatorCascade, getValidatorCascadeStats } from './tools/symfony-validator-cascade.js';
import { getValidatorGroupSequenceTools, listValidatorGroupSequence, getValidatorGroupSequenceStats } from './tools/symfony-validator-group-sequence.js';
import { getPhpStanCustomRuleTools, listPhpStanCustomRules, getPhpStanCustomRuleStats } from './tools/phpstan-custom-rules.js';
import { getRectorCustomRuleTools, listRectorCustomRules, getRectorCustomRuleStats } from './tools/rector-custom-rules.js';
import { getViteTools, listViteConfig, getViteStats } from './tools/vite-bundle.js';
import { getProfilerPanelTools, listProfilerPanels, getProfilerPanelStats } from './tools/symfony-debug-profiler-panels.js';
import { getValidatorExpressionTools, listValidatorExpressions, getValidatorExpressionStats } from './tools/symfony-validator-expression.js';
import { getConstraintValidatorTestTools, listConstraintValidatorTests, getConstraintValidatorTestStats } from './tools/symfony-constraint-validator-test.js';
import { getDebugDumpTools, listDebugDumps, getDebugDumpStats } from './tools/symfony-debug-dump.js';
import { getProfilerStorageTools, listProfilerStorage, getProfilerStorageStats } from './tools/symfony-profiler-storage.js';
import { getErrorControllerTools, listErrorController, getErrorControllerStats } from './tools/symfony-error-controller.js';
import { getMailerAttachmentTools, listMailerAttachments, getMailerAttachmentStats } from './tools/symfony-mailer-attachments.js';
import { getHttpClientMockTools, listHttpClientMocks, getHttpClientMockStats } from './tools/symfony-http-client-mock.js';
import { getControllerTestTools, listControllerTests, getControllerTestStats } from './tools/symfony-controller-test.js';
import { getClockTestTools, listClockTests, getClockTestStats } from './tools/symfony-clock-test.js';
import { getLazyGhostTools, listLazyGhostServices, getLazyGhostStats } from './tools/symfony-di-lazy-ghost.js';
import { getPhpCovarianceTools, listPhpCovariance, getPhpCovarianceStats } from './tools/php-covariance.js';
import { getAbstractPatternTools, listAbstractPatterns, getAbstractPatternStats } from './tools/php-abstract-patterns.js';
import { getInterfaceSegregationTools, listInterfaceSegregation, getInterfaceSegregationStats } from './tools/php-interface-segregation.js';
import { getStaticAnalysisIgnoreTools, listStaticAnalysisIgnores, getStaticAnalysisIgnoreStats } from './tools/php-static-analysis-ignore.js';
import { getPhpMagicMethodTools, listPhpMagicMethods, getPhpMagicMethodStats } from './tools/php-magic-methods.js';
import { getPhpUnitPerformanceTools, listPhpUnitPerformance, getPhpUnitPerformanceStats } from './tools/phpunit-performance.js';
import { getPhpUnitDatabaseTools, listPhpUnitDatabase, getPhpUnitDatabaseStats } from './tools/phpunit-database.js';
import { getPhpUnitParallelTools, listPhpUnitParallel, getPhpUnitParallelStats } from './tools/phpunit-parallel.js';
import { getRuntimeEnvTools, listRuntimeEnv, getRuntimeEnvStats } from './tools/symfony-runtime-env.js';
import { getHealthProbeTools, listHealthProbes, getHealthProbeStats } from './tools/symfony-health-probe.js';
import { getPhpObjectCloningTools, listPhpObjectCloning, getPhpObjectCloningStats } from './tools/php-object-cloning.js';
import { getPhpDateTimeTools, listPhpDateTime, getPhpDateTimeStats } from './tools/php-date-time.js';
import { getPhpUnitSnapshotTools, listPhpUnitSnapshots, getPhpUnitSnapshotStats } from './tools/phpunit-snapshot.js';
import { getPhpUnitExpectExceptionTools, listPhpUnitExpectException, getPhpUnitExpectExceptionStats } from './tools/phpunit-expect-exception.js';
import { getBehatStepCoverageTools, listBehatStepCoverage, getBehatStepCoverageStats } from './tools/behat-step-coverage.js';
import { getBehatTagTools, listBehatTags, getBehatTagStats } from './tools/behat-tags.js';
import { getUxChartTools, listUxChart, getUxChartStats } from './tools/symfony-ux-chart.js';
import { getUxNotifyTools, listUxNotify, getUxNotifyStats } from './tools/symfony-ux-notify.js';
import { getUxCropperJsTools, listUxCropperJs, getUxCropperJsStats } from './tools/symfony-ux-cropperjs.js';
import { getSerializerDiscriminatorTools, listSerializerDiscriminator, getSerializerDiscriminatorStats } from './tools/symfony-serializer-discriminator.js';
import { getSerializerDenormalizationTools, listSerializerDenormalization, getSerializerDenormalizationStats } from './tools/symfony-serializer-denormalization.js';
import { getDoctrineCriteriaTools, listDoctrineCriteria, getDoctrineCriteriaStats } from './tools/doctrine-criteria-api.js';
import { getDoctrineEntityGraphTools, listDoctrineEntityGraph, getDoctrineEntityGraphStats } from './tools/doctrine-entity-graph.js';
import { getDoctrineChangeTrackingTools, listDoctrineChangeTracking, getDoctrineChangeTrackingStats } from './tools/doctrine-change-tracking.js';
import { getDoctrineResultSetMappingTools, listDoctrineResultSetMapping, getDoctrineResultSetMappingStats } from './tools/doctrine-result-set-mapping.js';
import { getDoctrineOdmConfigTools, listDoctrineOdmConfig, getDoctrineOdmConfigStats } from './tools/doctrine-odm-config.js';
import { getDoctrineBulkOperationTools, listDoctrineBulkOperations, getDoctrineBulkOperationStats } from './tools/doctrine-bulk-operations.js';
import { getDoctrineEntityStateTools, listDoctrineEntityState, getDoctrineEntityStateStats } from './tools/doctrine-entity-state.js';
import { getHttpCacheValidationTools, listHttpCacheValidation, getHttpCacheValidationStats } from './tools/symfony-http-cache-validation.js';
import { getParameterBagTools, listParameterBagUsage, getParameterBagStats } from './tools/symfony-http-foundation-bag.js';
import { getMessengerSchedulerTools, listMessengerScheduler, getMessengerSchedulerStats } from './tools/symfony-messenger-scheduler.js';
import { getMessengerBatchHandlerTools, listMessengerBatchHandler, getMessengerBatchHandlerStats } from './tools/symfony-messenger-batch-handler.js';
import { getMessengerPriorityTools, listMessengerPriority, getMessengerPriorityStats } from './tools/symfony-messenger-priority.js';
import { getInMemoryTransportTools, listInMemoryTransport, getInMemoryTransportStats } from './tools/symfony-messenger-in-memory.js';
import { getResettableServiceTools, listResettableServices, getResettableServiceStats } from './tools/symfony-service-reset.js';
import { getTaggedIteratorTools, listTaggedIterators, getTaggedIteratorStats } from './tools/symfony-tagged-iterator.js';
import { getCommandLockTools, listCommandLock, getCommandLockStats } from './tools/symfony-command-lock.js';
import { getMailerDsnConfigTools, listMailerDsnConfig, getMailerDsnConfigStats } from './tools/symfony-mailer-dsn-analysis.js';
import { getDomainEventTools, listDomainEvents, getDomainEventStats } from './tools/symfony-domain-events.js';
import { getHandleTraitTools, listHandleTraitUsage, getHandleTraitStats } from './tools/symfony-handle-trait.js';
import { getRateLimiterStorageTools, listRateLimiterStorage, getRateLimiterStorageStats } from './tools/symfony-rate-limiter-storage.js';
import { getPasswordMigrationTools, listPasswordMigration, getPasswordMigrationStats } from './tools/symfony-password-migrator.js';
import { getKernelTerminateTools, listKernelTerminate, getKernelTerminateStats } from './tools/symfony-kernel-terminate.js';
import { getAssetMapperExtTools, listAssetMapper, getAssetMapperStats } from './tools/symfony-asset-mapper-ext.js';
import { getTwigTestFunctionTools, listTwigTestFunctions, getTwigTestFunctionStats } from './tools/symfony-twig-test.js';
import { getHttpClientAuthTools, listHttpClientAuth, getHttpClientAuthStats } from './tools/symfony-http-client-auth.js';
import { getExpressionLanguageExtTools, listExpressionLanguageExtensions, getExpressionLanguageExtStats } from './tools/symfony-expression-language-ext.js';
import { getConsoleHelperTools, listConsoleHelpers, getConsoleHelperStats } from './tools/symfony-console-helper.js';
import { getBrowserKitTools, listBrowserKitUsage, getBrowserKitStats } from './tools/symfony-browser-kit.js';
import { getKubernetesConfigTools, listKubernetesConfig, getKubernetesConfigStats } from './tools/symfony-kubernetes.js';
import { getUserCheckerTools, listUserCheckers, getUserCheckerStats } from './tools/symfony-user-checker.js';
import { getSecurityUserProviderTools, listSecurityUserProviders, getSecurityUserProviderStats } from './tools/symfony-security-user-provider.js';
import { getPhpClosureTools, listPhpClosures, getPhpClosureStats } from './tools/php-closures.js';
import { getPhpSplatTools, listPhpSplatOperator, getPhpSplatStats } from './tools/php-splat-operator.js';
import { getPhpNeverTypeTools, listPhpNeverType, getPhpNeverTypeStats } from './tools/php-never-type.js';
import { getPhpTraitConflictTools, listPhpTraitConflicts, getPhpTraitConflictStats } from './tools/php-trait-conflicts.js';
import { getPhpNullCoalescingTools, listPhpNullCoalescing, getPhpNullCoalescingStats } from './tools/php-null-coalescing.js';
import { getPhpConstructorPromotionTools, listPhpConstructorPromotion, getPhpConstructorPromotionStats } from './tools/php-constructor-promotion.js';
import { getPhpLateStaticBindingTools, listPhpLateStaticBinding, getPhpLateStaticBindingStats } from './tools/php-late-static-binding.js';
import { getPhpArrayFunctionTools, listPhpArrayFunctions, getPhpArrayFunctionStats } from './tools/php-array-functions.js';
// Phase 30 tools
import { getDoctrineDqlWalkerTools, listDoctrineDqlWalkers, getDoctrineDqlWalkerStats } from './tools/doctrine-dql-walker.js';
import { getDbalEventListenerTools, listDbalEventListeners, getDbalEventListenerStats } from './tools/doctrine-dbal-event-listeners.js';
import { getDoctrineEntityProxyTools, listDoctrineEntityProxies, getDoctrineEntityProxyStats } from './tools/doctrine-entity-proxy.js';
import { getDoctrineAssociationFetchTools, listDoctrineAssociationFetches, getDoctrineAssociationFetchStats } from './tools/doctrine-association-fetch.js';
import { getDbalBulkInsertTools, listDbalBulkInserts, getDbalBulkInsertStats } from './tools/doctrine-dbal-bulk-insert.js';
import { getDoctrineShardingTools, listDoctrineShardingConfig, getDoctrineShardingStats } from './tools/doctrine-sharding.js';
import { getDbalSchemaDiffTools, listDbalSchemaDiffs, getDbalSchemaDiffStats } from './tools/doctrine-dbal-schema-diff.js';
import { getPhpUnitCustomAssertionTools, listPhpUnitCustomAssertions, getPhpUnitCustomAssertionStats } from './tools/phpunit-assertions-custom.js';
import { getPhpUnitTestDoubleTools, listPhpUnitTestDoubles, getPhpUnitTestDoubleStats } from './tools/phpunit-test-doubles.js';
import { getInfectionMutantTools, listInfectionConfig, getInfectionMutantStats } from './tools/infection-mutants.js';
// Phase 31 tools
import { getPhpSplDataStructureTools, listPhpSplDataStructures, getPhpSplDataStructureStats } from './tools/php-spl-data-structures.js';
import { getPhpImmutableValueObjectTools, listPhpImmutableValueObjects, getPhpImmutableValueObjectStats } from './tools/php-immutable-value-objects.js';
import { getPhpTypeCoercionTools, listPhpTypeCoercions, getPhpTypeCoercionStats } from './tools/php-type-coercion.js';
import { getPhpStaticMethodTools, listPhpStaticMethods, getPhpStaticMethodStats } from './tools/php-static-methods.js';
import { getPhpClosureScopeTools, listPhpClosureScopes, getPhpClosureScopeStats } from './tools/php-closure-scope.js';
import { getPhpContractTestTools, listPhpContractTests, getPhpContractTestStats } from './tools/php-contract-tests.js';
import { getConsoleEventTools, listSymfonyConsoleEvents, getSymfonyConsoleEventStats } from './tools/symfony-console-events.js';
import { getServerSentEventTools, listSymfonyServerSentEvents, getSymfonyServerSentEventStats } from './tools/symfony-server-sent-events.js';
import { getSecurityAccessTokenTools, listSymfonySecurityAccessTokens, getSymfonySecurityAccessTokenStats } from './tools/symfony-security-access-token.js';
import { getSecurityOidcTools, listSymfonySecurityOidc, getSymfonySecurityOidcStats } from './tools/symfony-security-oidc.js';
// Phase 32 tools
import { getSymfonyTypeInfoTools, listSymfonyTypeInfo, getSymfonyTypeInfoStats } from './tools/symfony-type-info.js';
import { getSymfonyJsonEncoderTools, listSymfonyJsonEncoder, getSymfonyJsonEncoderStats } from './tools/symfony-json-encoder.js';
import { getSymfonyTwigSecurityTools, listSymfonyTwigSecurity, getSymfonyTwigSecurityStats } from './tools/symfony-twig-security.js';
import { getSymfonyMonologHandlerTools, listSymfonyMonologHandlers, getSymfonyMonologHandlerStats } from './tools/symfony-monolog-handler.js';
import { getSymfonyMonologFormatterTools, listSymfonyMonologFormatters, getSymfonyMonologFormatterStats } from './tools/symfony-monolog-formatter.js';
import { getTwigFormRenderingTools, listTwigFormRendering, getTwigFormRenderingStats } from './tools/twig-form-rendering.js';
import { getSymfonyTwigUxIconTools, listSymfonyTwigUxIcons, getSymfonyTwigUxIconStats } from './tools/symfony-twig-ux-icons.js';
import { getSymfonyDebugVarDumperTools, listSymfonyDebugVarDumpers, getSymfonyDebugVarDumperStats } from './tools/symfony-debug-var-dumper.js';
import { getSymfonySchedulerTaskTools, listSymfonySchedulerTasks, getSymfonySchedulerTaskStats } from './tools/symfony-scheduler-tasks.js';
import { getSymfonyRateLimiterPolicyTools, listSymfonyRateLimiterPolicies, getSymfonyRateLimiterPolicyStats } from './tools/symfony-rate-limiter-policy.js';
// Phase 33 tools
import { getSymfonyCacheEarlyExpiryTools, listSymfonyCacheEarlyExpiry, getSymfonyCacheEarlyExpiryStats } from './tools/symfony-cache-early-expiry.js';
import { getSymfonyMessengerTransportDsnTools, listSymfonyMessengerTransportDsns, getSymfonyMessengerTransportDsnStats } from './tools/symfony-messenger-transport-dsn.js';
import { getSymfonyFormChoiceValueTools, listSymfonyFormChoiceValues, getSymfonyFormChoiceValueStats } from './tools/symfony-form-choice-value.js';
// Phase 34 tools
import { getPhpReadonlyClassTools, listPhpReadonlyClasses, getPhpReadonlyClassStats } from './tools/php-readonly-classes.js';
import { getPhpNamedConstructorTools, listPhpNamedConstructors, getPhpNamedConstructorStats } from './tools/php-named-constructors.js';
import { getPhpStreamWrapperTools, listPhpStreamWrappers, getPhpStreamWrapperStats } from './tools/php-stream-wrappers.js';
import { getPhpReflectionApiTools, listPhpReflectionApi, getPhpReflectionApiStats } from './tools/php-reflection-api.js';
import { getFormDataMapperTools, listSymfonyFormDataMappers, getSymfonyFormDataMapperStats } from './tools/symfony-form-data-mapper.js';
import { getControllerMapPayloadTools, listSymfonyControllerMapPayloads, getSymfonyControllerMapPayloadStats } from './tools/symfony-controller-map-payload.js';
import { getStringInflectorTools, listSymfonyStringInflectors, getSymfonyStringInflectorStats } from './tools/symfony-string-inflector.js';
import { getSymfonySerializerNameConverterTools, listSymfonySerializerNameConverters, getSymfonySerializerNameConverterStats } from './tools/symfony-serializer-name-converter.js';
import { getSymfonySerializerMaxDepthTools, listSymfonySerializerMaxDepths, getSymfonySerializerMaxDepthStats } from './tools/symfony-serializer-max-depth.js';
import { getSymfonySerializerTransformTools, listSymfonySerializerTransforms, getSymfonySerializerTransformStats } from './tools/symfony-serializer-transform.js';
import { getSymfonyUxReactTools, listSymfonyUxReact, getSymfonyUxReactStats } from './tools/symfony-ux-react.js';
import { getSymfonyUxVueTools, listSymfonyUxVue, getSymfonyUxVueStats } from './tools/symfony-ux-vue.js';
import { getSymfonyUxSvelteTools, listSymfonyUxSvelte, getSymfonyUxSvelteStats } from './tools/symfony-ux-svelte.js';
import { getSymfonyUxMapTools, listSymfonyUxMap, getSymfonyUxMapStats } from './tools/symfony-ux-map.js';
import { getDoctrineOrmProfilingTools, listDoctrineOrmProfiling, getDoctrineOrmProfilingStats } from './tools/doctrine-orm-profiling.js';
import { getSymfonyMimeMessageHeaderTools, listSymfonyMimeMessageHeaders, getSymfonyMimeMessageHeaderStats } from './tools/symfony-mime-message-headers.js';
import { getDoctrineEntityLockTools, listDoctrineEntityLocks, getDoctrineEntityLockStats } from './tools/doctrine-entity-lock.js';
import { getPhpCognitiveComplexityTools, listPhpCognitiveComplexity, getPhpCognitiveComplexityStats } from './tools/php-cognitive-complexity.js';
import { getPhpCopyPasteTools, listPhpCopyPastePatterns, getPhpCopyPasteStats } from './tools/php-copy-paste-detector.js';
import { getPhpPreloadingTools, listPhpPreloadingConfig, getPhpPreloadingStats } from './tools/php-preloading-config.js';
import { getPhpIniTools, listPhpIniSettings, getPhpIniStats } from './tools/php-ini-analysis.js';
import { getPhpFpmTools, listPhpFpmConfig, getPhpFpmStats } from './tools/php-fpm-config.js';
import { getPhpGcTools, listPhpGcConfig, getPhpGcStats } from './tools/php-gc-config.js';
import { getPhpMetricsTools, listPhpMetricsConfig, getPhpMetricsStats } from './tools/php-metrics-config.js';
import { getPhpmdTools, listPhpmdConfig, getPhpmdStats } from './tools/phpmd-config.js';
import { getPhpbenchTools, listPhpbenchConfig, getPhpbenchStats } from './tools/phpbench-config.js';
import { getGrumphpTools, listGrumphpConfig, getGrumphpStats } from './tools/grumphp-config.js';
import { getSymfonyCqrsTools, listSymfonyCqrsPatterns, getSymfonyCqrsStats } from './tools/symfony-cqrs-patterns.js';
import { getSymfonyEventSourcingTools, listSymfonyEventSourcing, getSymfonyEventSourcingStats } from './tools/symfony-event-sourcing.js';
import { getSymfonyOutboxTools, listSymfonyOutboxPatterns, getSymfonyOutboxStats } from './tools/symfony-outbox-pattern.js';
import { getSymfonyRemoteEventTools, listSymfonyRemoteEvents, getSymfonyRemoteEventStats } from './tools/symfony-remote-event.js';
import { getSymfonyEmojiUsageTools, listSymfonyEmojiUsage, getSymfonyEmojiStats } from './tools/symfony-emoji.js';
import { getSymfonyIntlTools, listSymfonyIntlConfig, getSymfonyIntlStats } from './tools/symfony-intl-config.js';
import { getSymfonyPsrBridgeTools, listSymfonyPsrBridge, getSymfonyPsrBridgeStats } from './tools/symfony-psr-bridge.js';
import { getSymfonyLocaleSwitcherTools, listSymfonyLocaleSwitcher, getSymfonyLocaleSwitcherStats } from './tools/symfony-locale-switcher.js';
import { getSymfonyStringEncodingTools, listSymfonyStringEncoding, getSymfonyStringEncodingStats } from './tools/symfony-string-encoding.js';
import { getSymfonyCacheInvalidationTools, listSymfonyCacheInvalidation, getSymfonyCacheInvalidationStats } from './tools/symfony-cache-invalidation.js';
import { getSymfonyCachePsr16Tools, listSymfonyCachePsr16, getSymfonyCachePsr16Stats } from './tools/symfony-cache-psr16.js';
import { getSymfonyValidatorPayloadTools, listSymfonyValidatorPayloads, getSymfonyValidatorPayloadStats } from './tools/symfony-validator-payload.js';
import { getSymfonyKernelBootTools, listSymfonyKernelBoot, getSymfonyKernelBootStats } from './tools/symfony-kernel-boot.js';
import { getSymfonyMailerInlinerTools, listSymfonyMailerInliner, getSymfonyMailerInlinerStats } from './tools/symfony-mailer-inliner.js';
import { getSymfonyMessengerGracefulShutdownTools, listSymfonyMessengerGracefulShutdown, getSymfonyMessengerGracefulShutdownStats } from './tools/symfony-messenger-graceful-shutdown.js';
import { getSymfonyFormAjaxTools, listSymfonyFormAjax, getSymfonyFormAjaxStats } from './tools/symfony-form-ajax.js';
import { getSymfonyStringNormalizationTools, listSymfonyStringNormalization, getSymfonyStringNormalizationStats } from './tools/symfony-string-normalization.js';
import { getSymfonyUxStimulusControllerTools, listSymfonyUxStimulusControllers, getSymfonyUxStimulusStats } from './tools/symfony-ux-stimulus-controllers.js';
import { getDoctrineUpsertTools, listDoctrineUpsertPatterns, getDoctrineUpsertStats } from './tools/doctrine-upsert-patterns.js';
import { getDoctrineTemporalTools, listDoctrineTemporalTables, getDoctrineTemporalStats } from './tools/doctrine-temporal-tables.js';
import { getDoctrineEncryptionTools, listDoctrineEncryption, getDoctrineEncryptionStats } from './tools/doctrine-encryption.js';
import { getDoctrinePostgresTools, listDoctrinePostgresFeatures, getDoctrinePostgresStats } from './tools/doctrine-postgres-specific.js';
import { getDoctrineMysqlTools, listDoctrineMysqlFeatures, getDoctrineMysqlStats } from './tools/doctrine-mysql-specific.js';
import { getDoctrineConnectionRetryTools, listDoctrineConnectionRetry, getDoctrineConnectionRetryStats } from './tools/doctrine-connection-retry.js';
import { getDoctrineHydrationTools, listDoctrineHydrationPerformance, getDoctrineHydrationStats } from './tools/doctrine-hydration-performance.js';
import { getDoctrineDbalQueryProfilingTools, listDoctrineDbalQueryProfiling, getDoctrineDbalQueryProfilingStats } from './tools/doctrine-dbal-query-profiling.js';
import { getApiProblemDetailsTools, listApiProblemDetails, getApiProblemDetailsStats } from './tools/api-problem-details.js';
import { getApiJsonLdContextTools, listApiJsonLdContext, getApiJsonLdContextStats } from './tools/api-json-ld-context.js';
import { getApiIdempotencyTools, listApiIdempotency, getApiIdempotencyStats } from './tools/api-idempotency.js';
import { getApiOpenApiSecuritySchemesTools, listApiOpenApiSecuritySchemes, getApiOpenApiSecuritySchemesStats } from './tools/api-openapi-security-schemes.js';
import { getPwaManifestTools, listPwaManifestConfig, getPwaManifestStats } from './tools/pwa-manifest-config.js';
import { getSymfonyAssetIntegrityTools, listSymfonyAssetIntegrity, getSymfonyAssetIntegrityStats } from './tools/symfony-asset-integrity.js';
import { getSymfonyTwigProfilingTools, listSymfonyTwigProfiling, getSymfonyTwigProfilingStats } from './tools/symfony-twig-profiling.js';
import { getSymfonyRoadrunnerTools, listSymfonyRoadrunnerConfig, getSymfonyRoadrunnerStats } from './tools/symfony-roadrunner-config.js';
import { getPrometheusMetricsTools, listPrometheusMetrics, getPrometheusMetricsStats } from './tools/prometheus-metrics.js';
import { getDatadogIntegrationTools, listDatadogIntegration, getDatadogIntegrationStats } from './tools/datadog-integration.js';
import { getNginxPhpFpmTools, listNginxPhpFpmConfig, getNginxPhpFpmStats } from './tools/nginx-php-fpm.js';
import { getComposerSecurityAuditTools, listComposerSecurityAudit, getComposerSecurityAuditStats } from './tools/composer-security-audit.js';
import { getSymfonyWebhookSecurityTools, listSymfonyWebhookSecurity, getSymfonyWebhookSecurityStats } from './tools/symfony-webhook-security.js';
import { getSymfonySecretsRotationTools, listSymfonySecretsRotation, getSymfonySecretsRotationStats } from './tools/symfony-secrets-rotation.js';
import { getPhpJitConfigTools, listPhpJitConfig, getPhpJitStats } from './tools/php-jit-config.js';
import { getPhpFfiTools, listPhpFfi, getPhpFfiStats } from './tools/php-ffi.js';
import { getPhpSodiumCryptoTools, listPhpSodiumCrypto, getPhpSodiumCryptoStats } from './tools/php-sodium-crypto.js';
import { getPhpPcreSecurityTools, listPhpPcreSecurity, getPhpPcreSecurityStats } from './tools/php-pcre-security.js';
import { getPhpRandomSecurityTools, listPhpRandomSecurity, getPhpRandomSecurityStats } from './tools/php-random-security.js';
import { getPhpMemoryManagementTools, listPhpMemoryManagement, getPhpMemoryManagementStats } from './tools/php-memory-management.js';
import { getPhpDeprecationPolyfillTools, listPhpDeprecationPolyfills, getPhpDeprecationPolyfillStats } from './tools/php-deprecation-polyfills.js';
import { getSymfonyLdapAuthTools, listSymfonyLdapAuth, getSymfonyLdapAuthStats } from './tools/symfony-ldap-auth.js';
import { getSymfonyTurboStreamsTools, listSymfonyTurboStreams, getSymfonyTurboStreamsStats } from './tools/symfony-turbo-streams.js';
import { getSymfonyHttpClientCachingTools, listSymfonyHttpClientCaching, getSymfonyHttpClientCachingStats } from './tools/symfony-http-client-caching.js';
import { getSymfonyMessengerCircuitBreakerTools, listSymfonyMessengerCircuitBreaker, getSymfonyMessengerCircuitBreakerStats } from './tools/symfony-messenger-circuit-breaker.js';
import { getSymfonyMessengerSagasTools, listSymfonyMessengerSagas, getSymfonyMessengerSagasStats } from './tools/symfony-messenger-sagas.js';
import { getSymfonyNotifierSmsTools, listSymfonyNotifierSms, getSymfonyNotifierSmsStats } from './tools/symfony-notifier-sms.js';
import { getSymfonyNotifierPushTools, listSymfonyNotifierPush, getSymfonyNotifierPushStats } from './tools/symfony-notifier-push.js';
import { getSymfonyUxTypedTools, listSymfonyUxTyped, getSymfonyUxTypedStats } from './tools/symfony-ux-typed.js';
import { getSymfonyUxTranslatorTools, listSymfonyUxTranslator, getSymfonyUxTranslatorStats } from './tools/symfony-ux-translator.js';
import { getSymfonyTranslationCacheTools, listSymfonyTranslationCache, getSymfonyTranslationCacheStats } from './tools/symfony-translation-cache.js';
import { getSymfonyMultiLanguageRoutingTools, listSymfonyMultiLanguageRouting, getSymfonyMultiLanguageRoutingStats } from './tools/symfony-multi-language-routing.js';
import { getSymfonyMailerQueuingTools, listSymfonyMailerQueuing, getSymfonyMailerQueuingStats } from './tools/symfony-mailer-queuing.js';
import { getSymfonySignedUrlTools, listSymfonySignedUrl, getSymfonySignedUrlStats } from './tools/symfony-signed-url.js';
import { getSymfonyFormHoneypotTools, listSymfonyFormHoneypot, getSymfonyFormHoneypotStats } from './tools/symfony-form-honeypot.js';
import { getDoctrineVersionedEntitiesTools, listDoctrineVersionedEntities, getDoctrineVersionedEntitiesStats } from './tools/doctrine-versioned-entities.js';
import { getDoctrineReadReplicaTools, listDoctrineReadReplica, getDoctrineReadReplicaStats } from './tools/doctrine-read-replica.js';
import { getDoctrineRawSqlTools, listDoctrineRawSql, getDoctrineRawSqlStats } from './tools/doctrine-raw-sql.js';
import { getDoctrineEntityManagerScopeTools, listDoctrineEntityManagerScope, getDoctrineEntityManagerScopeStats } from './tools/doctrine-entity-manager-scope.js';
import { getVarnishConfigTools, listVarnishConfig, getVarnishConfigStats } from './tools/varnish-config.js';
import { getCdnConfigTools, listCdnConfig, getCdnConfigStats } from './tools/cdn-config.js';
import { getDockerComposeHealthTools, listDockerComposeHealth, getDockerComposeHealthStats } from './tools/docker-compose-health.js';
import { getRedisStreamsConfigTools, listRedisStreamsConfig, getRedisStreamsConfigStats } from './tools/redis-streams-config.js';
import { getRabbitmqConfigTools, listRabbitmqConfig, getRabbitmqConfigStats } from './tools/rabbitmq-config.js';
import { getKafkaIntegrationTools, listKafkaIntegration, getKafkaIntegrationStats } from './tools/kafka-integration.js';
import { getSonarqubeConfigTools, listSonarqubeConfig, getSonarqubeConfigStats } from './tools/sonarqube-config.js';
import { getSqsMessengerConfigTools, listSqsMessengerConfig, getSqsMessengerConfigStats } from './tools/sqs-messenger-config.js';
import { getHtmxIntegrationTools, listHtmxIntegration, getHtmxIntegrationStats } from './tools/htmx-integration.js';
import { getAlpineJsIntegrationTools, listAlpineJsIntegration, getAlpineJsIntegrationStats } from './tools/alpine-js-integration.js';
import { getApiHateoasTools, listApiHateoas, getApiHateoasStats } from './tools/api-hateoas.js';
import { getStripeIntegrationTools, listStripeIntegration, getStripeIntegrationStats } from './tools/stripe-integration.js';
import { getSamlAuthTools, listSamlAuth, getSamlAuthStats } from './tools/saml-auth.js';
import { getGrpcIntegrationTools, listGrpcIntegration, getGrpcIntegrationStats } from './tools/grpc-integration.js';
import { getApiCursorPaginationTools, listApiCursorPagination, getApiCursorPaginationStats } from './tools/api-cursor-pagination.js';
import { getElasticsearchMappingConfigTools, listElasticsearchMappingConfig, getElasticsearchMappingConfigStats } from './tools/elasticsearch-mapping-config.js';
import { getGdprComplianceTools, listGdprCompliance, getGdprComplianceStats } from './tools/gdpr-compliance.js';
import { getPhpOpensslPatternsTools, listPhpOpensslPatterns, getPhpOpensslPatternsStats } from './tools/php-openssl-patterns.js';
import { getSecurityAuditLogTools, listSecurityAuditLog, getSecurityAuditLogStats } from './tools/security-audit-log.js';
import { getApiKeyRotationTools, listApiKeyRotation, getApiKeyRotationStats } from './tools/api-key-rotation.js';
import { getPdfGenerationTools, listPdfGeneration, getPdfGenerationStats } from './tools/pdf-generation.js';
import { getImageProcessingTools, listImageProcessing, getImageProcessingStats } from './tools/image-processing.js';
import { getExcelGenerationTools, listExcelGeneration, getExcelGenerationStats } from './tools/excel-generation.js';
import { getFileArchiveTools, listFileArchive, getFileArchiveStats } from './tools/file-archive.js';
import { getNewRelicIntegrationTools, listNewRelicIntegration, getNewRelicIntegrationStats } from './tools/new-relic-integration.js';
// Phase 33 tools
import { getPhpCurlSecurityTools, listPhpCurlSecurity, getPhpCurlSecurityStats } from './tools/php-curl-security.js';
import { getPhpXmlSecurityTools, listPhpXmlSecurity, getPhpXmlSecurityStats } from './tools/php-xml-security.js';
import { getPhpLdapFunctionTools, listPhpLdapFunctions, getPhpLdapFunctionStats } from './tools/php-ldap-functions.js';
import { getPhpHtml5ParserTools, listPhpHtml5Parser, getPhpHtml5ParserStats } from './tools/php-html5-parser.js';
import { getPhpSessionSecurityTools, listPhpSessionSecurity, getPhpSessionSecurityStats } from './tools/php-session-security.js';
import { getPhpOpcacheSettingTools, listPhpOpcacheSettings, getPhpOpcacheSettingStats } from './tools/php-opcache-settings.js';
import { getPhpTypeJugglingTools, listPhpTypeJuggling, getPhpTypeJugglingStats } from './tools/php-type-juggling.js';
import { getPhpStringInterpolationSecurityTools, listPhpStringInterpolationSecurity, getPhpStringInterpolationSecurityStats } from './tools/php-string-interpolation-security.js';
import { getPhpMemoryProfilingTools, listPhpMemoryProfiling, getPhpMemoryProfilingStats } from './tools/php-memory-profiling.js';
import { getPhpCodesnifferConfigTools, listPhpCodesnifferConfig, getPhpCodesnifferConfigStats } from './tools/php-codesniffer-config.js';
import { getSymfonyDeprecationTools, listSymfonyDeprecations, getSymfonyDeprecationStats } from './tools/symfony-deprecation-detector.js';
import { getSymfonyLiveComponentSecurityTools, listSymfonyLiveComponentSecurity, getSymfonyLiveComponentSecurityStats } from './tools/symfony-ux-livecomponent-security.js';
import { getSymfonyChatNotifierTools, listSymfonyChatNotifiers, getSymfonyChatNotifierStats } from './tools/symfony-notifier-chat.js';
import { getSymfonyCacheRedisClusterTools, listSymfonyCacheRedisCluster, getSymfonyCacheRedisClusterStats } from './tools/symfony-cache-redis-cluster.js';
import { getSymfonySecurityBruteforceTools, listSymfonySecurityBruteforce, getSymfonySecurityBruteforceStats } from './tools/symfony-security-bruteforce.js';
import { getSymfonyMessengerMonitoringTools, listSymfonyMessengerMonitoring, getSymfonyMessengerMonitoringStats } from './tools/symfony-messenger-monitoring.js';
import { getSymfonyDiConditionalServiceTools, listSymfonyDiConditionalServices, getSymfonyDiConditionalServiceStats } from './tools/symfony-di-conditional-services.js';
import { getSymfonyMailerBounceHandlingTools, listSymfonyMailerBounceHandling, getSymfonyMailerBounceHandlingStats } from './tools/symfony-mailer-bounce-handling.js';
import { getSymfonyUxTurboFrameTools, listSymfonyUxTurboFrames, getSymfonyUxTurboFrameStats } from './tools/symfony-ux-turbo-frame.js';
import { getSymfonyHealthEndpointSecurityTools, listSymfonyHealthEndpointSecurity, getSymfonyHealthEndpointSecurityStats } from './tools/symfony-health-endpoint-security.js';
import { getSymfonyWorkflowPersistenceTools, listSymfonyWorkflowPersistence, getSymfonyWorkflowPersistenceStats } from './tools/symfony-workflow-persistence.js';
import { getSymfonyRoutingConflictTools, listSymfonyRoutingConflicts, getSymfonyRoutingConflictStats } from './tools/symfony-routing-conflicts.js';
import { getApiJsonApiFormatTools, listApiJsonApiFormat, getApiJsonApiFormatStats } from './tools/api-jsonapi-format.js';
import { getApiGraphqlSecurityTools, listApiGraphqlSecurity, getApiGraphqlSecurityStats } from './tools/api-graphql-security.js';
import { getApiResponseCompressionTools, listApiResponseCompression, getApiResponseCompressionStats } from './tools/api-response-compression.js';
import { getApiContractTestingTools, listApiContractTesting, getApiContractTestingStats } from './tools/api-contract-testing.js';
import { getDoctrineColumnDefaultTools, listDoctrineColumnDefaults, getDoctrineColumnDefaultStats } from './tools/doctrine-column-defaults.js';
import { getDoctrineFullTextSearchTools, listDoctrineFullTextSearch, getDoctrineFullTextSearchStats } from './tools/doctrine-full-text-search.js';
import { getPgBouncerConfigTools, listPgBouncerConfig, getPgBouncerConfigStats } from './tools/pgbouncer-config.js';
import { getMemcachedIntegrationTools, listMemcachedIntegration, getMemcachedIntegrationStats } from './tools/memcached-integration.js';
import { getApacheConfigTools, listApacheConfig, getApacheConfigStats } from './tools/apache-config.js';
import { getFrankenPhpConfigTools, listFrankenPhpConfig, getFrankenPhpConfigStats } from './tools/frankenphp-config.js';
import { getSwooleOpenSwooleTools, listSwooleOpenSwoole, getSwooleOpenSwooleStats } from './tools/swoole-openswoole.js';
import { getAwsLambdaBrefTools, listAwsLambdaBref, getAwsLambdaBrefStats } from './tools/aws-lambda-bref.js';
import { getGithubActionsConfigTools, listGithubActionsConfig, getGithubActionsConfigStats } from './tools/github-actions-config.js';
import { getGitlabCiConfigTools, listGitlabCiConfig, getGitlabCiConfigStats } from './tools/gitlab-ci-config.js';
import { getGrafanaDashboardTools, listGrafanaDashboard, getGrafanaDashboardStats } from './tools/grafana-dashboard.js';
import { getCloudwatchIntegrationTools, listCloudwatchIntegration, getCloudwatchIntegrationStats } from './tools/cloudwatch-integration.js';
import { getDockerSecurityConfigTools, listDockerSecurityConfig, getDockerSecurityConfigStats } from './tools/docker-security-config.js';
import { getWebsocketIntegrationTools, listWebsocketIntegration, getWebsocketIntegrationStats } from './tools/websocket-integration.js';
import { getDeptracConfigTools, listDeptracConfig, getDeptracConfigStats } from './tools/deptrac-config.js';
import { getPhpArkitectConfigTools, listPhpArkitectConfig, getPhpArkitectConfigStats } from './tools/phparkitect-config.js';
import { getPantherTestingTools, listPantherTesting, getPantherTestingStats } from './tools/panther-testing.js';
import { getZenstruckFoundryConfigTools, listZenstruckFoundryConfig, getZenstruckFoundryConfigStats } from './tools/zenstruck-foundry-config.js';
import { getPhpspecConfigTools, listPhpspecConfig, getPhpspecConfigStats } from './tools/phpspec-config.js';
import { getCodeceptionConfigTools, listCodeceptionConfig, getCodeceptionConfigStats } from './tools/codeception-config.js';
import { getMeilisearchIntegrationTools, listMeilisearchIntegration, getMeilisearchIntegrationStats } from './tools/meilisearch-integration.js';
import { getWebAuthnIntegrationTools, listWebAuthnIntegration, getWebAuthnIntegrationStats } from './tools/webauthn-integration.js';
import { getPaypalIntegrationTools, listPaypalIntegration, getPaypalIntegrationStats } from './tools/paypal-integration.js';
import { getEasyCodingStandardTools, listEasyCodingStandard, getEasyCodingStandardStats } from './tools/easy-coding-standard.js';
// Phase 34 tools
import { getPhpXdebugConfigTools, listPhpXdebugConfig, getPhpXdebugConfigStats } from './tools/php-xdebug-config.js';
import { getPhpComposerAutoloadOptimizeTools, listPhpComposerAutoloadOptimize, getPhpComposerAutoloadOptimizeStats } from './tools/php-composer-autoload-optimize.js';
import { getPhpIntlPatternsTools, listPhpIntlPatterns, getPhpIntlPatternsStats } from './tools/php-intl-patterns.js';
import { getPhpSoapPatternsTools, listPhpSoapPatterns, getPhpSoapPatternsStats } from './tools/php-soap-patterns.js';
import { getPhpZipArchiveTools, listPhpZipArchive, getPhpZipArchiveStats } from './tools/php-zip-archive.js';
import { getPhpMbstringPatternsTools, listPhpMbstringPatterns, getPhpMbstringPatternsStats } from './tools/php-mbstring-patterns.js';
import { getPhpObjectSerializationTools, listPhpObjectSerialization, getPhpObjectSerializationStats } from './tools/php-object-serialization.js';
import { getPhpBacktraceDebugTools, listPhpBacktraceDebug, getPhpBacktraceDebugStats } from './tools/php-backtrace-debug.js';
import { getPhpUuidGenerationTools, listPhpUuidGeneration, getPhpUuidGenerationStats } from './tools/php-uuid-generation.js';
import { getPhpWeakMapTools, listPhpWeakMap, getPhpWeakMapStats } from './tools/php-weak-map.js';
import { getSymfonyEsiConfigTools, listSymfonyEsiConfig, getSymfonyEsiConfigStats } from './tools/symfony-esi-config.js';
import { getSymfonyHttp2PushTools, listSymfonyHttp2Push, getSymfonyHttp2PushStats } from './tools/symfony-http2-push.js';
import { getSymfonyCacheRedisSentinelTools, listSymfonyCacheRedisSentinel, getSymfonyCacheRedisSentinelStats } from './tools/symfony-cache-redis-sentinel.js';
import { getSymfonyWorkflowStateMachineTools, listSymfonyWorkflowStateMachine, getSymfonyWorkflowStateMachineStats } from './tools/symfony-workflow-state-machine.js';
import { getSymfonyTwigCacheConfigTools, listSymfonyTwigCacheConfig, getSymfonyTwigCacheConfigStats } from './tools/symfony-twig-cache-config.js';
import { getSymfonyConsoleDaemonTools, listSymfonyConsoleDaemon, getSymfonyConsoleDaemonStats } from './tools/symfony-console-daemon.js';
import { getSymfonyTranslationExtractorsTools, listSymfonyTranslationExtractors, getSymfonyTranslationExtractorsStats } from './tools/symfony-translation-extractors.js';
import { getSymfonyMessengerCompetingConsumersTools, listSymfonyMessengerCompetingConsumers, getSymfonyMessengerCompetingConsumersStats } from './tools/symfony-messenger-competing-consumers.js';
import { getSymfonyAssetPreloadHintsTools, listSymfonyAssetPreloadHints, getSymfonyAssetPreloadHintsStats } from './tools/symfony-asset-preload-hints.js';
import { getSymfonyFormCompoundTypesTools, listSymfonyFormCompoundTypes, getSymfonyFormCompoundTypesStats } from './tools/symfony-form-compound-types.js';
import { getSymfonySerializerCircularReferenceTools, listSymfonySerializerCircularReference, getSymfonySerializerCircularReferenceStats } from './tools/symfony-serializer-circular-reference.js';
import { getSymfonyDataPipelinePatternsTools, listSymfonyDataPipelinePatterns, getSymfonyDataPipelinePatternsStats } from './tools/symfony-data-pipeline-patterns.js';
import { getSymfonyConsoleProgressBarTools, listSymfonyConsoleProgressBar, getSymfonyConsoleProgressBarStats } from './tools/symfony-console-progress-bar.js';
import { getSymfonyHttpClientConcurrentTools, listSymfonyHttpClientConcurrent, getSymfonyHttpClientConcurrentStats } from './tools/symfony-http-client-concurrent.js';
import { getSymfonyDoctrineMetadataCacheTools, listSymfonyDoctrineMetadataCache, getSymfonyDoctrineMetadataCacheStats } from './tools/symfony-doctrine-metadata-cache.js';
import { getSymfonySonataAdminTools, listSymfonySonataAdmin, getSymfonySonataAdminStats } from './tools/symfony-sonata-admin.js';
import { getSymfonyEnlightenAnalysisTools, listSymfonyEnlightenAnalysis, getSymfonyEnlightenAnalysisStats } from './tools/symfony-enlighten-analysis.js';
import { getSymfonyDoctrineMigrationRollbackTools, listSymfonyDoctrineMigrationRollback, getSymfonyDoctrineMigrationRollbackStats } from './tools/symfony-doctrine-migration-rollback.js';
import { getSymfonyRateLimiterAlgorithmsTools, listSymfonyRateLimiterAlgorithms, getSymfonyRateLimiterAlgorithmsStats } from './tools/symfony-rate-limiter-algorithms.js';
import { getSymfonyMessengerPauseResumeTools, listSymfonyMessengerPauseResume, getSymfonyMessengerPauseResumeStats } from './tools/symfony-messenger-pause-resume.js';
import { getCaddyServerConfigTools, listCaddyServerConfig, getCaddyServerConfigStats } from './tools/caddy-server-config.js';
import { getFlyIoConfigTools, listFlyIoConfig, getFlyIoConfigStats } from './tools/fly-io-config.js';
import { getHerokuConfigTools, listHerokuConfig, getHerokuConfigStats } from './tools/heroku-config.js';
import { getCircleCiConfigTools, listCircleCiConfig, getCircleCiConfigStats } from './tools/circleci-config.js';
import { getJenkinsConfigTools, listJenkinsConfig, getJenkinsConfigStats } from './tools/jenkins-config.js';
import { getTerraformConfigTools, listTerraformConfig, getTerraformConfigStats } from './tools/terraform-config.js';
import { getHelmChartsConfigTools, listHelmChartsConfig, getHelmChartsConfigStats } from './tools/helm-charts-config.js';
import { getCloudflareConfigTools, listCloudflareConfig, getCloudflareConfigStats } from './tools/cloudflare-config.js';
import { getAwsEcsConfigTools, listAwsEcsConfig, getAwsEcsConfigStats } from './tools/aws-ecs-config.js';
import { getAzurePipelinesConfigTools, listAzurePipelinesConfig, getAzurePipelinesConfigStats } from './tools/azure-pipelines-config.js';
import { getTwilioIntegrationTools, listTwilioIntegration, getTwilioIntegrationStats } from './tools/twilio-integration.js';
import { getSendgridIntegrationTools, listSendgridIntegration, getSendgridIntegrationStats } from './tools/sendgrid-integration.js';
import { getAwsS3IntegrationTools, listAwsS3Integration, getAwsS3IntegrationStats } from './tools/aws-s3-integration.js';
import { getAlgoliaIntegrationTools, listAlgoliaIntegration, getAlgoliaIntegrationStats } from './tools/algolia-integration.js';
import { getBugsnagIntegrationTools, listBugsnagIntegration, getBugsnagIntegrationStats } from './tools/bugsnag-integration.js';
import { getOpenAiIntegrationTools, listOpenAiIntegration, getOpenAiIntegrationStats } from './tools/openai-integration.js';
import { getSlackWebhookIntegrationTools, listSlackWebhookIntegration, getSlackWebhookIntegrationStats } from './tools/slack-webhook-integration.js';
import { getOwaspDependencyCheckTools, listOwaspDependencyCheck, getOwaspDependencyCheckStats } from './tools/owasp-dependency-check.js';
import { getVaultIntegrationTools, listVaultIntegration, getVaultIntegrationStats } from './tools/vault-integration.js';
import { getRabbitmqManagementApiTools, listRabbitmqManagementApi, getRabbitmqManagementApiStats } from './tools/rabbitmq-management-api.js';
// Phase 35 tools
import { getPhpPdoPatternsTools, listPhpPdoPatterns, getPhpPdoPatternsStats } from './tools/php-pdo-patterns.js';
import { getPhpTypeNarrowingTools, listPhpTypeNarrowing, getPhpTypeNarrowingStats } from './tools/php-type-narrowing.js';
import { getPhpHeredocNowdocTools, listPhpHeredocNowdoc, getPhpHeredocNowdocStats } from './tools/php-heredoc-nowdoc.js';
import { getPhpFileInclusionSecurityTools, listPhpFileInclusionSecurity, getPhpFileInclusionSecurityStats } from './tools/php-file-inclusion-security.js';
import { getSymfonyLockStoreConfigTools, listSymfonyLockStoreConfig, getSymfonyLockStoreConfigStats } from './tools/symfony-lock-store-config.js';
import { getSymfonyHttpCacheStoreTools, listSymfonyHttpCacheStore, getSymfonyHttpCacheStoreStats } from './tools/symfony-http-cache-store.js';
import { getSymfonyTranslationYamlLintTools, listSymfonyTranslationYamlLint, getSymfonyTranslationYamlLintStats } from './tools/symfony-translation-yaml-lint.js';
import { getSymfonySerializerContextBuilderTools, listSymfonySerializerContextBuilder, getSymfonySerializerContextBuilderStats } from './tools/symfony-serializer-context-builder.js';
import { getSymfonyPermissionsPolicyTools, listSymfonyPermissionsPolicy, getSymfonyPermissionsPolicyStats } from './tools/symfony-permissions-policy.js';
import { getSymfonySchedulerTransportConfigTools, listSymfonySchedulerTransportConfig, getSymfonySchedulerTransportConfigStats } from './tools/symfony-scheduler-transport-config.js';
import { getSymfonyDoctrineSqlLoggerTools, listSymfonyDoctrineSqlLogger, getSymfonyDoctrineSqlLoggerStats } from './tools/symfony-doctrine-sql-logger.js';
import { getBitbucketPipelinesConfigTools, listBitbucketPipelinesConfig, getBitbucketPipelinesConfigStats } from './tools/bitbucket-pipelines-config.js';
import { getDigitalOceanAppPlatformTools, listDigitalOceanAppPlatform, getDigitalOceanAppPlatformStats } from './tools/digitalocean-app-platform.js';
import { getRenderDeployConfigTools, listRenderDeployConfig, getRenderDeployConfigStats } from './tools/render-deploy-config.js';
import { getGoogleCloudRunConfigTools, listGoogleCloudRunConfig, getGoogleCloudRunConfigStats } from './tools/google-cloud-run-config.js';
import { getFirebaseIntegrationTools, listFirebaseIntegration, getFirebaseIntegrationStats } from './tools/firebase-integration.js';
import { getMailgunIntegrationTools, listMailgunIntegration, getMailgunIntegrationStats } from './tools/mailgun-integration.js';
import { getBraintreeIntegrationTools, listBraintreeIntegration, getBraintreeIntegrationStats } from './tools/braintree-integration.js';
import { getGithubApiIntegrationTools, listGithubApiIntegration, getGithubApiIntegrationStats } from './tools/github-api-integration.js';
import { getShopifyIntegrationTools, listShopifyIntegration, getShopifyIntegrationStats } from './tools/shopify-integration.js';
// Phase 36 tools
import { getPhpJsonEncodeFlagsTools, listPhpJsonEncodeFlags, getPhpJsonEncodeFlagsStats } from './tools/php-json-encode-flags.js';
import { getPhpSprintfTypeSafetyTools, listPhpSprintfTypeSafety, getPhpSprintfTypeSafetyStats } from './tools/php-sprintf-type-safety.js';
import { getPhpDateTimezoneTools, listPhpDateTimezone, getPhpDateTimezoneStats } from './tools/php-date-timezone.js';
import { getPhpGdSecurityTools, listPhpGdSecurity, getPhpGdSecurityStats } from './tools/php-gd-security.js';
import { getPhpImapPatternsTools, listPhpImapPatterns, getPhpImapPatternsStats } from './tools/php-imap-patterns.js';
import { getSymfonyMessengerRoutingTableTools, listSymfonyMessengerRoutingTable, getSymfonyMessengerRoutingTableStats } from './tools/symfony-messenger-routing-table.js';
import { getSymfonyCacheNamespaceTools, listSymfonyCacheNamespace, getSymfonyCacheNamespaceStats } from './tools/symfony-cache-namespace.js';
import { getSymfonyValidatorAutoMappingTools, listSymfonyValidatorAutoMapping, getSymfonyValidatorAutoMappingStats } from './tools/symfony-validator-auto-mapping.js';
import { getSymfonyContainerCompileTools, listSymfonyContainerCompile, getSymfonyContainerCompileStats } from './tools/symfony-container-compile.js';
import { getDoctrineCustomPlatformTools, listDoctrineCustomPlatform, getDoctrineCustomPlatformStats } from './tools/doctrine-custom-platform.js';
import { getAwsSesIntegrationTools, listAwsSesIntegration, getAwsSesIntegrationStats } from './tools/aws-ses-integration.js';
import { getPusherIntegrationTools, listPusherIntegration, getPusherIntegrationStats } from './tools/pusher-integration.js';
import { getCloudinaryIntegrationTools, listCloudinaryIntegration, getCloudinaryIntegrationStats } from './tools/cloudinary-integration.js';
import { getHubspotIntegrationTools, listHubspotIntegration, getHubspotIntegrationStats } from './tools/hubspot-integration.js';
import { getNetlifyDeployConfigTools, listNetlifyDeployConfig, getNetlifyDeployConfigStats } from './tools/netlify-deploy-config.js';
import { getVercelDeployConfigTools, listVercelDeployConfig, getVercelDeployConfigStats } from './tools/vercel-deploy-config.js';
import { getPhpBenchmarkPatternsTools, listPhpBenchmarkPatterns, getPhpBenchmarkPatternsStats } from './tools/php-benchmark-patterns.js';
import { getPhpFtpSftpPatternsTools, listPhpFtpSftpPatterns, getPhpFtpSftpPatternsStats } from './tools/php-ftp-sftp-patterns.js';
import { getNewrelicPhpAgentTools, listNewrelicPhpAgent, getNewrelicPhpAgentStats } from './tools/newrelic-php-agent.js';
import { getPhpCsvParsingTools, listPhpCsvParsing, getPhpCsvParsingStats } from './tools/php-csv-parsing.js';
// Phase 37 tools
import { getPhpCommandInjectionTools, listPhpCommandInjection, getPhpCommandInjectionStats } from './tools/php-command-injection.js';
import { getPhpSsrfPatternsTools, listPhpSsrfPatterns, getPhpSsrfPatternsStats } from './tools/php-ssrf-patterns.js';
import { getPhpOpenRedirectTools, listPhpOpenRedirect, getPhpOpenRedirectStats } from './tools/php-open-redirect.js';
import { getPhpXssPatternsTools, listPhpXssPatterns, getPhpXssPatternsStats } from './tools/php-xss-patterns.js';
import { getPhpTimingAttackTools, listPhpTimingAttack, getPhpTimingAttackStats } from './tools/php-timing-attack.js';
import { getPhpOutputBufferingTools, listPhpOutputBuffering, getPhpOutputBufferingStats } from './tools/php-output-buffering.js';
import { getPhpBcmathPatternsTools, listPhpBcmathPatterns, getPhpBcmathPatternsStats } from './tools/php-bcmath-patterns.js';
import { getPhpDomXpathTools, listPhpDomXpath, getPhpDomXpathStats } from './tools/php-dom-xpath.js';
import { getPhpSignalHandlingTools, listPhpSignalHandling, getPhpSignalHandlingStats } from './tools/php-signal-handling.js';
import { getPhpXslTransformationTools, listPhpXslTransformation, getPhpXslTransformationStats } from './tools/php-xsl-transformation.js';
import { getPhpParallelExtensionTools, listPhpParallelExtension, getPhpParallelExtensionStats } from './tools/php-parallel-extension.js';
import { getPhpLazyObjectsTools, listPhpLazyObjects, getPhpLazyObjectsStats } from './tools/php-lazy-objects.js';
import { getPhpArrayUnpackingTools, listPhpArrayUnpacking, getPhpArrayUnpackingStats } from './tools/php-array-unpacking.js';
import { getPhpBackedEnumPatternsTools, listPhpBackedEnumPatterns, getPhpBackedEnumPatternsStats } from './tools/php-backed-enum-patterns.js';
import { getPhpFileLockingTools, listPhpFileLocking, getPhpFileLockingStats } from './tools/php-file-locking.js';
import { getSymfonyFormTypeGuesserTools, listSymfonyFormTypeGuesser, getSymfonyFormTypeGuesserStats } from './tools/symfony-form-type-guesser.js';
import { getSymfonyValidatorSequenceProviderTools, listSymfonyValidatorSequenceProvider, getSymfonyValidatorSequenceProviderStats } from './tools/symfony-validator-sequence-provider.js';
import { getSymfonyMonologRotationTools, listSymfonyMonologRotation, getSymfonyMonologRotationStats } from './tools/symfony-monolog-rotation.js';
import { getSymfonyJsonLoginTools, listSymfonyJsonLogin, getSymfonyJsonLoginStats } from './tools/symfony-json-login.js';
import { getSymfonyHttpMiddlewareTools, listSymfonyHttpMiddleware, getSymfonyHttpMiddlewareStats } from './tools/symfony-http-middleware.js';
import { getSymfonyUxStimulusValuesTools, listSymfonyUxStimulusValues, getSymfonyUxStimulusValuesStats } from './tools/symfony-ux-stimulus-values.js';
import { getSymfonyNotifierStatusTools, listSymfonyNotifierStatus, getSymfonyNotifierStatusStats } from './tools/symfony-notifier-status.js';
import { getFosRestBundleTools, listFosRestBundle, getFosRestBundleStats } from './tools/fos-rest-bundle.js';
import { getNelmioSecurityBundleTools, listNelmioSecurityBundle, getNelmioSecurityBundleStats } from './tools/nelmio-security-bundle.js';
import { getDoctrineGedmoTreeTools, listDoctrineGedmoTree, getDoctrineGedmoTreeStats } from './tools/doctrine-gedmo-tree.js';
import { getDoctrineGedmoTranslatableTools, listDoctrineGedmoTranslatable, getDoctrineGedmoTranslatableStats } from './tools/doctrine-gedmo-translatable.js';
import { getDoctrineGedmoSluggableTools, listDoctrineGedmoSluggable, getDoctrineGedmoSluggableStats } from './tools/doctrine-gedmo-sluggable.js';
import { getDoctrineGedmoBlameableTools, listDoctrineGedmoBlameable, getDoctrineGedmoBlameableStats } from './tools/doctrine-gedmo-blameable.js';
import { getDockerSwarmConfigTools, listDockerSwarmConfig, getDockerSwarmConfigStats } from './tools/docker-swarm-config.js';
import { getKubernetesManifestsTools, listKubernetesManifests, getKubernetesManifestsStats } from './tools/kubernetes-manifests.js';
import { getLokiLogConfigTools, listLokiLogConfig, getLokiLogConfigStats } from './tools/loki-log-config.js';
import { getNginxUnitConfigTools, listNginxUnitConfig, getNginxUnitConfigStats } from './tools/nginx-unit-config.js';
import { getOauth2ServerConfigTools, listOauth2ServerConfig, getOauth2ServerConfigStats } from './tools/oauth2-server-config.js';
import { getRedisPubsubPatternsTools, listRedisPubsubPatterns, getRedisPubsubPatternsStats } from './tools/redis-pubsub-patterns.js';
import { getKafkaSchemaRegistryTools, listKafkaSchemaRegistry, getKafkaSchemaRegistryStats } from './tools/kafka-schema-registry.js';
import { getSqsDlqConfigTools, listSqsDlqConfig, getSqsDlqConfigStats } from './tools/sqs-dlq-config.js';
import { getStripeBillingSubscriptionsTools, listStripeBillingSubscriptions, getStripeBillingSubscriptionsStats } from './tools/stripe-billing-subscriptions.js';
import { getPaypalCheckoutV2Tools, listPaypalCheckoutV2, getPaypalCheckoutV2Stats } from './tools/paypal-checkout-v2.js';
import { getGoogleOauthIntegrationTools, listGoogleOauthIntegration, getGoogleOauthIntegrationStats } from './tools/google-oauth-integration.js';
import { getMicrosoftGraphIntegrationTools, listMicrosoftGraphIntegration, getMicrosoftGraphIntegrationStats } from './tools/microsoft-graph-integration.js';
import { getAwsCognitoIntegrationTools, listAwsCognitoIntegration, getAwsCognitoIntegrationStats } from './tools/aws-cognito-integration.js';
import { getAwsCloudfrontConfigTools, listAwsCloudfrontConfig, getAwsCloudfrontConfigStats } from './tools/aws-cloudfront-config.js';
import { getSentryPerformanceTracingTools, listSentryPerformanceTracing, getSentryPerformanceTracingStats } from './tools/sentry-performance-tracing.js';
import { getDatadogCustomMetricsTools, listDatadogCustomMetrics, getDatadogCustomMetricsStats } from './tools/datadog-custom-metrics.js';
import { getElasticApmPhpTools, listElasticApmPhp, getElasticApmPhpStats } from './tools/elastic-apm-php.js';
import { getLeagueOauth2ClientTools, listLeagueOauth2Client, getLeagueOauth2ClientStats } from './tools/league-oauth2-client.js';
import { getPhpunitTestIsolationTools, listPhpunitTestIsolation, getPhpunitTestIsolationStats } from './tools/phpunit-test-isolation.js';
import { getPhpunitTestNamingTools, listPhpunitTestNaming, getPhpunitTestNamingStats } from './tools/phpunit-test-naming.js';
import { getPhpRectorUpgradeSetsTools, listPhpRectorUpgradeSets, getPhpRectorUpgradeSetsStats } from './tools/php-rector-upgrade-sets.js';
import { getPhpDateIntervalTools, listPhpDateInterval, getPhpDateIntervalStats } from './tools/php-date-interval.js';
// Phase 38 tools
import { getPhpDeserializationGadgetTools, listPhpDeserializationGadget, getPhpDeserializationGadgetStats } from './tools/php-deserialization-gadget.js';
import { getPhpFileUploadValidationTools, listPhpFileUploadValidation, getPhpFileUploadValidationStats } from './tools/php-file-upload-validation.js';
import { getPhpNullByteInjectionTools, listPhpNullByteInjection, getPhpNullByteInjectionStats } from './tools/php-null-byte-injection.js';
import { getPhpRegexInjectionTools, listPhpRegexInjection, getPhpRegexInjectionStats } from './tools/php-regex-injection.js';
import { getPhpHashAlgorithmSecurityTools, listPhpHashAlgorithmSecurity, getPhpHashAlgorithmSecurityStats } from './tools/php-hash-algorithm-security.js';
import { getPhpSocketProgrammingTools, listPhpSocketProgramming, getPhpSocketProgrammingStats } from './tools/php-socket-programming.js';
import { getPhpShmopIpcTools, listPhpShmopIpc, getPhpShmopIpcStats } from './tools/php-shmop-ipc.js';
import { getPhpPosixFunctionsTools, listPhpPosixFunctions, getPhpPosixFunctionsStats } from './tools/php-posix-functions.js';
import { getPhpConstantVisibilityTools, listPhpConstantVisibility, getPhpConstantVisibilityStats } from './tools/php-constant-visibility.js';
import { getPhpDnfTypesTools, listPhpDnfTypes, getPhpDnfTypeStats as getPhpDnfTypesStats } from './tools/php-dnf-types.js';
import { getPhpResourceHandleLeaksTools, listPhpResourceHandleLeaks, getPhpResourceHandleLeaksStats } from './tools/php-resource-handle-leaks.js';
import { getPhpIntegerOverflowTools, listPhpIntegerOverflow, getPhpIntegerOverflowStats } from './tools/php-integer-overflow.js';
import { getPhpTemplateInjectionTools, listPhpTemplateInjection, getPhpTemplateInjectionStats } from './tools/php-template-injection.js';
import { getPhpObjectInjectionTools, listPhpObjectInjection, getPhpObjectInjectionStats } from './tools/php-object-injection.js';
import { getPhpArrayFindFunctionsTools, listPhpArrayFindFunctions, getPhpArrayFindFunctionsStats } from './tools/php-array-find-functions.js';
import { getSymfonyTwigEmbedTools, listSymfonyTwigEmbed, getSymfonyTwigEmbedStats } from './tools/symfony-twig-embed.js';
import { getSymfonyValidatorUniqueEntityTools, listSymfonyValidatorUniqueEntity, getSymfonyValidatorUniqueEntityStats } from './tools/symfony-validator-unique-entity.js';
import { getSymfonyFormPreSetDataTools, listSymfonyFormPreSetData, getSymfonyFormPreSetDataStats } from './tools/symfony-form-pre-set-data.js';
import { getSymfonyVarDumperCastersTools, listSymfonyVarDumperCasters, getSymfonyVarDumperCastersStats } from './tools/symfony-var-dumper-casters.js';
import { getSymfonyTestHttpKernelTools, listSymfonyTestHttpKernel, getSymfonyTestHttpKernelStats } from './tools/symfony-test-http-kernel.js';
import { getSymfonyWorkflowParallelTransitionsTools, listSymfonyWorkflowParallelTransitions, getSymfonyWorkflowParallelTransitionsStats } from './tools/symfony-workflow-parallel-transitions.js';
import { getSymfonyMailerHtmlToTextTools, listSymfonyMailerHtmlToText, getSymfonyMailerHtmlToTextStats } from './tools/symfony-mailer-html-to-text.js';
import { getSymfonyConsoleHiddenCommandsTools, listSymfonyConsoleHiddenCommands, getSymfonyConsoleHiddenCommandsStats } from './tools/symfony-console-hidden-commands.js';
import { getSymfonyRoutingSubCollectionsTools, listSymfonyRoutingSubCollections, getSymfonyRoutingSubCollectionsStats } from './tools/symfony-routing-sub-collections.js';
import { getSymfonySecurityCustomVoterTools, listSymfonySecurityCustomVoter, getSymfonySecurityCustomVoterStats } from './tools/symfony-security-custom-voter.js';
import { getSymfonyMailerSmtpFallbackTools, listSymfonyMailerSmtpFallback, getSymfonyMailerSmtpFallbackStats } from './tools/symfony-mailer-smtp-fallback.js';
import { getSymfonyTranslationLintAllTools, listSymfonyTranslationLintAll, getSymfonyTranslationLintAllStats } from './tools/symfony-translation-lint-all.js';
import { getSymfonyCachePsr6AdaptersTools, listSymfonyCachePsr6Adapters, getSymfonyCachePsr6AdaptersStats } from './tools/symfony-cache-psr6-adapters.js';
import { getDoctrineDbalDriveroptionsTools, listDoctrineDbalDriveroptions, getDoctrineDbalDriveroptionsStats } from './tools/doctrine-dbal-driveroptions.js';
import { getDoctrineCompositePrimaryKeysTools, listDoctrineCompositePrimaryKeys, getDoctrineCompositePrimaryKeysStats } from './tools/doctrine-composite-primary-keys.js';
import { getTraefikConfigTools, listTraefikConfig, getTraefikConfigStats } from './tools/traefik-config.js';
import { getAnsiblePlaybookConfigTools, listAnsiblePlaybookConfig, getAnsiblePlaybookConfigStats } from './tools/ansible-playbook-config.js';
import { getPrometheusAlertingRulesTools, listPrometheusAlertingRules, getPrometheusAlertingRulesStats } from './tools/prometheus-alerting-rules.js';
import { getVaultDynamicSecretsTools, listVaultDynamicSecrets, getVaultDynamicSecretsStats } from './tools/vault-dynamic-secrets.js';
import { getConsulServiceDiscoveryTools, listConsulServiceDiscovery, getConsulServiceDiscoveryStats } from './tools/consul-service-discovery.js';
import { getGithubDependabotConfigTools, listGithubDependabotConfig, getGithubDependabotConfigStats } from './tools/github-dependabot-config.js';
import { getAwsParameterStoreTools, listAwsParameterStore, getAwsParameterStoreStats } from './tools/aws-parameter-store.js';
import { getAwsSecretsManagerTools, listAwsSecretsManager, getAwsSecretsManagerStats } from './tools/aws-secrets-manager.js';
import { getGoogleCloudStorageTools, listGoogleCloudStorage, getGoogleCloudStorageStats } from './tools/google-cloud-storage.js';
import { getAzureBlobStorageTools, listAzureBlobStorage, getAzureBlobStorageStats } from './tools/azure-blob-storage.js';
import { getMongodbIntegrationTools, listMongodbIntegration, getMongodbIntegrationStats } from './tools/mongodb-integration.js';
import { getElasticsearchPercolateTools, listElasticsearchPercolate, getElasticsearchPercolateStats } from './tools/elasticsearch-percolate.js';
import { getSegmentAnalyticsTools, listSegmentAnalytics, getSegmentAnalyticsStats } from './tools/segment-analytics.js';
import { getZendeskIntegrationTools, listZendeskIntegration, getZendeskIntegrationStats } from './tools/zendesk-integration.js';
import { getSqsFifoQueuesTools, listSqsFifoQueues, getSqsFifoQueuesStats } from './tools/sqs-fifo-queues.js';
import { getIntercomIntegrationTools, listIntercomIntegration, getIntercomIntegrationStats } from './tools/intercom-integration.js';
import { getPhpunitClockAssertionTools, listPhpunitClockAssertion, getPhpunitClockAssertionStats } from './tools/phpunit-clock-assertion.js';
import { getPhpunitSelfShuntingTools, listPhpunitSelfShunting, getPhpunitSelfShuntingStats } from './tools/phpunit-self-shunting.js';
import { getCypressE2eConfigTools, listCypressE2eConfig, getCypressE2eConfigStats } from './tools/cypress-e2e-config.js';
import { getPlaywrightE2eConfigTools, listPlaywrightE2eConfig, getPlaywrightE2eConfigStats } from './tools/playwright-e2e-config.js';
import pkg from '../package.json' with { type: 'json' };
const SERVER_VERSION: string = pkg.version;

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>;

function str(args: Record<string, unknown>, key: string): string {
  return (args[key] as string) ?? '';
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  return (args[key] as number) ?? fallback;
}

function buildToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  // Discovery meta-tools (always available, session-aware)
  handlers.set('list_tool_categories', () => listToolCategories());
  handlers.set('search_tools', (a) => searchTools(str(a, 'query'), num(a, 'limit', 8)));
  handlers.set('activate_category', (a) =>
    activateCategory(
      resolveSessionId(a['_meta'] as Record<string, unknown> | undefined),
      str(a, 'category'),
      (a['force'] as boolean) ?? false,
    )
  );
  handlers.set('get_active_tools', (a) =>
    getActiveTools(resolveSessionId(a['_meta'] as Record<string, unknown> | undefined))
  );
  handlers.set('deactivate_category', (a) =>
    deactivateCategory(
      resolveSessionId(a['_meta'] as Record<string, unknown> | undefined),
      str(a, 'category'),
    )
  );

  // Routes
  handlers.set('list_routes', (a) => listRoutes(str(a, 'app_path')));
  handlers.set('get_route_details', (a) => getRouteDetails(str(a, 'app_path'), str(a, 'route_name')));
  handlers.set('search_routes', (a) =>
    searchRoutesCommand(str(a, 'app_path'), str(a, 'query'), (a['type'] as 'name' | 'path' | 'controller' | 'all') || 'all')
  );
  handlers.set('list_http_methods', (a) => listHttpMethods(str(a, 'app_path')));

  // Services
  handlers.set('list_services', (a) => listServices(str(a, 'app_path')));
  handlers.set('get_service_details', (a) => getServiceDetails(str(a, 'app_path'), str(a, 'service_id')));
  handlers.set('search_services', (a) =>
    searchServicesCommand(str(a, 'app_path'), str(a, 'query'), (a['type'] as 'id' | 'class' | 'tag' | 'all') || 'all')
  );
  handlers.set('list_services_by_tag', (a) => listServicesByTag(str(a, 'app_path'), str(a, 'tag')));
  handlers.set('list_available_tags', (a) => listAvailableTags(str(a, 'app_path')));

  // Configuration
  handlers.set('get_app_environment', (a) => getAppEnvironment(str(a, 'app_path')));
  handlers.set('list_environment_variables', (a) => listEnvironmentVariables(str(a, 'app_path')));
  handlers.set('get_database_config', (a) => getDatabaseConfig(str(a, 'app_path')));
  handlers.set('get_services_config', (a) => getServicesConfig(str(a, 'app_path')));
  handlers.set('get_framework_config', (a) => getFrameworkConfig(str(a, 'app_path')));
  handlers.set('get_security_config', (a) => getSecurityConfig(str(a, 'app_path')));
  handlers.set('list_config_packages', (a) => listConfigPackages(str(a, 'app_path')));

  // Logs
  handlers.set('list_logs', (a) => listLogs(str(a, 'app_path'), a['environment'] as string | undefined));
  handlers.set('tail_log', (a) => tailLog(str(a, 'app_path'), str(a, 'file_name'), num(a, 'lines', 50)));
  handlers.set('search_log', (a) => searchLog(str(a, 'app_path'), str(a, 'file_name'), str(a, 'search_term')));
  handlers.set('get_error_summary', (a) => getErrorSummary(str(a, 'app_path'), str(a, 'file_name')));
  handlers.set('get_environment_logs', (a) => getEnvironmentLogs(str(a, 'app_path'), str(a, 'environment')));

  // Entities
  handlers.set('list_entities', (a) => listEntities(str(a, 'app_path')));
  handlers.set('get_entity_details', (a) => getEntityDetails(str(a, 'app_path'), str(a, 'entity_name')));
  handlers.set('search_entities', (a) => searchEntities(str(a, 'app_path'), str(a, 'query')));
  handlers.set('get_related_entities', (a) => getRelatedEntities(str(a, 'app_path'), str(a, 'entity_name')));
  handlers.set('get_entities_stats', (a) => getEntitiesStats(str(a, 'app_path')));

  // Database
  handlers.set('list_tables', (a) => listTables(str(a, 'app_path')));
  handlers.set('get_table_schema', (a) => getTableSchema(str(a, 'app_path'), str(a, 'table_name')));
  handlers.set('get_database_info', (a) => getDatabaseInfo(str(a, 'app_path')));
  handlers.set('search_tables', (a) => searchTables(str(a, 'app_path'), str(a, 'query')));
  handlers.set('validate_schema_mapping', (a) => validateSchemaMapping(str(a, 'app_path')));
  handlers.set('get_migration_status', (a) => getMigrationStatus(str(a, 'app_path')));

  // Controllers
  handlers.set('list_controllers', (a) => listControllers(str(a, 'app_path')));
  handlers.set('get_controller_actions', (a) => getControllerActions(str(a, 'app_path'), str(a, 'controller_name')));
  handlers.set('search_controllers', (a) => searchControllers(str(a, 'app_path'), str(a, 'query')));

  // Composer
  handlers.set('get_composer_info', (a) => getComposerInfo(str(a, 'app_path')));
  handlers.set('get_installed_packages', (a) => getInstalledPackages(str(a, 'app_path'), a['type'] as string | undefined));
  handlers.set('get_symfony_version', (a) => getSymfonyVersion(str(a, 'app_path')));

  // Messenger
  handlers.set('get_messenger_info', (a) => getMessengerInfo(str(a, 'app_path')));
  handlers.set('list_messenger_transports', (a) => listMessengerTransports(str(a, 'app_path')));
  handlers.set('list_messenger_routing', (a) => listMessengerRouting(str(a, 'app_path')));
  handlers.set('list_message_classes', (a) => listMessageClasses(str(a, 'app_path')));

  // Forms
  handlers.set('list_form_types', (a) => listFormTypes(str(a, 'app_path')));
  handlers.set('get_form_type_details', (a) => getFormTypeDetails(str(a, 'app_path'), str(a, 'form_name')));
  handlers.set('search_form_types', (a) => searchFormTypes(str(a, 'app_path'), str(a, 'query')));
  handlers.set('get_form_stats', (a) => getFormStats(str(a, 'app_path')));

  // Profiler
  handlers.set('list_profiler_requests', (a) => listProfilerRequests(str(a, 'app_path'), num(a, 'limit', 20)));
  handlers.set('get_profiler_details', (a) => getProfilerDetails(str(a, 'app_path'), str(a, 'token')));
  handlers.set('get_profiler_queries', (a) => getProfilerQueries(str(a, 'app_path'), str(a, 'token')));
  handlers.set('get_profiler_stats', (a) => getProfilerStats(str(a, 'app_path')));

  // Cache Inspector
  handlers.set('inspect_symfony_cache', (a) => inspectSymfonyCache(str(a, 'app_path')));
  handlers.set('get_cache_config', (a) => getCacheConfig(str(a, 'app_path')));
  handlers.set('inspect_mcp_cache', () => inspectMcpCache());
  handlers.set('clear_mcp_cache', () => clearMcpCache());

  // Events
  handlers.set('list_event_listeners', (a) => listEventListeners(str(a, 'app_path')));
  handlers.set('get_event_listeners_by_event', (a) => getEventListenersByEvent(str(a, 'app_path'), str(a, 'event_name')));
  handlers.set('get_event_stats', (a) => getEventStats(str(a, 'app_path')));

  // Console Commands
  handlers.set('list_commands', (a) => listCommands(str(a, 'app_path')));
  handlers.set('get_command_details', (a) => getCommandDetails(str(a, 'app_path'), str(a, 'command_name')));
  handlers.set('search_commands', (a) => searchCommands(str(a, 'app_path'), str(a, 'query')));

  // Twig
  handlers.set('list_templates', (a) => listTemplates(str(a, 'app_path')));
  handlers.set('get_template_details', (a) => getTemplateDetails(str(a, 'app_path'), str(a, 'template_path')));
  handlers.set('get_template_inheritance_tree', (a) => getTemplateInheritanceTree(str(a, 'app_path')));
  handlers.set('search_templates', (a) => searchTemplates(str(a, 'app_path'), str(a, 'query')));

  // Translations
  handlers.set('list_translation_files', (a) => listTranslationFiles(str(a, 'app_path')));
  handlers.set('find_missing_translations', (a) => findMissingTranslations(str(a, 'app_path'), a['reference_locale'] as string | undefined));
  handlers.set('search_translations', (a) => searchTranslations(str(a, 'app_path'), str(a, 'query'), a['locale'] as string | undefined));
  handlers.set('get_translation_stats', (a) => getTranslationStats(str(a, 'app_path')));

  // Workflows
  handlers.set('list_workflows', (a) => listWorkflows(str(a, 'app_path')));
  handlers.set('get_workflow_details', (a) => getWorkflowDetails(str(a, 'app_path'), str(a, 'workflow_name')));
  handlers.set('get_workflow_stats', (a) => getWorkflowStats(str(a, 'app_path')));

  // Test Inspector
  handlers.set('list_test_classes', (a) => listTestClasses(str(a, 'app_path')));
  handlers.set('get_test_coverage_map', (a) => getTestCoverageMap(str(a, 'app_path')));
  handlers.set('get_test_stats', (a) => getTestStats(str(a, 'app_path')));

  // Environment diff
  handlers.set('list_env_files', (a) => listEnvFiles(str(a, 'app_path')));
  handlers.set('diff_env_files', (a) => diffEnvFiles(str(a, 'app_path'), a['reference_file'] as string | undefined));
  handlers.set('find_sensitive_env_keys', (a) => findSensitiveEnvKeys(str(a, 'app_path')));
  handlers.set('get_env_stats', (a) => getEnvStats(str(a, 'app_path')));

  // Dead code
  handlers.set('detect_dead_code', (a) => detectDeadCode(str(a, 'app_path')));
  handlers.set('detect_orphan_controllers', (a) => detectOrphanControllersOnly(str(a, 'app_path')));
  handlers.set('detect_unused_form_types', (a) => detectUnusedFormTypesOnly(str(a, 'app_path')));

  // API Platform
  handlers.set('list_api_resources', (a) => listApiResources(str(a, 'app_path')));
  handlers.set('get_api_resource_details', (a) => getApiResourceDetails(str(a, 'app_path'), str(a, 'resource_name')));
  handlers.set('get_api_platform_stats', (a) => getApiPlatformStats(str(a, 'app_path')));

  // Serializer
  handlers.set('list_serializer_groups', (a) => listSerializerGroups(str(a, 'app_path')));
  handlers.set('get_class_serializer_profile', (a) => getClassSerializerProfile(str(a, 'app_path'), str(a, 'class_name')));
  handlers.set('search_serializer_groups', (a) => searchSerializerGroups(str(a, 'app_path'), str(a, 'group_name')));
  handlers.set('get_serializer_stats', (a) => getSerializerStats(str(a, 'app_path')));

  // Security voters & role hierarchy
  handlers.set('get_role_hierarchy', (a) => getRoleHierarchy(str(a, 'app_path')));
  handlers.set('list_security_voters', (a) => listSecurityVoters(str(a, 'app_path')));
  handlers.set('get_access_control_matrix', (a) => getAccessControlMatrix(str(a, 'app_path')));
  handlers.set('list_firewalls', (a) => listFirewalls(str(a, 'app_path')));

  // Repository analyzer
  handlers.set('list_repositories', (a) => listRepositories(str(a, 'app_path')));
  handlers.set('get_repository_details', (a) => getRepositoryDetails(str(a, 'app_path'), str(a, 'repository_name')));
  handlers.set('detect_n_plus_one', (a) => detectNPlusOne(str(a, 'app_path')));
  handlers.set('get_repository_stats', (a) => getRepositoryStats(str(a, 'app_path')));

  // Mailer
  handlers.set('get_mailer_config', (a) => getMailerConfig(str(a, 'app_path')));
  handlers.set('list_email_classes', (a) => listEmailClasses(str(a, 'app_path')));
  handlers.set('list_email_templates', (a) => listEmailTemplates(str(a, 'app_path')));
  handlers.set('get_mailer_stats', (a) => getMailerStats(str(a, 'app_path')));

  // Bundles
  handlers.set('list_bundles', (a) => listBundles(str(a, 'app_path')));
  handlers.set('get_bundle_stats', (a) => getBundleStats(str(a, 'app_path')));

  // Doctrine lifecycle
  handlers.set('list_entity_lifecycles', (a) => listEntityLifecycles(str(a, 'app_path')));
  handlers.set('get_lifecycle_by_event', (a) => getLifecycleByEvent(str(a, 'app_path'), str(a, 'event_name')));
  handlers.set('get_lifecycle_stats', (a) => getLifecycleStats(str(a, 'app_path')));

  // HTTP Client
  handlers.set('list_http_clients', (a) => listHttpClients(str(a, 'app_path')));
  handlers.set('list_http_client_usage', (a) => listHttpClientUsage(str(a, 'app_path')));
  handlers.set('get_http_client_stats', (a) => getHttpClientStats(str(a, 'app_path')));

  // Scheduler
  handlers.set('list_scheduled_tasks', (a) => listScheduledTasks(str(a, 'app_path')));
  handlers.set('get_scheduler_stats', (a) => getSchedulerStats(str(a, 'app_path')));

  // DI Parameters
  handlers.set('list_di_parameters', (a) => listDiParameters(str(a, 'app_path')));
  handlers.set('search_di_parameters', (a) => searchDiParameters(str(a, 'app_path'), str(a, 'query')));
  handlers.set('get_di_parameter_stats', (a) => getDiParameterStats(str(a, 'app_path')));

  // Notifier
  handlers.set('list_notifier_transports', (a) => listNotifierTransports(str(a, 'app_path')));
  handlers.set('list_notifications', (a) => listNotifications(str(a, 'app_path')));
  handlers.set('get_notifier_stats', (a) => getNotifierStats(str(a, 'app_path')));

  // Rate Limiter
  handlers.set('list_rate_limiters', (a) => listRateLimiters(str(a, 'app_path')));
  handlers.set('get_rate_limiter_usage', (a) => getRateLimiterUsage(str(a, 'app_path')));
  handlers.set('get_rate_limiter_stats', (a) => getRateLimiterStats(str(a, 'app_path')));

  // Dependency Graph
  handlers.set('analyze_dependency_graph', (a) => analyzeDependencyGraph(str(a, 'app_path')));
  handlers.set('detect_circular_dependencies', (a) => detectCircularDependencies(str(a, 'app_path')));
  handlers.set('get_dependency_graph_stats', (a) => getDependencyGraphStats(str(a, 'app_path')));

  // Asset Mapper / Webpack Encore
  handlers.set('list_asset_pipeline', (a) => listAssetPipeline(str(a, 'app_path')));
  handlers.set('list_stimulus_controllers', (a) => listStimulusControllers(str(a, 'app_path')));
  handlers.set('get_asset_stats', (a) => getAssetStats(str(a, 'app_path')));

  // Security Scanner
  handlers.set('scan_security_issues', (a) => scanSecurityIssues(str(a, 'app_path')));
  handlers.set('get_security_scan_stats', (a) => getSecurityScanStats(str(a, 'app_path')));

  // Doctrine Embeddable
  handlers.set('list_embeddables', (a) => listEmbeddables(str(a, 'app_path')));
  handlers.set('get_embeddable_stats', (a) => getEmbeddableStats(str(a, 'app_path')));

  // Code Quality
  handlers.set('get_code_quality_report', (a) => getCodeQualityReport(str(a, 'app_path')));
  handlers.set('get_god_classes', (a) => getGodClasses(str(a, 'app_path')));
  handlers.set('get_code_quality_stats', (a) => getCodeQualityStats(str(a, 'app_path')));

  // Symfony UX
  handlers.set('list_ux_components', (a) => listUxComponents(str(a, 'app_path')));
  handlers.set('get_ux_stats', (a) => getUxStats(str(a, 'app_path')));

  // Doctrine Extensions (Gedmo)
  handlers.set('list_doctrine_extensions', (a) => listDoctrineExtensions(str(a, 'app_path')));
  handlers.set('get_doctrine_extension_stats', (a) => getDoctrineExtensionStats(str(a, 'app_path')));

  // JWT / Auth Inspector
  handlers.set('get_jwt_config', (a) => getJwtConfig(str(a, 'app_path')));
  handlers.set('get_auth_stats', (a) => getAuthStats(str(a, 'app_path')));

  // Twig Extensions
  handlers.set('list_twig_extensions', (a) => listTwigExtensions(str(a, 'app_path')));
  handlers.set('get_twig_extension_stats', (a) => getTwigExtensionStats(str(a, 'app_path')));

  // Service Decorators
  handlers.set('list_service_decorators', (a) => listServiceDecorators(str(a, 'app_path')));
  handlers.set('get_decorator_stats', (a) => getDecoratorStats(str(a, 'app_path')));

  // Migrations Analysis
  handlers.set('analyze_migrations', (a) => analyzeMigrations(str(a, 'app_path')));
  handlers.set('get_destructive_migrations', (a) => getDestructiveMigrations(str(a, 'app_path')));
  handlers.set('get_migration_analysis_stats', (a) => getMigrationAnalysisStats(str(a, 'app_path')));

  // Validation
  handlers.set('list_validation_constraints', (a) => listValidationConstraints(str(a, 'app_path')));
  handlers.set('get_validation_stats', (a) => getValidationStats(str(a, 'app_path')));

  // Fixtures
  handlers.set('list_fixtures', (a) => listFixtures(str(a, 'app_path')));
  handlers.set('get_fixture_stats', (a) => getFixtureStats(str(a, 'app_path')));

  // Secrets Vault
  handlers.set('list_secrets_vault', (a) => listSecretsVault(str(a, 'app_path'), str(a, 'env') || 'prod'));
  handlers.set('get_secrets_vault_stats', (a) => getSecretsVaultStats(str(a, 'app_path')));

  // HTTP Cache
  handlers.set('list_http_cache_config', (a) => listHttpCacheConfig(str(a, 'app_path')));
  handlers.set('get_http_cache_stats', (a) => getHttpCacheStats(str(a, 'app_path')));

  // Static Analysis
  handlers.set('get_static_analysis_config', (a) => getStaticAnalysisConfig(str(a, 'app_path')));
  handlers.set('get_static_analysis_stats', (a) => getStaticAnalysisStats(str(a, 'app_path')));

  // CORS
  handlers.set('list_cors_config', (a) => listCorsConfig(str(a, 'app_path')));
  handlers.set('get_cors_stats', (a) => getCorsStats(str(a, 'app_path')));

  // Lock
  handlers.set('list_lock_config', (a) => listLockConfig(str(a, 'app_path')));
  handlers.set('get_lock_stats', (a) => getLockStats(str(a, 'app_path')));

  // Env Config Diff
  handlers.set('list_env_config_diff', (a) => listEnvConfigDiff(str(a, 'app_path')));
  handlers.set('get_env_config_diff_stats', (a) => getEnvConfigDiffStats(str(a, 'app_path')));

  // Doctrine SLC
  handlers.set('list_doctrine_slc', (a) => listDoctrineSlc(str(a, 'app_path')));
  handlers.set('get_doctrine_slc_stats', (a) => getDoctrineSlcStats(str(a, 'app_path')));

  // Messenger Middleware
  handlers.set('list_messenger_middleware', (a) => listMessengerMiddleware(str(a, 'app_path')));
  handlers.set('get_messenger_middleware_stats', (a) => getMessengerMiddlewareStats(str(a, 'app_path')));

  // Monolog
  handlers.set('list_monolog_config', (a) => listMonologConfig(str(a, 'app_path')));
  handlers.set('get_monolog_stats', (a) => getMonologStats(str(a, 'app_path')));

  // Doctrine Custom Types
  handlers.set('list_doctrine_types', (a) => listDoctrineTypes(str(a, 'app_path')));
  handlers.set('get_doctrine_type_stats', (a) => getDoctrineTypeStats(str(a, 'app_path')));

  // Webhooks
  handlers.set('list_webhooks', (a) => listWebhooks(str(a, 'app_path')));
  handlers.set('get_webhook_stats', (a) => getWebhookStats(str(a, 'app_path')));

  // Input DTOs
  handlers.set('list_input_dtos', (a) => listInputDtos(str(a, 'app_path')));
  handlers.set('get_input_dto_stats', (a) => getInputDtoStats(str(a, 'app_path')));

  // Mercure
  handlers.set('list_mercure_config', (a) => listMercureConfig(str(a, 'app_path')));
  handlers.set('get_mercure_stats', (a) => getMercureStats(str(a, 'app_path')));

  // Controller Security
  handlers.set('audit_controller_security', (a) => auditControllerSecurity(str(a, 'app_path')));
  handlers.set('get_controller_security_stats', (a) => getControllerSecurityStats(str(a, 'app_path')));

  // PHPUnit config
  handlers.set('list_phpunit_config', (a) => listPhpUnitConfig(str(a, 'app_path')));
  handlers.set('get_phpunit_stats', (a) => getPhpUnitStats(str(a, 'app_path')));

  // Doctrine ORM deep config
  handlers.set('list_doctrine_orm_config', (a) => listDoctrineOrmConfig(str(a, 'app_path')));
  handlers.set('get_doctrine_orm_stats', (a) => getDoctrineOrmStats(str(a, 'app_path')));

  // Compiler Passes
  handlers.set('list_compiler_passes', (a) => listCompilerPasses(str(a, 'app_path')));
  handlers.set('get_compiler_pass_stats', (a) => getCompilerPassStats(str(a, 'app_path')));

  // Messenger Handler Map
  handlers.set('list_messenger_handlers', (a) => listMessengerHandlers(str(a, 'app_path')));
  handlers.set('get_messenger_handler_stats', (a) => getMessengerHandlerStats(str(a, 'app_path')));

  // Cache Pools
  handlers.set('list_cache_pools', (a) => listCachePools(str(a, 'app_path')));
  handlers.set('get_cache_pool_stats', (a) => getCachePoolStats(str(a, 'app_path')));

  // Session & Cookie Security
  handlers.set('list_session_config', (a) => listSessionConfig(str(a, 'app_path')));
  handlers.set('get_session_stats', (a) => getSessionStats(str(a, 'app_path')));

  // DBAL Connection Config
  handlers.set('list_dbal_config', (a) => listDbalConfig(str(a, 'app_path')));
  handlers.set('get_dbal_stats', (a) => getDbalStats(str(a, 'app_path')));

  // Custom Error Pages
  handlers.set('list_error_pages', (a) => listErrorPages(str(a, 'app_path')));
  handlers.set('get_error_page_stats', (a) => getErrorPageStats(str(a, 'app_path')));

  // Health Checks
  handlers.set('list_health_checks', (a) => listHealthChecks(str(a, 'app_path')));
  handlers.set('get_health_check_stats', (a) => getHealthCheckStats(str(a, 'app_path')));

  // Kernel Analysis
  handlers.set('list_kernel_config', (a) => listKernelConfig(str(a, 'app_path')));
  handlers.set('get_kernel_stats', (a) => getKernelStats(str(a, 'app_path')));

  // Password Hashers
  handlers.set('list_password_hashers', (a) => listPasswordHashers(str(a, 'app_path')));
  handlers.set('get_password_hasher_stats', (a) => getPasswordHasherStats(str(a, 'app_path')));

  // Cache Warmers
  handlers.set('list_cache_warmers', (a) => listCacheWarmers(str(a, 'app_path')));
  handlers.set('get_cache_warmer_stats', (a) => getCacheWarmerStats(str(a, 'app_path')));

  // EasyAdmin / SonataAdmin
  handlers.set('list_easyadmin_config', (a) => listEasyAdminConfig(str(a, 'app_path')));
  handlers.set('get_easyadmin_stats', (a) => getEasyAdminStats(str(a, 'app_path')));

  // Behat
  handlers.set('list_behat_config', (a) => listBehatConfig(str(a, 'app_path')));
  handlers.set('get_behat_stats', (a) => getBehatStats(str(a, 'app_path')));

  // Container Tags
  handlers.set('list_container_tags', (a) => listContainerTags(str(a, 'app_path')));
  handlers.set('get_container_tag_stats', (a) => getContainerTagStats(str(a, 'app_path')));

  // Flex Recipes
  handlers.set('list_flex_recipes', (a) => listFlexRecipes(str(a, 'app_path')));
  handlers.set('get_flex_recipe_stats', (a) => getFlexRecipeStats(str(a, 'app_path')));

  // OpenAPI / Swagger
  handlers.set('list_openapi_config', (a) => listOpenApiConfig(str(a, 'app_path')));
  handlers.set('get_openapi_stats', (a) => getOpenApiStats(str(a, 'app_path')));

  // Search Integration
  handlers.set('list_search_integration', (a) => listSearchIntegration(str(a, 'app_path')));
  handlers.set('get_search_integration_stats', (a) => getSearchIntegrationStats(str(a, 'app_path')));

  // Feature Flags
  handlers.set('list_feature_flags', (a) => listFeatureFlags(str(a, 'app_path')));
  handlers.set('get_feature_flag_stats', (a) => getFeatureFlagStats(str(a, 'app_path')));

  // CI/CD
  handlers.set('list_cicd_config', (a) => listCiCdConfig(str(a, 'app_path')));
  handlers.set('get_cicd_stats', (a) => getCiCdStats(str(a, 'app_path')));

  // OAuth / SSO
  handlers.set('list_oauth_config', (a) => listOAuthConfig(str(a, 'app_path')));
  handlers.set('get_oauth_stats', (a) => getOAuthStats(str(a, 'app_path')));

  // Docker
  handlers.set('list_docker_config', (a) => listDockerConfig(str(a, 'app_path')));
  handlers.set('get_docker_stats', (a) => getDockerStats(str(a, 'app_path')));

  // File storage
  handlers.set('list_file_storage', (a) => listFileStorage(str(a, 'app_path')));
  handlers.set('get_file_storage_stats', (a) => getFileStorageStats(str(a, 'app_path')));

  // GraphQL
  handlers.set('list_graphql_config', (a) => listGraphQlConfig(str(a, 'app_path')));
  handlers.set('get_graphql_stats', (a) => getGraphQlStats(str(a, 'app_path')));

  // Custom authenticators
  handlers.set('list_custom_authenticators', (a) => listCustomAuthenticators(str(a, 'app_path')));
  handlers.set('get_authenticator_stats', (a) => getAuthenticatorStats(str(a, 'app_path')));

  // Turbo
  handlers.set('list_turbo_config', (a) => listTurboConfig(str(a, 'app_path')));
  handlers.set('get_turbo_stats', (a) => getTurboStats(str(a, 'app_path')));

  // API versioning
  handlers.set('list_api_versions', (a) => listApiVersions(str(a, 'app_path')));
  handlers.set('get_api_version_stats', (a) => getApiVersionStats(str(a, 'app_path')));

  // Psalm
  handlers.set('list_psalm_config', (a) => listPsalmConfig(str(a, 'app_path')));
  handlers.set('get_psalm_stats', (a) => getPsalmStats(str(a, 'app_path')));

  // Cron jobs (external)
  handlers.set('list_cron_jobs', (a) => listCronJobs(str(a, 'app_path')));
  handlers.set('get_cron_job_stats', (a) => getCronJobStats(str(a, 'app_path')));

  // Webpack Encore
  handlers.set('list_webpack_config', (a) => listWebpackConfig(str(a, 'app_path')));
  handlers.set('get_webpack_stats', (a) => getWebpackStats(str(a, 'app_path')));

  // Doctrine QueryBuilder
  handlers.set('list_query_builder_patterns', (a) => listQueryBuilderPatterns(str(a, 'app_path')));
  handlers.set('get_query_builder_stats', (a) => getQueryBuilderStats(str(a, 'app_path')));

  // PSR compliance
  handlers.set('list_psr_compliance', (a) => listPsrCompliance(str(a, 'app_path')));
  handlers.set('get_psr_stats', (a) => getPsrStats(str(a, 'app_path')));

  // Twig lint
  handlers.set('list_twig_issues', (a) => listTwigIssues(str(a, 'app_path')));
  handlers.set('get_twig_lint_stats', (a) => getTwigLintStats(str(a, 'app_path')));

  // Multi-tenancy
  handlers.set('list_multitenancy_config', (a) => listMultitenancyConfig(str(a, 'app_path')));
  handlers.set('get_multitenancy_stats', (a) => getMultitenancyStats(str(a, 'app_path')));

  // SymfonyCloud / Platform.sh
  handlers.set('list_symfony_cli_config', (a) => listSymfonyCliConfig(str(a, 'app_path')));
  handlers.set('get_symfony_cli_stats', (a) => getSymfonyCliStats(str(a, 'app_path')));

  // Rector
  handlers.set('list_rector_rules', (a) => listRectorRules(str(a, 'app_path')));
  handlers.set('get_rector_stats', (a) => getRectorStats(str(a, 'app_path')));

  // API rate limits (HTTP layer)
  handlers.set('list_api_rate_limits', (a) => listApiRateLimits(str(a, 'app_path')));
  handlers.set('get_api_rate_limit_stats', (a) => getApiRateLimitStats(str(a, 'app_path')));

  // Deployment config
  handlers.set('list_deployment_config', (a) => listDeploymentConfig(str(a, 'app_path')));
  handlers.set('get_deployment_stats', (a) => getDeploymentStats(str(a, 'app_path')));

  // Custom application events
  handlers.set('list_custom_events', (a) => listCustomEvents(str(a, 'app_path')));
  handlers.set('get_custom_event_stats', (a) => getCustomEventStats(str(a, 'app_path')));

  // Accessibility audit
  handlers.set('list_accessibility_issues', (a) => listAccessibilityIssues(str(a, 'app_path')));
  handlers.set('get_accessibility_stats', (a) => getAccessibilityStats(str(a, 'app_path')));

  // Doctrine cache (SLC + entity #[Cache])
  handlers.set('list_doctrine_cache', (a) => listDoctrineCache(str(a, 'app_path')));
  handlers.set('get_doctrine_cache_stats', (a) => getDoctrineCacheStats(str(a, 'app_path')));

  // MakerBundle config + class type counts
  handlers.set('list_maker_config', (a) => listMakerConfig(str(a, 'app_path')));
  handlers.set('get_maker_stats', (a) => getMakerStats(str(a, 'app_path')));

  // Doctrine SQL filters
  handlers.set('list_doctrine_filters', (a) => listDoctrineFilters(str(a, 'app_path')));
  handlers.set('get_doctrine_filter_stats', (a) => getDoctrineFilterStats(str(a, 'app_path')));

  // UX Live Components
  handlers.set('list_live_components', (a) => listLiveComponents(str(a, 'app_path')));
  handlers.set('get_live_component_stats', (a) => getLiveComponentStats(str(a, 'app_path')));

  // PHP CS Fixer config
  handlers.set('list_cs_fixer_config', (a) => listCsFixerConfig(str(a, 'app_path')));
  handlers.set('get_cs_fixer_stats', (a) => getCsFixerStats(str(a, 'app_path')));

  // API Platform filters
  handlers.set('list_api_platform_filters', (a) => listApiPlatformFilters(str(a, 'app_path')));
  handlers.set('get_api_platform_filter_stats', (a) => getApiPlatformFilterStats(str(a, 'app_path')));

  // Messenger failure transports
  handlers.set('list_messenger_failure_config', (a) => listMessengerFailureConfig(str(a, 'app_path')));
  handlers.set('get_messenger_failure_stats', (a) => getMessengerFailureStats(str(a, 'app_path')));

  // Fixture groups and dependency tree
  handlers.set('list_fixture_groups', (a) => listFixtureGroups(str(a, 'app_path')));
  handlers.set('get_fixture_group_stats', (a) => getFixtureGroupStats(str(a, 'app_path')));

  // Translation plural forms
  handlers.set('list_translation_plurals', (a) => listTranslationPlurals(str(a, 'app_path')));
  handlers.set('get_plural_stats', (a) => getPluralStats(str(a, 'app_path')));

  // API Platform security audit
  handlers.set('list_api_platform_security', (a) => listApiPlatformSecurity(str(a, 'app_path')));
  handlers.set('get_api_platform_security_stats', (a) => getApiPlatformSecurityStats(str(a, 'app_path')));

  // Workflow guards
  handlers.set('list_workflow_guards', (a) => listWorkflowGuards(str(a, 'app_path')));
  handlers.set('get_workflow_guard_stats', (a) => getWorkflowGuardStats(str(a, 'app_path')));

  // Doctrine inheritance
  handlers.set('list_doctrine_inheritance', (a) => listDoctrineInheritance(str(a, 'app_path')));
  handlers.set('get_doctrine_inheritance_stats', (a) => getDoctrineInheritanceStats(str(a, 'app_path')));

  // Notifier channels
  handlers.set('list_notifier_channels', (a) => listNotifierChannels(str(a, 'app_path')));
  handlers.set('get_notifier_channel_stats', (a) => getNotifierChannelStats(str(a, 'app_path')));

  // Clock component
  handlers.set('list_clock_config', (a) => listClockConfig(str(a, 'app_path')));
  handlers.set('get_clock_stats', (a) => getClockStats(str(a, 'app_path')));

  // PHPStan config
  handlers.set('list_phpstan_config', (a) => listPhpStanConfig(str(a, 'app_path')));
  handlers.set('get_phpstan_stats', (a) => getPhpStanStats(str(a, 'app_path')));

  // Phase 22
  handlers.set('list_dql_functions', (a) => listDqlFunctions(str(a, 'app_path')));
  handlers.set('get_dql_function_stats', (a) => getDqlFunctionStats(str(a, 'app_path')));
  handlers.set('list_locale_config', (a) => listLocaleConfig(str(a, 'app_path')));
  handlers.set('get_locale_stats', (a) => getLocaleStats(str(a, 'app_path')));
  handlers.set('list_data_collectors', (a) => listDataCollectors(str(a, 'app_path')));
  handlers.set('get_data_collector_stats', (a) => getDataCollectorStats(str(a, 'app_path')));
  handlers.set('list_csrf_config', (a) => listCsrfConfig(str(a, 'app_path')));
  handlers.set('get_csrf_stats', (a) => getCsrfStats(str(a, 'app_path')));
  handlers.set('list_sentry_config', (a) => listSentryConfig(str(a, 'app_path')));
  handlers.set('get_sentry_stats', (a) => getSentryStats(str(a, 'app_path')));
  handlers.set('list_command_namespaces', (a) => listCommandNamespaces(str(a, 'app_path')));
  handlers.set('get_command_namespace_stats', (a) => getCommandNamespaceStats(str(a, 'app_path')));
  handlers.set('list_nelmio_config', (a) => listNelmioConfig(str(a, 'app_path')));
  handlers.set('get_nelmio_stats', (a) => getNelmioStats(str(a, 'app_path')));
  handlers.set('list_env_config_overrides', (a) => listEnvConfigOverrides(str(a, 'app_path')));
  handlers.set('get_env_config_override_stats', (a) => getEnvConfigOverrideStats(str(a, 'app_path')));
  handlers.set('list_blackfire_config', (a) => listBlackfireConfig(str(a, 'app_path')));
  handlers.set('get_blackfire_stats', (a) => getBlackfireStats(str(a, 'app_path')));
  handlers.set('list_uid_config', (a) => listUidConfig(str(a, 'app_path')));
  handlers.set('get_uid_stats', (a) => getUidStats(str(a, 'app_path')));
  handlers.set('list_api_state_providers', (a) => listApiStateProviders(str(a, 'app_path')));
  handlers.set('get_api_state_stats', (a) => getApiStateStats(str(a, 'app_path')));
  handlers.set('list_expression_functions', (a) => listExpressionFunctions(str(a, 'app_path')));
  handlers.set('get_expression_stats', (a) => getExpressionStats(str(a, 'app_path')));
  handlers.set('list_cache_tag_config', (a) => listCacheTagConfig(str(a, 'app_path')));
  handlers.set('get_cache_tag_stats', (a) => getCacheTagStats(str(a, 'app_path')));
  handlers.set('list_php_enums', (a) => listPhpEnums(str(a, 'app_path')));
  handlers.set('get_enum_stats', (a) => getEnumStats(str(a, 'app_path')));
  handlers.set('list_mailer_events', (a) => listMailerEvents(str(a, 'app_path')));
  handlers.set('get_mailer_event_stats', (a) => getMailerEventStats(str(a, 'app_path')));

  // Phase 23
  handlers.set('list_security_firewalls', (a) => listSecurityFirewalls(str(a, 'app_path')));
  handlers.set('get_firewall_stats', (a) => getFirewallStats(str(a, 'app_path')));
  handlers.set('list_passport_badges', (a) => listPassportBadges(str(a, 'app_path')));
  handlers.set('get_badge_stats', (a) => getBadgeStats(str(a, 'app_path')));
  handlers.set('list_trusted_proxy_config', (a) => listTrustedProxyConfig(str(a, 'app_path')));
  handlers.set('get_trusted_proxy_stats', (a) => getTrustedProxyStats(str(a, 'app_path')));
  handlers.set('list_response_cache_headers', (a) => listResponseCacheHeaders(str(a, 'app_path')));
  handlers.set('get_response_cache_stats', (a) => getResponseCacheStats(str(a, 'app_path')));
  handlers.set('list_asset_config', (a) => listAssetConfig(str(a, 'app_path')));
  handlers.set('get_asset_versioning_stats', (a) => getAssetVersioningStats(str(a, 'app_path')));
  handlers.set('list_timestampable_entities', (a) => listTimestampableEntities(str(a, 'app_path')));
  handlers.set('get_timestamp_stats', (a) => getTimestampStats(str(a, 'app_path')));
  handlers.set('list_dql_projections', (a) => listDqlProjections(str(a, 'app_path')));
  handlers.set('get_projection_stats', (a) => getProjectionStats(str(a, 'app_path')));
  handlers.set('list_migration_gaps', (a) => listMigrationGaps(str(a, 'app_path')));
  handlers.set('get_migration_history_stats', (a) => getMigrationHistoryStats(str(a, 'app_path')));
  handlers.set('list_messenger_stamps', (a) => listMessengerStamps(str(a, 'app_path')));
  handlers.set('get_stamp_stats', (a) => getStampStats(str(a, 'app_path')));
  handlers.set('list_message_buses', (a) => listMessageBuses(str(a, 'app_path')));
  handlers.set('get_bus_stats', (a) => getBusStats(str(a, 'app_path')));
  handlers.set('list_twig_globals', (a) => listTwigGlobals(str(a, 'app_path')));
  handlers.set('get_twig_global_stats', (a) => getTwigGlobalStats(str(a, 'app_path')));
  handlers.set('list_twig_components', (a) => listTwigComponents(str(a, 'app_path')));
  handlers.set('get_twig_component_stats', (a) => getTwigComponentStats(str(a, 'app_path')));
  handlers.set('list_test_groups', (a) => listTestGroups(str(a, 'app_path')));
  handlers.set('get_test_group_stats', (a) => getTestGroupStats(str(a, 'app_path')));
  handlers.set('list_custom_constraints', (a) => listCustomConstraints(str(a, 'app_path')));
  handlers.set('get_constraint_stats', (a) => getConstraintStats(str(a, 'app_path')));
  handlers.set('list_httpclient_scopes', (a) => listHttpClientScopes(str(a, 'app_path')));
  handlers.set('get_httpclient_scope_stats', (a) => getHttpClientScopeStats(str(a, 'app_path')));
  handlers.set('list_env_processors', (a) => listEnvProcessors(str(a, 'app_path')));
  handlers.set('get_env_processor_stats', (a) => getEnvProcessorStats(str(a, 'app_path')));
  handlers.set('list_debug_artifacts', (a) => listDebugArtifacts(str(a, 'app_path')));
  handlers.set('get_debug_stats', (a) => getDebugStats(str(a, 'app_path')));
  handlers.set('list_lock_resources', (a) => listLockResources(str(a, 'app_path')));
  handlers.set('get_lock_resource_stats', (a) => getLockResourceStats(str(a, 'app_path')));
  handlers.set('list_kernel_event_listeners', (a) => listKernelEventListeners(str(a, 'app_path')));
  handlers.set('get_kernel_event_stats', (a) => getKernelEventStats(str(a, 'app_path')));
  handlers.set('list_property_info_extractors', (a) => listPropertyInfoExtractors(str(a, 'app_path')));
  handlers.set('get_property_info_stats', (a) => getPropertyInfoStats(str(a, 'app_path')));
  handlers.set('list_serializer_group_attrs', (a) => listSerializerGroupAttrs(str(a, 'app_path')));
  handlers.set('get_serializer_group_stats', (a) => getSerializerGroupStats(str(a, 'app_path')));
  handlers.set('list_html_sanitizer_config', (a) => listHtmlSanitizerConfig(str(a, 'app_path')));
  handlers.set('get_sanitizer_stats', (a) => getSanitizerStats(str(a, 'app_path')));
  handlers.set('list_api_operations', (a) => listApiOperations(str(a, 'app_path')));
  handlers.set('get_api_operation_stats', (a) => getApiOperationStats(str(a, 'app_path')));
  handlers.set('list_custom_makers', (a) => listCustomMakers(str(a, 'app_path')));
  handlers.set('get_maker_command_stats', (a) => getMakerCommandStats(str(a, 'app_path')));
  handlers.set('list_string_usage', (a) => listStringUsage(str(a, 'app_path')));
  handlers.set('get_string_stats', (a) => getStringStats(str(a, 'app_path')));

  // Form events
  handlers.set('list_form_events', (a) => listFormEvents(str(a, 'app_path')));
  handlers.set('get_form_event_stats', (a) => getFormEventStats(str(a, 'app_path')));

  // Doctrine event subscribers
  handlers.set('list_doctrine_event_subscribers', (a) => listDoctrineEventSubscribers(str(a, 'app_path')));
  handlers.set('get_doctrine_subscriber_stats', (a) => getDoctrineSubscriberStats(str(a, 'app_path')));

  // Bundle config extensions
  handlers.set('list_config_extensions', (a) => listConfigExtensions(str(a, 'app_path')));
  handlers.set('get_config_extension_stats', (a) => getConfigExtensionStats(str(a, 'app_path')));

  // Stopwatch
  handlers.set('list_stopwatch_usage', (a) => listStopwatchUsage(str(a, 'app_path')));
  handlers.set('get_stopwatch_stats', (a) => getStopwatchStats(str(a, 'app_path')));

  // Process component
  handlers.set('list_process_usage', (a) => listProcessUsage(str(a, 'app_path')));
  handlers.set('get_process_stats', (a) => getProcessStats(str(a, 'app_path')));

  // PHP readonly classes
  handlers.set('list_readonly_classes', (a) => listReadonlyClasses(str(a, 'app_path')));
  handlers.set('get_readonly_stats', (a) => getReadonlyStats(str(a, 'app_path')));

  // API Platform pagination
  handlers.set('list_api_pagination', (a) => listApiPagination(str(a, 'app_path')));
  handlers.set('get_api_pagination_stats', (a) => getApiPaginationStats(str(a, 'app_path')));

  // Symfony lazy services
  handlers.set('list_lazy_services', (a) => listLazyServices(str(a, 'app_path')));
  handlers.set('get_lazy_service_stats', (a) => getLazyServiceStats(str(a, 'app_path')));

  // PHP custom attributes
  handlers.set('list_custom_php_attributes', (a) => listCustomPhpAttributes(str(a, 'app_path')));
  handlers.set('get_custom_attribute_stats', (a) => getCustomAttributeStats(str(a, 'app_path')));

  // Doctrine indexes
  handlers.set('list_doctrine_indexes', (a) => listDoctrineIndexes(str(a, 'app_path')));
  handlers.set('get_doctrine_index_stats', (a) => getDoctrineIndexStats(str(a, 'app_path')));

  // Console shell completion
  handlers.set('list_console_completion', (a) => listConsoleCompletion(str(a, 'app_path')));
  handlers.set('get_console_completion_stats', (a) => getConsoleCompletionStats(str(a, 'app_path')));

  // Doctrine association fetch modes
  handlers.set('list_fetch_modes', (a) => listFetchModes(str(a, 'app_path')));
  handlers.set('get_fetch_mode_stats', (a) => getFetchModeStats(str(a, 'app_path')));

  // Symfony compound constraints
  handlers.set('list_compound_constraints', (a) => listCompoundConstraints(str(a, 'app_path')));
  handlers.set('get_compound_constraint_stats', (a) => getCompoundConstraintStats(str(a, 'app_path')));

  // Mailer transport DSN
  handlers.set('list_mailer_transports', (a) => listMailerTransports(str(a, 'app_path')));
  handlers.set('get_mailer_transport_stats', (a) => getMailerTransportStats(str(a, 'app_path')));

  // API Platform Mercure push
  handlers.set('list_mercure_push_config', (a) => listMercurePushConfig(str(a, 'app_path')));
  handlers.set('get_mercure_push_stats', (a) => getMercurePushStats(str(a, 'app_path')));

  // Doctrine repository patterns
  handlers.set('list_repository_patterns', (a) => listRepositoryPatterns(str(a, 'app_path')));
  handlers.set('get_repository_pattern_stats', (a) => getRepositoryPatternStats(str(a, 'app_path')));

  // Symfony ObjectMapper
  handlers.set('list_object_mapper_config', (a) => listObjectMapperConfig(str(a, 'app_path')));
  handlers.set('get_object_mapper_stats', (a) => getObjectMapperStats(str(a, 'app_path')));

  // Symfony VarExporter
  handlers.set('list_var_exporter_usage', (a) => listVarExporterUsage(str(a, 'app_path')));
  handlers.set('get_var_exporter_stats', (a) => getVarExporterStats(str(a, 'app_path')));

  // Twig sandbox
  handlers.set('list_twig_sandbox', (a) => listTwigSandbox(str(a, 'app_path')));
  handlers.set('get_twig_sandbox_stats', (a) => getTwigSandboxStats(str(a, 'app_path')));

  // Symfony Autowire attributes
  handlers.set('list_autowire_attributes', (a) => listAutowireAttributes(str(a, 'app_path')));
  handlers.set('get_autowire_attribute_stats', (a) => getAutowireAttributeStats(str(a, 'app_path')));

  // Translation gaps
  handlers.set('list_translation_gaps', (a) => listTranslationGaps(str(a, 'app_path')));
  handlers.set('get_translation_gap_stats', (a) => getTranslationGapStats(str(a, 'app_path')));

  // Form type extensions
  handlers.set('list_form_type_extensions', (a) => listFormTypeExtensions(str(a, 'app_path')));
  handlers.set('get_form_type_extension_stats', (a) => getFormTypeExtensionStats(str(a, 'app_path')));

  // Symfony runtime
  handlers.set('list_runtime_config', (a) => listRuntimeConfig(str(a, 'app_path')));
  handlers.set('get_runtime_stats', (a) => getRuntimeStats(str(a, 'app_path')));

  // Symfony Mime parts
  handlers.set('list_mime_parts', (a) => listMimeParts(str(a, 'app_path')));
  handlers.set('get_mime_parts_stats', (a) => getMimePartsStats(str(a, 'app_path')));

  // PHP type coverage
  handlers.set('list_type_coverage', (a) => listTypeCoverage(str(a, 'app_path')));
  handlers.set('get_type_coverage_stats', (a) => getTypeCoverageStats(str(a, 'app_path')));

  // Symfony role hierarchy
  handlers.set('list_role_hierarchy', (a) => listRoleHierarchy(str(a, 'app_path')));
  handlers.set('get_role_hierarchy_stats', (a) => getRoleHierarchyStats(str(a, 'app_path')));

  // Symfony access control
  handlers.set('list_access_control', (a) => listAccessControl(str(a, 'app_path')));
  handlers.set('get_access_control_stats', (a) => getAccessControlStats(str(a, 'app_path')));

  // Symfony token storage
  handlers.set('list_token_storage_usage', (a) => listTokenStorageUsage(str(a, 'app_path')));
  handlers.set('get_token_storage_stats', (a) => getTokenStorageStats(str(a, 'app_path')));

  // Symfony form transformers
  handlers.set('list_form_transformers', (a) => listFormTransformers(str(a, 'app_path')));
  handlers.set('get_form_transformer_stats', (a) => getFormTransformerStats(str(a, 'app_path')));

  // Symfony choice loaders
  handlers.set('list_choice_loaders', (a) => listChoiceLoaders(str(a, 'app_path')));
  handlers.set('get_choice_loader_stats', (a) => getChoiceLoaderStats(str(a, 'app_path')));

  // Symfony validation groups
  handlers.set('list_validation_groups', (a) => listValidationGroups(str(a, 'app_path')));
  handlers.set('get_validation_group_stats', (a) => getValidationGroupStats(str(a, 'app_path')));

  // Symfony service aliases
  handlers.set('list_service_aliases', (a) => listServiceAliases(str(a, 'app_path')));
  handlers.set('get_service_alias_stats', (a) => getServiceAliasStats(str(a, 'app_path')));

  // Symfony DI factories
  handlers.set('list_di_factories', (a) => listDiFactories(str(a, 'app_path')));
  handlers.set('get_di_factory_stats', (a) => getDiFactoryStats(str(a, 'app_path')));

  // Symfony options resolver
  handlers.set('list_options_resolver_usage', (a) => listOptionsResolverUsage(str(a, 'app_path')));
  handlers.set('get_options_resolver_stats', (a) => getOptionsResolverStats(str(a, 'app_path')));

  // Symfony value resolver
  handlers.set('list_value_resolvers', (a) => listValueResolvers(str(a, 'app_path')));
  handlers.set('get_value_resolver_stats', (a) => getValueResolverStats(str(a, 'app_path')));

  // Symfony request mapping attributes
  handlers.set('list_request_mapping_attrs', (a) => listRequestMappingAttrs(str(a, 'app_path')));
  handlers.set('get_request_mapping_stats', (a) => getRequestMappingStats(str(a, 'app_path')));

  // Symfony file uploads
  handlers.set('list_file_upload_usage', (a) => listFileUploadUsage(str(a, 'app_path')));
  handlers.set('get_file_upload_stats', (a) => getFileUploadStats(str(a, 'app_path')));

  // Symfony HttpClient retry
  handlers.set('list_http_client_retry', (a) => listHttpClientRetry(str(a, 'app_path')));
  handlers.set('get_http_client_retry_stats', (a) => getHttpClientRetryStats(str(a, 'app_path')));

  // Symfony WebLink
  handlers.set('list_weblink_usage', (a) => listWebLinkUsage(str(a, 'app_path')));
  handlers.set('get_weblink_stats', (a) => getWebLinkStats(str(a, 'app_path')));

  // Symfony error renderer
  handlers.set('list_error_renderers', (a) => listErrorRenderers(str(a, 'app_path')));
  handlers.set('get_error_renderer_stats', (a) => getErrorRendererStats(str(a, 'app_path')));

  // Symfony console style
  handlers.set('list_console_style_usage', (a) => listConsoleStyleUsage(str(a, 'app_path')));
  handlers.set('get_console_style_stats', (a) => getConsoleStyleStats(str(a, 'app_path')));

  // Symfony console signals
  handlers.set('list_console_signals', (a) => listConsoleSignals(str(a, 'app_path')));
  handlers.set('get_console_signal_stats', (a) => getConsoleSignalStats(str(a, 'app_path')));

  // Symfony workflow marking
  handlers.set('list_workflow_markings', (a) => listWorkflowMarkings(str(a, 'app_path')));
  handlers.set('get_workflow_marking_stats', (a) => getWorkflowMarkingStats(str(a, 'app_path')));

  // Symfony messenger transport options
  handlers.set('list_messenger_transport_options', (a) => listMessengerTransportOptions(str(a, 'app_path')));
  handlers.set('get_messenger_transport_option_stats', (a) => getMessengerTransportOptionStats(str(a, 'app_path')));

  // Symfony notifier message types
  handlers.set('list_notifier_message_types', (a) => listNotifierMessageTypes(str(a, 'app_path')));
  handlers.set('get_notifier_message_type_stats', (a) => getNotifierMessageTypeStats(str(a, 'app_path')));

  // Symfony session handlers
  handlers.set('list_session_handlers', (a) => listSessionHandlers(str(a, 'app_path')));
  handlers.set('get_session_handler_stats', (a) => getSessionHandlerStats(str(a, 'app_path')));

  // Symfony event dispatcher tracing
  handlers.set('list_event_dispatcher_tracing', (a) => listEventDispatcherTracing(str(a, 'app_path')));
  handlers.set('get_event_dispatcher_tracing_stats', (a) => getEventDispatcherTracingStats(str(a, 'app_path')));

  // Symfony maintenance mode
  handlers.set('list_maintenance_mode', (a) => listMaintenanceMode(str(a, 'app_path')));
  handlers.set('get_maintenance_mode_stats', (a) => getMaintenanceModeStats(str(a, 'app_path')));

  // Symfony Monolog processors
  handlers.set('list_monolog_processors', (a) => listMonologProcessors(str(a, 'app_path')));
  handlers.set('get_monolog_processor_stats', (a) => getMonologProcessorStats(str(a, 'app_path')));

  // Twig token parsers
  handlers.set('list_twig_token_parsers', (a) => listTwigTokenParsers(str(a, 'app_path')));
  handlers.set('get_twig_token_parser_stats', (a) => getTwigTokenParserStats(str(a, 'app_path')));

  // Doctrine second level cache
  handlers.set('list_doctrine_second_level_cache', (a) => listDoctrineSecondLevelCache(str(a, 'app_path')));
  handlers.set('get_doctrine_second_level_cache_stats', (a) => getDoctrineSecondLevelCacheStats(str(a, 'app_path')));

  // Doctrine named queries
  handlers.set('list_doctrine_named_queries', (a) => listDoctrineNamedQueries(str(a, 'app_path')));
  handlers.set('get_doctrine_named_query_stats', (a) => getDoctrineNamedQueryStats(str(a, 'app_path')));

  // Doctrine repository queries
  handlers.set('list_doctrine_repository_queries', (a) => listDoctrineRepositoryQueries(str(a, 'app_path')));
  handlers.set('get_doctrine_repository_query_stats', (a) => getDoctrineRepositoryQueryStats(str(a, 'app_path')));

  // Doctrine paginator
  handlers.set('list_doctrine_paginators', (a) => listDoctrinePaginators(str(a, 'app_path')));
  handlers.set('get_doctrine_paginator_stats', (a) => getDoctrinePaginatorStats(str(a, 'app_path')));

  // Doctrine cascade config
  handlers.set('list_doctrine_cascade_config', (a) => listDoctrineCascadeConfig(str(a, 'app_path')));
  handlers.set('get_doctrine_cascade_stats', (a) => getDoctrineCascadeStats(str(a, 'app_path')));

  // Doctrine orphan removal
  handlers.set('list_doctrine_orphan_removal', (a) => listDoctrineOrphanRemoval(str(a, 'app_path')));
  handlers.set('get_doctrine_orphan_removal_stats', (a) => getDoctrineOrphanRemovalStats(str(a, 'app_path')));

  // Doctrine discriminator
  handlers.set('list_doctrine_discriminators', (a) => listDoctrineDiscriminators(str(a, 'app_path')));
  handlers.set('get_doctrine_discriminator_stats', (a) => getDoctrineDiscriminatorStats(str(a, 'app_path')));

  // Doctrine migration graph
  handlers.set('list_doctrine_migration_graph', (a) => listDoctrineMigrationGraph(str(a, 'app_path')));
  handlers.set('get_doctrine_migration_graph_stats', (a) => getDoctrineMigrationGraphStats(str(a, 'app_path')));

  // Doctrine event manager
  handlers.set('list_doctrine_event_manager_usage', (a) => listDoctrineEventManagerUsage(str(a, 'app_path')));
  handlers.set('get_doctrine_event_manager_stats', (a) => getDoctrineEventManagerStats(str(a, 'app_path')));

  // API Platform state processors
  handlers.set('list_api_platform_state_processors', (a) => listApiPlatformStateProcessors(str(a, 'app_path')));
  handlers.set('get_api_platform_state_processor_stats', (a) => getApiPlatformStateProcessorStats(str(a, 'app_path')));

  // API Platform serialization context
  handlers.set('list_api_platform_serialization_contexts', (a) => listApiPlatformSerializationContexts(str(a, 'app_path')));
  handlers.set('get_api_platform_serialization_context_stats', (a) => getApiPlatformSerializationContextStats(str(a, 'app_path')));

  // API Platform validation context
  handlers.set('list_api_platform_validation_contexts', (a) => listApiPlatformValidationContexts(str(a, 'app_path')));
  handlers.set('get_api_platform_validation_context_stats', (a) => getApiPlatformValidationContextStats(str(a, 'app_path')));

  // API Platform resource metadata
  handlers.set('list_api_platform_resource_metadata', (a) => listApiPlatformResourceMetadata(str(a, 'app_path')));
  handlers.set('get_api_platform_resource_metadata_stats', (a) => getApiPlatformResourceMetadataStats(str(a, 'app_path')));

  // PHPUnit data providers
  handlers.set('list_phpunit_data_providers', (a) => listPhpUnitDataProviders(str(a, 'app_path')));
  handlers.set('get_phpunit_data_provider_stats', (a) => getPhpUnitDataProviderStats(str(a, 'app_path')));

  // PHPUnit mocks
  handlers.set('list_phpunit_mocks', (a) => listPhpUnitMocks(str(a, 'app_path')));
  handlers.set('get_phpunit_mock_stats', (a) => getPhpUnitMockStats(str(a, 'app_path')));

  // Behat contexts
  handlers.set('list_behat_contexts', (a) => listBehatContexts(str(a, 'app_path')));
  handlers.set('get_behat_context_stats', (a) => getBehatContextStats(str(a, 'app_path')));

  // Pest PHP config
  handlers.set('list_pest_php_config', (a) => listPestPhpConfig(str(a, 'app_path')));
  handlers.set('get_pest_php_stats', (a) => getPestPhpStats(str(a, 'app_path')));

  // PHP complexity
  handlers.set('list_php_complexity', (a) => listPhpComplexity(str(a, 'app_path')));
  handlers.set('get_php_complexity_stats', (a) => getPhpComplexityStats(str(a, 'app_path')));

  // PHP namespace consistency
  handlers.set('list_php_namespace_consistency', (a) => listPhpNamespaceConsistency(str(a, 'app_path')));
  handlers.set('get_php_namespace_consistency_stats', (a) => getPhpNamespaceConsistencyStats(str(a, 'app_path')));

  // PHP match exhaustiveness
  handlers.set('list_php_match_exhaustiveness', (a) => listPhpMatchExhaustiveness(str(a, 'app_path')));
  handlers.set('get_php_match_exhaustiveness_stats', (a) => getPhpMatchExhaustivenessStats(str(a, 'app_path')));

  // PHP deprecations
  handlers.set('list_php_deprecations', (a) => listPhpDeprecations(str(a, 'app_path')));
  handlers.set('get_php_deprecation_stats', (a) => getPhpDeprecationStats(str(a, 'app_path')));

  // PHP arrow functions
  handlers.set('list_php_arrow_functions', (a) => listPhpArrowFunctions(str(a, 'app_path')));
  handlers.set('get_php_arrow_function_stats', (a) => getPhpArrowFunctionStats(str(a, 'app_path')));

  // PHP attributes reader
  handlers.set('list_php_attributes_reader', (a) => listPhpAttributesReader(str(a, 'app_path')));
  handlers.set('get_php_attributes_reader_stats', (a) => getPhpAttributesReaderStats(str(a, 'app_path')));

  // Webserver config
  handlers.set('list_webserver_config', (a) => listWebserverConfig(str(a, 'app_path')));
  handlers.set('get_webserver_config_stats', (a) => getWebserverConfigStats(str(a, 'app_path')));

  // PHP architecture rules
  handlers.set('list_php_architecture_rules', (a) => listPhpArchitectureRules(str(a, 'app_path')));
  handlers.set('get_php_architecture_rules_stats', (a) => getPhpArchitectureRulesStats(str(a, 'app_path')));

  // Phase 26: Twig macros
  handlers.set('list_twig_macros', (a) => listTwigMacros(str(a, 'app_path')));
  handlers.set('get_twig_macro_stats', (a) => getTwigMacroStats(str(a, 'app_path')));
  // Twig template inheritance
  handlers.set('list_twig_inheritance', (a) => listTwigInheritance(str(a, 'app_path')));
  handlers.set('get_twig_inheritance_stats', (a) => getTwigInheritanceStats(str(a, 'app_path')));
  // Twig namespace paths
  handlers.set('list_twig_namespace_paths', (a) => listTwigNamespacePaths(str(a, 'app_path')));
  handlers.set('get_twig_namespace_stats', (a) => getTwigNamespaceStats(str(a, 'app_path')));
  // Doctrine custom hydrators
  handlers.set('list_doctrine_custom_hydrators', (a) => listDoctrineCustomHydrators(str(a, 'app_path')));
  handlers.set('get_doctrine_hydrator_stats', (a) => getDoctrineHydratorStats(str(a, 'app_path')));
  // Doctrine result cache
  handlers.set('list_doctrine_result_cache', (a) => listDoctrineResultCache(str(a, 'app_path')));
  handlers.set('get_doctrine_result_cache_stats', (a) => getDoctrineResultCacheStats(str(a, 'app_path')));
  // DBAL middleware
  handlers.set('list_dbal_middleware', (a) => listDbalMiddleware(str(a, 'app_path')));
  handlers.set('get_dbal_middleware_stats', (a) => getDbalMiddlewareStats(str(a, 'app_path')));
  // Doctrine soft delete
  handlers.set('list_doctrine_soft_delete', (a) => listDoctrineSoftDelete(str(a, 'app_path')));
  handlers.set('get_doctrine_soft_delete_stats', (a) => getDoctrineSoftDeleteStats(str(a, 'app_path')));
  // Doctrine mapping format
  handlers.set('list_doctrine_mapping_format', (a) => listDoctrineMappingFormat(str(a, 'app_path')));
  handlers.set('get_doctrine_mapping_format_stats', (a) => getDoctrineMappingFormatStats(str(a, 'app_path')));
  // Cookie security
  handlers.set('list_cookie_security', (a) => listCookieSecurity(str(a, 'app_path')));
  handlers.set('get_cookie_security_stats', (a) => getCookieSecurityStats(str(a, 'app_path')));
  // Content Security Policy
  handlers.set('list_csp_config', (a) => listCspConfig(str(a, 'app_path')));
  handlers.set('get_csp_stats', (a) => getCspStats(str(a, 'app_path')));
  // HTTP security headers
  handlers.set('list_http_security_headers', (a) => listHttpSecurityHeaders(str(a, 'app_path')));
  handlers.set('get_http_security_header_stats', (a) => getHttpSecurityHeaderStats(str(a, 'app_path')));
  // N+1 queries
  handlers.set('list_n_plus_one_patterns', (a) => listNPlusOnePatterns(str(a, 'app_path')));
  handlers.set('get_n_plus_one_stats', (a) => getNPlusOneStats(str(a, 'app_path')));
  // API Platform query extensions
  handlers.set('list_api_platform_query_extensions', (a) => listApiQueryExtensions(str(a, 'app_path')));
  handlers.set('get_api_platform_query_extension_stats', (a) => getApiQueryExtensionStats(str(a, 'app_path')));
  // API Platform custom normalizers
  handlers.set('list_api_platform_custom_normalizers', (a) => listApiCustomNormalizers(str(a, 'app_path')));
  handlers.set('get_api_platform_custom_normalizer_stats', (a) => getApiCustomNormalizerStats(str(a, 'app_path')));
  // API Platform IRI converter
  handlers.set('list_api_platform_iri_converter', (a) => listApiIriConverter(str(a, 'app_path')));
  handlers.set('get_api_platform_iri_converter_stats', (a) => getApiIriConverterStats(str(a, 'app_path')));
  // API Platform subresources
  handlers.set('list_api_platform_subresources', (a) => listApiSubresources(str(a, 'app_path')));
  handlers.set('get_api_platform_subresource_stats', (a) => getApiSubresourceStats(str(a, 'app_path')));
  // API Platform DTO output
  handlers.set('list_api_platform_dto_output', (a) => listApiDtoOutput(str(a, 'app_path')));
  handlers.set('get_api_platform_dto_output_stats', (a) => getApiDtoOutputStats(str(a, 'app_path')));
  // Translation domains
  handlers.set('list_translation_domains', (a) => listTranslationDomains(str(a, 'app_path')));
  handlers.set('get_translation_domain_stats', (a) => getTranslationDomainStats(str(a, 'app_path')));
  // ICU translation format
  handlers.set('list_icu_translations', (a) => listIcuTranslations(str(a, 'app_path')));
  handlers.set('get_icu_translation_stats', (a) => getIcuTranslationStats(str(a, 'app_path')));
  // XLIFF format
  handlers.set('list_xliff_translations', (a) => listXliffTranslations(str(a, 'app_path')));
  handlers.set('get_xliff_format_stats', (a) => getXliffFormatStats(str(a, 'app_path')));
  // Importmap config
  handlers.set('list_importmap_config', (a) => listImportmapConfig(str(a, 'app_path')));
  handlers.set('get_importmap_stats', (a) => getImportmapStats(str(a, 'app_path')));
  // Service locators
  handlers.set('list_service_locators', (a) => listServiceLocators(str(a, 'app_path')));
  handlers.set('get_service_locator_stats', (a) => getServiceLocatorStats(str(a, 'app_path')));
  // Abstract parent services
  handlers.set('list_abstract_services', (a) => listAbstractServices(str(a, 'app_path')));
  handlers.set('get_abstract_service_stats', (a) => getAbstractServiceStats(str(a, 'app_path')));
  // Exception subscribers
  handlers.set('list_exception_subscribers', (a) => listExceptionSubscribers(str(a, 'app_path')));
  handlers.set('get_exception_subscriber_stats', (a) => getExceptionSubscriberStats(str(a, 'app_path')));
  // Event priority conflicts
  handlers.set('list_event_priority_conflicts', (a) => listEventPriorityConflicts(str(a, 'app_path')));
  handlers.set('get_event_priority_stats', (a) => getEventPriorityStats(str(a, 'app_path')));
  // Twig email structure
  handlers.set('list_twig_email_structure', (a) => listTwigEmailStructure(str(a, 'app_path')));
  handlers.set('get_twig_email_stats', (a) => getTwigEmailStats(str(a, 'app_path')));
  // Mailer DKIM config
  handlers.set('list_mailer_dkim_config', (a) => listMailerDkimConfig(str(a, 'app_path')));
  handlers.set('get_mailer_dkim_stats', (a) => getMailerDkimStats(str(a, 'app_path')));
  // OpenTelemetry config
  handlers.set('list_opentelemetry_config', (a) => listOpenTelemetryConfig(str(a, 'app_path')));
  handlers.set('get_opentelemetry_stats', (a) => getOpenTelemetryStats(str(a, 'app_path')));
  // Monolog channel mapping
  handlers.set('list_monolog_channel_mapping', (a) => listMonologChannelMapping(str(a, 'app_path')));
  handlers.set('get_monolog_channel_stats', (a) => getMonologChannelStats(str(a, 'app_path')));
  // PHP Fibers
  handlers.set('list_php_fibers', (a) => listPhpFibers(str(a, 'app_path')));
  handlers.set('get_php_fiber_stats', (a) => getPhpFiberStats(str(a, 'app_path')));
  // PHP named arguments
  handlers.set('list_php_named_arguments', (a) => listPhpNamedArguments(str(a, 'app_path')));
  handlers.set('get_php_named_argument_stats', (a) => getPhpNamedArgumentStats(str(a, 'app_path')));
  // PHP generic annotations
  handlers.set('list_php_generic_annotations', (a) => listPhpGenericAnnotations(str(a, 'app_path')));
  handlers.set('get_php_generic_annotation_stats', (a) => getPhpGenericAnnotationStats(str(a, 'app_path')));
  // PHP intersection types
  handlers.set('list_php_intersection_types', (a) => listPhpIntersectionTypes(str(a, 'app_path')));
  handlers.set('get_php_intersection_type_stats', (a) => getPhpIntersectionTypeStats(str(a, 'app_path')));
  // Custom exception hierarchy
  handlers.set('list_custom_exception_hierarchy', (a) => listCustomExceptionHierarchy(str(a, 'app_path')));
  handlers.set('get_custom_exception_stats', (a) => getCustomExceptionStats(str(a, 'app_path')));
  // PHPUnit coverage config
  handlers.set('list_phpunit_coverage_config', (a) => listPhpUnitCoverageConfig(str(a, 'app_path')));
  handlers.set('get_phpunit_coverage_stats', (a) => getPhpUnitCoverageStats(str(a, 'app_path')));
  // Symfony Filesystem
  handlers.set('list_symfony_filesystem', (a) => listFilesystemUsage(str(a, 'app_path')));
  handlers.set('get_symfony_filesystem_stats', (a) => getFilesystemStats(str(a, 'app_path')));
  // Symfony Finder
  handlers.set('list_symfony_finder', (a) => listFinderUsage(str(a, 'app_path')));
  handlers.set('get_symfony_finder_stats', (a) => getFinderStats(str(a, 'app_path')));
  // Symfony PropertyAccess
  handlers.set('list_symfony_property_access', (a) => listPropertyAccessUsage(str(a, 'app_path')));
  handlers.set('get_symfony_property_access_stats', (a) => getPropertyAccessStats(str(a, 'app_path')));
  // Symfony Serializer context builders
  handlers.set('list_symfony_serializer_context', (a) => listSerializerContextBuilders(str(a, 'app_path')));
  handlers.set('get_symfony_serializer_context_stats', (a) => getSerializerContextStats(str(a, 'app_path')));
  // OPcache / APCu config
  handlers.set('list_opcache_apcu_config', (a) => listOpcacheApcuConfig(str(a, 'app_path')));
  handlers.set('get_opcache_apcu_stats', (a) => getOpcacheApcuStats(str(a, 'app_path')));
  // Redis config analysis
  handlers.set('list_redis_config', (a) => listRedisConfig(str(a, 'app_path')));
  handlers.set('get_redis_config_stats', (a) => getRedisConfigStats(str(a, 'app_path')));
  // DBAL connection pool
  handlers.set('list_dbal_connection_pool', (a) => listDbalConnectionPool(str(a, 'app_path')));
  handlers.set('get_dbal_connection_pool_stats', (a) => getDbalConnectionPoolStats(str(a, 'app_path')));
  // Webhook consumers
  handlers.set('list_webhook_consumers', (a) => listWebhookConsumers(str(a, 'app_path')));
  handlers.set('get_webhook_consumer_stats', (a) => getWebhookConsumerStats(str(a, 'app_path')));
  // API Platform security expressions
  handlers.set('list_api_platform_security_expressions', (a) => listApiSecurityExpressions(str(a, 'app_path')));
  handlers.set('get_api_platform_security_expression_stats', (a) => getApiSecurityExpressionStats(str(a, 'app_path')));
  // Messenger serializer
  handlers.set('list_messenger_serializer', (a) => listMessengerSerializer(str(a, 'app_path')));
  handlers.set('get_messenger_serializer_stats', (a) => getMessengerSerializerStats(str(a, 'app_path')));
  // DBAL connection factory
  handlers.set('list_dbal_connection_factory', (a) => listDbalConnectionFactory(str(a, 'app_path')));
  handlers.set('get_dbal_connection_factory_stats', (a) => getDbalConnectionFactoryStats(str(a, 'app_path')));
  // Console command options
  handlers.set('list_console_command_options', (a) => listConsoleCommandOptions(str(a, 'app_path')));
  handlers.set('get_console_command_option_stats', (a) => getConsoleCommandOptionStats(str(a, 'app_path')));
  // Notifier transport config
  handlers.set('list_notifier_transport_config', (a) => listNotifierTransportConfig(str(a, 'app_path')));
  handlers.set('get_notifier_transport_stats', (a) => getNotifierTransportStats(str(a, 'app_path')));
  // PHP nullsafe patterns
  handlers.set('list_php_nullsafe_patterns', (a) => listPhpNullsafePatterns(str(a, 'app_path')));
  handlers.set('get_php_nullsafe_stats', (a) => getPhpNullsafeStats(str(a, 'app_path')));
  // Symfony bundle config tree
  handlers.set('list_symfony_bundle_config_tree', (a) => listBundleConfigTree(str(a, 'app_path')));
  handlers.set('get_symfony_bundle_config_tree_stats', (a) => getBundleConfigTreeStats(str(a, 'app_path')));

  // Phase 27: Form collection types
  handlers.set('list_form_collection_types', (a) => listFormCollectionTypes(str(a, 'app_path')));
  handlers.set('get_form_collection_stats', (a) => getFormCollectionStats(str(a, 'app_path')));
  // Form themes
  handlers.set('list_form_themes', (a) => listFormThemes(str(a, 'app_path')));
  handlers.set('get_form_theme_stats', (a) => getFormThemeStats(str(a, 'app_path')));
  // Form buttons
  handlers.set('list_form_buttons', (a) => listFormButtons(str(a, 'app_path')));
  handlers.set('get_form_button_stats', (a) => getFormButtonStats(str(a, 'app_path')));
  // Doctrine multi-connection
  handlers.set('list_doctrine_multi_connection', (a) => listDoctrineMultiConnection(str(a, 'app_path')));
  handlers.set('get_doctrine_multi_connection_stats', (a) => getDoctrineMultiConnectionStats(str(a, 'app_path')));
  // Doctrine UoW flush
  handlers.set('list_doctrine_uow_flush', (a) => listDoctrineUowFlush(str(a, 'app_path')));
  handlers.set('get_doctrine_uow_flush_stats', (a) => getDoctrineUowFlushStats(str(a, 'app_path')));
  // Doctrine entity listeners
  handlers.set('list_doctrine_entity_listeners', (a) => listDoctrineEntityListeners(str(a, 'app_path')));
  handlers.set('get_doctrine_entity_listener_stats', (a) => getDoctrineEntityListenerStats(str(a, 'app_path')));
  // Doctrine sequence generators
  handlers.set('list_doctrine_sequence_generators', (a) => listDoctrineSequenceGenerators(str(a, 'app_path')));
  handlers.set('get_doctrine_sequence_stats', (a) => getDoctrineSequenceStats(str(a, 'app_path')));
  // Doctrine column charset
  handlers.set('list_doctrine_column_charsets', (a) => listDoctrineColumnCharsets(str(a, 'app_path')));
  handlers.set('get_doctrine_column_charset_stats', (a) => getDoctrineColumnCharsetStats(str(a, 'app_path')));
  // DBAL prepared statements
  handlers.set('list_dbal_prepared_statements', (a) => listDbalPreparedStatements(str(a, 'app_path')));
  handlers.set('get_dbal_prepared_statement_stats', (a) => getDbalPreparedStatementStats(str(a, 'app_path')));
  // Doctrine migrations config
  handlers.set('list_doctrine_migrations_config', (a) => listDoctrineMigrationsConfig(str(a, 'app_path')));
  handlers.set('get_doctrine_migrations_config_stats', (a) => getDoctrineMigrationsConfigStats(str(a, 'app_path')));
  // Security remember-me
  handlers.set('list_security_remember_me', (a) => listRememberMeConfig(str(a, 'app_path')));
  handlers.set('get_security_remember_me_stats', (a) => getRememberMeStats(str(a, 'app_path')));
  // Security impersonation
  handlers.set('list_security_impersonation', (a) => listImpersonationConfig(str(a, 'app_path')));
  handlers.set('get_security_impersonation_stats', (a) => getImpersonationStats(str(a, 'app_path')));
  // Security access decision
  handlers.set('list_security_access_decision', (a) => listAccessDecisionConfig(str(a, 'app_path')));
  handlers.set('get_security_access_decision_stats', (a) => getAccessDecisionStats(str(a, 'app_path')));
  // Security login throttle
  handlers.set('list_security_login_throttle', (a) => listLoginThrottleConfig(str(a, 'app_path')));
  handlers.set('get_security_login_throttle_stats', (a) => getLoginThrottleStats(str(a, 'app_path')));
  // Security IP access
  handlers.set('list_security_ip_access', (a) => listSecurityIpAccess(str(a, 'app_path')));
  handlers.set('get_security_ip_access_stats', (a) => getSecurityIpAccessStats(str(a, 'app_path')));
  // Security login link
  handlers.set('list_security_login_link', (a) => listLoginLinkConfig(str(a, 'app_path')));
  handlers.set('get_security_login_link_stats', (a) => getLoginLinkStats(str(a, 'app_path')));
  // Security password upgrade
  handlers.set('list_security_password_upgrade', (a) => listPasswordUpgradeConfig(str(a, 'app_path')));
  handlers.set('get_security_password_upgrade_stats', (a) => getPasswordUpgradeStats(str(a, 'app_path')));
  // Security session strategy
  handlers.set('list_security_session_strategy', (a) => listSessionStrategyConfig(str(a, 'app_path')));
  handlers.set('get_security_session_strategy_stats', (a) => getSessionStrategyStats(str(a, 'app_path')));
  // Messenger retry
  handlers.set('list_messenger_retry_config', (a) => listMessengerRetryConfig(str(a, 'app_path')));
  handlers.set('get_messenger_retry_stats', (a) => getMessengerRetryStats(str(a, 'app_path')));
  // Messenger worker
  handlers.set('list_messenger_worker_config', (a) => listMessengerWorkerConfig(str(a, 'app_path')));
  handlers.set('get_messenger_worker_stats', (a) => getMessengerWorkerStats(str(a, 'app_path')));
  // Console table
  handlers.set('list_console_table_usage', (a) => listConsoleTableUsage(str(a, 'app_path')));
  handlers.set('get_console_table_stats', (a) => getConsoleTableStats(str(a, 'app_path')));
  // Console question
  handlers.set('list_console_questions', (a) => listConsoleQuestions(str(a, 'app_path')));
  handlers.set('get_console_question_stats', (a) => getConsoleQuestionStats(str(a, 'app_path')));
  // Cache chain
  handlers.set('list_cache_chain_config', (a) => listCacheChainConfig(str(a, 'app_path')));
  handlers.set('get_cache_chain_stats', (a) => getCacheChainStats(str(a, 'app_path')));
  // Translation providers
  handlers.set('list_translation_providers', (a) => listTranslationProviders(str(a, 'app_path')));
  handlers.set('get_translation_provider_stats', (a) => getTranslationProviderStats(str(a, 'app_path')));
  // UX Autocomplete
  handlers.set('list_ux_autocomplete', (a) => listUxAutocomplete(str(a, 'app_path')));
  handlers.set('get_ux_autocomplete_stats', (a) => getUxAutocompleteStats(str(a, 'app_path')));
  // Flash messages
  handlers.set('list_flash_messages', (a) => listFlashMessages(str(a, 'app_path')));
  handlers.set('get_flash_message_stats', (a) => getFlashMessageStats(str(a, 'app_path')));
  // Request stack
  handlers.set('list_request_stack_usage', (a) => listRequestStackUsage(str(a, 'app_path')));
  handlers.set('get_request_stack_stats', (a) => getRequestStackStats(str(a, 'app_path')));
  // HTTP client events
  handlers.set('list_http_client_events', (a) => listHttpClientEvents(str(a, 'app_path')));
  handlers.set('get_http_client_event_stats', (a) => getHttpClientEventStats(str(a, 'app_path')));
  // Semaphore
  handlers.set('list_semaphore_usage', (a) => listSemaphoreUsage(str(a, 'app_path')));
  handlers.set('get_semaphore_stats', (a) => getSemaphoreStats(str(a, 'app_path')));
  // Asset packages
  handlers.set('list_asset_packages', (a) => listAssetPackages(str(a, 'app_path')));
  handlers.set('get_asset_package_stats', (a) => getAssetPackageStats(str(a, 'app_path')));
  // MIME types
  handlers.set('list_mime_type_usage', (a) => listMimeTypeUsage(str(a, 'app_path')));
  handlers.set('get_mime_type_stats', (a) => getMimeTypeStats(str(a, 'app_path')));
  // Serializer encoders
  handlers.set('list_serializer_encoders', (a) => listSerializerEncoders(str(a, 'app_path')));
  handlers.set('get_serializer_encoder_stats', (a) => getSerializerEncoderStats(str(a, 'app_path')));
  // Workflow events
  handlers.set('list_workflow_event_subscriptions', (a) => listWorkflowEventSubscriptions(str(a, 'app_path')));
  handlers.set('get_workflow_event_stats', (a) => getWorkflowEventStats(str(a, 'app_path')));
  // API Platform error handling
  handlers.set('list_api_platform_error_handling', (a) => listApiPlatformErrorHandling(str(a, 'app_path')));
  handlers.set('get_api_platform_error_handling_stats', (a) => getApiPlatformErrorHandlingStats(str(a, 'app_path')));
  // API Platform OpenAPI context
  handlers.set('list_api_openapi_context', (a) => listApiOpenApiContext(str(a, 'app_path')));
  handlers.set('get_api_openapi_context_stats', (a) => getApiOpenApiContextStats(str(a, 'app_path')));
  // PHP first-class callables
  handlers.set('list_php_first_class_callables', (a) => listFirstClassCallables(str(a, 'app_path')));
  handlers.set('get_php_first_class_callable_stats', (a) => getFirstClassCallableStats(str(a, 'app_path')));
  // PHP string helpers
  handlers.set('list_php_string_helpers', (a) => listPhpStringHelpers(str(a, 'app_path')));
  handlers.set('get_php_string_helper_stats', (a) => getPhpStringHelperStats(str(a, 'app_path')));
  // PHP generators
  handlers.set('list_php_generators', (a) => listPhpGenerators(str(a, 'app_path')));
  handlers.set('get_php_generator_stats', (a) => getPhpGeneratorStats(str(a, 'app_path')));
  // PHP weak references
  handlers.set('list_php_weak_references', (a) => listPhpWeakReferences(str(a, 'app_path')));
  handlers.set('get_php_weak_reference_stats', (a) => getPhpWeakReferenceStats(str(a, 'app_path')));
  // PHP typed constants
  handlers.set('list_php_typed_constants', (a) => listPhpTypedConstants(str(a, 'app_path')));
  handlers.set('get_php_typed_constants_stats', (a) => getPhpTypedConstantStats(str(a, 'app_path')));
  // PHP property hooks
  handlers.set('list_php_property_hooks', (a) => listPhpPropertyHooks(str(a, 'app_path')));
  handlers.set('get_php_property_hook_stats', (a) => getPhpPropertyHookStats(str(a, 'app_path')));
  // PHP asymmetric visibility
  handlers.set('list_php_asymmetric_visibility', (a) => listAsymmetricVisibility(str(a, 'app_path')));
  handlers.set('get_php_asymmetric_visibility_stats', (a) => getAsymmetricVisibilityStats(str(a, 'app_path')));
  // PHP error handling
  handlers.set('list_php_error_handling', (a) => listPhpErrorHandling(str(a, 'app_path')));
  handlers.set('get_php_error_handling_stats', (a) => getPhpErrorHandlingStats(str(a, 'app_path')));
  // PHPUnit attributes
  handlers.set('list_phpunit_attributes', (a) => listPhpUnitAttributes(str(a, 'app_path')));
  handlers.set('get_phpunit_attribute_stats', (a) => getPhpUnitAttributeStats(str(a, 'app_path')));
  // PHPUnit extensions
  handlers.set('list_phpunit_extensions', (a) => listPhpUnitExtensions(str(a, 'app_path')));
  handlers.set('get_phpunit_extension_stats', (a) => getPhpUnitExtensionStats(str(a, 'app_path')));
  // Security two-factor
  handlers.set('list_security_two_factor', (a) => listTwoFactorConfig(str(a, 'app_path')));
  handlers.set('get_security_two_factor_stats', (a) => getTwoFactorStats(str(a, 'app_path')));
  // PHPStan custom rules
  handlers.set('list_phpstan_custom_rules', (a) => listPhpStanCustomRules(str(a, 'app_path')));
  handlers.set('get_phpstan_custom_rule_stats', (a) => getPhpStanCustomRuleStats(str(a, 'app_path')));
  // Rector custom rules
  handlers.set('list_rector_custom_rules', (a) => listRectorCustomRules(str(a, 'app_path')));
  handlers.set('get_rector_custom_rule_stats', (a) => getRectorCustomRuleStats(str(a, 'app_path')));
  // Vite bundle
  handlers.set('list_vite_config', (a) => listViteConfig(str(a, 'app_path')));
  handlers.set('get_vite_stats', (a) => getViteStats(str(a, 'app_path')));
  // Profiler panels
  handlers.set('list_profiler_panels', (a) => listProfilerPanels(str(a, 'app_path')));
  handlers.set('get_profiler_panel_stats', (a) => getProfilerPanelStats(str(a, 'app_path')));
  // Phase 28 — Response types / content negotiation / subrequest
  handlers.set('list_response_types', (a) => listResponseTypes(str(a, 'app_path')));
  handlers.set('get_response_type_stats', (a) => getResponseTypeStats(str(a, 'app_path')));
  handlers.set('list_content_negotiation', (a) => listContentNegotiation(str(a, 'app_path')));
  handlers.set('get_content_negotiation_stats', (a) => getContentNegotiationStats(str(a, 'app_path')));
  handlers.set('list_subrequest_usage', (a) => listSubrequestUsage(str(a, 'app_path')));
  handlers.set('get_subrequest_stats', (a) => getSubrequestStats(str(a, 'app_path')));
  handlers.set('list_form_data_class', (a) => listFormDataClass(str(a, 'app_path')));
  handlers.set('get_form_data_class_stats', (a) => getFormDataClassStats(str(a, 'app_path')));
  handlers.set('list_form_repeated', (a) => listFormRepeated(str(a, 'app_path')));
  handlers.set('get_form_repeated_stats', (a) => getFormRepeatedStats(str(a, 'app_path')));
  handlers.set('list_form_type_guess', (a) => listFormTypeGuess(str(a, 'app_path')));
  handlers.set('get_form_type_guess_stats', (a) => getFormTypeGuessStats(str(a, 'app_path')));
  handlers.set('list_form_callback_constraints', (a) => listFormCallbackConstraints(str(a, 'app_path')));
  handlers.set('get_form_callback_constraint_stats', (a) => getFormCallbackConstraintStats(str(a, 'app_path')));
  handlers.set('list_routing_requirements', (a) => listRoutingRequirements(str(a, 'app_path')));
  handlers.set('get_routing_requirement_stats', (a) => getRoutingRequirementStats(str(a, 'app_path')));
  handlers.set('list_routing_loaders', (a) => listRoutingLoaders(str(a, 'app_path')));
  handlers.set('get_routing_loader_stats', (a) => getRoutingLoaderStats(str(a, 'app_path')));
  handlers.set('list_security_entry_points', (a) => listSecurityEntryPoints(str(a, 'app_path')));
  handlers.set('get_security_entry_point_stats', (a) => getSecurityEntryPointStats(str(a, 'app_path')));
  // Security post-auth events
  handlers.set('list_security_post_auth', (a) => listSecurityPostAuth(str(a, 'app_path')));
  handlers.set('get_security_post_auth_stats', (a) => getSecurityPostAuthStats(str(a, 'app_path')));
  // Security firewall listeners
  handlers.set('list_security_firewall_listeners', (a) => listFirewallListeners(str(a, 'app_path')));
  handlers.set('get_security_firewall_listener_stats', (a) => getFirewallListenerStats(str(a, 'app_path')));
  // Password strength
  handlers.set('list_password_strength', (a) => listPasswordStrength(str(a, 'app_path')));
  handlers.set('get_password_strength_stats', (a) => getPasswordStrengthStats(str(a, 'app_path')));
  // Cache stampede
  handlers.set('list_cache_stampede', (a) => listCacheStampede(str(a, 'app_path')));
  handlers.set('get_cache_stampede_stats', (a) => getCacheStampedeStats(str(a, 'app_path')));
  // Cache pool prune
  handlers.set('list_cache_pool_prune', (a) => listCachePoolPrune(str(a, 'app_path')));
  handlers.set('get_cache_pool_prune_stats', (a) => getCachePoolPruneStats(str(a, 'app_path')));
  // Messenger envelopes
  handlers.set('list_messenger_envelopes', (a) => listMessengerEnvelopes(str(a, 'app_path')));
  handlers.set('get_messenger_envelope_stats', (a) => getMessengerEnvelopeStats(str(a, 'app_path')));
  // Messenger dispatch-after
  handlers.set('list_dispatch_after_current_bus', (a) => listDispatchAfterCurrentBus(str(a, 'app_path')));
  handlers.set('get_dispatch_after_stats', (a) => getDispatchAfterStats(str(a, 'app_path')));
  // Object normalizer
  handlers.set('list_object_normalizer_usage', (a) => listObjectNormalizerUsage(str(a, 'app_path')));
  handlers.set('get_object_normalizer_stats', (a) => getObjectNormalizerStats(str(a, 'app_path')));
  // Validator cascade
  handlers.set('list_validator_cascade', (a) => listValidatorCascade(str(a, 'app_path')));
  handlers.set('get_validator_cascade_stats', (a) => getValidatorCascadeStats(str(a, 'app_path')));
  // Validator group sequence
  handlers.set('list_validator_group_sequence', (a) => listValidatorGroupSequence(str(a, 'app_path')));
  handlers.set('get_validator_group_sequence_stats', (a) => getValidatorGroupSequenceStats(str(a, 'app_path')));

  // Phase 20 tools
  // Validator expressions
  handlers.set('list_validator_expressions', (a) => listValidatorExpressions(str(a, 'app_path')));
  handlers.set('get_validator_expression_stats', (a) => getValidatorExpressionStats(str(a, 'app_path')));
  // Constraint validator tests
  handlers.set('list_constraint_validator_tests', (a) => listConstraintValidatorTests(str(a, 'app_path')));
  handlers.set('get_constraint_validator_test_stats', (a) => getConstraintValidatorTestStats(str(a, 'app_path')));
  // Debug dumps
  handlers.set('list_debug_dumps', (a) => listDebugDumps(str(a, 'app_path')));
  handlers.set('get_debug_dump_stats', (a) => getDebugDumpStats(str(a, 'app_path')));
  // Profiler storage
  handlers.set('list_profiler_storage', (a) => listProfilerStorage(str(a, 'app_path')));
  handlers.set('get_profiler_storage_stats', (a) => getProfilerStorageStats(str(a, 'app_path')));
  // Error controller
  handlers.set('list_error_controller', (a) => listErrorController(str(a, 'app_path')));
  handlers.set('get_error_controller_stats', (a) => getErrorControllerStats(str(a, 'app_path')));
  // Mailer attachments
  handlers.set('list_mailer_attachments', (a) => listMailerAttachments(str(a, 'app_path')));
  handlers.set('get_mailer_attachment_stats', (a) => getMailerAttachmentStats(str(a, 'app_path')));
  // HTTP client mocks
  handlers.set('list_http_client_mocks', (a) => listHttpClientMocks(str(a, 'app_path')));
  handlers.set('get_http_client_mock_stats', (a) => getHttpClientMockStats(str(a, 'app_path')));
  // Controller tests
  handlers.set('list_controller_tests', (a) => listControllerTests(str(a, 'app_path')));
  handlers.set('get_controller_test_stats', (a) => getControllerTestStats(str(a, 'app_path')));
  // Clock tests
  handlers.set('list_clock_tests', (a) => listClockTests(str(a, 'app_path')));
  handlers.set('get_clock_test_stats', (a) => getClockTestStats(str(a, 'app_path')));
  // DI lazy ghost services
  handlers.set('list_lazy_ghost_services', (a) => listLazyGhostServices(str(a, 'app_path')));
  handlers.set('get_lazy_ghost_stats', (a) => getLazyGhostStats(str(a, 'app_path')));

  // Phase 21 tools
  // PHP covariance / contravariance
  handlers.set('list_php_covariance', (a) => listPhpCovariance(str(a, 'app_path')));
  handlers.set('get_php_covariance_stats', (a) => getPhpCovarianceStats(str(a, 'app_path')));
  // PHP abstract patterns
  handlers.set('list_php_abstract_patterns', (a) => listAbstractPatterns(str(a, 'app_path')));
  handlers.set('get_php_abstract_pattern_stats', (a) => getAbstractPatternStats(str(a, 'app_path')));
  // PHP interface segregation
  handlers.set('list_php_interface_segregation', (a) => listInterfaceSegregation(str(a, 'app_path')));
  handlers.set('get_php_interface_segregation_stats', (a) => getInterfaceSegregationStats(str(a, 'app_path')));
  // Static analysis ignores
  handlers.set('list_static_analysis_ignores', (a) => listStaticAnalysisIgnores(str(a, 'app_path')));
  handlers.set('get_static_analysis_ignore_stats', (a) => getStaticAnalysisIgnoreStats(str(a, 'app_path')));
  // PHP magic methods
  handlers.set('list_php_magic_methods', (a) => listPhpMagicMethods(str(a, 'app_path')));
  handlers.set('get_php_magic_method_stats', (a) => getPhpMagicMethodStats(str(a, 'app_path')));
  // PHPUnit performance
  handlers.set('list_phpunit_performance', (a) => listPhpUnitPerformance(str(a, 'app_path')));
  handlers.set('get_phpunit_performance_stats', (a) => getPhpUnitPerformanceStats(str(a, 'app_path')));
  // PHPUnit database
  handlers.set('list_phpunit_database', (a) => listPhpUnitDatabase(str(a, 'app_path')));
  handlers.set('get_phpunit_database_stats', (a) => getPhpUnitDatabaseStats(str(a, 'app_path')));
  // PHPUnit parallel
  handlers.set('list_phpunit_parallel', (a) => listPhpUnitParallel(str(a, 'app_path')));
  handlers.set('get_phpunit_parallel_stats', (a) => getPhpUnitParallelStats(str(a, 'app_path')));
  // Symfony runtime environment
  handlers.set('list_runtime_env', (a) => listRuntimeEnv(str(a, 'app_path')));
  handlers.set('get_runtime_env_stats', (a) => getRuntimeEnvStats(str(a, 'app_path')));
  // Symfony health probes
  handlers.set('list_health_probes', (a) => listHealthProbes(str(a, 'app_path')));
  handlers.set('get_health_probe_stats', (a) => getHealthProbeStats(str(a, 'app_path')));

  // Phase 28 tools
  handlers.set('list_php_object_cloning', (a) => listPhpObjectCloning(str(a, 'app_path')));
  handlers.set('get_php_object_cloning_stats', (a) => getPhpObjectCloningStats(str(a, 'app_path')));

  handlers.set('list_php_date_time', (a) => listPhpDateTime(str(a, 'app_path')));
  handlers.set('get_php_date_time_stats', (a) => getPhpDateTimeStats(str(a, 'app_path')));

  handlers.set('list_phpunit_snapshots', (a) => listPhpUnitSnapshots(str(a, 'app_path')));
  handlers.set('get_phpunit_snapshot_stats', (a) => getPhpUnitSnapshotStats(str(a, 'app_path')));

  handlers.set('list_phpunit_expect_exception', (a) => listPhpUnitExpectException(str(a, 'app_path')));
  handlers.set('get_phpunit_expect_exception_stats', (a) => getPhpUnitExpectExceptionStats(str(a, 'app_path')));

  handlers.set('list_behat_step_coverage', (a) => listBehatStepCoverage(str(a, 'app_path')));
  handlers.set('get_behat_step_coverage_stats', (a) => getBehatStepCoverageStats(str(a, 'app_path')));

  handlers.set('list_behat_tags', (a) => listBehatTags(str(a, 'app_path')));
  handlers.set('get_behat_tag_stats', (a) => getBehatTagStats(str(a, 'app_path')));

  handlers.set('list_ux_chart', (a) => listUxChart(str(a, 'app_path')));
  handlers.set('get_ux_chart_stats', (a) => getUxChartStats(str(a, 'app_path')));

  handlers.set('list_ux_notify', (a) => listUxNotify(str(a, 'app_path')));
  handlers.set('get_ux_notify_stats', (a) => getUxNotifyStats(str(a, 'app_path')));

  handlers.set('list_ux_cropper_js', (a) => listUxCropperJs(str(a, 'app_path')));
  handlers.set('get_ux_cropper_js_stats', (a) => getUxCropperJsStats(str(a, 'app_path')));

  handlers.set('list_serializer_discriminator', (a) => listSerializerDiscriminator(str(a, 'app_path')));
  handlers.set('get_serializer_discriminator_stats', (a) => getSerializerDiscriminatorStats(str(a, 'app_path')));

  handlers.set('list_serializer_denormalization', (a) => listSerializerDenormalization(str(a, 'app_path')));
  handlers.set('get_serializer_denormalization_stats', (a) => getSerializerDenormalizationStats(str(a, 'app_path')));
  handlers.set('list_doctrine_criteria', (a) => listDoctrineCriteria(str(a, 'app_path')));
  handlers.set('get_doctrine_criteria_stats', (a) => getDoctrineCriteriaStats(str(a, 'app_path')));
  handlers.set('list_doctrine_entity_graph', (a) => listDoctrineEntityGraph(str(a, 'app_path')));
  handlers.set('get_doctrine_entity_graph_stats', (a) => getDoctrineEntityGraphStats(str(a, 'app_path')));
  handlers.set('list_doctrine_change_tracking', (a) => listDoctrineChangeTracking(str(a, 'app_path')));
  handlers.set('get_doctrine_change_tracking_stats', (a) => getDoctrineChangeTrackingStats(str(a, 'app_path')));
  handlers.set('list_doctrine_result_set_mapping', (a) => listDoctrineResultSetMapping(str(a, 'app_path')));
  handlers.set('get_doctrine_result_set_mapping_stats', (a) => getDoctrineResultSetMappingStats(str(a, 'app_path')));
  handlers.set('list_doctrine_odm_config', (a) => listDoctrineOdmConfig(str(a, 'app_path')));
  handlers.set('get_doctrine_odm_config_stats', (a) => getDoctrineOdmConfigStats(str(a, 'app_path')));
  handlers.set('list_doctrine_bulk_operations', (a) => listDoctrineBulkOperations(str(a, 'app_path')));
  handlers.set('get_doctrine_bulk_operation_stats', (a) => getDoctrineBulkOperationStats(str(a, 'app_path')));
  handlers.set('list_doctrine_entity_state', (a) => listDoctrineEntityState(str(a, 'app_path')));
  handlers.set('get_doctrine_entity_state_stats', (a) => getDoctrineEntityStateStats(str(a, 'app_path')));
  handlers.set('list_http_cache_validation', (a) => listHttpCacheValidation(str(a, 'app_path')));
  handlers.set('get_http_cache_validation_stats', (a) => getHttpCacheValidationStats(str(a, 'app_path')));
  handlers.set('list_parameter_bag_usage', (a) => listParameterBagUsage(str(a, 'app_path')));
  handlers.set('get_parameter_bag_stats', (a) => getParameterBagStats(str(a, 'app_path')));

  handlers.set('list_messenger_scheduler', (a) => listMessengerScheduler(str(a, 'app_path')));
  handlers.set('get_messenger_scheduler_stats', (a) => getMessengerSchedulerStats(str(a, 'app_path')));

  handlers.set('list_messenger_batch_handler', (a) => listMessengerBatchHandler(str(a, 'app_path')));
  handlers.set('get_messenger_batch_handler_stats', (a) => getMessengerBatchHandlerStats(str(a, 'app_path')));

  handlers.set('list_messenger_priority', (a) => listMessengerPriority(str(a, 'app_path')));
  handlers.set('get_messenger_priority_stats', (a) => getMessengerPriorityStats(str(a, 'app_path')));

  handlers.set('list_in_memory_transport', (a) => listInMemoryTransport(str(a, 'app_path')));
  handlers.set('get_in_memory_transport_stats', (a) => getInMemoryTransportStats(str(a, 'app_path')));

  handlers.set('list_resettable_services', (a) => listResettableServices(str(a, 'app_path')));
  handlers.set('get_resettable_service_stats', (a) => getResettableServiceStats(str(a, 'app_path')));

  handlers.set('list_tagged_iterators', (a) => listTaggedIterators(str(a, 'app_path')));
  handlers.set('get_tagged_iterator_stats', (a) => getTaggedIteratorStats(str(a, 'app_path')));

  handlers.set('list_command_lock', (a) => listCommandLock(str(a, 'app_path')));
  handlers.set('get_command_lock_stats', (a) => getCommandLockStats(str(a, 'app_path')));

  handlers.set('list_mailer_dsn_config', (a) => listMailerDsnConfig(str(a, 'app_path')));
  handlers.set('get_mailer_dsn_config_stats', (a) => getMailerDsnConfigStats(str(a, 'app_path')));

  handlers.set('list_domain_events', (a) => listDomainEvents(str(a, 'app_path')));
  handlers.set('get_domain_event_stats', (a) => getDomainEventStats(str(a, 'app_path')));

  handlers.set('list_handle_trait_usage', (a) => listHandleTraitUsage(str(a, 'app_path')));
  handlers.set('get_handle_trait_stats', (a) => getHandleTraitStats(str(a, 'app_path')));

  // Phase 28 batch 2 — rate limiter storage / password migration / kernel terminate / asset mapper
  handlers.set('list_rate_limiter_storage', (a) => listRateLimiterStorage(str(a, 'app_path')));
  handlers.set('get_rate_limiter_storage_stats', (a) => getRateLimiterStorageStats(str(a, 'app_path')));
  handlers.set('list_password_migration', (a) => listPasswordMigration(str(a, 'app_path')));
  handlers.set('get_password_migration_stats', (a) => getPasswordMigrationStats(str(a, 'app_path')));
  handlers.set('list_kernel_terminate', (a) => listKernelTerminate(str(a, 'app_path')));
  handlers.set('get_kernel_terminate_stats', (a) => getKernelTerminateStats(str(a, 'app_path')));
  handlers.set('list_asset_mapper', (a) => listAssetMapper(str(a, 'app_path')));
  handlers.set('get_asset_mapper_stats', (a) => getAssetMapperStats(str(a, 'app_path')));
  handlers.set('list_twig_test_functions', (a) => listTwigTestFunctions(str(a, 'app_path')));
  handlers.set('get_twig_test_function_stats', (a) => getTwigTestFunctionStats(str(a, 'app_path')));
  handlers.set('list_http_client_auth', (a) => listHttpClientAuth(str(a, 'app_path')));
  handlers.set('get_http_client_auth_stats', (a) => getHttpClientAuthStats(str(a, 'app_path')));
  handlers.set('list_expression_language_extensions', (a) => listExpressionLanguageExtensions(str(a, 'app_path')));
  handlers.set('get_expression_language_ext_stats', (a) => getExpressionLanguageExtStats(str(a, 'app_path')));
  handlers.set('list_console_helpers', (a) => listConsoleHelpers(str(a, 'app_path')));
  handlers.set('get_console_helper_stats', (a) => getConsoleHelperStats(str(a, 'app_path')));
  handlers.set('list_browser_kit_usage', (a) => listBrowserKitUsage(str(a, 'app_path')));
  handlers.set('get_browser_kit_stats', (a) => getBrowserKitStats(str(a, 'app_path')));
  handlers.set('list_kubernetes_config', (a) => listKubernetesConfig(str(a, 'app_path')));
  handlers.set('get_kubernetes_config_stats', (a) => getKubernetesConfigStats(str(a, 'app_path')));

  // Phase 28+ tools — UserChecker, UserProvider, Closures, Splat, Never, Traits, NullCoalescing, CtorPromotion, LSB, ArrayFunctions
  handlers.set('list_user_checkers', (a) => listUserCheckers(str(a, 'app_path')));
  handlers.set('get_user_checker_stats', (a) => getUserCheckerStats(str(a, 'app_path')));
  handlers.set('list_security_user_providers', (a) => listSecurityUserProviders(str(a, 'app_path')));
  handlers.set('get_security_user_provider_stats', (a) => getSecurityUserProviderStats(str(a, 'app_path')));
  handlers.set('list_php_closures', (a) => listPhpClosures(str(a, 'app_path')));
  handlers.set('get_php_closure_stats', (a) => getPhpClosureStats(str(a, 'app_path')));
  handlers.set('list_php_splat_operator', (a) => listPhpSplatOperator(str(a, 'app_path')));
  handlers.set('get_php_splat_stats', (a) => getPhpSplatStats(str(a, 'app_path')));
  handlers.set('list_php_never_type', (a) => listPhpNeverType(str(a, 'app_path')));
  handlers.set('get_php_never_type_stats', (a) => getPhpNeverTypeStats(str(a, 'app_path')));
  handlers.set('list_php_trait_conflicts', (a) => listPhpTraitConflicts(str(a, 'app_path')));
  handlers.set('get_php_trait_conflict_stats', (a) => getPhpTraitConflictStats(str(a, 'app_path')));
  handlers.set('list_php_null_coalescing', (a) => listPhpNullCoalescing(str(a, 'app_path')));
  handlers.set('get_php_null_coalescing_stats', (a) => getPhpNullCoalescingStats(str(a, 'app_path')));
  handlers.set('list_php_constructor_promotion', (a) => listPhpConstructorPromotion(str(a, 'app_path')));
  handlers.set('get_php_constructor_promotion_stats', (a) => getPhpConstructorPromotionStats(str(a, 'app_path')));
  handlers.set('list_php_late_static_binding', (a) => listPhpLateStaticBinding(str(a, 'app_path')));
  handlers.set('get_php_late_static_binding_stats', (a) => getPhpLateStaticBindingStats(str(a, 'app_path')));
  handlers.set('list_php_array_functions', (a) => listPhpArrayFunctions(str(a, 'app_path')));
  handlers.set('get_php_array_function_stats', (a) => getPhpArrayFunctionStats(str(a, 'app_path')));

  // Phase 30 tools
  handlers.set('list_doctrine_dql_walkers', (a) => listDoctrineDqlWalkers(str(a, 'app_path')));
  handlers.set('get_doctrine_dql_walker_stats', (a) => getDoctrineDqlWalkerStats(str(a, 'app_path')));
  handlers.set('list_doctrine_dbal_event_listeners', (a) => listDbalEventListeners(str(a, 'app_path')));
  handlers.set('get_doctrine_dbal_event_listener_stats', (a) => getDbalEventListenerStats(str(a, 'app_path')));
  handlers.set('list_doctrine_entity_proxies', (a) => listDoctrineEntityProxies(str(a, 'app_path')));
  handlers.set('get_doctrine_entity_proxy_stats', (a) => getDoctrineEntityProxyStats(str(a, 'app_path')));
  handlers.set('list_doctrine_association_fetches', (a) => listDoctrineAssociationFetches(str(a, 'app_path')));
  handlers.set('get_doctrine_association_fetch_stats', (a) => getDoctrineAssociationFetchStats(str(a, 'app_path')));
  handlers.set('list_doctrine_dbal_bulk_inserts', (a) => listDbalBulkInserts(str(a, 'app_path')));
  handlers.set('get_doctrine_dbal_bulk_insert_stats', (a) => getDbalBulkInsertStats(str(a, 'app_path')));
  handlers.set('list_doctrine_sharding_config', (a) => listDoctrineShardingConfig(str(a, 'app_path')));
  handlers.set('get_doctrine_sharding_stats', (a) => getDoctrineShardingStats(str(a, 'app_path')));
  handlers.set('list_doctrine_dbal_schema_diffs', (a) => listDbalSchemaDiffs(str(a, 'app_path')));
  handlers.set('get_doctrine_dbal_schema_diff_stats', (a) => getDbalSchemaDiffStats(str(a, 'app_path')));
  handlers.set('list_phpunit_custom_assertions', (a) => listPhpUnitCustomAssertions(str(a, 'app_path')));
  handlers.set('get_phpunit_custom_assertion_stats', (a) => getPhpUnitCustomAssertionStats(str(a, 'app_path')));
  handlers.set('list_phpunit_test_doubles', (a) => listPhpUnitTestDoubles(str(a, 'app_path')));
  handlers.set('get_phpunit_test_double_stats', (a) => getPhpUnitTestDoubleStats(str(a, 'app_path')));
  handlers.set('list_infection_config', (a) => listInfectionConfig(str(a, 'app_path')));
  handlers.set('get_infection_mutant_stats', (a) => getInfectionMutantStats(str(a, 'app_path')));

  // Phase 31 tools
  handlers.set('list_php_spl_data_structures', (a) => listPhpSplDataStructures(str(a, 'app_path')));
  handlers.set('get_php_spl_data_structure_stats', (a) => getPhpSplDataStructureStats(str(a, 'app_path')));
  handlers.set('list_php_immutable_value_objects', (a) => listPhpImmutableValueObjects(str(a, 'app_path')));
  handlers.set('get_php_immutable_value_object_stats', (a) => getPhpImmutableValueObjectStats(str(a, 'app_path')));
  handlers.set('list_php_type_coercions', (a) => listPhpTypeCoercions(str(a, 'app_path')));
  handlers.set('get_php_type_coercion_stats', (a) => getPhpTypeCoercionStats(str(a, 'app_path')));
  handlers.set('list_php_static_methods', (a) => listPhpStaticMethods(str(a, 'app_path')));
  handlers.set('get_php_static_method_stats', (a) => getPhpStaticMethodStats(str(a, 'app_path')));
  handlers.set('list_php_closure_scopes', (a) => listPhpClosureScopes(str(a, 'app_path')));
  handlers.set('get_php_closure_scope_stats', (a) => getPhpClosureScopeStats(str(a, 'app_path')));
  handlers.set('list_php_contract_tests', (a) => listPhpContractTests(str(a, 'app_path')));
  handlers.set('get_php_contract_test_stats', (a) => getPhpContractTestStats(str(a, 'app_path')));
  handlers.set('list_symfony_console_events', (a) => listSymfonyConsoleEvents(str(a, 'app_path')));
  handlers.set('get_symfony_console_event_stats', (a) => getSymfonyConsoleEventStats(str(a, 'app_path')));
  handlers.set('list_symfony_server_sent_events', (a) => listSymfonyServerSentEvents(str(a, 'app_path')));
  handlers.set('get_symfony_server_sent_event_stats', (a) => getSymfonyServerSentEventStats(str(a, 'app_path')));
  handlers.set('list_symfony_security_access_tokens', (a) => listSymfonySecurityAccessTokens(str(a, 'app_path')));
  handlers.set('get_symfony_security_access_token_stats', (a) => getSymfonySecurityAccessTokenStats(str(a, 'app_path')));
  handlers.set('list_symfony_security_oidc', (a) => listSymfonySecurityOidc(str(a, 'app_path')));
  handlers.set('get_symfony_security_oidc_stats', (a) => getSymfonySecurityOidcStats(str(a, 'app_path')));
  // Phase 32 tools
  handlers.set('list_symfony_type_info', (a) => listSymfonyTypeInfo(str(a, 'app_path')));
  handlers.set('get_symfony_type_info_stats', (a) => getSymfonyTypeInfoStats(str(a, 'app_path')));
  handlers.set('list_symfony_json_encoder_usage', (a) => listSymfonyJsonEncoder(str(a, 'app_path')));
  handlers.set('get_symfony_json_encoder_stats', (a) => getSymfonyJsonEncoderStats(str(a, 'app_path')));
  handlers.set('list_symfony_twig_security', (a) => listSymfonyTwigSecurity(str(a, 'app_path')));
  handlers.set('get_symfony_twig_security_stats', (a) => getSymfonyTwigSecurityStats(str(a, 'app_path')));
  handlers.set('list_symfony_monolog_handlers', (a) => listSymfonyMonologHandlers(str(a, 'app_path')));
  handlers.set('get_symfony_monolog_handler_stats', (a) => getSymfonyMonologHandlerStats(str(a, 'app_path')));
  handlers.set('list_symfony_monolog_formatters', (a) => listSymfonyMonologFormatters(str(a, 'app_path')));
  handlers.set('get_symfony_monolog_formatter_stats', (a) => getSymfonyMonologFormatterStats(str(a, 'app_path')));
  handlers.set('list_twig_form_rendering', (a) => listTwigFormRendering(str(a, 'app_path')));
  handlers.set('get_twig_form_rendering_stats', (a) => getTwigFormRenderingStats(str(a, 'app_path')));
  handlers.set('list_symfony_twig_ux_icons', (a) => listSymfonyTwigUxIcons(str(a, 'app_path')));
  handlers.set('get_symfony_twig_ux_icon_stats', (a) => getSymfonyTwigUxIconStats(str(a, 'app_path')));
  handlers.set('list_symfony_debug_var_dumpers', (a) => listSymfonyDebugVarDumpers(str(a, 'app_path')));
  handlers.set('get_symfony_debug_var_dumper_stats', (a) => getSymfonyDebugVarDumperStats(str(a, 'app_path')));
  handlers.set('list_symfony_scheduler_tasks', (a) => listSymfonySchedulerTasks(str(a, 'app_path')));
  handlers.set('get_symfony_scheduler_task_stats', (a) => getSymfonySchedulerTaskStats(str(a, 'app_path')));
  handlers.set('list_symfony_rate_limiter_policies', (a) => listSymfonyRateLimiterPolicies(str(a, 'app_path')));
  handlers.set('get_symfony_rate_limiter_policy_stats', (a) => getSymfonyRateLimiterPolicyStats(str(a, 'app_path')));
  // Phase 33 tools
  handlers.set('list_symfony_cache_early_expiry', (a) => listSymfonyCacheEarlyExpiry(str(a, 'app_path')));
  handlers.set('get_symfony_cache_early_expiry_stats', (a) => getSymfonyCacheEarlyExpiryStats(str(a, 'app_path')));
  handlers.set('list_symfony_messenger_transport_dsns', (a) => listSymfonyMessengerTransportDsns(str(a, 'app_path')));
  handlers.set('get_symfony_messenger_transport_dsn_stats', (a) => getSymfonyMessengerTransportDsnStats(str(a, 'app_path')));
  handlers.set('list_symfony_form_choice_values', (a) => listSymfonyFormChoiceValues(str(a, 'app_path')));
  handlers.set('get_symfony_form_choice_value_stats', (a) => getSymfonyFormChoiceValueStats(str(a, 'app_path')));
  // Phase 34 tools
  handlers.set('list_symfony_ux_react', (a) => listSymfonyUxReact(str(a, 'app_path')));
  handlers.set('get_symfony_ux_react_stats', (a) => getSymfonyUxReactStats(str(a, 'app_path')));
  handlers.set('list_symfony_ux_vue', (a) => listSymfonyUxVue(str(a, 'app_path')));
  handlers.set('get_symfony_ux_vue_stats', (a) => getSymfonyUxVueStats(str(a, 'app_path')));
  handlers.set('list_symfony_ux_svelte', (a) => listSymfonyUxSvelte(str(a, 'app_path')));
  handlers.set('get_symfony_ux_svelte_stats', (a) => getSymfonyUxSvelteStats(str(a, 'app_path')));
  handlers.set('list_symfony_ux_map', (a) => listSymfonyUxMap(str(a, 'app_path')));
  handlers.set('get_symfony_ux_map_stats', (a) => getSymfonyUxMapStats(str(a, 'app_path')));
  handlers.set('list_doctrine_orm_profiling', (a) => listDoctrineOrmProfiling(str(a, 'app_path')));
  handlers.set('get_doctrine_orm_profiling_stats', (a) => getDoctrineOrmProfilingStats(str(a, 'app_path')));
  handlers.set('list_symfony_mime_message_headers', (a) => listSymfonyMimeMessageHeaders(str(a, 'app_path')));
  handlers.set('get_symfony_mime_message_header_stats', (a) => getSymfonyMimeMessageHeaderStats(str(a, 'app_path')));
  handlers.set('list_doctrine_entity_locks', (a) => listDoctrineEntityLocks(str(a, 'app_path')));
  handlers.set('get_doctrine_entity_lock_stats', (a) => getDoctrineEntityLockStats(str(a, 'app_path')));
  // Phase 35 tools
  handlers.set('list_php_readonly_classes', (a) => listPhpReadonlyClasses(str(a, 'app_path')));
  handlers.set('get_php_readonly_class_stats', (a) => getPhpReadonlyClassStats(str(a, 'app_path')));
  handlers.set('list_php_named_constructors', (a) => listPhpNamedConstructors(str(a, 'app_path')));
  handlers.set('get_php_named_constructor_stats', (a) => getPhpNamedConstructorStats(str(a, 'app_path')));
  handlers.set('list_php_stream_wrappers', (a) => listPhpStreamWrappers(str(a, 'app_path')));
  handlers.set('get_php_stream_wrapper_stats', (a) => getPhpStreamWrapperStats(str(a, 'app_path')));
  handlers.set('list_php_reflection_api', (a) => listPhpReflectionApi(str(a, 'app_path')));
  handlers.set('get_php_reflection_api_stats', (a) => getPhpReflectionApiStats(str(a, 'app_path')));
  handlers.set('list_symfony_form_data_mappers', (a) => listSymfonyFormDataMappers(str(a, 'app_path')));
  handlers.set('get_symfony_form_data_mapper_stats', (a) => getSymfonyFormDataMapperStats(str(a, 'app_path')));
  handlers.set('list_symfony_controller_map_payloads', (a) => listSymfonyControllerMapPayloads(str(a, 'app_path')));
  handlers.set('get_symfony_controller_map_payload_stats', (a) => getSymfonyControllerMapPayloadStats(str(a, 'app_path')));
  handlers.set('list_symfony_string_inflectors', (a) => listSymfonyStringInflectors(str(a, 'app_path')));
  handlers.set('get_symfony_string_inflector_stats', (a) => getSymfonyStringInflectorStats(str(a, 'app_path')));
  handlers.set('list_symfony_serializer_name_converters', (a) => listSymfonySerializerNameConverters(str(a, 'app_path')));
  handlers.set('get_symfony_serializer_name_converter_stats', (a) => getSymfonySerializerNameConverterStats(str(a, 'app_path')));
  handlers.set('list_symfony_serializer_max_depths', (a) => listSymfonySerializerMaxDepths(str(a, 'app_path')));
  handlers.set('get_symfony_serializer_max_depth_stats', (a) => getSymfonySerializerMaxDepthStats(str(a, 'app_path')));
  handlers.set('list_symfony_serializer_transforms', (a) => listSymfonySerializerTransforms(str(a, 'app_path')));
  handlers.set('get_symfony_serializer_transform_stats', (a) => getSymfonySerializerTransformStats(str(a, 'app_path')));
  // Phase 31 new tools
  handlers.set('list_php_cognitive_complexity', (a) => listPhpCognitiveComplexity(str(a, 'app_path')));
  handlers.set('get_php_cognitive_complexity_stats', (a) => getPhpCognitiveComplexityStats(str(a, 'app_path')));
  handlers.set('list_php_copy_paste_patterns', (a) => listPhpCopyPastePatterns(str(a, 'app_path')));
  handlers.set('get_php_copy_paste_stats', (a) => getPhpCopyPasteStats(str(a, 'app_path')));
  handlers.set('list_php_preloading_config', (a) => listPhpPreloadingConfig(str(a, 'app_path')));
  handlers.set('get_php_preloading_stats', (a) => getPhpPreloadingStats(str(a, 'app_path')));
  handlers.set('list_php_ini_settings', (a) => listPhpIniSettings(str(a, 'app_path')));
  handlers.set('get_php_ini_stats', (a) => getPhpIniStats(str(a, 'app_path')));
  handlers.set('list_php_fpm_config', (a) => listPhpFpmConfig(str(a, 'app_path')));
  handlers.set('get_php_fpm_stats', (a) => getPhpFpmStats(str(a, 'app_path')));
  handlers.set('list_php_gc_config', (a) => listPhpGcConfig(str(a, 'app_path')));
  handlers.set('get_php_gc_stats', (a) => getPhpGcStats(str(a, 'app_path')));
  handlers.set('list_php_metrics_config', (a) => listPhpMetricsConfig(str(a, 'app_path')));
  handlers.set('get_php_metrics_stats', (a) => getPhpMetricsStats(str(a, 'app_path')));
  handlers.set('list_phpmd_config', (a) => listPhpmdConfig(str(a, 'app_path')));
  handlers.set('get_phpmd_stats', (a) => getPhpmdStats(str(a, 'app_path')));
  handlers.set('list_phpbench_config', (a) => listPhpbenchConfig(str(a, 'app_path')));
  handlers.set('get_phpbench_stats', (a) => getPhpbenchStats(str(a, 'app_path')));
  handlers.set('list_grumphp_config', (a) => listGrumphpConfig(str(a, 'app_path')));
  handlers.set('get_grumphp_stats', (a) => getGrumphpStats(str(a, 'app_path')));
  handlers.set('list_symfony_cqrs_patterns', (a) => listSymfonyCqrsPatterns(str(a, 'app_path')));
  handlers.set('get_symfony_cqrs_stats', (a) => getSymfonyCqrsStats(str(a, 'app_path')));
  handlers.set('list_symfony_event_sourcing', (a) => listSymfonyEventSourcing(str(a, 'app_path')));
  handlers.set('get_symfony_event_sourcing_stats', (a) => getSymfonyEventSourcingStats(str(a, 'app_path')));
  handlers.set('list_symfony_outbox_patterns', (a) => listSymfonyOutboxPatterns(str(a, 'app_path')));
  handlers.set('get_symfony_outbox_stats', (a) => getSymfonyOutboxStats(str(a, 'app_path')));
  handlers.set('list_symfony_remote_events', (a) => listSymfonyRemoteEvents(str(a, 'app_path')));
  handlers.set('get_symfony_remote_event_stats', (a) => getSymfonyRemoteEventStats(str(a, 'app_path')));
  handlers.set('list_symfony_emoji_usage', (a) => listSymfonyEmojiUsage(str(a, 'app_path')));
  handlers.set('get_symfony_emoji_stats', (a) => getSymfonyEmojiStats(str(a, 'app_path')));
  handlers.set('list_symfony_intl_config', (a) => listSymfonyIntlConfig(str(a, 'app_path')));
  handlers.set('get_symfony_intl_stats', (a) => getSymfonyIntlStats(str(a, 'app_path')));
  handlers.set('list_symfony_psr_bridge', (a) => listSymfonyPsrBridge(str(a, 'app_path')));
  handlers.set('get_symfony_psr_bridge_stats', (a) => getSymfonyPsrBridgeStats(str(a, 'app_path')));
  handlers.set('list_symfony_locale_switcher', (a) => listSymfonyLocaleSwitcher(str(a, 'app_path')));
  handlers.set('get_symfony_locale_switcher_stats', (a) => getSymfonyLocaleSwitcherStats(str(a, 'app_path')));
  handlers.set('list_symfony_string_encoding', (a) => listSymfonyStringEncoding(str(a, 'app_path')));
  handlers.set('get_symfony_string_encoding_stats', (a) => getSymfonyStringEncodingStats(str(a, 'app_path')));
  handlers.set('list_symfony_cache_invalidation', (a) => listSymfonyCacheInvalidation(str(a, 'app_path')));
  handlers.set('get_symfony_cache_invalidation_stats', (a) => getSymfonyCacheInvalidationStats(str(a, 'app_path')));
  handlers.set('list_symfony_cache_psr16', (a) => listSymfonyCachePsr16(str(a, 'app_path')));
  handlers.set('get_symfony_cache_psr16_stats', (a) => getSymfonyCachePsr16Stats(str(a, 'app_path')));
  handlers.set('list_symfony_validator_payloads', (a) => listSymfonyValidatorPayloads(str(a, 'app_path')));
  handlers.set('get_symfony_validator_payload_stats', (a) => getSymfonyValidatorPayloadStats(str(a, 'app_path')));
  handlers.set('list_symfony_kernel_boot', (a) => listSymfonyKernelBoot(str(a, 'app_path')));
  handlers.set('get_symfony_kernel_boot_stats', (a) => getSymfonyKernelBootStats(str(a, 'app_path')));
  handlers.set('list_symfony_mailer_inliner', (a) => listSymfonyMailerInliner(str(a, 'app_path')));
  handlers.set('get_symfony_mailer_inliner_stats', (a) => getSymfonyMailerInlinerStats(str(a, 'app_path')));
  handlers.set('list_symfony_messenger_graceful_shutdown', (a) => listSymfonyMessengerGracefulShutdown(str(a, 'app_path')));
  handlers.set('get_symfony_messenger_graceful_shutdown_stats', (a) => getSymfonyMessengerGracefulShutdownStats(str(a, 'app_path')));
  handlers.set('list_symfony_form_ajax', (a) => listSymfonyFormAjax(str(a, 'app_path')));
  handlers.set('get_symfony_form_ajax_stats', (a) => getSymfonyFormAjaxStats(str(a, 'app_path')));
  handlers.set('list_symfony_string_normalization', (a) => listSymfonyStringNormalization(str(a, 'app_path')));
  handlers.set('get_symfony_string_normalization_stats', (a) => getSymfonyStringNormalizationStats(str(a, 'app_path')));
  handlers.set('list_symfony_ux_stimulus_controllers', (a) => listSymfonyUxStimulusControllers(str(a, 'app_path')));
  handlers.set('get_symfony_ux_stimulus_stats', (a) => getSymfonyUxStimulusStats(str(a, 'app_path')));
  handlers.set('list_doctrine_upsert_patterns', (a) => listDoctrineUpsertPatterns(str(a, 'app_path')));
  handlers.set('get_doctrine_upsert_stats', (a) => getDoctrineUpsertStats(str(a, 'app_path')));
  handlers.set('list_doctrine_temporal_tables', (a) => listDoctrineTemporalTables(str(a, 'app_path')));
  handlers.set('get_doctrine_temporal_stats', (a) => getDoctrineTemporalStats(str(a, 'app_path')));
  handlers.set('list_doctrine_encryption', (a) => listDoctrineEncryption(str(a, 'app_path')));
  handlers.set('get_doctrine_encryption_stats', (a) => getDoctrineEncryptionStats(str(a, 'app_path')));
  handlers.set('list_doctrine_postgres_features', (a) => listDoctrinePostgresFeatures(str(a, 'app_path')));
  handlers.set('get_doctrine_postgres_stats', (a) => getDoctrinePostgresStats(str(a, 'app_path')));
  handlers.set('list_doctrine_mysql_features', (a) => listDoctrineMysqlFeatures(str(a, 'app_path')));
  handlers.set('get_doctrine_mysql_stats', (a) => getDoctrineMysqlStats(str(a, 'app_path')));
  handlers.set('list_doctrine_connection_retry', (a) => listDoctrineConnectionRetry(str(a, 'app_path')));
  handlers.set('get_doctrine_connection_retry_stats', (a) => getDoctrineConnectionRetryStats(str(a, 'app_path')));
  handlers.set('list_doctrine_hydration_performance', (a) => listDoctrineHydrationPerformance(str(a, 'app_path')));
  handlers.set('get_doctrine_hydration_stats', (a) => getDoctrineHydrationStats(str(a, 'app_path')));
  handlers.set('list_doctrine_dbal_query_profiling', (a) => listDoctrineDbalQueryProfiling(str(a, 'app_path')));
  handlers.set('get_doctrine_dbal_query_profiling_stats', (a) => getDoctrineDbalQueryProfilingStats(str(a, 'app_path')));
  handlers.set('list_api_problem_details', (a) => listApiProblemDetails(str(a, 'app_path')));
  handlers.set('get_api_problem_details_stats', (a) => getApiProblemDetailsStats(str(a, 'app_path')));
  handlers.set('list_api_json_ld_context', (a) => listApiJsonLdContext(str(a, 'app_path')));
  handlers.set('get_api_json_ld_context_stats', (a) => getApiJsonLdContextStats(str(a, 'app_path')));
  handlers.set('list_api_idempotency', (a) => listApiIdempotency(str(a, 'app_path')));
  handlers.set('get_api_idempotency_stats', (a) => getApiIdempotencyStats(str(a, 'app_path')));
  handlers.set('list_api_openapi_security_schemes', (a) => listApiOpenApiSecuritySchemes(str(a, 'app_path')));
  handlers.set('get_api_openapi_security_schemes_stats', (a) => getApiOpenApiSecuritySchemesStats(str(a, 'app_path')));
  handlers.set('list_pwa_manifest_config', (a) => listPwaManifestConfig(str(a, 'app_path')));
  handlers.set('get_pwa_manifest_stats', (a) => getPwaManifestStats(str(a, 'app_path')));
  handlers.set('list_symfony_asset_integrity', (a) => listSymfonyAssetIntegrity(str(a, 'app_path')));
  handlers.set('get_symfony_asset_integrity_stats', (a) => getSymfonyAssetIntegrityStats(str(a, 'app_path')));
  handlers.set('list_symfony_twig_profiling', (a) => listSymfonyTwigProfiling(str(a, 'app_path')));
  handlers.set('get_symfony_twig_profiling_stats', (a) => getSymfonyTwigProfilingStats(str(a, 'app_path')));
  handlers.set('list_symfony_roadrunner_config', (a) => listSymfonyRoadrunnerConfig(str(a, 'app_path')));
  handlers.set('get_symfony_roadrunner_stats', (a) => getSymfonyRoadrunnerStats(str(a, 'app_path')));
  handlers.set('list_prometheus_metrics', (a) => listPrometheusMetrics(str(a, 'app_path')));
  handlers.set('get_prometheus_metrics_stats', (a) => getPrometheusMetricsStats(str(a, 'app_path')));
  handlers.set('list_datadog_integration', (a) => listDatadogIntegration(str(a, 'app_path')));
  handlers.set('get_datadog_integration_stats', (a) => getDatadogIntegrationStats(str(a, 'app_path')));
  handlers.set('list_nginx_php_fpm_config', (a) => listNginxPhpFpmConfig(str(a, 'app_path')));
  handlers.set('get_nginx_php_fpm_stats', (a) => getNginxPhpFpmStats(str(a, 'app_path')));
  handlers.set('list_composer_security_audit', (a) => listComposerSecurityAudit(str(a, 'app_path')));
  handlers.set('get_composer_security_audit_stats', (a) => getComposerSecurityAuditStats(str(a, 'app_path')));
  handlers.set('list_symfony_webhook_security', (a) => listSymfonyWebhookSecurity(str(a, 'app_path')));
  handlers.set('get_symfony_webhook_security_stats', (a) => getSymfonyWebhookSecurityStats(str(a, 'app_path')));
  handlers.set('list_symfony_secrets_rotation', (a) => listSymfonySecretsRotation(str(a, 'app_path')));
  handlers.set('get_symfony_secrets_rotation_stats', (a) => getSymfonySecretsRotationStats(str(a, 'app_path')));
  handlers.set('list_php_jit_config', (a) => listPhpJitConfig(str(a, 'app_path')));
  handlers.set('get_php_jit_stats', (a) => getPhpJitStats(str(a, 'app_path')));
  handlers.set('list_php_ffi', (a) => listPhpFfi(str(a, 'app_path')));
  handlers.set('get_php_ffi_stats', (a) => getPhpFfiStats(str(a, 'app_path')));
  handlers.set('list_php_sodium_crypto', (a) => listPhpSodiumCrypto(str(a, 'app_path')));
  handlers.set('get_php_sodium_crypto_stats', (a) => getPhpSodiumCryptoStats(str(a, 'app_path')));
  handlers.set('list_php_pcre_security', (a) => listPhpPcreSecurity(str(a, 'app_path')));
  handlers.set('get_php_pcre_security_stats', (a) => getPhpPcreSecurityStats(str(a, 'app_path')));
  handlers.set('list_php_random_security', (a) => listPhpRandomSecurity(str(a, 'app_path')));
  handlers.set('get_php_random_security_stats', (a) => getPhpRandomSecurityStats(str(a, 'app_path')));
  handlers.set('list_php_memory_management', (a) => listPhpMemoryManagement(str(a, 'app_path')));
  handlers.set('get_php_memory_management_stats', (a) => getPhpMemoryManagementStats(str(a, 'app_path')));
  handlers.set('list_php_deprecation_polyfills', (a) => listPhpDeprecationPolyfills(str(a, 'app_path')));
  handlers.set('get_php_deprecation_polyfill_stats', (a) => getPhpDeprecationPolyfillStats(str(a, 'app_path')));
  handlers.set('list_symfony_ldap_auth', (a) => listSymfonyLdapAuth(str(a, 'app_path')));
  handlers.set('get_symfony_ldap_auth_stats', (a) => getSymfonyLdapAuthStats(str(a, 'app_path')));
  handlers.set('list_symfony_turbo_streams', (a) => listSymfonyTurboStreams(str(a, 'app_path')));
  handlers.set('get_symfony_turbo_streams_stats', (a) => getSymfonyTurboStreamsStats(str(a, 'app_path')));
  handlers.set('list_symfony_http_client_caching', (a) => listSymfonyHttpClientCaching(str(a, 'app_path')));
  handlers.set('get_symfony_http_client_caching_stats', (a) => getSymfonyHttpClientCachingStats(str(a, 'app_path')));
  handlers.set('list_symfony_messenger_circuit_breaker', (a) => listSymfonyMessengerCircuitBreaker(str(a, 'app_path')));
  handlers.set('get_symfony_messenger_circuit_breaker_stats', (a) => getSymfonyMessengerCircuitBreakerStats(str(a, 'app_path')));
  handlers.set('list_symfony_messenger_sagas', (a) => listSymfonyMessengerSagas(str(a, 'app_path')));
  handlers.set('get_symfony_messenger_sagas_stats', (a) => getSymfonyMessengerSagasStats(str(a, 'app_path')));
  handlers.set('list_symfony_notifier_sms', (a) => listSymfonyNotifierSms(str(a, 'app_path')));
  handlers.set('get_symfony_notifier_sms_stats', (a) => getSymfonyNotifierSmsStats(str(a, 'app_path')));
  handlers.set('list_symfony_notifier_push', (a) => listSymfonyNotifierPush(str(a, 'app_path')));
  handlers.set('get_symfony_notifier_push_stats', (a) => getSymfonyNotifierPushStats(str(a, 'app_path')));
  handlers.set('list_symfony_ux_typed', (a) => listSymfonyUxTyped(str(a, 'app_path')));
  handlers.set('get_symfony_ux_typed_stats', (a) => getSymfonyUxTypedStats(str(a, 'app_path')));
  handlers.set('list_symfony_ux_translator', (a) => listSymfonyUxTranslator(str(a, 'app_path')));
  handlers.set('get_symfony_ux_translator_stats', (a) => getSymfonyUxTranslatorStats(str(a, 'app_path')));
  handlers.set('list_symfony_translation_cache', (a) => listSymfonyTranslationCache(str(a, 'app_path')));
  handlers.set('get_symfony_translation_cache_stats', (a) => getSymfonyTranslationCacheStats(str(a, 'app_path')));
  handlers.set('list_symfony_multi_language_routing', (a) => listSymfonyMultiLanguageRouting(str(a, 'app_path')));
  handlers.set('get_symfony_multi_language_routing_stats', (a) => getSymfonyMultiLanguageRoutingStats(str(a, 'app_path')));
  handlers.set('list_symfony_mailer_queuing', (a) => listSymfonyMailerQueuing(str(a, 'app_path')));
  handlers.set('get_symfony_mailer_queuing_stats', (a) => getSymfonyMailerQueuingStats(str(a, 'app_path')));
  handlers.set('list_symfony_signed_url', (a) => listSymfonySignedUrl(str(a, 'app_path')));
  handlers.set('get_symfony_signed_url_stats', (a) => getSymfonySignedUrlStats(str(a, 'app_path')));
  handlers.set('list_symfony_form_honeypot', (a) => listSymfonyFormHoneypot(str(a, 'app_path')));
  handlers.set('get_symfony_form_honeypot_stats', (a) => getSymfonyFormHoneypotStats(str(a, 'app_path')));
  handlers.set('list_doctrine_versioned_entities', (a) => listDoctrineVersionedEntities(str(a, 'app_path')));
  handlers.set('get_doctrine_versioned_entities_stats', (a) => getDoctrineVersionedEntitiesStats(str(a, 'app_path')));
  handlers.set('list_doctrine_read_replica', (a) => listDoctrineReadReplica(str(a, 'app_path')));
  handlers.set('get_doctrine_read_replica_stats', (a) => getDoctrineReadReplicaStats(str(a, 'app_path')));
  handlers.set('list_doctrine_raw_sql', (a) => listDoctrineRawSql(str(a, 'app_path')));
  handlers.set('get_doctrine_raw_sql_stats', (a) => getDoctrineRawSqlStats(str(a, 'app_path')));
  handlers.set('list_doctrine_entity_manager_scope', (a) => listDoctrineEntityManagerScope(str(a, 'app_path')));
  handlers.set('get_doctrine_entity_manager_scope_stats', (a) => getDoctrineEntityManagerScopeStats(str(a, 'app_path')));
  handlers.set('list_varnish_config', (a) => listVarnishConfig(str(a, 'app_path')));
  handlers.set('get_varnish_config_stats', (a) => getVarnishConfigStats(str(a, 'app_path')));
  handlers.set('list_cdn_config', (a) => listCdnConfig(str(a, 'app_path')));
  handlers.set('get_cdn_config_stats', (a) => getCdnConfigStats(str(a, 'app_path')));
  handlers.set('list_docker_compose_health', (a) => listDockerComposeHealth(str(a, 'app_path')));
  handlers.set('get_docker_compose_health_stats', (a) => getDockerComposeHealthStats(str(a, 'app_path')));
  handlers.set('list_redis_streams_config', (a) => listRedisStreamsConfig(str(a, 'app_path')));
  handlers.set('get_redis_streams_config_stats', (a) => getRedisStreamsConfigStats(str(a, 'app_path')));
  handlers.set('list_rabbitmq_config', (a) => listRabbitmqConfig(str(a, 'app_path')));
  handlers.set('get_rabbitmq_config_stats', (a) => getRabbitmqConfigStats(str(a, 'app_path')));
  handlers.set('list_kafka_integration', (a) => listKafkaIntegration(str(a, 'app_path')));
  handlers.set('get_kafka_integration_stats', (a) => getKafkaIntegrationStats(str(a, 'app_path')));
  handlers.set('list_sonarqube_config', (a) => listSonarqubeConfig(str(a, 'app_path')));
  handlers.set('get_sonarqube_config_stats', (a) => getSonarqubeConfigStats(str(a, 'app_path')));
  handlers.set('list_sqs_messenger_config', (a) => listSqsMessengerConfig(str(a, 'app_path')));
  handlers.set('get_sqs_messenger_config_stats', (a) => getSqsMessengerConfigStats(str(a, 'app_path')));
  handlers.set('list_htmx_integration', (a) => listHtmxIntegration(str(a, 'app_path')));
  handlers.set('get_htmx_integration_stats', (a) => getHtmxIntegrationStats(str(a, 'app_path')));
  handlers.set('list_alpine_js_integration', (a) => listAlpineJsIntegration(str(a, 'app_path')));
  handlers.set('get_alpine_js_integration_stats', (a) => getAlpineJsIntegrationStats(str(a, 'app_path')));
  handlers.set('list_api_hateoas', (a) => listApiHateoas(str(a, 'app_path')));
  handlers.set('get_api_hateoas_stats', (a) => getApiHateoasStats(str(a, 'app_path')));
  handlers.set('list_stripe_integration', (a) => listStripeIntegration(str(a, 'app_path')));
  handlers.set('get_stripe_integration_stats', (a) => getStripeIntegrationStats(str(a, 'app_path')));
  handlers.set('list_saml_auth', (a) => listSamlAuth(str(a, 'app_path')));
  handlers.set('get_saml_auth_stats', (a) => getSamlAuthStats(str(a, 'app_path')));
  handlers.set('list_grpc_integration', (a) => listGrpcIntegration(str(a, 'app_path')));
  handlers.set('get_grpc_integration_stats', (a) => getGrpcIntegrationStats(str(a, 'app_path')));
  handlers.set('list_api_cursor_pagination', (a) => listApiCursorPagination(str(a, 'app_path')));
  handlers.set('get_api_cursor_pagination_stats', (a) => getApiCursorPaginationStats(str(a, 'app_path')));
  handlers.set('list_elasticsearch_mapping_config', (a) => listElasticsearchMappingConfig(str(a, 'app_path')));
  handlers.set('get_elasticsearch_mapping_config_stats', (a) => getElasticsearchMappingConfigStats(str(a, 'app_path')));
  handlers.set('list_gdpr_compliance', (a) => listGdprCompliance(str(a, 'app_path')));
  handlers.set('get_gdpr_compliance_stats', (a) => getGdprComplianceStats(str(a, 'app_path')));
  handlers.set('list_php_openssl_patterns', (a) => listPhpOpensslPatterns(str(a, 'app_path')));
  handlers.set('get_php_openssl_patterns_stats', (a) => getPhpOpensslPatternsStats(str(a, 'app_path')));
  handlers.set('list_security_audit_log', (a) => listSecurityAuditLog(str(a, 'app_path')));
  handlers.set('get_security_audit_log_stats', (a) => getSecurityAuditLogStats(str(a, 'app_path')));
  handlers.set('list_api_key_rotation', (a) => listApiKeyRotation(str(a, 'app_path')));
  handlers.set('get_api_key_rotation_stats', (a) => getApiKeyRotationStats(str(a, 'app_path')));
  handlers.set('list_pdf_generation', (a) => listPdfGeneration(str(a, 'app_path')));
  handlers.set('get_pdf_generation_stats', (a) => getPdfGenerationStats(str(a, 'app_path')));
  handlers.set('list_image_processing', (a) => listImageProcessing(str(a, 'app_path')));
  handlers.set('get_image_processing_stats', (a) => getImageProcessingStats(str(a, 'app_path')));
  handlers.set('list_excel_generation', (a) => listExcelGeneration(str(a, 'app_path')));
  handlers.set('get_excel_generation_stats', (a) => getExcelGenerationStats(str(a, 'app_path')));
  handlers.set('list_file_archive', (a) => listFileArchive(str(a, 'app_path')));
  handlers.set('get_file_archive_stats', (a) => getFileArchiveStats(str(a, 'app_path')));
  handlers.set('list_new_relic_integration', (a) => listNewRelicIntegration(str(a, 'app_path')));
  handlers.set('get_new_relic_integration_stats', (a) => getNewRelicIntegrationStats(str(a, 'app_path')));
  // Phase 33 tools
  handlers.set('list_php_curl_security', (a) => listPhpCurlSecurity(str(a, 'app_path')));
  handlers.set('get_php_curl_security_stats', (a) => getPhpCurlSecurityStats(str(a, 'app_path')));
  handlers.set('list_php_xml_security', (a) => listPhpXmlSecurity(str(a, 'app_path')));
  handlers.set('get_php_xml_security_stats', (a) => getPhpXmlSecurityStats(str(a, 'app_path')));
  handlers.set('list_php_ldap_functions', (a) => listPhpLdapFunctions(str(a, 'app_path')));
  handlers.set('get_php_ldap_function_stats', (a) => getPhpLdapFunctionStats(str(a, 'app_path')));
  handlers.set('list_php_html5_parser', (a) => listPhpHtml5Parser(str(a, 'app_path')));
  handlers.set('get_php_html5_parser_stats', (a) => getPhpHtml5ParserStats(str(a, 'app_path')));
  handlers.set('list_php_session_security', (a) => listPhpSessionSecurity(str(a, 'app_path')));
  handlers.set('get_php_session_security_stats', (a) => getPhpSessionSecurityStats(str(a, 'app_path')));
  handlers.set('list_php_opcache_settings', (a) => listPhpOpcacheSettings(str(a, 'app_path')));
  handlers.set('get_php_opcache_setting_stats', (a) => getPhpOpcacheSettingStats(str(a, 'app_path')));
  handlers.set('list_php_type_juggling', (a) => listPhpTypeJuggling(str(a, 'app_path')));
  handlers.set('get_php_type_juggling_stats', (a) => getPhpTypeJugglingStats(str(a, 'app_path')));
  handlers.set('list_php_string_interpolation_security', (a) => listPhpStringInterpolationSecurity(str(a, 'app_path')));
  handlers.set('get_php_string_interpolation_security_stats', (a) => getPhpStringInterpolationSecurityStats(str(a, 'app_path')));
  handlers.set('list_php_memory_profiling', (a) => listPhpMemoryProfiling(str(a, 'app_path')));
  handlers.set('get_php_memory_profiling_stats', (a) => getPhpMemoryProfilingStats(str(a, 'app_path')));
  handlers.set('list_php_codesniffer_config', (a) => listPhpCodesnifferConfig(str(a, 'app_path')));
  handlers.set('get_php_codesniffer_config_stats', (a) => getPhpCodesnifferConfigStats(str(a, 'app_path')));
  handlers.set('list_symfony_deprecations', (a) => listSymfonyDeprecations(str(a, 'app_path')));
  handlers.set('get_symfony_deprecation_stats', (a) => getSymfonyDeprecationStats(str(a, 'app_path')));
  handlers.set('list_symfony_live_component_security', (a) => listSymfonyLiveComponentSecurity(str(a, 'app_path')));
  handlers.set('get_symfony_live_component_security_stats', (a) => getSymfonyLiveComponentSecurityStats(str(a, 'app_path')));
  handlers.set('list_symfony_chat_notifiers', (a) => listSymfonyChatNotifiers(str(a, 'app_path')));
  handlers.set('get_symfony_chat_notifier_stats', (a) => getSymfonyChatNotifierStats(str(a, 'app_path')));
  handlers.set('list_symfony_cache_redis_cluster', (a) => listSymfonyCacheRedisCluster(str(a, 'app_path')));
  handlers.set('get_symfony_cache_redis_cluster_stats', (a) => getSymfonyCacheRedisClusterStats(str(a, 'app_path')));
  handlers.set('list_symfony_security_bruteforce', (a) => listSymfonySecurityBruteforce(str(a, 'app_path')));
  handlers.set('get_symfony_security_bruteforce_stats', (a) => getSymfonySecurityBruteforceStats(str(a, 'app_path')));
  handlers.set('list_symfony_messenger_monitoring', (a) => listSymfonyMessengerMonitoring(str(a, 'app_path')));
  handlers.set('get_symfony_messenger_monitoring_stats', (a) => getSymfonyMessengerMonitoringStats(str(a, 'app_path')));
  handlers.set('list_symfony_di_conditional_services', (a) => listSymfonyDiConditionalServices(str(a, 'app_path')));
  handlers.set('get_symfony_di_conditional_service_stats', (a) => getSymfonyDiConditionalServiceStats(str(a, 'app_path')));
  handlers.set('list_symfony_mailer_bounce_handling', (a) => listSymfonyMailerBounceHandling(str(a, 'app_path')));
  handlers.set('get_symfony_mailer_bounce_handling_stats', (a) => getSymfonyMailerBounceHandlingStats(str(a, 'app_path')));
  handlers.set('list_symfony_ux_turbo_frames', (a) => listSymfonyUxTurboFrames(str(a, 'app_path')));
  handlers.set('get_symfony_ux_turbo_frame_stats', (a) => getSymfonyUxTurboFrameStats(str(a, 'app_path')));
  handlers.set('list_symfony_health_endpoint_security', (a) => listSymfonyHealthEndpointSecurity(str(a, 'app_path')));
  handlers.set('get_symfony_health_endpoint_security_stats', (a) => getSymfonyHealthEndpointSecurityStats(str(a, 'app_path')));
  handlers.set('list_symfony_workflow_persistence', (a) => listSymfonyWorkflowPersistence(str(a, 'app_path')));
  handlers.set('get_symfony_workflow_persistence_stats', (a) => getSymfonyWorkflowPersistenceStats(str(a, 'app_path')));
  handlers.set('list_symfony_routing_conflicts', (a) => listSymfonyRoutingConflicts(str(a, 'app_path')));
  handlers.set('get_symfony_routing_conflict_stats', (a) => getSymfonyRoutingConflictStats(str(a, 'app_path')));
  handlers.set('list_api_jsonapi_format', (a) => listApiJsonApiFormat(str(a, 'app_path')));
  handlers.set('get_api_jsonapi_format_stats', (a) => getApiJsonApiFormatStats(str(a, 'app_path')));
  handlers.set('list_api_graphql_security', (a) => listApiGraphqlSecurity(str(a, 'app_path')));
  handlers.set('get_api_graphql_security_stats', (a) => getApiGraphqlSecurityStats(str(a, 'app_path')));
  handlers.set('list_api_response_compression', (a) => listApiResponseCompression(str(a, 'app_path')));
  handlers.set('get_api_response_compression_stats', (a) => getApiResponseCompressionStats(str(a, 'app_path')));
  handlers.set('list_api_contract_testing', (a) => listApiContractTesting(str(a, 'app_path')));
  handlers.set('get_api_contract_testing_stats', (a) => getApiContractTestingStats(str(a, 'app_path')));
  handlers.set('list_doctrine_column_defaults', (a) => listDoctrineColumnDefaults(str(a, 'app_path')));
  handlers.set('get_doctrine_column_default_stats', (a) => getDoctrineColumnDefaultStats(str(a, 'app_path')));
  handlers.set('list_doctrine_full_text_search', (a) => listDoctrineFullTextSearch(str(a, 'app_path')));
  handlers.set('get_doctrine_full_text_search_stats', (a) => getDoctrineFullTextSearchStats(str(a, 'app_path')));
  handlers.set('list_pgbouncer_config', (a) => listPgBouncerConfig(str(a, 'app_path')));
  handlers.set('get_pgbouncer_config_stats', (a) => getPgBouncerConfigStats(str(a, 'app_path')));
  handlers.set('list_memcached_integration', (a) => listMemcachedIntegration(str(a, 'app_path')));
  handlers.set('get_memcached_integration_stats', (a) => getMemcachedIntegrationStats(str(a, 'app_path')));
  handlers.set('list_apache_config', (a) => listApacheConfig(str(a, 'app_path')));
  handlers.set('get_apache_config_stats', (a) => getApacheConfigStats(str(a, 'app_path')));
  handlers.set('list_frankenphp_config', (a) => listFrankenPhpConfig(str(a, 'app_path')));
  handlers.set('get_frankenphp_config_stats', (a) => getFrankenPhpConfigStats(str(a, 'app_path')));
  handlers.set('list_swoole_openswoole', (a) => listSwooleOpenSwoole(str(a, 'app_path')));
  handlers.set('get_swoole_openswoole_stats', (a) => getSwooleOpenSwooleStats(str(a, 'app_path')));
  handlers.set('list_aws_lambda_bref', (a) => listAwsLambdaBref(str(a, 'app_path')));
  handlers.set('get_aws_lambda_bref_stats', (a) => getAwsLambdaBrefStats(str(a, 'app_path')));
  handlers.set('list_github_actions_config', (a) => listGithubActionsConfig(str(a, 'app_path')));
  handlers.set('get_github_actions_config_stats', (a) => getGithubActionsConfigStats(str(a, 'app_path')));
  handlers.set('list_gitlab_ci_config', (a) => listGitlabCiConfig(str(a, 'app_path')));
  handlers.set('get_gitlab_ci_config_stats', (a) => getGitlabCiConfigStats(str(a, 'app_path')));
  handlers.set('list_grafana_dashboard', (a) => listGrafanaDashboard(str(a, 'app_path')));
  handlers.set('get_grafana_dashboard_stats', (a) => getGrafanaDashboardStats(str(a, 'app_path')));
  handlers.set('list_cloudwatch_integration', (a) => listCloudwatchIntegration(str(a, 'app_path')));
  handlers.set('get_cloudwatch_integration_stats', (a) => getCloudwatchIntegrationStats(str(a, 'app_path')));
  handlers.set('list_docker_security_config', (a) => listDockerSecurityConfig(str(a, 'app_path')));
  handlers.set('get_docker_security_config_stats', (a) => getDockerSecurityConfigStats(str(a, 'app_path')));
  handlers.set('list_websocket_integration', (a) => listWebsocketIntegration(str(a, 'app_path')));
  handlers.set('get_websocket_integration_stats', (a) => getWebsocketIntegrationStats(str(a, 'app_path')));
  handlers.set('list_deptrac_config', (a) => listDeptracConfig(str(a, 'app_path')));
  handlers.set('get_deptrac_config_stats', (a) => getDeptracConfigStats(str(a, 'app_path')));
  handlers.set('list_phparkitect_config', (a) => listPhpArkitectConfig(str(a, 'app_path')));
  handlers.set('get_phparkitect_config_stats', (a) => getPhpArkitectConfigStats(str(a, 'app_path')));
  handlers.set('list_panther_testing', (a) => listPantherTesting(str(a, 'app_path')));
  handlers.set('get_panther_testing_stats', (a) => getPantherTestingStats(str(a, 'app_path')));
  handlers.set('list_zenstruck_foundry_config', (a) => listZenstruckFoundryConfig(str(a, 'app_path')));
  handlers.set('get_zenstruck_foundry_config_stats', (a) => getZenstruckFoundryConfigStats(str(a, 'app_path')));
  handlers.set('list_phpspec_config', (a) => listPhpspecConfig(str(a, 'app_path')));
  handlers.set('get_phpspec_config_stats', (a) => getPhpspecConfigStats(str(a, 'app_path')));
  handlers.set('list_codeception_config', (a) => listCodeceptionConfig(str(a, 'app_path')));
  handlers.set('get_codeception_config_stats', (a) => getCodeceptionConfigStats(str(a, 'app_path')));
  handlers.set('list_meilisearch_integration', (a) => listMeilisearchIntegration(str(a, 'app_path')));
  handlers.set('get_meilisearch_integration_stats', (a) => getMeilisearchIntegrationStats(str(a, 'app_path')));
  handlers.set('list_webauthn_integration', (a) => listWebAuthnIntegration(str(a, 'app_path')));
  handlers.set('get_webauthn_integration_stats', (a) => getWebAuthnIntegrationStats(str(a, 'app_path')));
  handlers.set('list_paypal_integration', (a) => listPaypalIntegration(str(a, 'app_path')));
  handlers.set('get_paypal_integration_stats', (a) => getPaypalIntegrationStats(str(a, 'app_path')));
  handlers.set('list_easy_coding_standard', (a) => listEasyCodingStandard(str(a, 'app_path')));
  handlers.set('get_easy_coding_standard_stats', (a) => getEasyCodingStandardStats(str(a, 'app_path')));
  // Phase 34 tools
  handlers.set('list_php_xdebug_config', (a) => listPhpXdebugConfig(str(a, 'app_path')));
  handlers.set('get_php_xdebug_config_stats', (a) => getPhpXdebugConfigStats(str(a, 'app_path')));
  handlers.set('list_php_composer_autoload_optimize', (a) => listPhpComposerAutoloadOptimize(str(a, 'app_path')));
  handlers.set('get_php_composer_autoload_optimize_stats', (a) => getPhpComposerAutoloadOptimizeStats(str(a, 'app_path')));
  handlers.set('list_php_intl_patterns', (a) => listPhpIntlPatterns(str(a, 'app_path')));
  handlers.set('get_php_intl_patterns_stats', (a) => getPhpIntlPatternsStats(str(a, 'app_path')));
  handlers.set('list_php_soap_patterns', (a) => listPhpSoapPatterns(str(a, 'app_path')));
  handlers.set('get_php_soap_patterns_stats', (a) => getPhpSoapPatternsStats(str(a, 'app_path')));
  handlers.set('list_php_zip_archive', (a) => listPhpZipArchive(str(a, 'app_path')));
  handlers.set('get_php_zip_archive_stats', (a) => getPhpZipArchiveStats(str(a, 'app_path')));
  handlers.set('list_php_mbstring_patterns', (a) => listPhpMbstringPatterns(str(a, 'app_path')));
  handlers.set('get_php_mbstring_patterns_stats', (a) => getPhpMbstringPatternsStats(str(a, 'app_path')));
  handlers.set('list_php_object_serialization', (a) => listPhpObjectSerialization(str(a, 'app_path')));
  handlers.set('get_php_object_serialization_stats', (a) => getPhpObjectSerializationStats(str(a, 'app_path')));
  handlers.set('list_php_backtrace_debug', (a) => listPhpBacktraceDebug(str(a, 'app_path')));
  handlers.set('get_php_backtrace_debug_stats', (a) => getPhpBacktraceDebugStats(str(a, 'app_path')));
  handlers.set('list_php_uuid_generation', (a) => listPhpUuidGeneration(str(a, 'app_path')));
  handlers.set('get_php_uuid_generation_stats', (a) => getPhpUuidGenerationStats(str(a, 'app_path')));
  handlers.set('list_php_weak_map', (a) => listPhpWeakMap(str(a, 'app_path')));
  handlers.set('get_php_weak_map_stats', (a) => getPhpWeakMapStats(str(a, 'app_path')));
  handlers.set('list_symfony_esi_config', (a) => listSymfonyEsiConfig(str(a, 'app_path')));
  handlers.set('get_symfony_esi_config_stats', (a) => getSymfonyEsiConfigStats(str(a, 'app_path')));
  handlers.set('list_symfony_http2_push', (a) => listSymfonyHttp2Push(str(a, 'app_path')));
  handlers.set('get_symfony_http2_push_stats', (a) => getSymfonyHttp2PushStats(str(a, 'app_path')));
  handlers.set('list_symfony_cache_redis_sentinel', (a) => listSymfonyCacheRedisSentinel(str(a, 'app_path')));
  handlers.set('get_symfony_cache_redis_sentinel_stats', (a) => getSymfonyCacheRedisSentinelStats(str(a, 'app_path')));
  handlers.set('list_symfony_workflow_state_machine', (a) => listSymfonyWorkflowStateMachine(str(a, 'app_path')));
  handlers.set('get_symfony_workflow_state_machine_stats', (a) => getSymfonyWorkflowStateMachineStats(str(a, 'app_path')));
  handlers.set('list_symfony_twig_cache_config', (a) => listSymfonyTwigCacheConfig(str(a, 'app_path')));
  handlers.set('get_symfony_twig_cache_config_stats', (a) => getSymfonyTwigCacheConfigStats(str(a, 'app_path')));
  handlers.set('list_symfony_console_daemon', (a) => listSymfonyConsoleDaemon(str(a, 'app_path')));
  handlers.set('get_symfony_console_daemon_stats', (a) => getSymfonyConsoleDaemonStats(str(a, 'app_path')));
  handlers.set('list_symfony_translation_extractors', (a) => listSymfonyTranslationExtractors(str(a, 'app_path')));
  handlers.set('get_symfony_translation_extractors_stats', (a) => getSymfonyTranslationExtractorsStats(str(a, 'app_path')));
  handlers.set('list_symfony_messenger_competing_consumers', (a) => listSymfonyMessengerCompetingConsumers(str(a, 'app_path')));
  handlers.set('get_symfony_messenger_competing_consumers_stats', (a) => getSymfonyMessengerCompetingConsumersStats(str(a, 'app_path')));
  handlers.set('list_symfony_asset_preload_hints', (a) => listSymfonyAssetPreloadHints(str(a, 'app_path')));
  handlers.set('get_symfony_asset_preload_hints_stats', (a) => getSymfonyAssetPreloadHintsStats(str(a, 'app_path')));
  handlers.set('list_symfony_form_compound_types', (a) => listSymfonyFormCompoundTypes(str(a, 'app_path')));
  handlers.set('get_symfony_form_compound_types_stats', (a) => getSymfonyFormCompoundTypesStats(str(a, 'app_path')));
  handlers.set('list_symfony_serializer_circular_reference', (a) => listSymfonySerializerCircularReference(str(a, 'app_path')));
  handlers.set('get_symfony_serializer_circular_reference_stats', (a) => getSymfonySerializerCircularReferenceStats(str(a, 'app_path')));
  handlers.set('list_symfony_data_pipeline_patterns', (a) => listSymfonyDataPipelinePatterns(str(a, 'app_path')));
  handlers.set('get_symfony_data_pipeline_patterns_stats', (a) => getSymfonyDataPipelinePatternsStats(str(a, 'app_path')));
  handlers.set('list_symfony_console_progress_bar', (a) => listSymfonyConsoleProgressBar(str(a, 'app_path')));
  handlers.set('get_symfony_console_progress_bar_stats', (a) => getSymfonyConsoleProgressBarStats(str(a, 'app_path')));
  handlers.set('list_symfony_http_client_concurrent', (a) => listSymfonyHttpClientConcurrent(str(a, 'app_path')));
  handlers.set('get_symfony_http_client_concurrent_stats', (a) => getSymfonyHttpClientConcurrentStats(str(a, 'app_path')));
  handlers.set('list_symfony_doctrine_metadata_cache', (a) => listSymfonyDoctrineMetadataCache(str(a, 'app_path')));
  handlers.set('get_symfony_doctrine_metadata_cache_stats', (a) => getSymfonyDoctrineMetadataCacheStats(str(a, 'app_path')));
  handlers.set('list_symfony_sonata_admin', (a) => listSymfonySonataAdmin(str(a, 'app_path')));
  handlers.set('get_symfony_sonata_admin_stats', (a) => getSymfonySonataAdminStats(str(a, 'app_path')));
  handlers.set('list_symfony_enlighten_analysis', (a) => listSymfonyEnlightenAnalysis(str(a, 'app_path')));
  handlers.set('get_symfony_enlighten_analysis_stats', (a) => getSymfonyEnlightenAnalysisStats(str(a, 'app_path')));
  handlers.set('list_symfony_doctrine_migration_rollback', (a) => listSymfonyDoctrineMigrationRollback(str(a, 'app_path')));
  handlers.set('get_symfony_doctrine_migration_rollback_stats', (a) => getSymfonyDoctrineMigrationRollbackStats(str(a, 'app_path')));
  handlers.set('list_symfony_rate_limiter_algorithms', (a) => listSymfonyRateLimiterAlgorithms(str(a, 'app_path')));
  handlers.set('get_symfony_rate_limiter_algorithms_stats', (a) => getSymfonyRateLimiterAlgorithmsStats(str(a, 'app_path')));
  handlers.set('list_symfony_messenger_pause_resume', (a) => listSymfonyMessengerPauseResume(str(a, 'app_path')));
  handlers.set('get_symfony_messenger_pause_resume_stats', (a) => getSymfonyMessengerPauseResumeStats(str(a, 'app_path')));
  handlers.set('list_caddy_server_config', (a) => listCaddyServerConfig(str(a, 'app_path')));
  handlers.set('get_caddy_server_config_stats', (a) => getCaddyServerConfigStats(str(a, 'app_path')));
  handlers.set('list_fly_io_config', (a) => listFlyIoConfig(str(a, 'app_path')));
  handlers.set('get_fly_io_config_stats', (a) => getFlyIoConfigStats(str(a, 'app_path')));
  handlers.set('list_heroku_config', (a) => listHerokuConfig(str(a, 'app_path')));
  handlers.set('get_heroku_config_stats', (a) => getHerokuConfigStats(str(a, 'app_path')));
  handlers.set('list_circleci_config', (a) => listCircleCiConfig(str(a, 'app_path')));
  handlers.set('get_circleci_config_stats', (a) => getCircleCiConfigStats(str(a, 'app_path')));
  handlers.set('list_jenkins_config', (a) => listJenkinsConfig(str(a, 'app_path')));
  handlers.set('get_jenkins_config_stats', (a) => getJenkinsConfigStats(str(a, 'app_path')));
  handlers.set('list_terraform_config', (a) => listTerraformConfig(str(a, 'app_path')));
  handlers.set('get_terraform_config_stats', (a) => getTerraformConfigStats(str(a, 'app_path')));
  handlers.set('list_helm_charts_config', (a) => listHelmChartsConfig(str(a, 'app_path')));
  handlers.set('get_helm_charts_config_stats', (a) => getHelmChartsConfigStats(str(a, 'app_path')));
  handlers.set('list_cloudflare_config', (a) => listCloudflareConfig(str(a, 'app_path')));
  handlers.set('get_cloudflare_config_stats', (a) => getCloudflareConfigStats(str(a, 'app_path')));
  handlers.set('list_aws_ecs_config', (a) => listAwsEcsConfig(str(a, 'app_path')));
  handlers.set('get_aws_ecs_config_stats', (a) => getAwsEcsConfigStats(str(a, 'app_path')));
  handlers.set('list_azure_pipelines_config', (a) => listAzurePipelinesConfig(str(a, 'app_path')));
  handlers.set('get_azure_pipelines_config_stats', (a) => getAzurePipelinesConfigStats(str(a, 'app_path')));
  handlers.set('list_twilio_integration', (a) => listTwilioIntegration(str(a, 'app_path')));
  handlers.set('get_twilio_integration_stats', (a) => getTwilioIntegrationStats(str(a, 'app_path')));
  handlers.set('list_sendgrid_integration', (a) => listSendgridIntegration(str(a, 'app_path')));
  handlers.set('get_sendgrid_integration_stats', (a) => getSendgridIntegrationStats(str(a, 'app_path')));
  handlers.set('list_aws_s3_integration', (a) => listAwsS3Integration(str(a, 'app_path')));
  handlers.set('get_aws_s3_integration_stats', (a) => getAwsS3IntegrationStats(str(a, 'app_path')));
  handlers.set('list_algolia_integration', (a) => listAlgoliaIntegration(str(a, 'app_path')));
  handlers.set('get_algolia_integration_stats', (a) => getAlgoliaIntegrationStats(str(a, 'app_path')));
  handlers.set('list_bugsnag_integration', (a) => listBugsnagIntegration(str(a, 'app_path')));
  handlers.set('get_bugsnag_integration_stats', (a) => getBugsnagIntegrationStats(str(a, 'app_path')));
  handlers.set('list_openai_integration', (a) => listOpenAiIntegration(str(a, 'app_path')));
  handlers.set('get_openai_integration_stats', (a) => getOpenAiIntegrationStats(str(a, 'app_path')));
  handlers.set('list_slack_webhook_integration', (a) => listSlackWebhookIntegration(str(a, 'app_path')));
  handlers.set('get_slack_webhook_integration_stats', (a) => getSlackWebhookIntegrationStats(str(a, 'app_path')));
  handlers.set('list_owasp_dependency_check', (a) => listOwaspDependencyCheck(str(a, 'app_path')));
  handlers.set('get_owasp_dependency_check_stats', (a) => getOwaspDependencyCheckStats(str(a, 'app_path')));
  handlers.set('list_vault_integration', (a) => listVaultIntegration(str(a, 'app_path')));
  handlers.set('get_vault_integration_stats', (a) => getVaultIntegrationStats(str(a, 'app_path')));
  handlers.set('list_rabbitmq_management_api', (a) => listRabbitmqManagementApi(str(a, 'app_path')));
  handlers.set('get_rabbitmq_management_api_stats', (a) => getRabbitmqManagementApiStats(str(a, 'app_path')));
  // Phase 35 tools
  handlers.set('list_php_pdo_patterns', (a) => listPhpPdoPatterns(str(a, 'app_path')));
  handlers.set('get_php_pdo_patterns_stats', (a) => getPhpPdoPatternsStats(str(a, 'app_path')));
  handlers.set('list_php_type_narrowing', (a) => listPhpTypeNarrowing(str(a, 'app_path')));
  handlers.set('get_php_type_narrowing_stats', (a) => getPhpTypeNarrowingStats(str(a, 'app_path')));
  handlers.set('list_php_heredoc_nowdoc', (a) => listPhpHeredocNowdoc(str(a, 'app_path')));
  handlers.set('get_php_heredoc_nowdoc_stats', (a) => getPhpHeredocNowdocStats(str(a, 'app_path')));
  handlers.set('list_php_file_inclusion_security', (a) => listPhpFileInclusionSecurity(str(a, 'app_path')));
  handlers.set('get_php_file_inclusion_security_stats', (a) => getPhpFileInclusionSecurityStats(str(a, 'app_path')));
  handlers.set('list_symfony_lock_store_config', (a) => listSymfonyLockStoreConfig(str(a, 'app_path')));
  handlers.set('get_symfony_lock_store_config_stats', (a) => getSymfonyLockStoreConfigStats(str(a, 'app_path')));
  handlers.set('list_symfony_http_cache_store', (a) => listSymfonyHttpCacheStore(str(a, 'app_path')));
  handlers.set('get_symfony_http_cache_store_stats', (a) => getSymfonyHttpCacheStoreStats(str(a, 'app_path')));
  handlers.set('list_symfony_translation_yaml_lint', (a) => listSymfonyTranslationYamlLint(str(a, 'app_path')));
  handlers.set('get_symfony_translation_yaml_lint_stats', (a) => getSymfonyTranslationYamlLintStats(str(a, 'app_path')));
  handlers.set('list_symfony_serializer_context_builder', (a) => listSymfonySerializerContextBuilder(str(a, 'app_path')));
  handlers.set('get_symfony_serializer_context_builder_stats', (a) => getSymfonySerializerContextBuilderStats(str(a, 'app_path')));
  handlers.set('list_symfony_permissions_policy', (a) => listSymfonyPermissionsPolicy(str(a, 'app_path')));
  handlers.set('get_symfony_permissions_policy_stats', (a) => getSymfonyPermissionsPolicyStats(str(a, 'app_path')));
  handlers.set('list_symfony_scheduler_transport_config', (a) => listSymfonySchedulerTransportConfig(str(a, 'app_path')));
  handlers.set('get_symfony_scheduler_transport_config_stats', (a) => getSymfonySchedulerTransportConfigStats(str(a, 'app_path')));
  handlers.set('list_symfony_doctrine_sql_logger', (a) => listSymfonyDoctrineSqlLogger(str(a, 'app_path')));
  handlers.set('get_symfony_doctrine_sql_logger_stats', (a) => getSymfonyDoctrineSqlLoggerStats(str(a, 'app_path')));
  handlers.set('list_bitbucket_pipelines_config', (a) => listBitbucketPipelinesConfig(str(a, 'app_path')));
  handlers.set('get_bitbucket_pipelines_config_stats', (a) => getBitbucketPipelinesConfigStats(str(a, 'app_path')));
  handlers.set('list_digitalocean_app_platform', (a) => listDigitalOceanAppPlatform(str(a, 'app_path')));
  handlers.set('get_digitalocean_app_platform_stats', (a) => getDigitalOceanAppPlatformStats(str(a, 'app_path')));
  handlers.set('list_render_deploy_config', (a) => listRenderDeployConfig(str(a, 'app_path')));
  handlers.set('get_render_deploy_config_stats', (a) => getRenderDeployConfigStats(str(a, 'app_path')));
  handlers.set('list_google_cloud_run_config', (a) => listGoogleCloudRunConfig(str(a, 'app_path')));
  handlers.set('get_google_cloud_run_config_stats', (a) => getGoogleCloudRunConfigStats(str(a, 'app_path')));
  handlers.set('list_firebase_integration', (a) => listFirebaseIntegration(str(a, 'app_path')));
  handlers.set('get_firebase_integration_stats', (a) => getFirebaseIntegrationStats(str(a, 'app_path')));
  handlers.set('list_mailgun_integration', (a) => listMailgunIntegration(str(a, 'app_path')));
  handlers.set('get_mailgun_integration_stats', (a) => getMailgunIntegrationStats(str(a, 'app_path')));
  handlers.set('list_braintree_integration', (a) => listBraintreeIntegration(str(a, 'app_path')));
  handlers.set('get_braintree_integration_stats', (a) => getBraintreeIntegrationStats(str(a, 'app_path')));
  handlers.set('list_github_api_integration', (a) => listGithubApiIntegration(str(a, 'app_path')));
  handlers.set('get_github_api_integration_stats', (a) => getGithubApiIntegrationStats(str(a, 'app_path')));
  handlers.set('list_shopify_integration', (a) => listShopifyIntegration(str(a, 'app_path')));
  handlers.set('get_shopify_integration_stats', (a) => getShopifyIntegrationStats(str(a, 'app_path')));
  // Phase 36 handlers
  handlers.set('list_php_json_encode_flags', (a) => listPhpJsonEncodeFlags(str(a, 'app_path')));
  handlers.set('get_php_json_encode_flags_stats', (a) => getPhpJsonEncodeFlagsStats(str(a, 'app_path')));
  handlers.set('list_php_sprintf_type_safety', (a) => listPhpSprintfTypeSafety(str(a, 'app_path')));
  handlers.set('get_php_sprintf_type_safety_stats', (a) => getPhpSprintfTypeSafetyStats(str(a, 'app_path')));
  handlers.set('list_php_date_timezone', (a) => listPhpDateTimezone(str(a, 'app_path')));
  handlers.set('get_php_date_timezone_stats', (a) => getPhpDateTimezoneStats(str(a, 'app_path')));
  handlers.set('list_php_gd_security', (a) => listPhpGdSecurity(str(a, 'app_path')));
  handlers.set('get_php_gd_security_stats', (a) => getPhpGdSecurityStats(str(a, 'app_path')));
  handlers.set('list_php_imap_patterns', (a) => listPhpImapPatterns(str(a, 'app_path')));
  handlers.set('get_php_imap_patterns_stats', (a) => getPhpImapPatternsStats(str(a, 'app_path')));
  handlers.set('list_symfony_messenger_routing_table', (a) => listSymfonyMessengerRoutingTable(str(a, 'app_path')));
  handlers.set('get_symfony_messenger_routing_table_stats', (a) => getSymfonyMessengerRoutingTableStats(str(a, 'app_path')));
  handlers.set('list_symfony_cache_namespace', (a) => listSymfonyCacheNamespace(str(a, 'app_path')));
  handlers.set('get_symfony_cache_namespace_stats', (a) => getSymfonyCacheNamespaceStats(str(a, 'app_path')));
  handlers.set('list_symfony_validator_auto_mapping', (a) => listSymfonyValidatorAutoMapping(str(a, 'app_path')));
  handlers.set('get_symfony_validator_auto_mapping_stats', (a) => getSymfonyValidatorAutoMappingStats(str(a, 'app_path')));
  handlers.set('list_symfony_container_compile', (a) => listSymfonyContainerCompile(str(a, 'app_path')));
  handlers.set('get_symfony_container_compile_stats', (a) => getSymfonyContainerCompileStats(str(a, 'app_path')));
  handlers.set('list_doctrine_custom_platform', (a) => listDoctrineCustomPlatform(str(a, 'app_path')));
  handlers.set('get_doctrine_custom_platform_stats', (a) => getDoctrineCustomPlatformStats(str(a, 'app_path')));
  handlers.set('list_aws_ses_integration', (a) => listAwsSesIntegration(str(a, 'app_path')));
  handlers.set('get_aws_ses_integration_stats', (a) => getAwsSesIntegrationStats(str(a, 'app_path')));
  handlers.set('list_pusher_integration', (a) => listPusherIntegration(str(a, 'app_path')));
  handlers.set('get_pusher_integration_stats', (a) => getPusherIntegrationStats(str(a, 'app_path')));
  handlers.set('list_cloudinary_integration', (a) => listCloudinaryIntegration(str(a, 'app_path')));
  handlers.set('get_cloudinary_integration_stats', (a) => getCloudinaryIntegrationStats(str(a, 'app_path')));
  handlers.set('list_hubspot_integration', (a) => listHubspotIntegration(str(a, 'app_path')));
  handlers.set('get_hubspot_integration_stats', (a) => getHubspotIntegrationStats(str(a, 'app_path')));
  handlers.set('list_netlify_deploy_config', (a) => listNetlifyDeployConfig(str(a, 'app_path')));
  handlers.set('get_netlify_deploy_config_stats', (a) => getNetlifyDeployConfigStats(str(a, 'app_path')));
  handlers.set('list_vercel_deploy_config', (a) => listVercelDeployConfig(str(a, 'app_path')));
  handlers.set('get_vercel_deploy_config_stats', (a) => getVercelDeployConfigStats(str(a, 'app_path')));
  handlers.set('list_php_benchmark_patterns', (a) => listPhpBenchmarkPatterns(str(a, 'app_path')));
  handlers.set('get_php_benchmark_patterns_stats', (a) => getPhpBenchmarkPatternsStats(str(a, 'app_path')));
  handlers.set('list_php_ftp_sftp_patterns', (a) => listPhpFtpSftpPatterns(str(a, 'app_path')));
  handlers.set('get_php_ftp_sftp_patterns_stats', (a) => getPhpFtpSftpPatternsStats(str(a, 'app_path')));
  handlers.set('list_newrelic_php_agent', (a) => listNewrelicPhpAgent(str(a, 'app_path')));
  handlers.set('get_newrelic_php_agent_stats', (a) => getNewrelicPhpAgentStats(str(a, 'app_path')));
  handlers.set('list_php_csv_parsing', (a) => listPhpCsvParsing(str(a, 'app_path')));
  handlers.set('get_php_csv_parsing_stats', (a) => getPhpCsvParsingStats(str(a, 'app_path')));
  // Phase 37 handlers
  handlers.set('list_php_command_injection', (a) => listPhpCommandInjection(str(a, 'app_path')));
  handlers.set('get_php_command_injection_stats', (a) => getPhpCommandInjectionStats(str(a, 'app_path')));
  handlers.set('list_php_ssrf_patterns', (a) => listPhpSsrfPatterns(str(a, 'app_path')));
  handlers.set('get_php_ssrf_patterns_stats', (a) => getPhpSsrfPatternsStats(str(a, 'app_path')));
  handlers.set('list_php_open_redirect', (a) => listPhpOpenRedirect(str(a, 'app_path')));
  handlers.set('get_php_open_redirect_stats', (a) => getPhpOpenRedirectStats(str(a, 'app_path')));
  handlers.set('list_php_xss_patterns', (a) => listPhpXssPatterns(str(a, 'app_path')));
  handlers.set('get_php_xss_patterns_stats', (a) => getPhpXssPatternsStats(str(a, 'app_path')));
  handlers.set('list_php_timing_attack', (a) => listPhpTimingAttack(str(a, 'app_path')));
  handlers.set('get_php_timing_attack_stats', (a) => getPhpTimingAttackStats(str(a, 'app_path')));
  handlers.set('list_php_output_buffering', (a) => listPhpOutputBuffering(str(a, 'app_path')));
  handlers.set('get_php_output_buffering_stats', (a) => getPhpOutputBufferingStats(str(a, 'app_path')));
  handlers.set('list_php_bcmath_patterns', (a) => listPhpBcmathPatterns(str(a, 'app_path')));
  handlers.set('get_php_bcmath_patterns_stats', (a) => getPhpBcmathPatternsStats(str(a, 'app_path')));
  handlers.set('list_php_dom_xpath', (a) => listPhpDomXpath(str(a, 'app_path')));
  handlers.set('get_php_dom_xpath_stats', (a) => getPhpDomXpathStats(str(a, 'app_path')));
  handlers.set('list_php_signal_handling', (a) => listPhpSignalHandling(str(a, 'app_path')));
  handlers.set('get_php_signal_handling_stats', (a) => getPhpSignalHandlingStats(str(a, 'app_path')));
  handlers.set('list_php_xsl_transformation', (a) => listPhpXslTransformation(str(a, 'app_path')));
  handlers.set('get_php_xsl_transformation_stats', (a) => getPhpXslTransformationStats(str(a, 'app_path')));
  handlers.set('list_php_parallel_extension', (a) => listPhpParallelExtension(str(a, 'app_path')));
  handlers.set('get_php_parallel_extension_stats', (a) => getPhpParallelExtensionStats(str(a, 'app_path')));
  handlers.set('list_php_lazy_objects', (a) => listPhpLazyObjects(str(a, 'app_path')));
  handlers.set('get_php_lazy_objects_stats', (a) => getPhpLazyObjectsStats(str(a, 'app_path')));
  handlers.set('list_php_array_unpacking', (a) => listPhpArrayUnpacking(str(a, 'app_path')));
  handlers.set('get_php_array_unpacking_stats', (a) => getPhpArrayUnpackingStats(str(a, 'app_path')));
  handlers.set('list_php_backed_enum_patterns', (a) => listPhpBackedEnumPatterns(str(a, 'app_path')));
  handlers.set('get_php_backed_enum_patterns_stats', (a) => getPhpBackedEnumPatternsStats(str(a, 'app_path')));
  handlers.set('list_php_file_locking', (a) => listPhpFileLocking(str(a, 'app_path')));
  handlers.set('get_php_file_locking_stats', (a) => getPhpFileLockingStats(str(a, 'app_path')));
  handlers.set('list_symfony_form_type_guesser', (a) => listSymfonyFormTypeGuesser(str(a, 'app_path')));
  handlers.set('get_symfony_form_type_guesser_stats', (a) => getSymfonyFormTypeGuesserStats(str(a, 'app_path')));
  handlers.set('list_symfony_validator_sequence_provider', (a) => listSymfonyValidatorSequenceProvider(str(a, 'app_path')));
  handlers.set('get_symfony_validator_sequence_provider_stats', (a) => getSymfonyValidatorSequenceProviderStats(str(a, 'app_path')));
  handlers.set('list_symfony_monolog_rotation', (a) => listSymfonyMonologRotation(str(a, 'app_path')));
  handlers.set('get_symfony_monolog_rotation_stats', (a) => getSymfonyMonologRotationStats(str(a, 'app_path')));
  handlers.set('list_symfony_json_login', (a) => listSymfonyJsonLogin(str(a, 'app_path')));
  handlers.set('get_symfony_json_login_stats', (a) => getSymfonyJsonLoginStats(str(a, 'app_path')));
  handlers.set('list_symfony_http_middleware', (a) => listSymfonyHttpMiddleware(str(a, 'app_path')));
  handlers.set('get_symfony_http_middleware_stats', (a) => getSymfonyHttpMiddlewareStats(str(a, 'app_path')));
  handlers.set('list_symfony_ux_stimulus_values', (a) => listSymfonyUxStimulusValues(str(a, 'app_path')));
  handlers.set('get_symfony_ux_stimulus_values_stats', (a) => getSymfonyUxStimulusValuesStats(str(a, 'app_path')));
  handlers.set('list_symfony_notifier_status', (a) => listSymfonyNotifierStatus(str(a, 'app_path')));
  handlers.set('get_symfony_notifier_status_stats', (a) => getSymfonyNotifierStatusStats(str(a, 'app_path')));
  handlers.set('list_fos_rest_bundle', (a) => listFosRestBundle(str(a, 'app_path')));
  handlers.set('get_fos_rest_bundle_stats', (a) => getFosRestBundleStats(str(a, 'app_path')));
  handlers.set('list_nelmio_security_bundle', (a) => listNelmioSecurityBundle(str(a, 'app_path')));
  handlers.set('get_nelmio_security_bundle_stats', (a) => getNelmioSecurityBundleStats(str(a, 'app_path')));
  handlers.set('list_doctrine_gedmo_tree', (a) => listDoctrineGedmoTree(str(a, 'app_path')));
  handlers.set('get_doctrine_gedmo_tree_stats', (a) => getDoctrineGedmoTreeStats(str(a, 'app_path')));
  handlers.set('list_doctrine_gedmo_translatable', (a) => listDoctrineGedmoTranslatable(str(a, 'app_path')));
  handlers.set('get_doctrine_gedmo_translatable_stats', (a) => getDoctrineGedmoTranslatableStats(str(a, 'app_path')));
  handlers.set('list_doctrine_gedmo_sluggable', (a) => listDoctrineGedmoSluggable(str(a, 'app_path')));
  handlers.set('get_doctrine_gedmo_sluggable_stats', (a) => getDoctrineGedmoSluggableStats(str(a, 'app_path')));
  handlers.set('list_doctrine_gedmo_blameable', (a) => listDoctrineGedmoBlameable(str(a, 'app_path')));
  handlers.set('get_doctrine_gedmo_blameable_stats', (a) => getDoctrineGedmoBlameableStats(str(a, 'app_path')));
  handlers.set('list_docker_swarm_config', (a) => listDockerSwarmConfig(str(a, 'app_path')));
  handlers.set('get_docker_swarm_config_stats', (a) => getDockerSwarmConfigStats(str(a, 'app_path')));
  handlers.set('list_kubernetes_manifests', (a) => listKubernetesManifests(str(a, 'app_path')));
  handlers.set('get_kubernetes_manifests_stats', (a) => getKubernetesManifestsStats(str(a, 'app_path')));
  handlers.set('list_loki_log_config', (a) => listLokiLogConfig(str(a, 'app_path')));
  handlers.set('get_loki_log_config_stats', (a) => getLokiLogConfigStats(str(a, 'app_path')));
  handlers.set('list_nginx_unit_config', (a) => listNginxUnitConfig(str(a, 'app_path')));
  handlers.set('get_nginx_unit_config_stats', (a) => getNginxUnitConfigStats(str(a, 'app_path')));
  handlers.set('list_oauth2_server_config', (a) => listOauth2ServerConfig(str(a, 'app_path')));
  handlers.set('get_oauth2_server_config_stats', (a) => getOauth2ServerConfigStats(str(a, 'app_path')));
  handlers.set('list_redis_pubsub_patterns', (a) => listRedisPubsubPatterns(str(a, 'app_path')));
  handlers.set('get_redis_pubsub_patterns_stats', (a) => getRedisPubsubPatternsStats(str(a, 'app_path')));
  handlers.set('list_kafka_schema_registry', (a) => listKafkaSchemaRegistry(str(a, 'app_path')));
  handlers.set('get_kafka_schema_registry_stats', (a) => getKafkaSchemaRegistryStats(str(a, 'app_path')));
  handlers.set('list_sqs_dlq_config', (a) => listSqsDlqConfig(str(a, 'app_path')));
  handlers.set('get_sqs_dlq_config_stats', (a) => getSqsDlqConfigStats(str(a, 'app_path')));
  handlers.set('list_stripe_billing_subscriptions', (a) => listStripeBillingSubscriptions(str(a, 'app_path')));
  handlers.set('get_stripe_billing_subscriptions_stats', (a) => getStripeBillingSubscriptionsStats(str(a, 'app_path')));
  handlers.set('list_paypal_checkout_v2', (a) => listPaypalCheckoutV2(str(a, 'app_path')));
  handlers.set('get_paypal_checkout_v2_stats', (a) => getPaypalCheckoutV2Stats(str(a, 'app_path')));
  handlers.set('list_google_oauth_integration', (a) => listGoogleOauthIntegration(str(a, 'app_path')));
  handlers.set('get_google_oauth_integration_stats', (a) => getGoogleOauthIntegrationStats(str(a, 'app_path')));
  handlers.set('list_microsoft_graph_integration', (a) => listMicrosoftGraphIntegration(str(a, 'app_path')));
  handlers.set('get_microsoft_graph_integration_stats', (a) => getMicrosoftGraphIntegrationStats(str(a, 'app_path')));
  handlers.set('list_aws_cognito_integration', (a) => listAwsCognitoIntegration(str(a, 'app_path')));
  handlers.set('get_aws_cognito_integration_stats', (a) => getAwsCognitoIntegrationStats(str(a, 'app_path')));
  handlers.set('list_aws_cloudfront_config', (a) => listAwsCloudfrontConfig(str(a, 'app_path')));
  handlers.set('get_aws_cloudfront_config_stats', (a) => getAwsCloudfrontConfigStats(str(a, 'app_path')));
  handlers.set('list_sentry_performance_tracing', (a) => listSentryPerformanceTracing(str(a, 'app_path')));
  handlers.set('get_sentry_performance_tracing_stats', (a) => getSentryPerformanceTracingStats(str(a, 'app_path')));
  handlers.set('list_datadog_custom_metrics', (a) => listDatadogCustomMetrics(str(a, 'app_path')));
  handlers.set('get_datadog_custom_metrics_stats', (a) => getDatadogCustomMetricsStats(str(a, 'app_path')));
  handlers.set('list_elastic_apm_php', (a) => listElasticApmPhp(str(a, 'app_path')));
  handlers.set('get_elastic_apm_php_stats', (a) => getElasticApmPhpStats(str(a, 'app_path')));
  handlers.set('list_league_oauth2_client', (a) => listLeagueOauth2Client(str(a, 'app_path')));
  handlers.set('get_league_oauth2_client_stats', (a) => getLeagueOauth2ClientStats(str(a, 'app_path')));
  handlers.set('list_phpunit_test_isolation', (a) => listPhpunitTestIsolation(str(a, 'app_path')));
  handlers.set('get_phpunit_test_isolation_stats', (a) => getPhpunitTestIsolationStats(str(a, 'app_path')));
  handlers.set('list_phpunit_test_naming', (a) => listPhpunitTestNaming(str(a, 'app_path')));
  handlers.set('get_phpunit_test_naming_stats', (a) => getPhpunitTestNamingStats(str(a, 'app_path')));
  handlers.set('list_php_rector_upgrade_sets', (a) => listPhpRectorUpgradeSets(str(a, 'app_path')));
  handlers.set('get_php_rector_upgrade_sets_stats', (a) => getPhpRectorUpgradeSetsStats(str(a, 'app_path')));
  handlers.set('list_php_date_interval', (a) => listPhpDateInterval(str(a, 'app_path')));
  handlers.set('get_php_date_interval_stats', (a) => getPhpDateIntervalStats(str(a, 'app_path')));
  // Phase 38 handlers
  handlers.set('list_php_deserialization_gadget', (a) => listPhpDeserializationGadget(str(a, 'app_path')));
  handlers.set('get_php_deserialization_gadget_stats', (a) => getPhpDeserializationGadgetStats(str(a, 'app_path')));
  handlers.set('list_php_file_upload_validation', (a) => listPhpFileUploadValidation(str(a, 'app_path')));
  handlers.set('get_php_file_upload_validation_stats', (a) => getPhpFileUploadValidationStats(str(a, 'app_path')));
  handlers.set('list_php_null_byte_injection', (a) => listPhpNullByteInjection(str(a, 'app_path')));
  handlers.set('get_php_null_byte_injection_stats', (a) => getPhpNullByteInjectionStats(str(a, 'app_path')));
  handlers.set('list_php_regex_injection', (a) => listPhpRegexInjection(str(a, 'app_path')));
  handlers.set('get_php_regex_injection_stats', (a) => getPhpRegexInjectionStats(str(a, 'app_path')));
  handlers.set('list_php_hash_algorithm_security', (a) => listPhpHashAlgorithmSecurity(str(a, 'app_path')));
  handlers.set('get_php_hash_algorithm_security_stats', (a) => getPhpHashAlgorithmSecurityStats(str(a, 'app_path')));
  handlers.set('list_php_socket_programming', (a) => listPhpSocketProgramming(str(a, 'app_path')));
  handlers.set('get_php_socket_programming_stats', (a) => getPhpSocketProgrammingStats(str(a, 'app_path')));
  handlers.set('list_php_shmop_ipc', (a) => listPhpShmopIpc(str(a, 'app_path')));
  handlers.set('get_php_shmop_ipc_stats', (a) => getPhpShmopIpcStats(str(a, 'app_path')));
  handlers.set('list_php_posix_functions', (a) => listPhpPosixFunctions(str(a, 'app_path')));
  handlers.set('get_php_posix_functions_stats', (a) => getPhpPosixFunctionsStats(str(a, 'app_path')));
  handlers.set('list_php_constant_visibility', (a) => listPhpConstantVisibility(str(a, 'app_path')));
  handlers.set('get_php_constant_visibility_stats', (a) => getPhpConstantVisibilityStats(str(a, 'app_path')));
  handlers.set('list_php_dnf_types', (a) => listPhpDnfTypes(str(a, 'app_path')));
  handlers.set('get_php_dnf_types_stats', (a) => getPhpDnfTypesStats(str(a, 'app_path')));
  handlers.set('list_php_resource_handle_leaks', (a) => listPhpResourceHandleLeaks(str(a, 'app_path')));
  handlers.set('get_php_resource_handle_leaks_stats', (a) => getPhpResourceHandleLeaksStats(str(a, 'app_path')));
  handlers.set('list_php_integer_overflow', (a) => listPhpIntegerOverflow(str(a, 'app_path')));
  handlers.set('get_php_integer_overflow_stats', (a) => getPhpIntegerOverflowStats(str(a, 'app_path')));
  handlers.set('list_php_template_injection', (a) => listPhpTemplateInjection(str(a, 'app_path')));
  handlers.set('get_php_template_injection_stats', (a) => getPhpTemplateInjectionStats(str(a, 'app_path')));
  handlers.set('list_php_object_injection', (a) => listPhpObjectInjection(str(a, 'app_path')));
  handlers.set('get_php_object_injection_stats', (a) => getPhpObjectInjectionStats(str(a, 'app_path')));
  handlers.set('list_php_array_find_functions', (a) => listPhpArrayFindFunctions(str(a, 'app_path')));
  handlers.set('get_php_array_find_functions_stats', (a) => getPhpArrayFindFunctionsStats(str(a, 'app_path')));
  handlers.set('list_symfony_twig_embed', (a) => listSymfonyTwigEmbed(str(a, 'app_path')));
  handlers.set('get_symfony_twig_embed_stats', (a) => getSymfonyTwigEmbedStats(str(a, 'app_path')));
  handlers.set('list_symfony_validator_unique_entity', (a) => listSymfonyValidatorUniqueEntity(str(a, 'app_path')));
  handlers.set('get_symfony_validator_unique_entity_stats', (a) => getSymfonyValidatorUniqueEntityStats(str(a, 'app_path')));
  handlers.set('list_symfony_form_pre_set_data', (a) => listSymfonyFormPreSetData(str(a, 'app_path')));
  handlers.set('get_symfony_form_pre_set_data_stats', (a) => getSymfonyFormPreSetDataStats(str(a, 'app_path')));
  handlers.set('list_symfony_var_dumper_casters', (a) => listSymfonyVarDumperCasters(str(a, 'app_path')));
  handlers.set('get_symfony_var_dumper_casters_stats', (a) => getSymfonyVarDumperCastersStats(str(a, 'app_path')));
  handlers.set('list_symfony_test_http_kernel', (a) => listSymfonyTestHttpKernel(str(a, 'app_path')));
  handlers.set('get_symfony_test_http_kernel_stats', (a) => getSymfonyTestHttpKernelStats(str(a, 'app_path')));
  handlers.set('list_symfony_workflow_parallel_transitions', (a) => listSymfonyWorkflowParallelTransitions(str(a, 'app_path')));
  handlers.set('get_symfony_workflow_parallel_transitions_stats', (a) => getSymfonyWorkflowParallelTransitionsStats(str(a, 'app_path')));
  handlers.set('list_symfony_mailer_html_to_text', (a) => listSymfonyMailerHtmlToText(str(a, 'app_path')));
  handlers.set('get_symfony_mailer_html_to_text_stats', (a) => getSymfonyMailerHtmlToTextStats(str(a, 'app_path')));
  handlers.set('list_symfony_console_hidden_commands', (a) => listSymfonyConsoleHiddenCommands(str(a, 'app_path')));
  handlers.set('get_symfony_console_hidden_commands_stats', (a) => getSymfonyConsoleHiddenCommandsStats(str(a, 'app_path')));
  handlers.set('list_symfony_routing_sub_collections', (a) => listSymfonyRoutingSubCollections(str(a, 'app_path')));
  handlers.set('get_symfony_routing_sub_collections_stats', (a) => getSymfonyRoutingSubCollectionsStats(str(a, 'app_path')));
  handlers.set('list_symfony_security_custom_voter', (a) => listSymfonySecurityCustomVoter(str(a, 'app_path')));
  handlers.set('get_symfony_security_custom_voter_stats', (a) => getSymfonySecurityCustomVoterStats(str(a, 'app_path')));
  handlers.set('list_symfony_mailer_smtp_fallback', (a) => listSymfonyMailerSmtpFallback(str(a, 'app_path')));
  handlers.set('get_symfony_mailer_smtp_fallback_stats', (a) => getSymfonyMailerSmtpFallbackStats(str(a, 'app_path')));
  handlers.set('list_symfony_translation_lint_all', (a) => listSymfonyTranslationLintAll(str(a, 'app_path')));
  handlers.set('get_symfony_translation_lint_all_stats', (a) => getSymfonyTranslationLintAllStats(str(a, 'app_path')));
  handlers.set('list_symfony_cache_psr6_adapters', (a) => listSymfonyCachePsr6Adapters(str(a, 'app_path')));
  handlers.set('get_symfony_cache_psr6_adapters_stats', (a) => getSymfonyCachePsr6AdaptersStats(str(a, 'app_path')));
  handlers.set('list_doctrine_dbal_driveroptions', (a) => listDoctrineDbalDriveroptions(str(a, 'app_path')));
  handlers.set('get_doctrine_dbal_driveroptions_stats', (a) => getDoctrineDbalDriveroptionsStats(str(a, 'app_path')));
  handlers.set('list_doctrine_composite_primary_keys', (a) => listDoctrineCompositePrimaryKeys(str(a, 'app_path')));
  handlers.set('get_doctrine_composite_primary_keys_stats', (a) => getDoctrineCompositePrimaryKeysStats(str(a, 'app_path')));
  handlers.set('list_traefik_config', (a) => listTraefikConfig(str(a, 'app_path')));
  handlers.set('get_traefik_config_stats', (a) => getTraefikConfigStats(str(a, 'app_path')));
  handlers.set('list_ansible_playbook_config', (a) => listAnsiblePlaybookConfig(str(a, 'app_path')));
  handlers.set('get_ansible_playbook_config_stats', (a) => getAnsiblePlaybookConfigStats(str(a, 'app_path')));
  handlers.set('list_prometheus_alerting_rules', (a) => listPrometheusAlertingRules(str(a, 'app_path')));
  handlers.set('get_prometheus_alerting_rules_stats', (a) => getPrometheusAlertingRulesStats(str(a, 'app_path')));
  handlers.set('list_vault_dynamic_secrets', (a) => listVaultDynamicSecrets(str(a, 'app_path')));
  handlers.set('get_vault_dynamic_secrets_stats', (a) => getVaultDynamicSecretsStats(str(a, 'app_path')));
  handlers.set('list_consul_service_discovery', (a) => listConsulServiceDiscovery(str(a, 'app_path')));
  handlers.set('get_consul_service_discovery_stats', (a) => getConsulServiceDiscoveryStats(str(a, 'app_path')));
  handlers.set('list_github_dependabot_config', (a) => listGithubDependabotConfig(str(a, 'app_path')));
  handlers.set('get_github_dependabot_config_stats', (a) => getGithubDependabotConfigStats(str(a, 'app_path')));
  handlers.set('list_aws_parameter_store', (a) => listAwsParameterStore(str(a, 'app_path')));
  handlers.set('get_aws_parameter_store_stats', (a) => getAwsParameterStoreStats(str(a, 'app_path')));
  handlers.set('list_aws_secrets_manager', (a) => listAwsSecretsManager(str(a, 'app_path')));
  handlers.set('get_aws_secrets_manager_stats', (a) => getAwsSecretsManagerStats(str(a, 'app_path')));
  handlers.set('list_google_cloud_storage', (a) => listGoogleCloudStorage(str(a, 'app_path')));
  handlers.set('get_google_cloud_storage_stats', (a) => getGoogleCloudStorageStats(str(a, 'app_path')));
  handlers.set('list_azure_blob_storage', (a) => listAzureBlobStorage(str(a, 'app_path')));
  handlers.set('get_azure_blob_storage_stats', (a) => getAzureBlobStorageStats(str(a, 'app_path')));
  handlers.set('list_mongodb_integration', (a) => listMongodbIntegration(str(a, 'app_path')));
  handlers.set('get_mongodb_integration_stats', (a) => getMongodbIntegrationStats(str(a, 'app_path')));
  handlers.set('list_elasticsearch_percolate', (a) => listElasticsearchPercolate(str(a, 'app_path')));
  handlers.set('get_elasticsearch_percolate_stats', (a) => getElasticsearchPercolateStats(str(a, 'app_path')));
  handlers.set('list_segment_analytics', (a) => listSegmentAnalytics(str(a, 'app_path')));
  handlers.set('get_segment_analytics_stats', (a) => getSegmentAnalyticsStats(str(a, 'app_path')));
  handlers.set('list_zendesk_integration', (a) => listZendeskIntegration(str(a, 'app_path')));
  handlers.set('get_zendesk_integration_stats', (a) => getZendeskIntegrationStats(str(a, 'app_path')));
  handlers.set('list_sqs_fifo_queues', (a) => listSqsFifoQueues(str(a, 'app_path')));
  handlers.set('get_sqs_fifo_queues_stats', (a) => getSqsFifoQueuesStats(str(a, 'app_path')));
  handlers.set('list_intercom_integration', (a) => listIntercomIntegration(str(a, 'app_path')));
  handlers.set('get_intercom_integration_stats', (a) => getIntercomIntegrationStats(str(a, 'app_path')));
  handlers.set('list_phpunit_clock_assertion', (a) => listPhpunitClockAssertion(str(a, 'app_path')));
  handlers.set('get_phpunit_clock_assertion_stats', (a) => getPhpunitClockAssertionStats(str(a, 'app_path')));
  handlers.set('list_phpunit_self_shunting', (a) => listPhpunitSelfShunting(str(a, 'app_path')));
  handlers.set('get_phpunit_self_shunting_stats', (a) => getPhpunitSelfShuntingStats(str(a, 'app_path')));
  handlers.set('list_cypress_e2e_config', (a) => listCypressE2eConfig(str(a, 'app_path')));
  handlers.set('get_cypress_e2e_config_stats', (a) => getCypressE2eConfigStats(str(a, 'app_path')));
  handlers.set('list_playwright_e2e_config', (a) => listPlaywrightE2eConfig(str(a, 'app_path')));
  handlers.set('get_playwright_e2e_config_stats', (a) => getPlaywrightE2eConfigStats(str(a, 'app_path')));
  return handlers;
}

/**
 * Wraps raw tool execution with the full security stack:
 *   1. Request signing (HMAC-SHA256) — optional, controlled by SYMFONY_MCP_SIGNING_SECRET
 *   2. Rate limiting — sliding window, controlled by SYMFONY_MCP_RATE_LIMIT
 *   3. App path authorization — controlled by SYMFONY_MCP_ALLOWED_PATHS
 *   4. Audit logging — controlled by SYMFONY_MCP_AUDIT_LOG
 */
async function executeWithSecurity(
  name: string,
  args: Record<string, unknown>,
  handler: ToolHandler
): Promise<McpToolResult> {
  const appPath = str(args, 'app_path');

  // 0a. Input validation — reject malformed or oversized parameters before any processing
  if (isInputValidationEnabled()) {
    const validation = validateToolArgs(name, args);
    if (!validation.valid) {
      return {
        content: [{ type: 'text', text: `Invalid input: ${validation.reason}` }],
        isError: true,
      };
    }
  }

  // 0b. Per-tool access control — check allowlist / denylist before anything else
  const accessResult = checkToolAccess(name);
  if (!accessResult.allowed) {
    return {
      content: [{ type: 'text', text: `Access denied: ${accessResult.reason}` }],
      isError: true,
    };
  }

  // 1. Anomaly detection — check for path traversal, scanning, etc. before any auth
  const anomaly = checkAnomaly(name, appPath);
  if (anomaly?.blocked) {
    return {
      content: [{ type: 'text', text: `Request blocked: anomaly detected (${anomaly.type})` }],
      isError: true,
    };
  }

  // 2. Request signing verification
  const signResult = verifyRequest(name, args);
  if (!signResult.valid) {
    recordAuthFailure(signResult.reason);
    incAuthFailure(signResult.reason);
    return {
      content: [{ type: 'text', text: `Request rejected: ${signResult.reason}` }],
      isError: true,
    };
  }

  // 3. Rate limiting
  const rateResult = checkRateLimit(name);
  if (!rateResult.allowed) {
    const retryAfter = Math.ceil((rateResult.retryAfterMs ?? rateResult.resetInMs) / 1000);
    recordRateLimitBlock(name);
    incRateLimitHit(name);
    return {
      content: [{
        type: 'text',
        text: `Rate limit exceeded for tool "${name}". Try again in ${retryAfter}s. ` +
          `Set SYMFONY_MCP_RATE_LIMIT=0 to disable rate limiting.`,
      }],
      isError: true,
    };
  }

  // 4. App path authorization (skipped for discovery meta-tools that need no app_path)
  const NO_APP_PATH_TOOLS = new Set([
    'list_tool_categories', 'search_tools', 'activate_category',
    'get_active_tools', 'deactivate_category',
  ]);
  if (!NO_APP_PATH_TOOLS.has(name)) {
    const guardResult = guardAppPath(appPath);
    if (!guardResult.allowed) {
      incPathGuardBlock(guardResult.reason ?? 'unknown');
      return {
        content: [{ type: 'text', text: `Access denied: ${guardResult.reason}` }],
        isError: true,
      };
    }
  }

  // 5. Execute with concurrency limit (J) + timeout (I) + audit logging + metrics
  const timeoutMs = parseInt(process.env['SYMFONY_MCP_TOOL_TIMEOUT_MS'] ?? '30000', 10) || 30_000;

  const timeoutGuard = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`tool_timeout_${timeoutMs}ms`)), timeoutMs).unref()
  );

  try {
    const rawResult = await withConcurrencyLimit(() =>
      Promise.race([
        withAudit(name, appPath, () => handler(args)) as Promise<McpToolResult>,
        timeoutGuard,
      ])
    );
    incToolCall(name, rawResult.isError ? 'error' : 'success');
    if (rawResult.isError) recordToolError(name);
    // 6. Output sanitization: DLP gate + error sanitization + privacy mode
    return sanitizeToolResult(rawResult, name) as McpToolResult;
  } catch (err) {
    incToolCall(name, 'error');
    recordToolError(name);
    // Surface concurrency/timeout errors as clean user-facing messages
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'concurrency_queue_full') {
      return {
        content: [{ type: 'text', text: 'Server is busy. Too many concurrent requests — try again shortly.' }],
        isError: true,
      };
    }
    if (msg.startsWith('tool_timeout_')) {
      return {
        content: [{ type: 'text', text: `Tool "${name}" timed out after ${timeoutMs}ms. Set SYMFONY_MCP_TOOL_TIMEOUT_MS to adjust.` }],
        isError: true,
      };
    }
    throw err;
  }
}

async function main(): Promise<void> {
  // B. Security startup audit — warn about dangerous configurations before accepting connections
  runStartupAudit();

  // E. Secrets rotation — flush vault cache on SIGUSR2 for zero-downtime rotation
  process.on('SIGUSR2', () => { clearVaultCache(); });

  // Validate session token on startup (for stdio mode, env var provides the token)
  const sessionToken = process.env['SYMFONY_MCP_SESSION_TOKEN'];
  const tokenResult = verifySessionToken(sessionToken);
  if (!tokenResult.valid) {
    process.stderr.write(`[symfony-agent-mcp] FATAL: ${tokenResult.reason}\n`);
    process.exit(1);
  }

  // Emit session token instructions so the client can configure itself
  emitTokenInstructions();

  const allTools = [
    ...getRouteTools(),
    ...getServiceTools(),
    ...getConfigTools(),
    ...getLogTools(),
    ...getEntityTools(),
    ...getDatabaseTools(),
    ...getControllerTools(),
    ...getComposerTools(),
    ...getMessengerTools(),
    ...getFormTools(),
    ...getProfilerTools(),
    ...getCacheInspectorTools(),
    ...getEventTools(),
    ...getCommandTools(),
    ...getTwigTools(),
    ...getTranslationTools(),
    ...getWorkflowTools(),
    ...getTestInspectorTools(),
    ...getEnvDiffTools(),
    ...getDeadCodeTools(),
    ...getApiPlatformTools(),
    ...getSerializerTools(),
    ...getSecurityVoterTools(),
    ...getRepositoryAnalyzerTools(),
    ...getMailerTools(),
    ...getBundleTools(),
    ...getDoctrineLifecycleTools(),
    ...getHttpClientTools(),
    ...getSchedulerTools(),
    ...getDiParameterTools(),
    ...getNotifierTools(),
    ...getRateLimiterTools(),
    ...getDependencyGraphTools(),
    ...getAssetMapperTools(),
    ...getSecurityScannerTools(),
    ...getDoctrineEmbeddableTools(),
    ...getCodeQualityTools(),
    ...getSymfonyUxTools(),
    ...getDoctrineExtensionTools(),
    ...getJwtAuthTools(),
    ...getTwigExtensionTools(),
    ...getServiceDecoratorTools(),
    ...getMigrationAnalysisTools(),
    ...getValidationTools(),
    ...getFixtureTools(),
    ...getSecretsVaultTools(),
    ...getHttpCacheTools(),
    ...getStaticAnalysisTools(),
    ...getCorsTools(),
    ...getLockTools(),
    ...getEnvConfigDiffTools(),
    ...getDoctrineSlcTools(),
    ...getMessengerMiddlewareTools(),
    ...getMonologTools(),
    ...getDoctrineTypeTools(),
    ...getWebhookTools(),
    ...getInputDtoTools(),
    ...getMercureTools(),
    ...getControllerSecurityTools(),
    ...getPhpUnitConfigTools(),
    ...getDoctrineOrmConfigTools(),
    ...getCompilerPassTools(),
    ...getMessengerHandlerTools(),
    ...getCachePoolTools(),
    ...getSessionConfigTools(),
    ...getDbalConfigTools(),
    ...getErrorPageTools(),
    ...getHealthCheckTools(),
    ...getKernelAnalysisTools(),
    ...getPasswordHasherTools(),
    ...getCacheWarmerTools(),
    ...getEasyAdminTools(),
    ...getBehatConfigTools(),
    ...getContainerTagTools(),
    ...getFlexRecipeTools(),
    ...getOpenApiTools(),
    ...getSearchIntegrationTools(),
    ...getFeatureFlagTools(),
    ...getCiCdConfigTools(),
    ...getOAuthSsoTools(),
    ...getDockerInspectorTools(),
    ...getFileStorageTools(),
    ...getGraphQlTools(),
    ...getCustomAuthenticatorTools(),
    ...getTurboTools(),
    ...getApiVersioningTools(),
    ...getPsalmTools(),
    ...getCronJobTools(),
    ...getWebpackEncoreTools(),
    ...getDoctrineQueryBuilderTools(),
    ...getPsrComplianceTools(),
    ...getTwigLintTools(),
    ...getMultiTenancyTools(),
    ...getSymfonyCliTools(),
    ...getRectorTools(),
    ...getApiRateLimitsTools(),
    ...getDeploymentConfigTools(),
    ...getCustomEventsTools(),
    ...getAccessibilityTools(),
    ...getDoctrineCacheTools(),
    ...getMakerTools(),
    ...getDoctrineFilterTools(),
    ...getLiveComponentTools(),
    ...getCsFixerTools(),
    ...getApiPlatformFiltersTools(),
    ...getMessengerFailureTools(),
    ...getFixtureGroupTools(),
    ...getTranslationPluralTools(),
    ...getApiPlatformSecurityTools(),
    ...getWorkflowGuardTools(),
    ...getDoctrineInheritanceTools(),
    ...getNotifierChannelTools(),
    ...getClockTools(),
    ...getPhpStanTools(),
    ...getDqlFunctionTools(),
    ...getLocaleConfigTools(),
    ...getDataCollectorTools(),
    ...getCsrfTools(),
    ...getSentryTools(),
    ...getConsoleNamespaceTools(),
    ...getNelmioApiDocTools(),
    ...getEnvConfigOverrideTools(),
    ...getBlackfireTools(),
    ...getUidTools(),
    ...getApiStateTools(),
    ...getExpressionLanguageTools(),
    ...getCacheTagTools(),
    ...getPhpEnumTools(),
    ...getMailerEventTools(),
    ...getSecurityFirewallTools(),
    ...getSecurityPassportTools(),
    ...getTrustedProxyTools(),
    ...getResponseCacheTools(),
    ...getAssetVersioningTools(),
    ...getDoctrineTimestampTools(),
    ...getDoctrineProjectionTools(),
    ...getMigrationHistoryTools(),
    ...getMessengerStampTools(),
    ...getMessageBusTools(),
    ...getTwigGlobalTools(),
    ...getTwigComponentTools(),
    ...getPhpUnitTestGroupTools(),
    ...getCustomConstraintTools(),
    ...getHttpClientScopeTools(),
    ...getEnvProcessorTools(),
    ...getSymfonyDebugTools(),
    ...getLockResourceTools(),
    ...getKernelEventTools(),
    ...getPropertyInfoTools(),
    ...getSerializerGroupTools(),
    ...getHtmlSanitizerTools(),
    ...getApiOperationTools(),
    ...getCustomMakerTools(),
    ...getStringSluggerTools(),
    ...getFormEventTools(),
    ...getDoctrineEventSubscriberTools(),
    ...getConfigExtensionTools(),
    ...getStopwatchTools(),
    ...getProcessTools(),
    ...getReadonlyTools(),
    ...getApiPaginationTools(),
    ...getLazyServiceTools(),
    ...getCustomAttributeTools(),
    ...getDoctrineIndexTools(),
    ...getConsoleCompletionTools(),
    ...getDoctrineAssocFetchTools(),
    ...getCompoundConstraintTools(),
    ...getMailerTransportTools(),
    ...getMercurePushTools(),
    ...getRepositoryPatternTools(),
    ...getObjectMapperTools(),
    ...getVarExporterTools(),
    ...getTwigSandboxTools(),
    ...getAutowireAttributeTools(),
    ...getTranslationGapTools(),
    ...getFormTypeExtensionTools(),
    ...getSymfonyRuntimeTools(),
    ...getMimePartsTools(),
    ...getTypeCoverageTools(),
    ...getRoleHierarchyTools(),
    ...getAccessControlTools(),
    ...getTokenStorageTools(),
    ...getFormTransformerTools(),
    ...getChoiceLoaderTools(),
    ...getValidationGroupTools(),
    ...getServiceAliasTools(),
    ...getDiFactoryTools(),
    ...getOptionsResolverTools(),
    ...getValueResolverTools(),
    ...getRequestMappingTools(),
    ...getFileUploadTools(),
    ...getHttpClientRetryTools(),
    ...getWebLinkTools(),
    ...getErrorRendererTools(),
    ...getConsoleStyleTools(),
    ...getConsoleSignalTools(),
    ...getWorkflowMarkingTools(),
    ...getMessengerTransportOptionTools(),
    ...getNotifierMessageTypeTools(),
    ...getSessionHandlerTools(),
    ...getEventDispatcherTracingTools(),
    ...getMaintenanceModeTools(),
    ...getMonologProcessorTools(),
    ...getTwigTokenParserTools(),
    ...getDoctrineSecondLevelCacheTools(),
    ...getDoctrineNamedQueryTools(),
    ...getDoctrineRepositoryQueryTools(),
    ...getDoctrinePaginatorTools(),
    ...getDoctrineCascadeTools(),
    ...getDoctrineOrphanRemovalTools(),
    ...getDoctrineDiscriminatorTools(),
    ...getDoctrineMigrationGraphTools(),
    ...getDoctrineEventManagerTools(),
    ...getApiPlatformStateProcessorTools(),
    ...getApiPlatformSerializationContextTools(),
    ...getApiPlatformValidationContextTools(),
    ...getApiPlatformResourceMetadataTools(),
    ...getPhpUnitDataProviderTools(),
    ...getPhpUnitMockTools(),
    ...getBehatContextTools(),
    ...getPestPhpTools(),
    ...getPhpComplexityTools(),
    ...getPhpNamespaceConsistencyTools(),
    ...getPhpMatchExhaustivenessTools(),
    ...getPhpDeprecationTools(),
    ...getPhpArrowFunctionTools(),
    ...getPhpAttributesReaderTools(),
    ...getWebserverConfigTools(),
    ...getPhpArchitectureRulesTools(),
    ...getTwigMacroTools(),
    ...getTwigInheritanceTools(),
    ...getTwigNamespaceTools(),
    ...getDoctrineHydratorTools(),
    ...getDoctrineResultCacheTools(),
    ...getDbalMiddlewareTools(),
    ...getDoctrineSoftDeleteTools(),
    ...getDoctrineMappingFormatTools(),
    ...getCookieSecurityTools(),
    ...getCspTools(),
    ...getHttpSecurityHeaderTools(),
    ...getNPlusOneTools(),
    ...getApiQueryExtensionTools(),
    ...getApiCustomNormalizerTools(),
    ...getApiIriConverterTools(),
    ...getApiSubresourceTools(),
    ...getApiDtoOutputTools(),
    ...getTranslationDomainTools(),
    ...getIcuTranslationTools(),
    ...getXliffFormatTools(),
    ...getImportmapTools(),
    ...getServiceLocatorTools(),
    ...getAbstractServiceTools(),
    ...getExceptionSubscriberTools(),
    ...getEventPriorityTools(),
    ...getTwigEmailTools(),
    ...getMailerDkimTools(),
    ...getOpenTelemetryTools(),
    ...getMonologChannelTools(),
    ...getPhpFiberTools(),
    ...getPhpNamedArgumentTools(),
    ...getPhpGenericAnnotationTools(),
    ...getPhpIntersectionTypeTools(),
    ...getCustomExceptionTools(),
    ...getPhpUnitCoverageTools(),
    ...getFilesystemTools(),
    ...getFinderTools(),
    ...getPropertyAccessTools(),
    ...getSerializerContextTools(),
    ...getOpcacheApcuTools(),
    ...getRedisConfigTools(),
    ...getDbalConnectionPoolTools(),
    ...getWebhookConsumerTools(),
    ...getApiSecurityExpressionTools(),
    ...getMessengerSerializerTools(),
    ...getDbalConnectionFactoryTools(),
    ...getConsoleCommandOptionTools(),
    ...getNotifierTransportTools(),
    ...getPhpNullsafeTools(),
    ...getBundleConfigTreeTools(),
    ...getFormCollectionTools(),
    ...getFormThemeTools(),
    ...getFormButtonTools(),
    ...getDoctrineMultiConnectionTools(),
    ...getDoctrineUowFlushTools(),
    ...getDoctrineEntityListenerTools(),
    ...getDoctrineSequenceTools(),
    ...getDoctrineColumnCharsetTools(),
    ...getDbalPreparedStatementTools(),
    ...getDoctrineMigrationsConfigTools(),
    ...getRememberMeTools(),
    ...getImpersonationTools(),
    ...getAccessDecisionTools(),
    ...getLoginThrottleTools(),
    ...getSecurityIpAccessTools(),
    ...getLoginLinkTools(),
    ...getPasswordUpgradeTools(),
    ...getSessionStrategyTools(),
    ...getMessengerRetryTools(),
    ...getMessengerWorkerTools(),
    ...getConsoleTableTools(),
    ...getConsoleQuestionTools(),
    ...getCacheChainTools(),
    ...getTranslationProviderTools(),
    ...getUxAutocompleteTools(),
    ...getFlashMessageTools(),
    ...getRequestStackTools(),
    ...getHttpClientEventTools(),
    ...getSemaphoreTools(),
    ...getAssetPackageTools(),
    ...getMimeTypeTools(),
    ...getSerializerEncoderTools(),
    ...getWorkflowEventTools(),
    ...getApiPlatformErrorHandlingTools(),
    ...getApiOpenApiContextTools(),
    ...getFirstClassCallableTools(),
    ...getPhpStringHelperTools(),
    ...getPhpGeneratorTools(),
    ...getPhpWeakReferenceTools(),
    ...getPhpTypedConstantTools(),
    ...getPhpPropertyHookTools(),
    ...getAsymmetricVisibilityTools(),
    ...getPhpErrorHandlingTools(),
    ...getPhpUnitAttributeTools(),
    ...getPhpUnitExtensionTools(),
    ...getTwoFactorTools(),
    ...getResponseTypeTools(),
    ...getContentNegotiationTools(),
    ...getSubrequestTools(),
    ...getFormDataClassTools(),
    ...getFormRepeatedTools(),
    ...getFormTypeGuessTools(),
    ...getFormCallbackConstraintTools(),
    ...getRoutingRequirementTools(),
    ...getRoutingLoaderTools(),
    ...getSecurityEntryPointTools(),
    ...getSecurityPostAuthTools(),
    ...getFirewallListenerTools(),
    ...getPasswordStrengthTools(),
    ...getCacheStampedeTools(),
    ...getCachePoolPruneTools(),
    ...getMessengerEnvelopeTools(),
    ...getDispatchAfterTools(),
    ...getObjectNormalizerTools(),
    ...getValidatorCascadeTools(),
    ...getValidatorGroupSequenceTools(),
    ...getPhpStanCustomRuleTools(),
    ...getRectorCustomRuleTools(),
    ...getViteTools(),
    ...getProfilerPanelTools(),
    // Phase 20 tools
    ...getValidatorExpressionTools(),
    ...getConstraintValidatorTestTools(),
    ...getDebugDumpTools(),
    ...getProfilerStorageTools(),
    ...getErrorControllerTools(),
    ...getMailerAttachmentTools(),
    ...getHttpClientMockTools(),
    ...getControllerTestTools(),
    ...getClockTestTools(),
    ...getLazyGhostTools(),
    // Phase 21 tools
    ...getPhpCovarianceTools(),
    ...getAbstractPatternTools(),
    ...getInterfaceSegregationTools(),
    ...getStaticAnalysisIgnoreTools(),
    ...getPhpMagicMethodTools(),
    ...getPhpUnitPerformanceTools(),
    ...getPhpUnitDatabaseTools(),
    ...getPhpUnitParallelTools(),
    ...getRuntimeEnvTools(),
    ...getHealthProbeTools(),
    // Phase 28 tools
    ...getPhpObjectCloningTools(),
    ...getPhpDateTimeTools(),
    ...getPhpUnitSnapshotTools(),
    ...getPhpUnitExpectExceptionTools(),
    ...getBehatStepCoverageTools(),
    ...getBehatTagTools(),
    ...getUxChartTools(),
    ...getUxNotifyTools(),
    ...getUxCropperJsTools(),
    ...getSerializerDiscriminatorTools(),
    ...getSerializerDenormalizationTools(),
    ...getDoctrineCriteriaTools(),
    ...getDoctrineEntityGraphTools(),
    ...getDoctrineChangeTrackingTools(),
    ...getDoctrineResultSetMappingTools(),
    ...getDoctrineOdmConfigTools(),
    ...getDoctrineBulkOperationTools(),
    ...getDoctrineEntityStateTools(),
    ...getHttpCacheValidationTools(),
    ...getParameterBagTools(),
    ...getMessengerSchedulerTools(),
    ...getMessengerBatchHandlerTools(),
    ...getMessengerPriorityTools(),
    ...getInMemoryTransportTools(),
    ...getResettableServiceTools(),
    ...getTaggedIteratorTools(),
    ...getCommandLockTools(),
    ...getMailerDsnConfigTools(),
    ...getDomainEventTools(),
    ...getHandleTraitTools(),
    // Phase 28 batch 2 tools
    ...getRateLimiterStorageTools(),
    ...getPasswordMigrationTools(),
    ...getKernelTerminateTools(),
    ...getAssetMapperExtTools(),
    ...getTwigTestFunctionTools(),
    ...getHttpClientAuthTools(),
    ...getExpressionLanguageExtTools(),
    ...getConsoleHelperTools(),
    ...getBrowserKitTools(),
    ...getKubernetesConfigTools(),
    // Phase 29 tools — UserChecker, UserProvider, Closures, Splat, Never, Traits, NullCoalescing, CtorPromotion, LSB, ArrayFunctions
    ...getUserCheckerTools(),
    ...getSecurityUserProviderTools(),
    ...getPhpClosureTools(),
    ...getPhpSplatTools(),
    ...getPhpNeverTypeTools(),
    ...getPhpTraitConflictTools(),
    ...getPhpNullCoalescingTools(),
    ...getPhpConstructorPromotionTools(),
    ...getPhpLateStaticBindingTools(),
    ...getPhpArrayFunctionTools(),
    // Phase 30 tools
    ...getDoctrineDqlWalkerTools(),
    ...getDbalEventListenerTools(),
    ...getDoctrineEntityProxyTools(),
    ...getDoctrineAssociationFetchTools(),
    ...getDbalBulkInsertTools(),
    ...getDoctrineShardingTools(),
    ...getDbalSchemaDiffTools(),
    ...getPhpUnitCustomAssertionTools(),
    ...getPhpUnitTestDoubleTools(),
    ...getInfectionMutantTools(),
    // Phase 31 tools
    ...getPhpSplDataStructureTools(),
    ...getPhpImmutableValueObjectTools(),
    ...getPhpTypeCoercionTools(),
    ...getPhpStaticMethodTools(),
    ...getPhpClosureScopeTools(),
    ...getPhpContractTestTools(),
    ...getConsoleEventTools(),
    ...getServerSentEventTools(),
    ...getSecurityAccessTokenTools(),
    ...getSecurityOidcTools(),
    // Phase 32 tools
    ...getSymfonyTypeInfoTools(),
    ...getSymfonyJsonEncoderTools(),
    ...getSymfonyTwigSecurityTools(),
    ...getSymfonyMonologHandlerTools(),
    ...getSymfonyMonologFormatterTools(),
    ...getTwigFormRenderingTools(),
    ...getSymfonyTwigUxIconTools(),
    ...getSymfonyDebugVarDumperTools(),
    ...getSymfonySchedulerTaskTools(),
    ...getSymfonyRateLimiterPolicyTools(),
    // Phase 33 tools
    ...getSymfonyCacheEarlyExpiryTools(),
    ...getSymfonyMessengerTransportDsnTools(),
    ...getSymfonyFormChoiceValueTools(),
    // Phase 34 tools
    ...getSymfonyUxReactTools(),
    ...getSymfonyUxVueTools(),
    ...getSymfonyUxSvelteTools(),
    ...getSymfonyUxMapTools(),
    ...getDoctrineOrmProfilingTools(),
    ...getSymfonyMimeMessageHeaderTools(),
    ...getDoctrineEntityLockTools(),
    // Phase 35 tools
    ...getPhpReadonlyClassTools(),
    ...getPhpNamedConstructorTools(),
    ...getPhpStreamWrapperTools(),
    ...getPhpReflectionApiTools(),
    ...getFormDataMapperTools(),
    ...getControllerMapPayloadTools(),
    ...getStringInflectorTools(),
    ...getSymfonySerializerNameConverterTools(),
    ...getSymfonySerializerMaxDepthTools(),
    ...getSymfonySerializerTransformTools(),
    // Phase 31 new tools
    ...getPhpCognitiveComplexityTools(),
    ...getPhpCopyPasteTools(),
    ...getPhpPreloadingTools(),
    ...getPhpIniTools(),
    ...getPhpFpmTools(),
    ...getPhpGcTools(),
    ...getPhpMetricsTools(),
    ...getPhpmdTools(),
    ...getPhpbenchTools(),
    ...getGrumphpTools(),
    ...getSymfonyCqrsTools(),
    ...getSymfonyEventSourcingTools(),
    ...getSymfonyOutboxTools(),
    ...getSymfonyRemoteEventTools(),
    ...getSymfonyEmojiUsageTools(),
    ...getSymfonyIntlTools(),
    ...getSymfonyPsrBridgeTools(),
    ...getSymfonyLocaleSwitcherTools(),
    ...getSymfonyStringEncodingTools(),
    ...getSymfonyCacheInvalidationTools(),
    ...getSymfonyCachePsr16Tools(),
    ...getSymfonyValidatorPayloadTools(),
    ...getSymfonyKernelBootTools(),
    ...getSymfonyMailerInlinerTools(),
    ...getSymfonyMessengerGracefulShutdownTools(),
    ...getSymfonyFormAjaxTools(),
    ...getSymfonyStringNormalizationTools(),
    ...getSymfonyUxStimulusControllerTools(),
    ...getDoctrineUpsertTools(),
    ...getDoctrineTemporalTools(),
    ...getDoctrineEncryptionTools(),
    ...getDoctrinePostgresTools(),
    ...getDoctrineMysqlTools(),
    ...getDoctrineConnectionRetryTools(),
    ...getDoctrineHydrationTools(),
    ...getDoctrineDbalQueryProfilingTools(),
    ...getApiProblemDetailsTools(),
    ...getApiJsonLdContextTools(),
    ...getApiIdempotencyTools(),
    ...getApiOpenApiSecuritySchemesTools(),
    ...getPwaManifestTools(),
    ...getSymfonyAssetIntegrityTools(),
    ...getSymfonyTwigProfilingTools(),
    ...getSymfonyRoadrunnerTools(),
    ...getPrometheusMetricsTools(),
    ...getDatadogIntegrationTools(),
    ...getNginxPhpFpmTools(),
    ...getComposerSecurityAuditTools(),
    ...getSymfonyWebhookSecurityTools(),
    ...getSymfonySecretsRotationTools(),
    ...getPhpJitConfigTools(),
    ...getPhpFfiTools(),
    ...getPhpSodiumCryptoTools(),
    ...getPhpPcreSecurityTools(),
    ...getPhpRandomSecurityTools(),
    ...getPhpMemoryManagementTools(),
    ...getPhpDeprecationPolyfillTools(),
    ...getSymfonyLdapAuthTools(),
    ...getSymfonyTurboStreamsTools(),
    ...getSymfonyHttpClientCachingTools(),
    ...getSymfonyMessengerCircuitBreakerTools(),
    ...getSymfonyMessengerSagasTools(),
    ...getSymfonyNotifierSmsTools(),
    ...getSymfonyNotifierPushTools(),
    ...getSymfonyUxTypedTools(),
    ...getSymfonyUxTranslatorTools(),
    ...getSymfonyTranslationCacheTools(),
    ...getSymfonyMultiLanguageRoutingTools(),
    ...getSymfonyMailerQueuingTools(),
    ...getSymfonySignedUrlTools(),
    ...getSymfonyFormHoneypotTools(),
    ...getDoctrineVersionedEntitiesTools(),
    ...getDoctrineReadReplicaTools(),
    ...getDoctrineRawSqlTools(),
    ...getDoctrineEntityManagerScopeTools(),
    ...getVarnishConfigTools(),
    ...getCdnConfigTools(),
    ...getDockerComposeHealthTools(),
    ...getRedisStreamsConfigTools(),
    ...getRabbitmqConfigTools(),
    ...getKafkaIntegrationTools(),
    ...getSonarqubeConfigTools(),
    ...getSqsMessengerConfigTools(),
    ...getHtmxIntegrationTools(),
    ...getAlpineJsIntegrationTools(),
    ...getApiHateoasTools(),
    ...getStripeIntegrationTools(),
    ...getSamlAuthTools(),
    ...getGrpcIntegrationTools(),
    ...getApiCursorPaginationTools(),
    ...getElasticsearchMappingConfigTools(),
    ...getGdprComplianceTools(),
    ...getPhpOpensslPatternsTools(),
    ...getSecurityAuditLogTools(),
    ...getApiKeyRotationTools(),
    ...getPdfGenerationTools(),
    ...getImageProcessingTools(),
    ...getExcelGenerationTools(),
    ...getFileArchiveTools(),
    ...getNewRelicIntegrationTools(),
    // Phase 33 tools
    ...getPhpCurlSecurityTools(),
    ...getPhpXmlSecurityTools(),
    ...getPhpLdapFunctionTools(),
    ...getPhpHtml5ParserTools(),
    ...getPhpSessionSecurityTools(),
    ...getPhpOpcacheSettingTools(),
    ...getPhpTypeJugglingTools(),
    ...getPhpStringInterpolationSecurityTools(),
    ...getPhpMemoryProfilingTools(),
    ...getPhpCodesnifferConfigTools(),
    ...getSymfonyDeprecationTools(),
    ...getSymfonyLiveComponentSecurityTools(),
    ...getSymfonyChatNotifierTools(),
    ...getSymfonyCacheRedisClusterTools(),
    ...getSymfonySecurityBruteforceTools(),
    ...getSymfonyMessengerMonitoringTools(),
    ...getSymfonyDiConditionalServiceTools(),
    ...getSymfonyMailerBounceHandlingTools(),
    ...getSymfonyUxTurboFrameTools(),
    ...getSymfonyHealthEndpointSecurityTools(),
    ...getSymfonyWorkflowPersistenceTools(),
    ...getSymfonyRoutingConflictTools(),
    ...getApiJsonApiFormatTools(),
    ...getApiGraphqlSecurityTools(),
    ...getApiResponseCompressionTools(),
    ...getApiContractTestingTools(),
    ...getDoctrineColumnDefaultTools(),
    ...getDoctrineFullTextSearchTools(),
    ...getPgBouncerConfigTools(),
    ...getMemcachedIntegrationTools(),
    ...getApacheConfigTools(),
    ...getFrankenPhpConfigTools(),
    ...getSwooleOpenSwooleTools(),
    ...getAwsLambdaBrefTools(),
    ...getGithubActionsConfigTools(),
    ...getGitlabCiConfigTools(),
    ...getGrafanaDashboardTools(),
    ...getCloudwatchIntegrationTools(),
    ...getDockerSecurityConfigTools(),
    ...getWebsocketIntegrationTools(),
    ...getDeptracConfigTools(),
    ...getPhpArkitectConfigTools(),
    ...getPantherTestingTools(),
    ...getZenstruckFoundryConfigTools(),
    ...getPhpspecConfigTools(),
    ...getCodeceptionConfigTools(),
    ...getMeilisearchIntegrationTools(),
    ...getWebAuthnIntegrationTools(),
    ...getPaypalIntegrationTools(),
    ...getEasyCodingStandardTools(),
    // Phase 34 tools
    ...getPhpXdebugConfigTools(),
    ...getPhpComposerAutoloadOptimizeTools(),
    ...getPhpIntlPatternsTools(),
    ...getPhpSoapPatternsTools(),
    ...getPhpZipArchiveTools(),
    ...getPhpMbstringPatternsTools(),
    ...getPhpObjectSerializationTools(),
    ...getPhpBacktraceDebugTools(),
    ...getPhpUuidGenerationTools(),
    ...getPhpWeakMapTools(),
    ...getSymfonyEsiConfigTools(),
    ...getSymfonyHttp2PushTools(),
    ...getSymfonyCacheRedisSentinelTools(),
    ...getSymfonyWorkflowStateMachineTools(),
    ...getSymfonyTwigCacheConfigTools(),
    ...getSymfonyConsoleDaemonTools(),
    ...getSymfonyTranslationExtractorsTools(),
    ...getSymfonyMessengerCompetingConsumersTools(),
    ...getSymfonyAssetPreloadHintsTools(),
    ...getSymfonyFormCompoundTypesTools(),
    ...getSymfonySerializerCircularReferenceTools(),
    ...getSymfonyDataPipelinePatternsTools(),
    ...getSymfonyConsoleProgressBarTools(),
    ...getSymfonyHttpClientConcurrentTools(),
    ...getSymfonyDoctrineMetadataCacheTools(),
    ...getSymfonySonataAdminTools(),
    ...getSymfonyEnlightenAnalysisTools(),
    ...getSymfonyDoctrineMigrationRollbackTools(),
    ...getSymfonyRateLimiterAlgorithmsTools(),
    ...getSymfonyMessengerPauseResumeTools(),
    ...getCaddyServerConfigTools(),
    ...getFlyIoConfigTools(),
    ...getHerokuConfigTools(),
    ...getCircleCiConfigTools(),
    ...getJenkinsConfigTools(),
    ...getTerraformConfigTools(),
    ...getHelmChartsConfigTools(),
    ...getCloudflareConfigTools(),
    ...getAwsEcsConfigTools(),
    ...getAzurePipelinesConfigTools(),
    ...getTwilioIntegrationTools(),
    ...getSendgridIntegrationTools(),
    ...getAwsS3IntegrationTools(),
    ...getAlgoliaIntegrationTools(),
    ...getBugsnagIntegrationTools(),
    ...getOpenAiIntegrationTools(),
    ...getSlackWebhookIntegrationTools(),
    ...getOwaspDependencyCheckTools(),
    ...getVaultIntegrationTools(),
    ...getRabbitmqManagementApiTools(),
    // Phase 35 tools
    ...getPhpPdoPatternsTools(),
    ...getPhpTypeNarrowingTools(),
    ...getPhpHeredocNowdocTools(),
    ...getPhpFileInclusionSecurityTools(),
    ...getSymfonyLockStoreConfigTools(),
    ...getSymfonyHttpCacheStoreTools(),
    ...getSymfonyTranslationYamlLintTools(),
    ...getSymfonySerializerContextBuilderTools(),
    ...getSymfonyPermissionsPolicyTools(),
    ...getSymfonySchedulerTransportConfigTools(),
    ...getSymfonyDoctrineSqlLoggerTools(),
    ...getBitbucketPipelinesConfigTools(),
    ...getDigitalOceanAppPlatformTools(),
    ...getRenderDeployConfigTools(),
    ...getGoogleCloudRunConfigTools(),
    ...getFirebaseIntegrationTools(),
    ...getMailgunIntegrationTools(),
    ...getBraintreeIntegrationTools(),
    ...getGithubApiIntegrationTools(),
    ...getShopifyIntegrationTools(),
    // Phase 36
    ...getPhpJsonEncodeFlagsTools(),
    ...getPhpSprintfTypeSafetyTools(),
    ...getPhpDateTimezoneTools(),
    ...getPhpGdSecurityTools(),
    ...getPhpImapPatternsTools(),
    ...getSymfonyMessengerRoutingTableTools(),
    ...getSymfonyCacheNamespaceTools(),
    ...getSymfonyValidatorAutoMappingTools(),
    ...getSymfonyContainerCompileTools(),
    ...getDoctrineCustomPlatformTools(),
    ...getAwsSesIntegrationTools(),
    ...getPusherIntegrationTools(),
    ...getCloudinaryIntegrationTools(),
    ...getHubspotIntegrationTools(),
    ...getNetlifyDeployConfigTools(),
    ...getVercelDeployConfigTools(),
    ...getPhpBenchmarkPatternsTools(),
    ...getPhpFtpSftpPatternsTools(),
    ...getNewrelicPhpAgentTools(),
    ...getPhpCsvParsingTools(),
    // Phase 37
    ...getPhpCommandInjectionTools(),
    ...getPhpSsrfPatternsTools(),
    ...getPhpOpenRedirectTools(),
    ...getPhpXssPatternsTools(),
    ...getPhpTimingAttackTools(),
    ...getPhpOutputBufferingTools(),
    ...getPhpBcmathPatternsTools(),
    ...getPhpDomXpathTools(),
    ...getPhpSignalHandlingTools(),
    ...getPhpXslTransformationTools(),
    ...getPhpParallelExtensionTools(),
    ...getPhpLazyObjectsTools(),
    ...getPhpArrayUnpackingTools(),
    ...getPhpBackedEnumPatternsTools(),
    ...getPhpFileLockingTools(),
    ...getSymfonyFormTypeGuesserTools(),
    ...getSymfonyValidatorSequenceProviderTools(),
    ...getSymfonyMonologRotationTools(),
    ...getSymfonyJsonLoginTools(),
    ...getSymfonyHttpMiddlewareTools(),
    ...getSymfonyUxStimulusValuesTools(),
    ...getSymfonyNotifierStatusTools(),
    ...getFosRestBundleTools(),
    ...getNelmioSecurityBundleTools(),
    ...getDoctrineGedmoTreeTools(),
    ...getDoctrineGedmoTranslatableTools(),
    ...getDoctrineGedmoSluggableTools(),
    ...getDoctrineGedmoBlameableTools(),
    ...getDockerSwarmConfigTools(),
    ...getKubernetesManifestsTools(),
    ...getLokiLogConfigTools(),
    ...getNginxUnitConfigTools(),
    ...getOauth2ServerConfigTools(),
    ...getRedisPubsubPatternsTools(),
    ...getKafkaSchemaRegistryTools(),
    ...getSqsDlqConfigTools(),
    ...getStripeBillingSubscriptionsTools(),
    ...getPaypalCheckoutV2Tools(),
    ...getGoogleOauthIntegrationTools(),
    ...getMicrosoftGraphIntegrationTools(),
    ...getAwsCognitoIntegrationTools(),
    ...getAwsCloudfrontConfigTools(),
    ...getSentryPerformanceTracingTools(),
    ...getDatadogCustomMetricsTools(),
    ...getElasticApmPhpTools(),
    ...getLeagueOauth2ClientTools(),
    ...getPhpunitTestIsolationTools(),
    ...getPhpunitTestNamingTools(),
    ...getPhpRectorUpgradeSetsTools(),
    ...getPhpDateIntervalTools(),
    // Phase 38
    ...getPhpDeserializationGadgetTools(),
    ...getPhpFileUploadValidationTools(),
    ...getPhpNullByteInjectionTools(),
    ...getPhpRegexInjectionTools(),
    ...getPhpHashAlgorithmSecurityTools(),
    ...getPhpSocketProgrammingTools(),
    ...getPhpShmopIpcTools(),
    ...getPhpPosixFunctionsTools(),
    ...getPhpConstantVisibilityTools(),
    ...getPhpDnfTypesTools(),
    ...getPhpResourceHandleLeaksTools(),
    ...getPhpIntegerOverflowTools(),
    ...getPhpTemplateInjectionTools(),
    ...getPhpObjectInjectionTools(),
    ...getPhpArrayFindFunctionsTools(),
    ...getSymfonyTwigEmbedTools(),
    ...getSymfonyValidatorUniqueEntityTools(),
    ...getSymfonyFormPreSetDataTools(),
    ...getSymfonyVarDumperCastersTools(),
    ...getSymfonyTestHttpKernelTools(),
    ...getSymfonyWorkflowParallelTransitionsTools(),
    ...getSymfonyMailerHtmlToTextTools(),
    ...getSymfonyConsoleHiddenCommandsTools(),
    ...getSymfonyRoutingSubCollectionsTools(),
    ...getSymfonySecurityCustomVoterTools(),
    ...getSymfonyMailerSmtpFallbackTools(),
    ...getSymfonyTranslationLintAllTools(),
    ...getSymfonyCachePsr6AdaptersTools(),
    ...getDoctrineDbalDriveroptionsTools(),
    ...getDoctrineCompositePrimaryKeysTools(),
    ...getTraefikConfigTools(),
    ...getAnsiblePlaybookConfigTools(),
    ...getPrometheusAlertingRulesTools(),
    ...getVaultDynamicSecretsTools(),
    ...getConsulServiceDiscoveryTools(),
    ...getGithubDependabotConfigTools(),
    ...getAwsParameterStoreTools(),
    ...getAwsSecretsManagerTools(),
    ...getGoogleCloudStorageTools(),
    ...getAzureBlobStorageTools(),
    ...getMongodbIntegrationTools(),
    ...getElasticsearchPercolateTools(),
    ...getSegmentAnalyticsTools(),
    ...getZendeskIntegrationTools(),
    ...getSqsFifoQueuesTools(),
    ...getIntercomIntegrationTools(),
    ...getPhpunitClockAssertionTools(),
    ...getPhpunitSelfShuntingTools(),
    ...getCypressE2eConfigTools(),
    ...getPlaywrightE2eConfigTools(),
  ];

  // Initialise registry once — assigns categories and builds the search index
  toolRegistry.init(allTools);

  const dynamicMode = process.env['SYMFONY_MCP_DYNAMIC_TOOLS'] !== 'false';

  // Published in the initialize response. Without it a client sees five tools
  // and no way to know the other ~1,670 exist: in dynamic mode tools/list
  // deliberately advertises only the discovery meta-tools until a category is
  // activated, which is invisible unless the server says so.
  const instructions = [
    `Read-only introspection for a Symfony application: ${allTools.length} tools across`,
    `${Object.keys(CATEGORY_DESCRIPTIONS).length} categories (routes, controllers, services, entities, Doctrine,`,
    'migrations, events, forms, security, Messenger, Twig, API Platform, testing,',
    'infrastructure and third-party integrations).',
    '',
    dynamicMode
      ? [
          'Tools are discovered progressively. tools/list starts with five meta-tools only;',
          'the rest become callable once you activate the categories you need, which keeps',
          `the advertised schema inside a ${String(getTokenBudget()).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}-token budget.`,
          '',
          'Start with list_tool_categories to see what exists, or search_tools with a task',
          'description to find the right one. Then activate_category to make a category',
          'callable, get_active_tools to see what is currently exposed, and',
          'deactivate_category to free budget. Set SYMFONY_MCP_DYNAMIC_TOOLS=false to',
          'advertise every tool at once instead.',
        ].join('\n')
      : 'Every tool is advertised up front (SYMFONY_MCP_DYNAMIC_TOOLS=false).',
    '',
    'Every tool takes an app_path pointing at the root of the Symfony application.',
    'Nothing is executed and nothing is written: the tools parse files and',
    'configuration only, and results are scanned for credentials before they are',
    'returned.',
  ].join('\n');

  const server = new Server(
    { name: 'symfony-agent-mcp', version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions }
  );

  const toolHandlers = buildToolHandlers();


  // M. Rate-limit + anomaly-detect tools/list to prevent tool enumeration / scanning
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const listAnomaly = checkAnomaly('tools/list', '');
    if (listAnomaly?.blocked) {
      throw new Error(`Request blocked: anomaly detected (${listAnomaly.type})`);
    }
    const listRate = checkRateLimit('tools/list');
    if (!listRate.allowed) {
      const retryAfter = Math.ceil((listRate.retryAfterMs ?? listRate.resetInMs) / 1000);
      throw new Error(`Rate limit exceeded for tools/list. Try again in ${retryAfter}s.`);
    }

    if (dynamicMode) {
      // Dynamic mode: expose only discovery meta-tools + session-active tools
      const sessionId = resolveSessionId(
        (request.params as Record<string, unknown>)?.['_meta'] as Record<string, unknown> | undefined
      );
      const discoveryTools = getToolDiscoveryTools();
      const sessionTools = sessionStore.getActiveTools(sessionId);
      // Cast to a common base type so filterAllowedTools generic resolves cleanly
      const exposed = [...discoveryTools, ...sessionTools] as Array<{ name: string }>;
      return { tools: filterAllowedTools(exposed) };
    }

    // H. Filter tools by access control before advertising them to the client
    return { tools: filterAllowedTools(allTools) };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<any> => {
    const { name, arguments: args = {} } = request.params;
    const handler = toolHandlers.get(name);

    if (!handler) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      return await executeWithSecurity(name, args as Record<string, unknown>, handler);
    } catch (error) {
      // F. Sanitize error messages before they leave the server — strip paths and stack traces
      const raw = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Tool error: ${sanitizeErrorMessage(raw)}` }],
        isError: true,
      };
    }
  });

  // HTTP/SSE transport (optional — activated by SYMFONY_MCP_HTTP_PORT)
  const httpServer = await startHttpTransport(server);

  // Stdio transport (default — always started unless HTTP-only mode is wanted)
  if (!httpServer || process.env['SYMFONY_MCP_STDIO'] !== 'false') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  const auditPath = getAuditLogPath();
  const auditInfo = auditPath ? `audit → ${auditPath}` : 'audit → stderr only';
  const tokenStatus = getTokenStatus();
  const tokenInfo = tokenStatus.enabled ? `session-tokens=on (${tokenStatus.windowSeconds}s window)` : 'session-tokens=off';

  const toolsInfo = dynamicMode
    ? `${allTools.length} tools (dynamic discovery — default: 5 meta-tools visible)`
    : `${allTools.length} tools (static mode — all exposed)`;

  console.error(
    `[symfony-agent-mcp] Server started (v${SERVER_VERSION}) — ${toolsInfo} | ` +
    `${auditInfo} | ${tokenInfo}` +
    (httpServer ? ' | http=on' : ' | transport=stdio')
  );
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
