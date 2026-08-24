<?php

/**
 * A catalogue of Symfony and PHP API usage, for the tool test-suite.
 *
 * The analysers under src/tools/ look for specific symbols in application
 * source. The realistic fixtures cover what an application normally holds;
 * this covers the symbols no single application would happen to use, so that
 * their parsing runs too.
 *
 * The list is extracted from the modules themselves — every literal they
 * search for — not guessed, with anything credential-shaped filtered out.
 * It is a fixture: plausible, not runnable, and never executed.
 */

namespace App\Reference;

use Doctrine\\ORM\\Mapping;
use FormInterface;
use FOS\\RestBundle\\;
use Gedmo\\Tree\\;
use HandleTrait;
use LockableTrait;
use MatchesSnapshots;
use Nelmio\\;
use OpenApi\\;
use Stof\\DoctrineExtensionsBundle\\;
use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\Notifier\\;
use Symfony\\Component\\Serializer\\Annotation\\Context;
use Symfony\\Component\\Serializer\\Attribute\\Context;
use Symfony\\Component\\Validator;
use Symfony\\Component\\Validator\\Constraints;
use Symfony\\Contracts\\Cache;
use Symfony\\UX\\LiveComponent;
use Timestampable;

#[ApiFilter]
class AttrApiFilter {}
#[ApiProperty]
class AttrApiProperty {}
#[ApiResource]
class AttrApiResource {}
#[AsAlias]
class AttrAsAlias {}
#[AsController]
class AttrAsController {}
#[AsDecorator]
class AttrAsDecorator {}
#[AsDoctrineListener]
class AttrAsDoctrineListener {}
#[AsEntityAutocompleteField]
class AttrAsEntityAutocompleteField {}
#[AsEntityListener]
class AttrAsEntityListener {}
#[AsEventListener]
class AttrAsEventListener {}
#[AsKernelListener]
class AttrAsKernelListener {}
#[AsMessageHandler]
class AttrAsMessageHandler {}
#[AsMonologProcessor]
class AttrAsMonologProcessor {}
#[AsProjector]
class AttrAsProjector {}
#[AsRemoteEventConsumer]
class AttrAsRemoteEventConsumer {}
#[Assert\\All]
class AttrAssertAll {}
#[Assert\\Valid]
class AttrAssertValid {}
#[AsService]
class AttrAsService {}
#[AsTaggedItem]
class AttrAsTaggedItem {}
#[AsTwigComponent]
class AttrAsTwigComponent {}
#[AsTwigTest]
class AttrAsTwigTest {}
#[AsVoter]
class AttrAsVoter {}
#[AsWebhook]
class AttrAsWebhook {}
#[AsWebhookConsumer]
class AttrAsWebhookConsumer {}
#[Attribute]
class AttrAttribute {}
#[Autowire]
class AttrAutowire {}
#[AutowireIterator]
class AttrAutowireIterator {}
#[AutowireLocator]
class AttrAutowireLocator {}
#[BackupStaticProperties]
class AttrBackupStaticProperties {}
#[Broadcast]
class AttrBroadcast {}
#[CoversClass]
class AttrCoversClass {}
#[CoversFunction]
class AttrCoversFunction {}
#[DoctrineEncrypt\\Annotation\\Encrypted]
class AttrDoctrineEncryptAnnotationEncrypted {}
#[Doctrine\\ORM\\]
class AttrDoctrineORM {}
#[Document]
class AttrDocument {}
#[Embeddable]
class AttrEmbeddable {}
#[Embedded]
class AttrEmbedded {}
#[EmbeddedDocument]
class AttrEmbeddedDocument {}
#[EmbedMany]
class AttrEmbedMany {}
#[EmbedOne]
class AttrEmbedOne {}
#[EncodedName]
class AttrEncodedName {}
#[Encrypted]
class AttrEncrypted {}
#[FFI\\Attr]
class AttrFFIAttr {}
#[File]
class AttrFile {}
#[Gedmo\\Locale]
class AttrGedmoLocale {}
#[Gedmo\\SlugHandler]
class AttrGedmoSlugHandler {}
#[Gedmo\\Tree]
class AttrGedmoTree {}
#[GQL\\]
class AttrGQL {}
#[GQL\\Mutation]
class AttrGQLMutation {}
#[GQL\\Query]
class AttrGQLQuery {}
#[Groups]
class AttrGroups {}
#[GroupSequenceProvider]
class AttrGroupSequenceProvider {}
#[Id]
class AttrId {}
#[Ignore]
class AttrIgnore {}
#[Indexes]
class AttrIndexes {}
#[IsGranted]
class AttrIsGranted {}
#[LiveAction]
class AttrLiveAction {}
#[Map]
class AttrMap {}
#[MapFrom]
class AttrMapFrom {}
#[MappedSuperclass]
class AttrMappedSuperclass {}
#[MapQueryParameter]
class AttrMapQueryParameter {}
#[MapQueryString]
class AttrMapQueryString {}
#[MapRequestPayload]
class AttrMapRequestPayload {}
#[MapTo]
class AttrMapTo {}
#[OA\\Operation]
class AttrOAOperation {}
#[OA\\Property]
class AttrOAProperty {}
#[OA\\RequestBody]
class AttrOARequestBody {}
#[OA\\Schema]
class AttrOASchema {}
#[OA\\Security]
class AttrOASecurity {}
#[OrderBy]
class AttrOrderBy {}
#[ORM\\Cache]
class AttrORMCache {}
#[ORM\\Entity]
class AttrORMEntity {}
#[ORM\\ManyToOne]
class AttrORMManyToOne {}
#[ORM\\MappedSuperclass]
class AttrORMMappedSuperclass {}
#[ORM\\OneToMany]
class AttrORMOneToMany {}
#[ORM\\OrderBy]
class AttrORMOrderBy {}
#[ORM\\Version]
class AttrORMVersion {}
#[PostHydrate]
class AttrPostHydrate {}
#[PostMount]
class AttrPostMount {}
#[PreDehydrate]
class AttrPreDehydrate {}

