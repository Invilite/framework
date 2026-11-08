import fs from "fs";
import os from "os";
import path from "path";
import Domains from "../../src/infrastructure/Filesystem/Domains";

describe('Domains', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'domains-'));
        fs.mkdirSync(path.join(root, 'calendar', 'services'), {recursive: true});
        fs.mkdirSync(path.join(root, 'calendar', 'controllers'), {recursive: true});
        fs.mkdirSync(path.join(root, 'help', 'controllers'), {recursive: true});
    });

    afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true});
    });

    test('servicesPath points at the services directory when it exists, null otherwise', () => {
        const domains: Domains = new Domains(root);
        domains.scan();

        expect(domains.get('calendar')?.servicesPath).toBe(path.join(root, 'calendar', 'services'));
        expect(domains.get('help')?.servicesPath).toBeNull();
    });

    test('modulePath points at the module file in the domain root, null otherwise', () => {
        fs.writeFileSync(path.join(root, 'calendar', 'CalendarModule.ts'), '');
        const domains: Domains = new Domains(root);
        domains.scan();

        expect(domains.get('calendar')?.modulePath).toBe(path.join(root, 'calendar', 'CalendarModule.ts'));
        expect(domains.get('help')?.modulePath).toBeNull();
    });

    test('modulePath ignores declaration and map files next to the compiled module', () => {
        fs.mkdirSync(path.join(root, 'user'));
        fs.writeFileSync(path.join(root, 'user', 'UserModule.js'), '');
        fs.writeFileSync(path.join(root, 'user', 'UserModule.d.ts'), '');
        fs.writeFileSync(path.join(root, 'user', 'UserModule.js.map'), '');
        const domains: Domains = new Domains(root);
        domains.scan();

        expect(domains.get('user')?.modulePath).toBe(path.join(root, 'user', 'UserModule.js'));
    });

    test('modulePath ignores modules in subdirectories and lowercase names', () => {
        fs.writeFileSync(path.join(root, 'calendar', 'services', 'CalendarModule.ts'), '');
        fs.writeFileSync(path.join(root, 'calendar', 'helperModule.ts'), '');
        const domains: Domains = new Domains(root);
        domains.scan();

        expect(domains.get('calendar')?.modulePath).toBeNull();
    });

    test('two module files in one domain stop the scan', () => {
        fs.writeFileSync(path.join(root, 'calendar', 'CalendarModule.ts'), '');
        fs.writeFileSync(path.join(root, 'calendar', 'PlannerModule.ts'), '');
        const domains: Domains = new Domains(root);

        expect(() => domains.scan()).toThrow('[Domains] Domain "calendar" has more than one module file: CalendarModule.ts, PlannerModule.ts');
    });
});
