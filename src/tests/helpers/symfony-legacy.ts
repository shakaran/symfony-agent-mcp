// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The pre-attribute way of writing a Symfony application.
 *
 * 81 of the analysers handle docblock annotations as well as PHP 8 attributes,
 * and every fixture so far uses attributes only — so in those modules an
 * entire branch, usually the longer one, never ran. Applications written
 * before PHP 8, and plenty written since, look like this.
 *
 * Also covers the XML mapping and service formats that 18 modules read, and
 * the bundle registrations several gate on.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Entities, controllers, forms and validation in docblock style. */
export function addAnnotationStyle(root: string): void {
  put(root, 'src/Entity/LegacyProduct.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    'use Symfony\\Component\\Validator\\Constraints as Assert;',
    'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
    'use Symfony\\Bridge\\Doctrine\\Validator\\Constraints\\UniqueEntity;',
    '',
    '/**',
    ' * @ORM\\Entity(repositoryClass="App\\Repository\\LegacyProductRepository")',
    ' * @ORM\\Table(name="legacy_product", indexes={@ORM\\Index(name="idx_sku", columns={"sku"})})',
    ' * @ORM\\HasLifecycleCallbacks',
    ' * @UniqueEntity(fields={"sku"}, message="Duplicate SKU")',
    ' */',
    'class LegacyProduct',
    '{',
    '    /**',
    '     * @ORM\\Id',
    '     * @ORM\\GeneratedValue(strategy="AUTO")',
    '     * @ORM\\Column(type="integer")',
    '     * @Groups({"product:read"})',
    '     */',
    '    private $id;',
    '',
    '    /**',
    '     * @ORM\\Column(type="string", length=64, unique=true)',
    '     * @Assert\\NotBlank',
    '     * @Assert\\Length(min=3, max=64)',
    '     * @Groups({"product:read", "product:write"})',
    '     */',
    '    private $sku;',
    '',
    '    /**',
    '     * @ORM\\ManyToOne(targetEntity="App\\Entity\\Category", inversedBy="products", fetch="EAGER")',
    '     * @ORM\\JoinColumn(nullable=false, onDelete="CASCADE")',
    '     */',
    '    private $category;',
    '',
    '    /**',
    '     * @ORM\\OneToMany(targetEntity="App\\Entity\\Review", mappedBy="product", cascade={"persist", "remove"})',
    '     */',
    '    private $reviews;',
    '',
    '    /**',
    '     * @ORM\\PrePersist',
    '     */',
    '    public function onPrePersist() {}',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Controller/LegacyAnnotatedController.php', [
    '<?php',
    'namespace App\\Controller;',
    '',
    'use Sensio\\Bundle\\FrameworkExtraBundle\\Configuration\\Cache;',
    'use Sensio\\Bundle\\FrameworkExtraBundle\\Configuration\\IsGranted;',
    'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
    'use Symfony\\Component\\HttpFoundation\\Response;',
    'use Symfony\\Component\\Routing\\Annotation\\Route;',
    '',
    '/**',
    ' * @Route("/legacy", name="legacy_")',
    ' */',
    'class LegacyAnnotatedController extends AbstractController',
    '{',
    '    /**',
    '     * @Route("/list", name="list", methods={"GET"})',
    '     * @Cache(smaxage="3600", public=true)',
    '     */',
    '    public function list()',
    '    {',
    '        return $this->render("legacy/list.html.twig");',
    '    }',
    '',
    '    /**',
    '     * @Route("/{id}/edit", name="edit", methods={"GET", "POST"}, requirements={"id"="\\d+"})',
    '     * @IsGranted("ROLE_ADMIN")',
    '     */',
    '    public function edit($id)',
    '    {',
    '        return new Response((string) $id);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Form/LegacyType.php', [
    '<?php',
    'namespace App\\Form;',
    '',
    'use Symfony\\Component\\Form\\AbstractType;',
    'use Symfony\\Component\\Form\\FormBuilderInterface;',
    'use Symfony\\Component\\OptionsResolver\\OptionsResolver;',
    '',
    'class LegacyType extends AbstractType',
    '{',
    "    public function buildForm(FormBuilderInterface $builder, array $options)",
    '    {',
    "        $builder",
    "            ->add('sku', null, ['required' => false, 'label' => 'SKU'])",
    "            ->add('name', null, ['required' => true])",
    "            ->add('category', null, ['required' => false, 'placeholder' => '']);",
    '    }',
    '',
    '    public function configureOptions(OptionsResolver $resolver)',
    '    {',
    "        $resolver->setDefaults(['data_class' => LegacyProduct::class]);",
    '    }',
    '',
    '    public function getBlockPrefix()',
    '    {',
    "        return 'legacy';",
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/EventListener/LegacySubscriber.php', [
    '<?php',
    'namespace App\\EventListener;',
    '',
    'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
    'use Symfony\\Component\\HttpKernel\\KernelEvents;',
    '',
    'class LegacySubscriber implements EventSubscriberInterface',
    '{',
    '    public static function getSubscribedEvents()',
    '    {',
    '        return [',
    '            KernelEvents::REQUEST => [["onRequest", 10]],',
    '            KernelEvents::RESPONSE => "onResponse",',
    '            KernelEvents::EXCEPTION => [["onException", -100]],',
    '        ];',
    '    }',
    '',
    '    public function onRequest($event) {}',
    '    public function onResponse($event) {}',
    '    public function onException($event) {}',
    '}',
  ].join('\n') + '\n');
}