interface Marker {}

abstract class ImplAccessDecisionManagerInterface implements AccessDecisionManagerInterface {}
abstract class ImplAuthenticationEntryPointInterface implements AuthenticationEntryPointInterface {}
abstract class ImplAuthenticationSuccessHandlerInterface implements AuthenticationSuccessHandlerInterface {}
abstract class ImplAuthenticatorInterface implements AuthenticatorInterface {}
abstract class ImplBadgeInterface implements BadgeInterface {}
abstract class ImplBatchHandlerInterface implements BatchHandlerInterface {}
abstract class ImplBatchInterface implements BatchInterface {}
abstract class ImplCacheInterface implements CacheInterface {}
abstract class ImplCacheItemInterface implements CacheItemInterface {}
abstract class ImplCacheItemPoolInterface implements CacheItemPoolInterface {}
abstract class ImplCacheWarmerInterface implements CacheWarmerInterface {}
abstract class ImplChartBuilderInterface implements ChartBuilderInterface {}
abstract class ImplChoiceLoaderInterface implements ChoiceLoaderInterface {}
abstract class ImplClassDiscriminatorResolverInterface implements ClassDiscriminatorResolverInterface {}
abstract class ImplClockInterface implements ClockInterface {}
abstract class ImplCommandBusInterface implements CommandBusInterface {}
abstract class ImplCommandInterface implements CommandInterface {}
abstract class ImplCompilerPassInterface implements CompilerPassInterface {}
abstract class ImplConfigurationInterface implements ConfigurationInterface {}
abstract class ImplConstraintValidatorInterface implements ConstraintValidatorInterface {}
abstract class ImplContainerAwareInterface implements ContainerAwareInterface {}
abstract class ImplContainerInterface implements ContainerInterface {}
abstract class ImplContextBuilderInterface implements ContextBuilderInterface {}
abstract class ImplContextInterface implements ContextInterface {}
abstract class ImplControllerInterface implements ControllerInterface {}
abstract class ImplCustomStopExceptionInterface implements CustomStopExceptionInterface {}
abstract class ImplDataCollectorInterface implements DataCollectorInterface {}
abstract class ImplDataPersisterInterface implements DataPersisterInterface {}
abstract class ImplDataProviderInterface implements DataProviderInterface {}
abstract class ImplDataTransformerInterface implements DataTransformerInterface {}
abstract class ImplDateTimeInterface implements DateTimeInterface {}
abstract class ImplDecoderInterface implements DecoderInterface {}
abstract class ImplDenormalizableInterface implements DenormalizableInterface {}
abstract class ImplDenormalizerAwareInterface implements DenormalizerAwareInterface {}
abstract class ImplDenormalizerInterface implements DenormalizerInterface {}
abstract class ImplDispatcherInterface implements DispatcherInterface {}
abstract class ImplDomainEventInterface implements DomainEventInterface {}
abstract class ImplDriverManagerInterface implements DriverManagerInterface {}
abstract class ImplEncoderInterface implements EncoderInterface {}
abstract class ImplEntityManagerInterface implements EntityManagerInterface {}
abstract class ImplEnvVarProcessorInterface implements EnvVarProcessorInterface {}
abstract class ImplErrorNormalizerInterface implements ErrorNormalizerInterface {}
abstract class ImplErrorRendererInterface implements ErrorRendererInterface {}
abstract class ImplEventBusInterface implements EventBusInterface {}
abstract class ImplEventDispatcherInterface implements EventDispatcherInterface {}
abstract class ImplEventListenerInterface implements EventListenerInterface {}
abstract class ImplEventStoreInterface implements EventStoreInterface {}
abstract class ImplEventSubscriberInterface implements EventSubscriberInterface {}
abstract class ImplExceptionMapperInterface implements ExceptionMapperInterface {}
abstract class ImplExpressionFunctionProviderInterface implements ExpressionFunctionProviderInterface {}
abstract class ImplExtensionInterface implements ExtensionInterface {}
abstract class ImplFilterInterface implements FilterInterface {}
abstract class ImplFinderInterface implements FinderInterface {}
abstract class ImplFixtureInterface implements FixtureInterface {}
abstract class ImplFormBuilderInterface implements FormBuilderInterface {}
abstract class ImplFormInterface implements FormInterface {}
abstract class ImplFormTypeExtensionInterface implements FormTypeExtensionInterface {}
abstract class ImplFormTypeGuesserInterface implements FormTypeGuesserInterface {}
abstract class ImplFormTypeInterface implements FormTypeInterface {}
abstract class ImplGhostObjectInterface implements GhostObjectInterface {}
abstract class ImplGroupSequenceProviderInterface implements GroupSequenceProviderInterface {}
abstract class ImplHealthIndicatorInterface implements HealthIndicatorInterface {}
abstract class ImplHelperInterface implements HelperInterface {}
abstract class ImplHtmlSanitizerInterface implements HtmlSanitizerInterface {}
abstract class ImplHttpClientInterface implements HttpClientInterface {}
abstract class ImplHttpExceptionInterface implements HttpExceptionInterface {}
abstract class ImplHttpFoundationFactoryInterface implements HttpFoundationFactoryInterface {}
abstract class ImplHttpKernelInterface implements HttpKernelInterface {}
abstract class ImplHttpMessageFactoryInterface implements HttpMessageFactoryInterface {}
abstract class ImplHubInterface implements HubInterface {}
abstract class ImplInflectorInterface implements InflectorInterface {}
abstract class ImplIriConverterInterface implements IriConverterInterface {}
abstract class ImplItemInterface implements ItemInterface {}
abstract class ImplLoaderInterface implements LoaderInterface {}
abstract class ImplLocaleSwitcherInterface implements LocaleSwitcherInterface {}
abstract class ImplLockInterface implements LockInterface {}
abstract class ImplLoggerInterface implements LoggerInterface {}
abstract class ImplLoginLinkHandlerInterface implements LoginLinkHandlerInterface {}
abstract class ImplMailerInterface implements MailerInterface {}
abstract class ImplMakerInterface implements MakerInterface {}
abstract class ImplMapperInterface implements MapperInterface {}
abstract class ImplMessageBusInterface implements MessageBusInterface {}
abstract class ImplMessageHandlerInterface implements MessageHandlerInterface {}
abstract class ImplMessageSerializerInterface implements MessageSerializerInterface {}
abstract class ImplMessengerInterface implements MessengerInterface {}
abstract class ImplMiddlewareInterface implements MiddlewareInterface {}
abstract class ImplMimeTypeGuesserInterface implements MimeTypeGuesserInterface {}
abstract class ImplMutationInterface implements MutationInterface {}
abstract class ImplNonSendableStampInterface implements NonSendableStampInterface {}
abstract class ImplNormalizerAwareInterface implements NormalizerAwareInterface {}
abstract class ImplNormalizerInterface implements NormalizerInterface {}
abstract class ImplNotificationInterface implements NotificationInterface {}
abstract class ImplOpenApiFactoryInterface implements OpenApiFactoryInterface {}
abstract class ImplOutputDataTransformerInterface implements OutputDataTransformerInterface {}
abstract class ImplOutputInterface implements OutputInterface {}
abstract class ImplPaginatorInterface implements PaginatorInterface {}
abstract class ImplParamConverterInterface implements ParamConverterInterface {}
abstract class ImplPartialPaginatorInterface implements PartialPaginatorInterface {}
abstract class ImplPassportInterface implements PassportInterface {}
abstract class ImplPrependExtensionInterface implements PrependExtensionInterface {}
abstract class ImplProcessorInterface implements ProcessorInterface {}
abstract class ImplProjectorInterface implements ProjectorInterface {}
abstract class ImplProviderInterface implements ProviderInterface {}
abstract class ImplPruneableInterface implements PruneableInterface {}
abstract class ImplQueryBusInterface implements QueryBusInterface {}
abstract class ImplQueryCollectionExtensionInterface implements QueryCollectionExtensionInterface {}
abstract class ImplQueryInterface implements QueryInterface {}
abstract class ImplQueryItemExtensionInterface implements QueryItemExtensionInterface {}
abstract class ImplRectorInterface implements RectorInterface {}
abstract class ImplRememberMeHandlerInterface implements RememberMeHandlerInterface {}
abstract class ImplRemoteEventConsumerInterface implements RemoteEventConsumerInterface {}
abstract class ImplRepositoryInterface implements RepositoryInterface {}
abstract class ImplRequestFactoryInterface implements RequestFactoryInterface {}
abstract class ImplRequestHandlerInterface implements RequestHandlerInterface {}
abstract class ImplRequestParserInterface implements RequestParserInterface {}
abstract class ImplResettableInterface implements ResettableInterface {}
abstract class ImplResolverInterface implements ResolverInterface {}
abstract class ImplResponseFactoryInterface implements ResponseFactoryInterface {}
abstract class ImplResponseInterface implements ResponseInterface {}
abstract class ImplRestrictedDataProviderInterface implements RestrictedDataProviderInterface {}
abstract class ImplRetryStrategyInterface implements RetryStrategyInterface {}
abstract class ImplRunnerInterface implements RunnerInterface {}
abstract class ImplRuntimeExtensionInterface implements RuntimeExtensionInterface {}
abstract class ImplRuntimeInterface implements RuntimeInterface {}
abstract class ImplScheduleProviderInterface implements ScheduleProviderInterface {}
abstract class ImplSearchableInterface implements SearchableInterface {}
abstract class ImplSemaphoreInterface implements SemaphoreInterface {}
abstract class ImplSentMessageInterface implements SentMessageInterface {}
abstract class ImplSerializerInterface implements SerializerInterface {}
abstract class ImplServerRequestInterface implements ServerRequestInterface {}
abstract class ImplServiceLocatorInterface implements ServiceLocatorInterface {}
abstract class ImplServiceSubscriberInterface implements ServiceSubscriberInterface {}
abstract class ImplSessionHandlerInterface implements SessionHandlerInterface {}
abstract class ImplSignalableCommandInterface implements SignalableCommandInterface {}
abstract class ImplSluggerInterface implements SluggerInterface {}
abstract class ImplStampInterface implements StampInterface {}
abstract class ImplStateProcessorInterface implements StateProcessorInterface {}
abstract class ImplStopwatchInterface implements StopwatchInterface {}
abstract class ImplStoreInterface implements StoreInterface {}
abstract class ImplStreamFactoryInterface implements StreamFactoryInterface {}
abstract class ImplSubscriptionInterface implements SubscriptionInterface {}
abstract class ImplTagAwareCacheInterface implements TagAwareCacheInterface {}
abstract class ImplTerminableInterface implements TerminableInterface {}
abstract class ImplTransformerInterface implements TransformerInterface {}
abstract class ImplTranslatorInterface implements TranslatorInterface {}
abstract class ImplTransportExceptionInterface implements TransportExceptionInterface {}
abstract class ImplTypeConfigDecoratorInterface implements TypeConfigDecoratorInterface {}
abstract class ImplTypeResolverInterface implements TypeResolverInterface {}
abstract class ImplUrlGeneratorInterface implements UrlGeneratorInterface {}
abstract class ImplUserCheckerInterface implements UserCheckerInterface {}

