import 'reflect-metadata';
import path from "path";
import {Service} from "../../src/decorators/Service/Service";
import {AbstractService} from "../../src/infrastructure/Service/AbstractService";
import {ServiceRegistry} from "../../src/infrastructure/Service/ServiceRegistry";
import ServiceContainer from "../../src/infrastructure/ServiceContainer";
import {AbstractLogger} from "../../src/types/interfaces/AbstractLogger";
import {ServiceClass, ServiceContext} from "../../src/types/types/ServiceTypes";

type TestContext = ServiceContext & {events: string[]};

const logger: AbstractLogger = {
    trace: jest.fn(), debug: jest.fn(), info: jest.fn(), notice: jest.fn(), warning: jest.fn(),
    error: jest.fn(), critical: jest.fn(), alert: jest.fn(), emergency: jest.fn(),
};

const FIXTURES: string = path.resolve(__dirname, 'fixtures/services');

function lifecycleService(label: string, opts: {failStart?: boolean; failStop?: boolean} = {}): ServiceClass<TestContext> {
    @Service(label)
    class LifecycleService extends AbstractService {
        public constructor(private readonly ctx: TestContext) {
            super(ctx);
        }

        public static create(ctx: TestContext): LifecycleService {
            ctx.events.push(`create:${label}`);
            return new LifecycleService(ctx);
        }

        public async initialize(): Promise<void> {
            this.ctx.events.push(`start:${label}`);
            if (opts.failStart) {
                throw new Error(`boom:${label}`);
            }
        }

        public shutdown(): void {
            this.ctx.events.push(`stop:${label}`);
            if (opts.failStop) {
                throw new Error(`stop-boom:${label}`);
            }
        }
    }

    return LifecycleService;
}

describe('ServiceRegistry', () => {
    let container: ServiceContainer;
    let registry: ServiceRegistry<TestContext>;
    let ctx: TestContext;

    beforeEach(() => {
        jest.clearAllMocks();
        container = new ServiceContainer();
        registry = new ServiceRegistry<TestContext>(logger, container);
        ctx = {events: [], logger, container};
    });

    test('scan registers decorated classes in sorted path order, skips undecorated ones', () => {
        registry.scan([FIXTURES]);

        expect(registry.getRegistrations().map((r) => r.name)).toEqual(['AlphaService', 'Gamma']);
    });

    test('scan registers a class exported both as named and default export only once', () => {
        registry.scan([FIXTURES]);

        expect(registry.getRegistrations().filter((r) => r.className === 'AlphaService')).toHaveLength(1);
    });

    test('scan skips a missing directory with a warning', () => {
        expect(() => registry.scan([path.join(FIXTURES, 'does-not-exist')])).not.toThrow();
        expect(logger.warning).toHaveBeenCalledTimes(1);
    });

    test('isServiceModule accepts .ts/.js and rejects declaration and map files', () => {
        expect(ServiceRegistry.isServiceModule('FooService.ts')).toBe(true);
        expect(ServiceRegistry.isServiceModule('FooService.js')).toBe(true);
        expect(ServiceRegistry.isServiceModule('FooService.d.ts')).toBe(false);
        expect(ServiceRegistry.isServiceModule('FooService.js.map')).toBe(false);
        expect(ServiceRegistry.isServiceModule('README.md')).toBe(false);
    });

    test('register throws for an undecorated class', () => {
        class Plain extends AbstractService {
        }
        expect(() => registry.register(Plain)).toThrow(/not decorated with @Service/);
    });

    test('register throws for a service that does not extend AbstractService', () => {
        @Service('Loose')
        class Loose {
            public static create(): Loose {
                return new Loose();
            }
        }
        expect(() => registry.register(Loose as unknown as ServiceClass<TestContext>)).toThrow(/does not extend AbstractService/);
    });

    test('register throws when two classes share a service name', () => {
        registry.register(lifecycleService('Same'));
        expect(() => registry.register(lifecycleService('Same'))).toThrow(/already used/);
    });

    test('create calls the static factory with the context and registers the instance in the container', () => {
        const A: ServiceClass<TestContext> = lifecycleService('A');
        registry.register(A);

        registry.create(ctx);

        expect(ctx.events).toEqual(['create:A']);
        expect(container.get('A')).toBeInstanceOf(A as unknown as Function);
        expect(registry.getInstances()).toHaveLength(1);
        expect(registry.getRegistrations()[0].status).toBe('created');
    });

    test('a service without its own factory is built by the default one, with the logger and container of the context', () => {
        @Service('Plain')
        class Plain extends AbstractService {
            public parts(): unknown[] {
                return [this.logger, this.container];
            }
        }
        registry.register(Plain);

        registry.create(ctx);

        expect(container.get<Plain>('Plain')).toBeInstanceOf(Plain);
        expect(container.get<Plain>('Plain').parts()).toEqual([logger, container]);
    });

    test('a subclass inheriting a hand-written factory that builds its parent fails to start', () => {
        const Parent: ServiceClass<TestContext> = lifecycleService('Parent');

        @Service('Child')
        class Child extends (Parent as unknown as new (ctx: TestContext) => AbstractService) {
        }
        registry.register(Child as unknown as ServiceClass<TestContext>);

        expect(() => registry.create(ctx)).toThrow(/did not return a Child/);
    });

    test('create throws when the factory returns something else than the service', () => {
        @Service('Liar')
        class Liar extends AbstractService {
            public static create(context: ServiceContext): AbstractService {
                return new (class Other extends AbstractService {})(context);
            }
        }
        registry.register(Liar);

        expect(() => registry.create(ctx)).toThrow(/did not return a Liar/);
    });

    test('create throws when the name is already taken in the container', () => {
        container.register({}, 'Logger');
        registry.register(lifecycleService('Logger'));

        expect(() => registry.create(ctx)).toThrow(/already registered in the service container/);
    });

    test('initialize runs services in registration order; a service without its own initialize() is valid', async () => {
        @Service('Passive')
        class Passive extends AbstractService {
        }
        registry.register(lifecycleService('A'));
        registry.register(Passive);
        registry.register(lifecycleService('B'));
        registry.create(ctx);

        await registry.initialize();

        expect(ctx.events).toEqual(['create:A', 'create:B', 'start:A', 'start:B']);
        expect(registry.getRegistrations().map((r) => r.status)).toEqual(['initialized', 'initialized', 'initialized']);
    });

    test('a failing initialize() shuts down the initialized services in reverse order and rethrows', async () => {
        registry.register(lifecycleService('A'));
        registry.register(lifecycleService('B'));
        registry.register(lifecycleService('C', {failStart: true}));
        registry.register(lifecycleService('D'));
        registry.create(ctx);

        await expect(registry.initialize()).rejects.toThrow('boom:C');

        expect(ctx.events.filter((e) => !e.startsWith('create:'))).toEqual([
            'start:A', 'start:B', 'start:C', 'stop:B', 'stop:A',
        ]);
        expect(registry.getRegistrations().map((r) => r.status)).toEqual(['shut down', 'shut down', 'failed', 'created']);
    });

    test('shutdown runs in reverse order, continues past a failing shutdown() and is idempotent', async () => {
        registry.register(lifecycleService('A'));
        registry.register(lifecycleService('B', {failStop: true}));
        registry.register(lifecycleService('C'));
        registry.create(ctx);
        await registry.initialize();
        ctx.events.length = 0;

        await registry.shutdown();
        await registry.shutdown();

        expect(ctx.events).toEqual(['stop:C', 'stop:B', 'stop:A']);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });
});
