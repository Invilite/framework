import fs from "fs";
import {Dirent} from "node:fs";
import path from "path";

export interface Domain {
    name: string;
    path: string;
    controllersPath: string | null;
    tasksPath: string | null;
    servicesPath: string | null;
    modulePath: string | null;
}

export default class Domains extends Map<string, Domain> {

    public constructor(protected readonly domainsPath: string) {
        super(null);
    }

    public getDomainsPath(): string {
        return this.domainsPath;
    }

    public static isModuleFile(fileName: string): boolean {
        return /^[A-Z][A-Za-z0-9]*Module\.(ts|js)$/.test(fileName);
    }

    public scan(): string[] {
        const domainsDirs: Dirent[] = fs.readdirSync(this.domainsPath, {
            encoding: 'utf8',
            withFileTypes: true,
            recursive: false}
        ).filter((dirent: Dirent) => {
            return dirent.isDirectory();
        });

        this.clear();

        domainsDirs.forEach((domainDirectory: Dirent): void => {
            const domain: Domain = {
                name: domainDirectory.name,
                path: path.join(domainDirectory.parentPath, domainDirectory.name),
                controllersPath: null,
                tasksPath: null,
                servicesPath: null,
                modulePath: null,
            }

            const controllersPath: string = path.join(domainDirectory.parentPath, domainDirectory.name, 'controllers');
            if (fs.existsSync(controllersPath)) {
                domain.controllersPath = controllersPath;
            }

            const tasksPath: string = path.join(domainDirectory.parentPath, domainDirectory.name, 'tasks');
            if (fs.existsSync(tasksPath)) {
                domain.tasksPath = tasksPath;
            }

            const servicesPath: string = path.join(domainDirectory.parentPath, domainDirectory.name, 'services');
            if (fs.existsSync(servicesPath)) {
                domain.servicesPath = servicesPath;
            }

            const moduleFiles: string[] = fs.readdirSync(domain.path, {withFileTypes: true})
                .filter((dirent: Dirent): boolean => dirent.isFile() && Domains.isModuleFile(dirent.name))
                .map((dirent: Dirent): string => dirent.name)
                .sort();

            if (moduleFiles.length > 1) {
                throw new Error(`[Domains] Domain "${domain.name}" has more than one module file: ${moduleFiles.join(', ')}`);
            }

            if (moduleFiles.length === 1) {
                domain.modulePath = path.join(domain.path, moduleFiles[0]);
            }

            this.set(domainDirectory.name, domain);
        });

        return Array.from(this.keys());
    }
}