final class ApiSurface
{
    private $client; private $logger; private $cache; private $em; private $bus;

    public function classes(): array
    {
        return [
            AbstractAdmin::class,
            AbstractAuthenticator::class,
            AbstractCommand::class,
            AbstractContextAwareFilter::class,
            AbstractController::class,
            AbstractCrudController::class,
            AbstractDashboardController::class,
            AbstractDataCollector::class,
            AbstractDomainEvent::class,
            AbstractExtension::class,
            AbstractFilter::class,
            AbstractFixture::class,
            AbstractFormTypeGuesser::class,
            AbstractHealthIndicator::class,
            AbstractHydrator::class,
            AbstractInflector::class,
            AbstractLazyObject::class,
            AbstractLogEntry::class,
            AbstractLoginFormAuthenticator::class,
            AbstractMaker::class,
            AbstractMigration::class,
            AbstractNormalizer::class,
            AbstractQuery::class,
            AbstractRateLimiter::class,
            AbstractReconnectingMiddleware::class,
            AbstractRector::class,
            AbstractRemoteEvent::class,
            AbstractRequestParser::class,
            AbstractSocialAuthenticator::class,
            AbstractSQLFilter::class,
            AbstractTranslation::class,
            AbstractType::class,
            AbstractTypeExtension::class,
            AbstractUserChecker::class,
            AbstractVoter::class,
            AccessException::class,
            AccountExpiredException::class,
            AccountStatusException::class,
            AdminController::class,
            AdminNotifier::class,
            AggregateChanged::class,
            AggregateRoot::class,
            Anonymize::class,
            ApiErrorException::class,
            ApiException::class,
            ApiPlatform::class,
            ApiPlatformException::class,
            ApiSubresource::class,
            AppRoleAuth::class,
            ArrayAdapter::class,
            ArrayCollection::class,
            ArrayParameterType::class,
            AsciiSlugger::class,
            AsciiString::class,
            AsCommand::class,
            AsCronTask::class,
            AsLiveComponent::class,
            AsPeriodicTask::class,
            AsSchedule::class,
            AtomicDumper::class,
            Autoconfigure::class,
            AutoconfigureTag::class,
            AvroSerializer::class,
            Azure::class,
            AzureBlobStorage::class,
            BatchCollectionLoader::class,
            BatchLoader::class,
            Blackfire::class,
            Blob::class,
            BlobClient::class,
            BlobSasPermissions::class,
            BlobServiceClient::class,
            BlockBlobClient::class,
            Brick::class,
            BroadcastMercure::class,
            Bucket::class,
            Bugsnag::class,
            ByteString::class,
            Cache::class,
            CacheItem::class,
            CacheItemPool::class,
            CachingFactoryDecorator::class,
            CachingHttpClient::class,
            Cancelled::class,
            CardException::class,
            ChainAdapter::class,
            ChainedBatch::class,
            Chart::class,
            ChartBuilder::class,
            Check::class,
            ChoiceType::class,
            CircuitBreaker::class,
            ClassDiscriminatorMapping::class,
            ClockAwareTrait::class,
            ClockMock::class,
            ClockSensitiveTrait::class,
            CloudFront::class,
            CloudFrontClient::class,
            CloudFrontCookieSigner::class,
            CloudFrontUrlSigner::class,
            Cloudinary::class,
            Cluster::class,
            CognitoIdentityProviderClient::class,
            CollectionType::class,
            Column::class,
            Command::class,
            CommandBus::class,
            ComponentWithFormTrait::class,
            Connection::class,
            ConnectionFactory::class,
            ConsoleCommand::class,
            ConsoleEvents::class,
            ConstraintValidator::class,
            ConstraintValidatorTestCase::class,
            Consul::class,
            ConsumerPactBuilder::class,
            Container::class,
            ContainerBuilder::class,
            ContainerClient::class,
            ContainerCommandLoader::class,
            ContentBasedDeduplication::class,
            ContentType::class,
            Controller::class,
            Cookie::class,
            Countable::class,
            CronJob::class,
            CroppedField::class,
            CropperField::class,
            CssInliner::class,
            CursorBasedPagination::class,
            DashboardController::class,
            DatabaseChecker::class,
            DataCollector::class,
            DataLoader::class,
            DataProvider::class,
            DataSet::class,
            DataTable::class,
            DateInterval::class,
            DatePeriod::class,
            DateTime::class,
            DateTimeImmutable::class,
            DateTimeZone::class,
            DebugDataHolder::class,
            DebugStack::class,
            Default::class,
            DelayedMessage::class,
            DelayStamp::class,
            Delete::class,
            DeregisterCriticalServiceAfter::class,
            DisabledException::class,
            Discriminator::class,
            DiscriminatorMap::class,
            DispatchAfterCurrentBus::class,
            DispatchAfterCurrentBusMiddleware::class,
            DispatchAfterCurrentBusStamp::class,
            DkimSigner::class,
            Doctrine::class,
            DoctrineEncryptSubscriber::class,
            DoctrineEventListener::class,
            DoctrineOrmTypeGuesser::class,
            DoctrinePaginator::class,
            DoctrineTransactionMiddleware::class,
            DocumentRoot::class,
            DogStatsd::class,
            DomainEvent::class,
            DOMDocument::class,
            Dompdf::class,
            DOMXPath::class,
            EasyAdmin::class,
            EchoSQLLogger::class,
            Elastica::class,
            ElasticaProxyQuery::class,
            Elasticsearch::class,
            ElasticSearch::class,
            Email::class,
            EmailType::class,
            EmojiTransliterator::class,
            EnglishInflector::class,
            EntityAutocompleteType::class,
            EntityListener::class,
            EntityManager::class,
            EntityRepository::class,
            EntityType::class,
            EnumType::class,
            Error::class,
            ErrorRenderer::class,
            ETag::class,
            Event::class,
            EventBus::class,
            EventListener::class,
            EventManager::class,
            Events::class,
            EventStreamId::class,
            EventStreamResponse::class,
            EventSubscriber::class,
            Exception::class,
            ExceptionEvent::class,
            ExceptionListener::class,
            Exif::class,
            Expires::class,
            ExpiresOn::class,
            Expiry::class,
            ExponentialBackoff::class,
            ExponentialBackOffStrategy::class,
            Export::class,
            Expression::class,
            ExpressionFunction::class,
            ExpressionLanguage::class,
            Extension::class,
            Factory::class,
            Failed::class,
            FailedMessageEvent::class,
            Faker::class,
            FastExcel::class,
            FeatureChecker::class,
            FeatureManager::class,
            Fiber::class,
            Filesystem::class,
            FilesystemAdapter::class,
            Finder::class,
            FirebaseFactory::class,
            FirebaseMessage::class,
            Fixture::class,
            FixtureResponse::class,
            FlockStore::class,
            Form::class,
            FormType::class,
            FOSView::class,
            FrankenPHP::class,
            Fresh::class,
            GcsAdapter::class,
            GeneratedValue::class,
            Generator::class,
            GenericProvider::class,
            GenericRetryStrategy::class,
            GeometryType::class,
            GetParameter::class,
            GetParameters::class,
            GiST::class,
            Github::class,
            GitHub::class,
            GithubClient::class,
            GoogleCloudStorage::class,
            GoogleMapsRenderer::class,
            GraphServiceClient::class,
            GroupSequence::class,
            GuardEvent::class,
            Guzzle::class,
            GuzzleHttp::class,
            HandledStamp::class,
            Handler::class,
            HandleTrait::class,
            HashHelper::class,
            HasLifecycleCallbacks::class,
            Hateoas::class,
            HeaderSet::class,
            HealthCheck::class,
            HoneypotType::class,
            HtmlPart::class,
            HtmlToTextConverter::class,
            HttpClient::class,
            HubSpot::class,
            IdempotentRequest::class,
            Identical::class,
            Imagick::class,
            Imagine::class,
            Import::class,
            Inflect::class,
            InheritanceType::class,
            InlineCss::class,
            InMemoryTransport::class,
            InteractiveLoginEvent::class,
            IntercomClient::class,
            Interface::class,
            IriConverter::class,
            Irregular::class,
            Iterator::class,
            JsonDecodable::class,
            JsonDecoder::class,
            JsonEncodable::class,
            JsonEncoder::class,
            JsonLdContextBuilder::class,
            JsonManifest::class,
            JsonResponse::class,
            JsonType::class,
            Kafka::class,
            KafkaConsumer::class,
            KafkaProducer::class,
            Kernel::class,
            KernelTestCase::class,
            KeyExpiredException::class,
            KmsKeyId::class,
            LazyGhostTrait::class,
            LazyProxyTrait::class,
            LeafletRenderer::class,
            LiipMonitor::class,
            LiveProp::class,
            LocaleListener::class,
            Location::class,
            LockableTrait::class,
            LockedException::class,
            LockException::class,
            LockFactory::class,
            LogEntry::class,
            Loggable::class,
            Logger::class,
            LoggingConnection::class,
            LoginFailureEvent::class,
            LoginFormAuthenticator::class,
            LoginLinkNotification::class,
            LoginSuccessEvent::class,
            LogoutEvent::class,
            LogRecord::class,
            Loop::class,
            Mailer::class,
            Mailgun::class,
            MailgunClient::class,
            MailgunTransport::class,
            Manager::class,
            ManagerRegistry::class,
            Marking::class,
            MatchesSnapshots::class,
            MaxDepth::class,
            Meilisearch::class,
            MeiliSearch::class,
            Memcache::class,
            Memcached::class,
            MemcachedAdapter::class,
            MessageBus::class,
            MessageDeduplicationId::class,
            MessageEvent::class,
            MessageGroupId::class,
            MessageHandler::class,
            Messenger::class,
            Metadata::class,
            MicroKernelTrait::class,
            MimeTypes::class,
            MinkContext::class,
            Misd::class,
            Missing::class,
            MockClock::class,
            MockHttpClient::class,
            MockResponse::class,
            MockServer::class,
            MockService::class,
            ModelFactory::class,
            Mpdf::class,
            Mutation::class,
            MyISAM::class,
            NamedNativeQuery::class,
            NameIDFormat::class,
            NativeQuery::class,
            NeedsRehashException::class,
            NewRelic::class,
            NoSuchPropertyException::class,
            Notification::class,
            NotifyPropertyChanged::class,
            NullAdapter::class,
            NullRetryStrategy::class,
            OAuth::class,
            OAuth2Client::class,
            ObjectFactory::class,
            ObjectHydrator::class,
            OidcClient::class,
            OnClear::class,
            OneSignalOptions::class,
            OpenIdConnect::class,
            OptimisticLockException::class,
            OptionsResolver::class,
            OrderConfirmation::class,
            OrdersCaptureRequest::class,
            OrdersCreate::class,
            OrdersCreateRequest::class,
            PactBuilder::class,
            PactVerifier::class,
            Pagerfanta::class,
            Pagination::class,
            Paginator::class,
            Panther::class,
            PantherTestCase::class,
            ParamConverter::class,
            ParameterStore::class,
            Passport::class,
            Patch::class,
            PaymentIntent::class,
            PaymentMethod::class,
            PayPal::class,
            PayPalCheckoutSdk::class,
            PersistentProxyObjectFactory::class,
            Personal::class,
            PharData::class,
            PhpArrayAdapter::class,
            PHPExcel::class,
            PhpSpreadsheet::class,
            PHPUnit::class,
            PingController::class,
            PointType::class,
            PoolingShardConnectionWrapper::class,
            Post::class,
            PostConnectEventArgs::class,
        ];
    }

