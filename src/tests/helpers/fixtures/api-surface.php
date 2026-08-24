<?php

/**
 * A catalogue of Symfony and PHP API usage, for the tool test-suite.
 *
 * The analysers under src/tools/ look for specific symbols in application
 * source. This file exercises the ones the well-formed fixtures do not
 * naturally contain, so their parsing runs. The symbol list was extracted
 * from the modules themselves rather than guessed.
 *
 * It is a fixture: plausible, not runnable, and never executed.
 */

namespace App\Reference;

use Symfony\Contracts\EventSubscriberInterface;
use Symfony\Contracts\HttpClientInterface;
use Symfony\Contracts\CacheInterface;
use Symfony\Contracts\TagAwareCacheInterface;
use Symfony\Contracts\MiddlewareInterface;
use Symfony\Contracts\MailerInterface;
use Symfony\Contracts\CacheItemPoolInterface;
use Symfony\Contracts\ScheduleProviderInterface;
use Symfony\Contracts\QueryBusInterface;
use Symfony\Contracts\ProcessorInterface;
use Symfony\Contracts\NotificationInterface;
use Symfony\Contracts\NormalizerInterface;
use Symfony\Contracts\MessageHandlerInterface;
use Symfony\Contracts\GroupSequenceProviderInterface;
use Symfony\Contracts\FormTypeInterface;
use Symfony\Contracts\CommandBusInterface;
use Symfony\Contracts\VoterInterface;
use Symfony\Contracts\StampInterface;
use Symfony\Contracts\RequestParserInterface;
use Symfony\Contracts\QueryInterface;
use Symfony\Contracts\PrependExtensionInterface;
use Symfony\Contracts\PaginatorInterface;
use Symfony\Contracts\MessageBusInterface;
use Symfony\Contracts\FormBuilderInterface;
use Symfony\Contracts\ExpressionFunctionProviderInterface;
use Symfony\Contracts\EventDispatcherInterface;
use Symfony\Contracts\EntityManagerInterface;
use Symfony\Contracts\DataTransformerInterface;
use Symfony\Contracts\ClassDiscriminatorResolverInterface;
use Symfony\Contracts\TypeConfigDecoratorInterface;
use Symfony\Contracts\SluggerInterface;
use Symfony\Contracts\SignalableCommandInterface;
use Symfony\Contracts\ServiceSubscriberInterface;
use Symfony\Contracts\RuntimeInterface;
use Symfony\Contracts\ResolverInterface;
use Symfony\Contracts\RememberMeHandlerInterface;
use Symfony\Contracts\ProviderInterface;
use Symfony\Contracts\OutputDataTransformerInterface;
use Symfony\Contracts\MutationInterface;
use Symfony\Contracts\MimeTypeGuesserInterface;

#[AsTaggedItem]
class RefAsTaggedItem {}

#[Route]
class RefRoute {}

#[ORM\\Entity]
class RefORMEntity {}

#[Column]
class RefColumn {}

#[AsLiveComponent]
class RefAsLiveComponent {}

#[ApiResource]
class RefApiResource {}

#[Version]
class RefVersion {}

#[Test]
class RefTest {}

#[SerializedName]
class RefSerializedName {}

#[ORM\\Cache]
class RefORMCache {}

#[ORM\\]
class RefORM {}

#[MapQueryParameter]
class RefMapQueryParameter {}

#[LiveAction]
class RefLiveAction {}

#[IsGranted]
class RefIsGranted {}

#[GroupSequenceProvider]
class RefGroupSequenceProvider {}

#[Entity]
class RefEntity {}

#[EncodedName]
class RefEncodedName {}

#[Cache]
class RefCache {}

#[Broadcast]
class RefBroadcast {}

#[AutoconfigureTag]
class RefAutoconfigureTag {}

#[Assert\\]
class RefAssert {}

#[AsTwigComponent]
class RefAsTwigComponent {}

#[AsMessageHandler]
class RefAsMessageHandler {}

#[AsEventListener]
class RefAsEventListener {}

#[AsDoctrineListener]
class RefAsDoctrineListener {}

#[AsController]
class RefAsController {}

#[AsCommand]
class RefAsCommand {}

class ApiSurface implements EventSubscriberInterface, HttpClientInterface, CacheInterface, TagAwareCacheInterface, MiddlewareInterface, MailerInterface
{
    private $client;
    private $logger;
    private $cache;