/** The XML mapping and service formats. */
export function addXmlFormats(root: string): void {
  put(root, 'config/services.xml', [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    '<container xmlns="http://symfony.com/schema/dic/services">',
    '    <parameters>',
    '        <parameter key="app.locale">en</parameter>',
    '    </parameters>',
    '    <services>',
    '        <defaults autowire="true" autoconfigure="true" public="false" />',
    '        <service id="App\\Service\\LegacyService" class="App\\Service\\LegacyService" public="true">',
    '            <argument type="service" id="doctrine.orm.entity_manager" />',
    '            <tag name="kernel.event_listener" event="kernel.request" method="onRequest" />',
    '        </service>',
    '        <service id="app.alias" alias="App\\Service\\LegacyService" />',
    '    </services>',
    '</container>',
  ].join('\n') + '\n');

  put(root, 'config/routes.xml', [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    '<routes xmlns="http://symfony.com/schema/routing">',
    '    <route id="legacy_home" path="/legacy-home" controller="App\\Controller\\LegacyAnnotatedController::list">',
    '        <default key="_format">html</default>',
    '        <requirement key="_method">GET</requirement>',
    '    </route>',
    '</routes>',
  ].join('\n') + '\n');

  put(root, 'config/doctrine/LegacyProduct.orm.xml', [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    '<doctrine-mapping xmlns="http://doctrine-project.org/schemas/orm/doctrine-mapping">',
    '    <entity name="App\\Entity\\LegacyProduct" table="legacy_product">',
    '        <id name="id" type="integer">',
    '            <generator strategy="AUTO" />',
    '        </id>',
    '        <field name="sku" type="string" length="64" unique="true" />',
    '        <many-to-one field="category" target-entity="App\\Entity\\Category" fetch="EAGER" />',
    '    </entity>',
    '</doctrine-mapping>',
  ].join('\n') + '\n');

  put(root, 'config/validator/validation.xml', [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    '<constraint-mapping xmlns="http://symfony.com/schema/dic/constraint-mapping">',
    '    <class name="App\\Entity\\LegacyProduct">',
    '        <property name="sku">',
    '            <constraint name="NotBlank" />',
    '            <constraint name="Length">',
    '                <option name="min">3</option>',
    '            </constraint>',
    '        </property>',
    '    </class>',
    '</constraint-mapping>',
  ].join('\n') + '\n');

  put(root, 'config/serializer/LegacyProduct.xml', [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    '<serializer xmlns="http://symfony.com/schema/dic/serializer-mapping">',
    '    <class name="App\\Entity\\LegacyProduct">',
    '        <attribute name="sku"><group>product:read</group></attribute>',
    '    </class>',
    '</serializer>',
  ].join('\n') + '\n');
}

/** Register the bundles several analysers gate on. */
export function addBundles(root: string): void {
  put(root, 'config/bundles.php', [
    '<?php',
    '',
    'return [',
    '    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ["all" => true],',
    '    Symfony\\Bundle\\SecurityBundle\\SecurityBundle::class => ["all" => true],',
    '    Symfony\\Bundle\\TwigBundle\\TwigBundle::class => ["all" => true],',
    '    Symfony\\Bundle\\MonologBundle\\MonologBundle::class => ["all" => true],',
    '    Symfony\\Bundle\\DebugBundle\\DebugBundle::class => ["dev" => true, "test" => true],',
    '    Symfony\\Bundle\\MakerBundle\\MakerBundle::class => ["dev" => true],',
    '    Symfony\\Bundle\\WebProfilerBundle\\WebProfilerBundle::class => ["dev" => true, "test" => true],',
    '    Doctrine\\Bundle\\DoctrineBundle\\DoctrineBundle::class => ["all" => true],',
    '    Doctrine\\Bundle\\MigrationsBundle\\DoctrineMigrationsBundle::class => ["all" => true],',
    '    Doctrine\\Bundle\\FixturesBundle\\DoctrineFixturesBundle::class => ["dev" => true, "test" => true],',
    '    ApiPlatform\\Symfony\\Bundle\\ApiPlatformBundle::class => ["all" => true],',
    '    FOS\\RestBundle\\FOSRestBundle::class => ["all" => true],',
    '    Nelmio\\CorsBundle\\NelmioCorsBundle::class => ["all" => true],',
    '    Sonata\\AdminBundle\\SonataAdminBundle::class => ["all" => true],',
    '    Sonata\\DoctrineORMAdminBundle\\SonataDoctrineORMAdminBundle::class => ["all" => true],',
    '    Liip\\FunctionalTestBundle\\LiipFunctionalTestBundle::class => ["test" => true],',
    '    Stof\\DoctrineExtensionsBundle\\StofDoctrineExtensionsBundle::class => ["all" => true],',
    '    Karser\\Recaptcha3Bundle\\KarserRecaptcha3Bundle::class => ["all" => true],',
    '];',
  ].join('\n') + '\n');
}

/** Everything in this file. */
export function addLegacyStyle(root: string): void {
  addAnnotationStyle(root);
  addXmlFormats(root);
  addBundles(root);
}