    public function constants(): array
    {
        return [
            AAAA,
            ACCESS_DENIED,
            ACCESS_GRANTED,
            ALLOW_EXTRA_ATTRIBUTES,
            ALREADY_CALLED,
            APP_DEBUG,
            APP_ENV,
            APP_VERSION,
            AWSCURRENT,
            AWS_DEFAULT_REGION,
            AWSPREVIOUS,
            AWS_REGION,
            BACKWARD,
            BATCH_SIZE,
            CIRCULAR_REFERENCE_HANDLER,
            CLASS_CONSTRAINT,
            CSRF,
            CURLOPT_,
            CURLOPT_CONNECTTIMEOUT,
            CURLOPT_MAXREDIRS,
            CURLOPT_TIMEOUT,
            CURLOPT_URL,
            DATABASE_URL,
            DEAD_CODE,
            DISABLE_TYPE_ENFORCEMENT,
            DISALLOW_MAGIC_CALL,
            DISTINCT,
            DKIM,
            DOMPDF_ENABLE_REMOTE,
            ENABLE_MAX_DEPTH,
            EXCLUDE_START_DATE,
            FALSE,
            FORWARD,
            GENERATED,
            GETTER_CONSTRAINT,
            HALF_OPEN,
            HIGH,
            HINT_CUSTOM_OUTPUT_WALKER,
            HINT_CUSTOM_TREE_WALKERS,
            HINT_FORCE_PARTIAL_LOAD,
            HMAC,
            HSTS,
            INSERT,
            IS_ARRAY,
            IS_AUTHENTICATED_ANONYMOUSLY,
            IS_REPEATABLE,
            JOIN,
            JSONB,
            JSON_CONTAINS,
            JSON_EXTRACT,
            JSON_GET_FIELD,
            JSON_THROW_ON_ERROR,
            LATEST,
            LDAP_OPT_PROTOCOL_VERSION,
            LIBXML_HTML_NOIMPLIED,
            LIBXML_NOENT,
            LIBXML_NONET,
            LIKE,
            LIMIT,
            MAGIC_CALL,
            MAILER,
            MAILER_DSN,
            MAINTENANCE_IPS,
            MAX_DEPTH,
            MAX_DEPTH_HANDLER,
            MAX_FILE_SIZE,
            MEDIUM,
            MERCURE_PUBLIC_URL,
            MERCURE_PUBLISH_URL,
            MERCURE_URL,
            METHOD_OVERRIDE,
            MFA_SETUP,
            MJML,
            NFKC,
            NFKD,
            NONSTRICT,
            NONSTRICT_READ_WRITE,
            OBJECT_TO_POPULATE,
            OFFSET,
            OPENSSL_,
            OPENSSL_PKCS1_PADDING,
            OPT_BINARY_PROTOCOL,
            OPTIMISTIC,
            PACT_BROKER_URL,
            PANTHER_BROWSER,
            PANTHER_CHROME_DRIVER_BINARY,
            PARAM_INT_ARRAY,
            PARAM_STR_ARRAY,
            PATHINFO_EXTENSION,
            PHP_MAJOR_VERSION,
            PHP_VERSION,
            PKCE,
            PRE_SET_DATA,
            PROPERTY_CONSTRAINT,
            PUBLIC_ACCESS,
            PURGE,
            RABBITMQ,
            READ_ONLY,
            READ_WRITE,
            REDIS_URL,
            REMOTE_ADDR,
            REQUIRED,
            ROLE_,
            ROLE_ALLOWED_TO_SWITCH,
            RS256,
            S256,
            SEARCH_KEY,
            SELECT,
            SERIALIZABLE,
            SERVICE_SUPERVISOR,
            SIGHUP,
            SIGINT,
            SIGTERM,
            SINGLE_TABLE,
            SMS_MFA,
            SODIUM_CRYPTO_PWHASH_,
            STORED,
            STRIPE_PUBLISHABLE_KEY,
            SYMFONY_ENV,
            TABLE_PER_CLASS,
            TCPDF,
            TIMEOUT,
            TRANSLIT,
            TRUSTED_PROXIES,
            URGENCY_URGENT,
            VALUE_IS_ARRAY,
            VALUE_OPTIONAL,
            VALUE_REQUIRED,
            VAPID,
            VAULT,
            VAULT_CACERT,
            VIRTUAL,
            WEBDRIVER_URL,
            XDEBUG,
        ];
    }