    public function symbols(): array
    {
        return [
            AbstractController::class,
            TestCase::class,
            AbstractType::class,
            TemplatedEmail::class,
            JsonResponse::class,
            JSON_THROW_ON_ERROR::class,
            Repository::class,
            RedrivePolicy::class,
            DateTimeZone::class,
            Controller::class,
            AbstractMigration::class,
            VaultClient::class,
            Uuid::class,
            UniqueEntity::class,
            Ulid::class,
            Twilio::class,
            TurboStreamResponse::class,
            SIGTERM::class,
            QueryBuilder::class,
            Paginator::class,
            IsGranted::class,
            INSERT::class,
            HttpClient::class,
            HMAC::class,
            GetParameter::class,
            Filesystem::class,
            ExceptionEvent::class,
            Exception::class,
            EventSubscriber::class,
            EventListener::class,
            EntityRepository::class,
            EntityManager::class,
            ChainAdapter::class,
            CachingHttpClient::class,
            CIRCULAR_REFERENCE_HANDLER::class,
            AsSchedule::class,
            AbstractHydrator::class,
            WebhookHandler::class,
            Webhook::class,
            WebTestCase::class,
            WebLink::class,
            WeakMap::class,
            Vault::class,
            UploadedFile::class,
            Timeout::class,
            TextPart::class,
            TagAwareAdapter::class,
            Stripe::class,
            SplFileObject::class,
            ShardManager::class,
            RouteCollection::class,
            Request::class,
            RepeatedType::class,
            RateLimiterFactory::class,
            RateLimiter::class,
            PHPUnit::class,
            Notification::class,
            MimeTypes::class,
            MemcachedAdapter::class,
            Mailer::class,
            LogEntry::class,
            LockFactory::class,
            LIMIT::class,
            Iterator::class,
            InheritanceType::class,
            HtmlPart::class,
            HINT_CUSTOM_TREE_WALKERS::class,
            GroupSequence::class,
            Fixture::class,
            Finder::class,
            FilesystemAdapter::class,
            FailedMessageEvent::class,
            Extension::class,
            EventStreamResponse::class,
            Event::class,
            Error::class,
            EnumType::class,
            ENABLE_MAX_DEPTH::class,
            Doctrine::class,
            DiscriminatorMap::class,
            DebugStack::class,
            DOMDocument::class,
            CloudFrontUrlSigner::class,
            CacheItemPool::class,
            ByteString::class,
            BATCH_SIZE::class,
            ArrayCollection::class,
            ApiResource::class,
            AbstractFilter::class,
            AbstractExtension::class,
        ];
    }

    public function calls(): void
    {
        $this->client->send();
        $this->client->request();
        $this->client->get();
        $this->client->setMaxResults();
        $this->client->upload();
        $this->client->subject();
        $this->client->set();
        $this->client->htmlTemplate();
        $this->client->flush();
        $this->client->find();
        $this->client->uploadLarge();
        $this->client->textTemplate();
        $this->client->setFirstResult();
        $this->client->persist();
        $this->client->contains();
        $this->client->triggerBatch();
        $this->client->trigger();
        $this->client->track();
        $this->client->normalize();
        $this->client->merge();
        $this->client->matching();
        $this->client->lock();
        $this->client->last();
        $this->client->in();
        $this->client->html();
        $this->client->getAuthorizationUrl();
        $this->client->detach();
        $this->client->clear();
        $this->client->adminInitiateAuth();
        $this->client->adminApi();
        $this->client->withTag();
        $this->client->verifyWebhook();
        $this->client->uploadApi();
        $this->client->transformToXML();
        $this->client->transformToDoc();
        $this->client->timing();
        $this->client->text();
        $this->client->submit();
        $this->client->start();
        $this->client->slug();
        $this->client->sleep();
        $this->client->signUp();
        $this->client->sign();
        $this->client->setValue();
        $this->client->setUser();
        $this->client->setTag();
        $this->client->setSettings();
        $this->client->setLocale();
        $this->client->setLastModified();
        $this->client->setEtag();
        $this->client->setContext();
        $this->client->sendMessage();
        $this->client->selectLink();
        $this->client->search();
        $this->client->save();
        $this->client->runWithLocale();
        $this->client->respondToAuthChallenge();
        $this->client->refresh();
        $this->client->publish();
        $this->client->prepare();
        $this->client->post();
        $this->client->orderBy();
        $this->client->notifyException();
        $this->client->notifyError();
        $this->client->mustRun();
        $this->client->modify();
        $this->client->insert();
        $this->client->initiateAuth();
        $this->client->increment();
        $this->client->incBy();
        $this->client->inc();
        $this->client->histogram();
        $this->client->getValue();
        $this->client->getString();
        $this->client->getStatusCode();
        $this->client->getResourceOwner();
        $this->client->getQuery();
        $this->client->getItem();
        $this->client->getInt();
        $this->client->getDistribution();
    }

    public function functions(): void
    {
        @shmop_open();
        @count();
        @trans();
        @time();
        @strcmp();
        @shm_put_var();
        @sem_get();
        @posix_setuid();
        @pcntl_signal();
        @msg_send();
        @msg_receive();
        @form_start();
        @empty();
        @dispatch();
        @unset();
        @turbo_stream();
        @transactional();
        @shm_get_var();
        @setcookie();
        @sem_acquire();
        @render_esi();
        @render();
        @putenv();
        @proc_open();
        @preload();
        @posix_setgid();
        @posix_mkfifo();
        @posix_kill();
        @posix_getpwnam();
        @pcntl_fork();
        @openssl_encrypt();
        @ob_start();
        @msg_get_queue();
        @mkdir();
        @json_encode();
        @json_decode();
        @join();
        @is_null();
        @is_a();
        @hash();
        @has();
        @getenv();
        @get_called_class();
        @for();
        @fopen();
        @flush();
        @finfo_file();
        @fetch();
        @expects();
        @disconnect();
    }

    public function superglobals(): array
    {
        return [$_GET, $_POST, $_REQUEST, $_FILES, $_ENV, $_SERVER, $_COOKIE, $_SESSION];
    }
}
