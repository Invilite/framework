import ServiceContainer from "../infrastructure/ServiceContainer";

export abstract class AbstractController {
    protected readonly serviceContainer: ServiceContainer;

    public constructor(controllerParameters?: any[]) {
        this.serviceContainer = controllerParameters?.[0];
    }
}