    public function calls(): void
    {
        $this->client->acquire();
        $this->client->add();
        $this->client->addFile();
        $this->client->addFromString();
        $this->client->addOrderBy();
        $this->client->addRow();
        $this->client->addRows();
        $this->client->addTo();
        $this->client->adminApi();
        $this->client->adminConfirmSignUp();
        $this->client->adminGetUser();
        $this->client->adminInitiateAuth();
        $this->client->advance();
        $this->client->alert();
        $this->client->api();
        $this->client->authenticate();
        $this->client->can();
        $this->client->cancel();
        $this->client->cast();
        $this->client->clear();
        $this->client->click();
        $this->client->commit();
        $this->client->contains();
        $this->client->content();
        $this->client->context();
        $this->client->cookie();
        $this->client->createConnection();
        $this->client->createInvalidation();
        $this->client->createQueryBuilder();
        $this->client->createQueue();
        $this->client->createRequest();
        $this->client->createSpan();
        $this->client->critical();
        $this->client->date();
        $this->client->deactivate();
        $this->client->debug();
        $this->client->deleteItem();
        $this->client->denormalize();
        $this->client->depth();
        $this->client->detach();
        $this->client->diff();
        $this->client->dispatch();
        $this->client->distinct();
        $this->client->emergency();
        $this->client->enableShellEmulation();
        $this->client->error();
        $this->client->evaluate();
        $this->client->event();
        $this->client->exec();
        $this->client->executeStatement();
        $this->client->extractTo();
        $this->client->filter();
        $this->client->find();
        $this->client->findBy();
        $this->client->findOne();
        $this->client->findOneBy();
        $this->client->finish();
        $this->client->form();
        $this->client->gauge();
        $this->client->get();
        $this->client->getAcceptableContentTypes();
        $this->client->getAlnum();
        $this->client->getArguments();
        $this->client->getAuthorizationUrl();
        $this->client->getBoolean();
        $this->client->getConnection();
        $this->client->getContent();
        $this->client->getCurrentRequest();
        $this->client->getDistribution();
        $this->client->getFormat();
        $this->client->getHelper();
        $this->client->getInt();
        $this->client->getItem();
        $this->client->getMainRequest();
        $this->client->getMimeType();
        $this->client->getMultiple();
        $this->client->getParentRequest();
        $this->client->getPreferredFormat();
        $this->client->getQuery();
        $this->client->getReference();
        $this->client->getRepository();
        $this->client->getResourceOwner();
        $this->client->getSigningKey();
        $this->client->getStatusCode();
        $this->client->getString();
        $this->client->getUnitOfWork();
        $this->client->getValue();
        $this->client->guessExtension();
        $this->client->handle();
        $this->client->has();
        $this->client->hint();
        $this->client->histogram();
        $this->client->html();
        $this->client->htmlTemplate();
        $this->client->hydrate();
        $this->client->identify();
        $this->client->in();
        $this->client->inc();
        $this->client->incBy();
        $this->client->increment();
        $this->client->info();
        $this->client->initiateAuth();
        $this->client->inlineCss();
        $this->client->innerJoin();
        $this->client->insert();
        $this->client->invalidateTags();
        $this->client->isGranted();
        $this->client->isMethod();
        $this->client->isReadable();
        $this->client->isValid();
        $this->client->isWritable();
        $this->client->iterate();
        $this->client->join();
        $this->client->lap();
        $this->client->last();
        $this->client->leftJoin();
        $this->client->like();
        $this->client->link();
        $this->client->load();
        $this->client->lock();
        $this->client->log();
        $this->client->matching();
        $this->client->merge();
        $this->client->mkdir();
        $this->client->modify();
        $this->client->mustRun();
        $this->client->name();
        $this->client->needsRehash();
        $this->client->newInstance();
        $this->client->normalize();
        $this->client->notContains();
        $this->client->notice();
        $this->client->notification();
        $this->client->notifyError();
        $this->client->notifyException();
        $this->client->notName();
        $this->client->observe();
        $this->client->onlyMethods();
        $this->client->open();
        $this->client->orderBy();
        $this->client->parse();
        $this->client->patch();
        $this->client->persist();
        $this->client->pipe();
        $this->client->post();
        $this->client->prepare();
        $this->client->preventSend();
        $this->client->publish();
        $this->client->put();
        $this->client->query();
        $this->client->read();
        $this->client->redirect();
        $this->client->refresh();
        $this->client->reject();
        $this->client->remove();
        $this->client->render();
        $this->client->request();
        $this->client->reset();
        $this->client->respondToAuthChallenge();
        $this->client->rollback();
        $this->client->run();
        $this->client->runWithLocale();
        $this->client->sanitize();
        $this->client->save();
        $this->client->saveObject();
        $this->client->scheduleForDirtyCheck();
        $this->client->search();
        $this->client->seed();
        $this->client->selectButton();
        $this->client->selectImage();
        $this->client->selectLink();
        $this->client->send();
        $this->client->sendMessage();
        $this->client->set();
        $this->client->setCenter();
        $this->client->setColumnWidth();
        $this->client->setContext();
        $this->client->setData();
        $this->client->setDefault();
        $this->client->setDefaults();
        $this->client->setErrorMessage();
        $this->client->setEtag();
        $this->client->setFirstResult();
        $this->client->setHeaders();
        $this->client->setHiddenFallback();
        $this->client->setImportance();
        $this->client->setLabels();
        $this->client->setLastModified();
        $this->client->setLocale();
        $this->client->setMaxAttempts();
        $this->client->setMaxResults();
        $this->client->setMultiple();
        $this->client->setParameter();
        $this->client->setProgress();
        $this->client->setQueueAttributes();
        $this->client->setRows();
        $this->client->setSettings();
        $this->client->setStyle();
        $this->client->setTag();
        $this->client->setTimeout();
        $this->client->setUser();
        $this->client->setValidator();
        $this->client->setValue();
        $this->client->setVary();
        $this->client->setVertical();
        $this->client->sign();
        $this->client->signUp();
        $this->client->signUrl();
        $this->client->size();
        $this->client->sleep();
        $this->client->slug();
        $this->client->sort();
        $this->client->start();
        $this->client->stop();
        $this->client->stopPropagation();
        $this->client->stream();
        $this->client->subject();
        $this->client->submit();
        $this->client->tag();
        $this->client->text();
        $this->client->textTemplate();
        $this->client->timing();
        $this->client->to();
        $this->client->toUnicodeString();
        $this->client->track();
        $this->client->trans();
        $this->client->transformToDoc();
        $this->client->transformToURI();
        $this->client->transformToXML();
        $this->client->transliterate();
        $this->client->trigger();
        $this->client->triggerBatch();
        $this->client->upload();
        $this->client->uploadApi();
        $this->client->uploadLarge();
        $this->client->upsert();
        $this->client->values();
        $this->client->verify();
        $this->client->verifyWebhook();
        $this->client->warning();
        $this->client->where();
        $this->client->with();
        $this->client->withOptions();
        $this->client->withoutAll();
        $this->client->withoutStampsOfType();
        $this->client->withParallel();
        $this->client->withTag();
    }

