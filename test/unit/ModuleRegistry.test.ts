import 'reflect-metadata';
import path from 'path';
import {Module} from "../../src/decorators/Module/Module";
import {ModuleRegistry} from "../../src/infrastructure/Module/ModuleRegistry";
import ServiceContainer from "../../src/infrastructure/ServiceContainer";
import {AbstractLogger} from "../../src/types/interfaces/AbstractLogger";
import {ModuleClass, ModuleContext, ModuleOptions} from "../../src/types/types/ModuleTypes";

type TestContext = ModuleContext & {events: string[]};

const logger: AbstractLogger = {
    trace: jest.fn(), debug: jest.fn(), info: jest.fn(), notice: jest.fn(), warning: jest.fn(),
    error: jest.fn(), critical: jest.fn(), alert: jest.fn(), emergency: jest.fn(),
};

function moduleClass(name: string, after: string[] = [], onConstruct?: (context: TestContext) => void): ModuleClass<TestContext> {
    const options: ModuleOptions = after.length > 0 ? {name, after} : {name};

    @Module(options)
    class TestModule {
        public constructor(context: TestContext) {
            context.events.push(`create:${name}`);
            onConstruct?.(context);
        }
    }

    return TestModule;
}

describe('ModuleRegistry', () => {
    let container: ServiceContainer;
    let registry: ModuleRegistry<TestContext>;

    beforeEach(() => {
        jest.clearAllMocks();
        container = new ServiceContainer();
        registry = new ModuleRegistry<TestContext>(logger, container);
    });

    test('creates modules in after order, ties by name', () => {
        registry.register(moduleClass('c', ['a']));
        registry.register(moduleClass('b'));
        registry.register(moduleClass('a'));
        const events: string[] = [];

        registry.create({events});

        expect(events).toEqual(['create:a', 'create:b', 'create:c']);
        expect(logger.notice).toHaveBeenCalledWith('[ModuleRegistry] 3 module(s): a, b, c');
    });

    test('passes the application resources and the library fields', () => {
        const events: string[] = [];
        let received: TestContext | undefined;
        registry.register(moduleClass('a', [], (context: TestContext): void => {
            received = context;
        }));

        registry.create({events});

        expect(received?.events).toBe(events);
        expect(received?.logger).toBe(logger);
        expect(received?.container).toBeDefined();
        expect(received?.modules).toBeDefined();
    });

    test('gives a module the modules it lists in after', () => {
        let received: TestContext | undefined;
        const A: ModuleClass<TestContext> = moduleClass('a');
        const B: ModuleClass<TestContext> = moduleClass('b', ['a'], (context: TestContext): void => {
            received = context;
        });
        registry.register(B);
        registry.register(A);

        registry.create({events: []});

        expect(received?.modules.get(A)).toBe(registry.get(A));
    });

    test('refuses a module outside after', () => {
        const A: ModuleClass<TestContext> = moduleClass('a');
        const B: ModuleClass<TestContext> = moduleClass('b', [], (context: TestContext): void => {
            context.modules.get(A);
        });
        registry.register(A);
        registry.register(B);

        expect(() => registry.create({events: []}))
            .toThrow('[ModuleRegistry] Module "b" uses "a" without listing it in after');
    });

    test('refuses a class that is not a module', () => {
        class NotAModule {
        }
        registry.register(moduleClass('a', [], (context: TestContext): void => {
            context.modules.get(NotAModule);
        }));

        expect(() => registry.create({events: []}))
            .toThrow('[ModuleRegistry] Class "NotAModule" is not a registered module');
    });

    test('validates after before creating anything', () => {
        const selfRegistry: ModuleRegistry<TestContext> = new ModuleRegistry<TestContext>(logger, container);
        selfRegistry.register(moduleClass('a', ['a']));
        const selfEvents: string[] = [];
        expect(() => selfRegistry.create({events: selfEvents}))
            .toThrow('[ModuleRegistry] Module "a" lists itself in after');
        expect(selfEvents).toEqual([]);

        const unknownRegistry: ModuleRegistry<TestContext> = new ModuleRegistry<TestContext>(logger, container);
        unknownRegistry.register(moduleClass('a', ['acount']));
        const unknownEvents: string[] = [];
        expect(() => unknownRegistry.create({events: unknownEvents}))
            .toThrow('[ModuleRegistry] Module "a" lists unknown module "acount" in after');
        expect(unknownEvents).toEqual([]);

        const cycleRegistry: ModuleRegistry<TestContext> = new ModuleRegistry<TestContext>(logger, container);
        cycleRegistry.register(moduleClass('a', ['b']));
        cycleRegistry.register(moduleClass('b', ['a']));
        const cycleEvents: string[] = [];
        expect(() => cycleRegistry.create({events: cycleEvents}))
            .toThrow('[ModuleRegistry] Cycle in after: a -> b -> a');
        expect(cycleEvents).toEqual([]);
    });

    test('reports a cycle from its alphabetically first module', () => {
        registry.register(moduleClass('a', ['c']));
        registry.register(moduleClass('b', ['c']));
        registry.register(moduleClass('c', ['b']));

        expect(() => registry.create({events: []}))
            .toThrow('[ModuleRegistry] Cycle in after: b -> c -> b');
    });

    test('a failing constructor stops the start', () => {
        const error: Error = new Error('boom');
        registry.register(moduleClass('a'));
        registry.register(moduleClass('b', [], (): void => {
            throw error;
        }));
        registry.register(moduleClass('c', ['b']));
        const events: string[] = [];

        let thrown: unknown;
        try {
            registry.create({events});
        } catch (caught: unknown) {
            thrown = caught;
        }

        expect(thrown).toBe(error);
        expect(registry.getRegistrations().map((registration) => registration.status))
            .toEqual(['created', 'failed', 'registered']);
        expect(logger.error).toHaveBeenCalledWith('[ModuleRegistry] Module "b" failed to create:', error);
    });

    test('creates only once', () => {
        registry.register(moduleClass('a'));
        registry.create({events: []});

        expect(() => registry.create({events: []}))
            .toThrow('[ModuleRegistry] Modules are already created');
    });

    test('the module container cannot read', () => {
        class Value {
        }
        const value: Value = new Value();
        registry.register(moduleClass('a', [], (context: TestContext): void => {
            expect(typeof (context.container as {get?: unknown}).get).toBe('undefined');
            context.container.register(value, Value);
        }));

        registry.create({events: []});

        expect(container.get(Value)).toBe(value);
    });

    test('loads one module per file and accepts a double export', () => {
        const alphaPath: string = path.resolve(__dirname, 'fixtures/modules/AlphaModule.ts');

        registry.load([alphaPath]);

        expect(registry.getRegistrations()).toEqual([{
            name: 'alpha',
            className: 'AlphaModule',
            modulePath: alphaPath,
            after: [],
            status: 'registered',
        }]);
    });

    test('rejects files without exactly one module', () => {
        const twinPath: string = path.resolve(__dirname, 'fixtures/modules/TwinModule.ts');
        const plainPath: string = path.resolve(__dirname, 'fixtures/modules/PlainModule.ts');

        expect(() => registry.load([twinPath]))
            .toThrow(`[ModuleRegistry] File "${twinPath}" exports more than one @Module class`);
        expect(() => registry.load([plainPath]))
            .toThrow(`[ModuleRegistry] File "${plainPath}" exports no class decorated with @Module`);
    });

    test('rejects duplicate names and undecorated classes', () => {
        class Plain {
        }
        expect(() => registry.register(Plain as unknown as ModuleClass<TestContext>))
            .toThrow('[ModuleRegistry] Class "Plain" is not decorated with @Module');

        @Module({name: 'same'})
        class FirstModule {
        }
        @Module({name: 'same'})
        class SecondModule {
        }
        registry.register(FirstModule);

        expect(() => registry.register(SecondModule))
            .toThrow('[ModuleRegistry] Module name "same" is already used by class "FirstModule"');
    });
});
