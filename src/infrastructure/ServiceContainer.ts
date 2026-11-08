export type ContainerKey<T> = abstract new (...args: never[]) => T;

export default class ServiceContainer {
    private readonly services: Map<string | Function, unknown> = new Map<string | Function, unknown>();

    public register<T>(service: T, key: string | ContainerKey<T>): void {
        this.services.set(key, service);
    }

    public get<T>(key: string): T;
    public get<T>(key: ContainerKey<T>): T;
    public get<T>(key: string | ContainerKey<T>): T {
        const service: T | undefined = this.services.get(key) as T | undefined;
        if (!service) throw new Error(`Nie znaleziono instancji o nazwie: ${typeof key === 'string' ? key : key.name}`);
        return service;
    }

    public has(key: string | ContainerKey<unknown>): boolean {
        return this.services.has(key);
    }
}