    public function functions(): void
    {
        @any();
        @apply();
        @array_chunk();
        @array_filter();
        @array_map();
        @array_values();
        @assert();
        @authenticate();
        @basename();
        @bccomp();
        @bcdiv();
        @bcscale();
        @block();
        @bulk();
        @com_create_guid();
        @connect();
        @count();
        @csrf_field();
        @date();
        @define();
        @delete();
        @describe();
        @disconnect();
        @dispatch();
        @empty();
        @encode();
        @eval();
        @exec();
        @expect();
        @expects();
        @faker();
        @fetch();
        @file_put_contents();
        @find();
        @fopen();
        @form_end();
        @form_label();
        @form_start();
        @fwrite();
        @gc_collect_cycles();
        @gc_disable();
        @get_called_class();
        @get_class();
        @has();
        @hash();
        @hash_equals();
        @header();
        @iconv();
        @initialize();
        @is_a();
        @is_authenticated();
        @is_granted();
        @is_null();
        @iterator_to_array();
        @join();
        @load();
        @log();
        @map();
        @mark();
        @mb_convert_case();
        @mb_convert_encoding();
        @mb_internal_encoding();
        @mb_strlen();
        @mkdir();
        @move();
        @msg_get_queue();
        @msg_receive();
        @msg_remove_queue();
        @msg_send();
        @newrelic_name_transaction();
        @newrelic_notice_error();
        @nonce();
        @normalizer_normalize();
        @notification_widget();
        @number_format();
        @ob_flush();
        @ob_get_level();
        @ob_start();
        @parse();
        @parse_ini_file();
        @pcntl_async_signals();
        @pcntl_fork();
        @pcntl_signal();
        @pcntl_signal_dispatch();
        @pcntl_waitpid();
        @ping();
        @pipeline();
        @pluralize();
        @popen();
        @posix_getpwnam();
        @posix_kill();
        @posix_mkfifo();
        @posix_setgid();
        @posix_setuid();
        @prepend();
        @process();
        @proc_open();
        @produce();
        @putenv();
        @rand();
        @range();
        @react_component();
        @realpath();
        @render();
        @render_chart();
        @render_esi();
        @reset();
        @rollback();
        @save();
        @search();
        @sem_acquire();
        @sem_get();
        @sem_release();
        @setcookie();
        @shm_get_var();
        @shmop_close();
        @shmop_open();
        @shm_put_var();
        @sign();
        @singularize();
        @socket_set_option();
        @sodium_crypto_auth_verify();
        @sodium_crypto_pwhash();
        @sodium_memcmp();
        @sodium_randombytes_buf();
        @sprintf();
        @strcmp();
        @stream_set_timeout();
        @strlen();
        @strnatcmp();
        @strncmp();
        @strtotime();
        @substr();
        @svelte_component();
        @system();
        @time();
        @tmpfile();
        @transactional();
        @unmark();
        @unset();
        @usleep();
        @usort();
        @uuid_create();
        @ux_chart();
        @ux_map();
        @ux_notify();
        @verify();
        @vote();
        @vue_component();
        @zip_entry_open();
    }

    public function superglobals(): array
    {
        return [$_GET, $_POST, $_REQUEST, $_FILES, $_ENV, $_SERVER, $_COOKIE, $_SESSION];
    }
}
