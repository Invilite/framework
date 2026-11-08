import fs from "fs";
import path from "path";
import vm from "vm";

const SOURCE: string = fs.readFileSync(path.resolve(__dirname, '../../src/client/socket/websocket-events.js'), 'utf8');

type Message = Record<string, unknown>;
type Listener = (event: {persisted?: boolean}) => void;

class FakePort {
    public readonly sent: Message[] = [];
    public onmessage: ((message: {data: Message}) => void) | null = null;
    public closed: boolean = false;

    public postMessage(message: Message): void {
        this.sent.push(message);
    }

    public start(): void {
    }

    public close(): void {
        this.closed = true;
    }

    public worker(message: Message): void {
        this.onmessage?.({data: message});
    }
}

interface Facade {
    subscribe(name: string, onEvent: (event: {type: string; data: unknown}) => void, onError?: (code: string) => void, onSubscribed?: () => void): () => void;
    send(name: string, type: string, data: unknown): Promise<unknown>;
    onStatus(listener: (status: {state: string; user: number | null}) => void): () => void;
}

interface Page {
    facade: Facade;
    workers: {url: string; options: unknown; port: FakePort; onerror: (() => void) | null}[];
    scripts: {src: string; onload: () => void}[];
    connections: {calls: unknown[][]; on: Record<string, (...args: unknown[]) => void>; options: Record<string, unknown>}[];
    fire(event: string, detail?: {persisted?: boolean}): void;
    root: Record<string, unknown>;
}

function load(user: string, shared: boolean = true): Page {
    const listeners: Record<string, Listener[]> = {};
    const page: Page = {facade: null as unknown as Facade, workers: [], scripts: [], connections: [], fire: (): void => undefined, root: {}};
    const root: Record<string, unknown> = {
        setTimeout, clearTimeout, setInterval, clearInterval, Promise,
        location: {protocol: 'https:', host: 'site.test'},
        addEventListener: (event: string, listener: Listener): void => {
            (listeners[event] = listeners[event] ?? []).push(listener);
        },
        document: {
            currentScript: {
                getAttribute: (name: string): string | null => ({
                    'data-user': user,
                    'data-endpoint': '/socket',
                    'data-worker': '/socket/client/websocket-events-worker.js?v=1&c=2',
                    'data-connection': '/socket/client/websocket-events-connection.js?v=2',
                } as Record<string, string>)[name] ?? null,
            },
            visibilityState: 'visible',
            addEventListener: (): void => undefined,
            createElement: (): {src: string; onload: () => void} => ({src: '', onload: (): void => undefined}),
            head: {appendChild: (element: {src: string; onload: () => void}): number => page.scripts.push(element)},
        },
    };
    if (shared) {
        root.SharedWorker = function (this: Page['workers'][number], url: string, options: unknown): void {
            this.url = url;
            this.options = options;
            this.port = new FakePort();
            this.onerror = null;
            page.workers.push(this);
        };
    }
    root.window = root;
    page.root = root;
    page.fire = (event: string, detail: {persisted?: boolean} = {}): void => (listeners[event] ?? []).forEach((listener: Listener): void => listener(detail));
    vm.runInNewContext(SOURCE, root);
    page.facade = root.WebSocketEvents as Facade;

    return page;
}

function connectionLibrary(page: Page): void {
    page.root.WebSocketEventsConnection = {
        createConnection: (options: {on: Record<string, (...args: unknown[]) => void>}) => {
            const connection: Page['connections'][number] = {calls: [], on: options.on, options: options as unknown as Record<string, unknown>};
            page.connections.push(connection);
            const record: (name: string) => (...args: unknown[]) => number = (name: string) => (...args: unknown[]): number => connection.calls.push([name, ...args]);
            return {subscribe: record('subscribe'), unsubscribe: record('unsubscribe'), expectUser: record('expectUser'), check: record('check'), close: record('close'), send: (): Promise<void> => Promise.resolve()};
        },
    };
}

