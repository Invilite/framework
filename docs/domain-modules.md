# Domain modules

A domain module is a single file the framework discovers, instantiates in dependency order and hands the base dependencies to. In its constructor the module assembles its domain's objects (repositories, operations, services without a decorator), registers in the container what controllers and services need, and exposes as fields what other modules need. The framework injects no domain objects.

- Sources: `src/decorators/Module/Module.ts`, `src/infrastructure/Module/ModuleRegistry.ts`, `src/types/types/ModuleTypes.ts`, `src/infrastructure/Filesystem/Domains.ts` (`modulePath`), `src/infrastructure/ServiceContainer.ts` (class keys)
- `@Controller` and `@Service` work independently of modules, as before.

## 1. The module file

One file per domain, in its root, named `<Name>Module.ts` (matched by `^[A-Z][A-Za-z0-9]*Module\.(ts|js)$`), with a single class decorated `@Module`:

```ts
@Module({name: 'orders', after: ['users', 'billing']})
export default class OrderModule {
    public readonly operations: OrderOperations;

    public constructor(context: AppModuleContext) {
        const users: UserOperations = context.modules.get(UserModule).operations;
        const orders: OrderRepository = new OrderRepository(context.database);

        this.operations = new OrderOperations(orders, users);
        context.container.register(this.operations, OrderOperations);
    }
}
```

- `name`: the name other modules use in `after`; the convention is the domain's folder name.
- `after`: names of the modules whose instances this module uses. It also decides the creation order.
- The constructor is the only entry point and it is synchronous. A module has no `initialize`/`shutdown`: timers, subscriptions and connections belong to a `@Service` in the domain's `services/` directory.
- The same class exported twice (a named export and `default`) is one module.

## 2. The context

The library gives every module three fields and knows only them:

| Field | Type | Purpose |
|---|---|---|
| `logger` | `AbstractLogger` | logging |
| `container` | `ModuleContainer` | registering objects for controllers and services (`register`, `has`) |
| `modules` | `ModuleLookup` | instances of the modules from `after` |

The application types the rest (infrastructure, configuration) in its own context type and passes it to the registry at creation:

```ts
// the application's type, not the library's
export interface AppModuleContext extends ModuleContext {
    config: AppConfig;
    database: PgClient;
    sendEmail: SendEmail;
}
```

- Into the application part goes only what is built from configuration, secrets or connections: the database, queues, storage, mail, authentication, the translator, configuration. External service clients (SMS, captcha and similar) also go there, so tests can pass fakes.
- Domain objects never go into the context: the module assembles them.
- Every module gets its own context object, so the application fields are shared while `modules` is narrowed to its own `after`.

## 3. Other modules

```ts
const users: UserOperations = context.modules.get(UserModule).operations;
```

- `get` returns the instance typed by the class, without casting.
- It works only for modules listed in `after`. Reaching for another module, or for a class without `@Module`, stops the start.
- `after` takes names, not classes: the decorator argument is read while the module file loads, and with circular imports between module files the class would still be `undefined` at that moment. `modules.get(...)` in the constructor works because every file is loaded by then.

## 4. The container

- `context.container` has only `register` and `has`: a module does not pull other domains' objects out of the container. It takes them through `modules.get` from the modules in `after`.
- Classes are registered under the class: `register(operations, OrderOperations)`. A controller reads it with `get(OrderOperations)`, with the type inferred.
- Ports typed by an interface stay under string keys, because an interface does not exist at runtime.
- `get` by class does not look up an entry made under the class name, and falsy values (`false`, `0`, `''`) throw on `get`, as with string keys.

## 5. Process start

Recommended order: infrastructure, modules, services (`ServiceRegistry`), `WebServer`.

```ts
const domains: Domains = new Domains(path.resolve(`${__dirname}/domains`));
domains.scan();
const modulePaths: string[] = [...domains.values()]
    .map((domain: Domain): string | null => domain.modulePath)
    .filter((value: string | null): value is string => value !== null);

const modules: ModuleRegistry<AppModuleContext> = new ModuleRegistry<AppModuleContext>(logger, serviceContainer);
modules.load(modulePaths);
modules.create({config, database, sendEmail});

const session: SessionService = modules.get(UserModule).session;
```

- `create` accepts only the application fields (`ModuleResources<TContext>`); the library fields cannot be overridden.
- Modules are created in the topological order of `after`, ties broken alphabetically by name. The log line is `[ModuleRegistry] 3 module(s): billing, users, orders`.
- `get` on the registry returns an instance without the `after` narrowing (for the start steps, for example a session service handed to `WebServer`).
- `getRegistrations()` returns the name, class, file, `after` and status (`registered`, `created`, `failed`) of every module, in registration (file loading) order, not creation order; the creation order is in the `notice` log line.

## 6. Tests

A module is tested without the file scan: `register` the classes and `create` with fakes of the application fields.

```ts
const registry: ModuleRegistry<AppModuleContext> = new ModuleRegistry<AppModuleContext>(logger, serviceContainer);
registry.register(UserModule);
registry.register(OrderModule);
registry.create({config, database: testDatabase, sendEmail: fakeSender});
```

## 7. Errors

Every one of them stops the process start.

| Message | When |
|---|---|
| `[Domains] Domain "<d>" has more than one module file: <A>, <B>` | two `*Module` files in a domain root |
| `[ModuleRegistry] Class "<K>" is not decorated with @Module` | `register` of a class without the decorator |
| `[ModuleRegistry] Module name "<n>" is already used by class "<K>"` | two classes with the same name |
| `[ModuleRegistry] File "<file>" exports no class decorated with @Module` | a module file without a module |
| `[ModuleRegistry] File "<file>" exports more than one @Module class` | two modules in one file |
| `[ModuleRegistry] Module "<a>" lists itself in after` | own name in `after` |
| `[ModuleRegistry] Module "<a>" lists unknown module "<b>" in after` | a typo or a missing module |
| `[ModuleRegistry] Cycle in after: <a> -> <b> -> <a>` | a dependency cycle |
| `[ModuleRegistry] Modules are already created` | a second `create` |
| `[ModuleRegistry] Module "<a>" uses "<b>" without listing it in after` | `modules.get` outside `after` |
| `[ModuleRegistry] Class "<K>" is not a registered module` | `get` of a class that is not a module |
| `[ModuleRegistry] Module "<a>" is not created` | `get` on the registry before `create` or after a failure |

The `after` validation (own name, unknown name, cycle) runs before the first module is created. An exception from a module constructor is logged (`[ModuleRegistry] Module "<a>" failed to create:`) and rethrown unchanged.
