import ServiceContainer from '../../src/infrastructure/ServiceContainer';

class Sample {
}

describe('ServiceContainer', () => {
    test('returns an instance registered under its class', () => {
        const container: ServiceContainer = new ServiceContainer();
        const instance: Sample = new Sample();

        container.register(instance, Sample);

        expect(container.get(Sample)).toBe(instance);
    });

    test('keeps string keys working', () => {
        const container: ServiceContainer = new ServiceContainer();
        const instance: Sample = new Sample();

        container.register(instance, 'Sample');

        expect(container.get<Sample>('Sample')).toBe(instance);
    });

    test('does not fall back from a class to its name', () => {
        const container: ServiceContainer = new ServiceContainer();
        const instance: Sample = new Sample();
        container.register(instance, 'Sample');

        expect(container.has(Sample)).toBe(false);
        expect(() => container.get(Sample)).toThrow('Nie znaleziono instancji o nazwie: Sample');
    });

    test('still rejects falsy values', () => {
        const container: ServiceContainer = new ServiceContainer();
        container.register(false, 'Flag');

        expect(() => container.get('Flag')).toThrow('Nie znaleziono instancji o nazwie: Flag');
    });
});