describe("socket client page facade", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("connects nothing until the first subscription, then talks to the shared worker", () => {
        const page: Page = load('7');
        expect(page.workers).toHaveLength(0);

        const events: unknown[] = [];
        page.facade.subscribe('order:12', (event) => events.push(event));
        const worker: Page['workers'][number] = page.workers[0];
        expect([worker.url, worker.options]).toEqual(['/socket/client/websocket-events-worker.js?v=1&c=2', {name: 'websocket-events:/socket', extendedLifetime: true}]);
        expect(worker.port.sent).toEqual([{type: 'hello', user: 7}, {type: 'sub', ch: 'order:12'}]);

        worker.port.worker({type: 'event', ch: 'order:12', t: 'watchers', d: {count: 3}});
        expect(events).toEqual([{type: 'watchers', data: {count: 3}}]);
    });

    it("cuts a tab off the personal channel when the shared socket belongs to another account", () => {
        const page: Page = load('7');
        const received: unknown[] = [];
        const refusals: string[] = [];
        page.facade.subscribe('user', (event) => received.push(event), (code) => refusals.push(code));
        const port: FakePort = page.workers[0].port;

        port.worker({type: 'status', state: 'open', user: 9});
        port.worker({type: 'event', ch: 'user', t: 'notification', d: {id: 1}});

        expect(received).toEqual([]);
        expect(refusals).toEqual(['account_changed']);
        expect(port.sent).toContainEqual({type: 'unsub', ch: 'user'});
    });

    it("falls back to its own socket when the worker stays silent", () => {
        const page: Page = load('');
        page.facade.subscribe('order:12', (): void => undefined);
        const port: FakePort = page.workers[0].port;

        jest.advanceTimersByTime(5000);
        expect(port.sent).toContainEqual({type: 'detach'});
        expect(page.scripts.map((script) => script.src)).toEqual(['/socket/client/websocket-events-connection.js?v=2']);

        connectionLibrary(page);
        page.scripts[0].onload();
        expect(page.connections[0].calls).toEqual([['expectUser', null], ['subscribe', 'order:12']]);
    });

    it("keeps the worker that answers in time", () => {
        const page: Page = load('');
        page.facade.subscribe('order:12', (): void => undefined);
        page.workers[0].port.worker({type: 'status', state: 'connecting', user: null});

        jest.advanceTimersByTime(10_000);
        expect(page.scripts).toHaveLength(0);
    });

    it("falls back at once when the worker fails to start or SharedWorker is missing", () => {
        const failing: Page = load('');
        failing.facade.subscribe('order:12', (): void => undefined);
        failing.workers[0].onerror?.();
        expect(failing.scripts).toHaveLength(1);

        const old: Page = load('', false);
        connectionLibrary(old);
        old.facade.subscribe('order:12', (): void => undefined);
        // The connection ignores a repeated subscribe; what matters is the account first, then the channel.
        expect(old.connections[0].calls[0]).toEqual(['expectUser', null]);
        expect(old.connections[0].calls).toContainEqual(['subscribe', 'order:12']);
    });

    it("lets go of the worker on pagehide and takes its channels back when restored from the back/forward cache", () => {
        const page: Page = load('');
        page.facade.subscribe('order:12', (): void => undefined);
        const first: FakePort = page.workers[0].port;

        page.fire('pagehide');
        expect(first.sent.slice(-1)).toEqual([{type: 'detach'}]);
        expect(first.closed).toBe(true);

        page.fire('pageshow', {persisted: true});
        expect(page.workers).toHaveLength(2);
        expect(page.workers[1].port.sent).toEqual([{type: 'hello', user: null}, {type: 'sub', ch: 'order:12'}]);
    });

    it("tells each handler of a channel about every confirmed subscription, a late handler of a confirmed channel at once", () => {
        const page: Page = load('7');
        const first: string[] = [];
        const late: string[] = [];
        page.facade.subscribe('order:12', (): void => undefined, (): void => undefined, (): number => first.push('subscribed'));
        const port: FakePort = page.workers[0].port;

        port.worker({type: 'status', state: 'open', user: 7});
        port.worker({type: 'subscription', ch: 'order:12', ok: true, code: null});
        page.facade.subscribe('order:12', (): void => undefined, (): void => undefined, (): number => late.push('subscribed'));
        expect(late).toEqual([]);
        jest.advanceTimersByTime(0);
        expect(late).toEqual(['subscribed']);

        port.worker({type: 'status', state: 'connecting', user: 7});
        port.worker({type: 'status', state: 'open', user: 7});
        port.worker({type: 'subscription', ch: 'order:12', ok: true, code: null});
        expect(first).toEqual(['subscribed', 'subscribed']);
        expect(late).toEqual(['subscribed', 'subscribed']);
    });

    it("does not report a refused subscription as subscribed", () => {
        const page: Page = load('7');
        const subscribed: string[] = [];
        const refusals: string[] = [];
        page.facade.subscribe('order:13', (): void => undefined, (code: string): number => refusals.push(code), (): number => subscribed.push('subscribed'));

        page.workers[0].port.worker({type: 'subscription', ch: 'order:13', ok: false, code: 'blocked'});

        expect(subscribed).toEqual([]);
        expect(refusals).toEqual(['blocked']);
    });

    it("resolves a send with the data of the reply", async () => {
        const page: Page = load('7');
        page.facade.subscribe('order:12', (): void => undefined);
        const port: FakePort = page.workers[0].port;

        const history: Promise<unknown> = page.facade.send('order:12', 'notes.history', {});
        const sent: Record<string, unknown> = port.sent[port.sent.length - 1];
        port.worker({type: 'reply', id: sent.id, ok: true, code: null, d: {messages: [1]}});

        await expect(history).resolves.toEqual({messages: [1]});
    });

    it("connects the page's own socket to the endpoint it was given", () => {
        const page: Page = load('', false);
        connectionLibrary(page);
        page.facade.subscribe('order:12', (): void => undefined);

        expect(page.connections[0].options.url).toBe('wss://site.test/socket');
        expect(page.connections[0].options.sessionUrl).toBe('/socket/session');
    });
});
