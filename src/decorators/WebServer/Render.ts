import express from "express";
import {ExtendedRequest} from "../../models/ExtendedRequest";
import {NotFoundResponse} from "../../models/response/NotFoundResponse";
import {RedirectResponse} from "../../models/response/RedirectResponse";

export function Render(templateName: string) {
    return function (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        descriptor.value = async function(request: express.Request, response: express.Response, next: express.NextFunction): Promise<void> {
            // Flag the route as SSR before the controller method runs, so the terminal
            // 500 handler knows to render an error page instead of a JSON payload.
            (request as ExtendedRequest).renderRoute = true;

            const data = await originalMethod.call(this, request, response, next);

            if (data instanceof RedirectResponse) {
                response.redirect(data.statusCode, data.location);
                return;
            }

            // Strony HTML są per-user — `no-cache` pozwala
            // trzymać kopię, ale wymaga rewalidacji przy każdym użyciu (304 zamiast pełnej
            // strony). `no-transform` chroni ETag przed skasowaniem przez CDN przy
            // transkodowaniu. Handler może ustawić własny Cache-Control przed returnem.
            if (!response.getHeader('Cache-Control')) {
                response.setHeader('Cache-Control', 'private, no-cache, no-transform');
            }

            if (data instanceof NotFoundResponse) {
                response.status(data.statusCode).render(data.template, {
                    ...data.data,
                    robotsMeta: 'noindex, follow',
                });
                return;
            }

            // Error pages (4xx/5xx) get noindex automatically; controllers can override via robotsMeta.
            const renderData = data ?? {};
            if (response.statusCode >= 400 && !renderData.robotsMeta) {
                response.render(templateName, {...renderData, robotsMeta: 'noindex, follow'});
                return;
            }
            response.render(templateName, renderData);
        };

        return descriptor;
    };
}