# @invilite/framework

A TypeScript framework for Node.js servers built on Express 5. It provides decorator-based routing (`@Controller`, `@Get`, `@Post`, `@Render`, `@RequiresAuth`, `@Upload`, WebSocket `@SocketEndpoint`/`@SocketChannel`/`@SocketMessage`), a PostgreSQL client with transactions and advisory locks, a repository/model layer (`PostgresRepository`, `AbstractModel`), JWT sessions (`SessionService`, `AuthService`), background tasks in worker threads with cron schedules (`TaskService`), a service registry (`@Service`, `AbstractService`, `ServiceRegistry`), a domain module registry (`@Module`, `ModuleRegistry`), WebSocket channels with a browser client, storage adapters (SeaweedFS, S3), Handlebars e-mail, HTTP threat detection, an OAuth authorization server and OpenAI-protocol/Ollama connectors.

## Requirements

- Node.js >= 24.
- TypeScript with `experimentalDecorators` and `emitDecoratorMetadata`: the decorators read and write Reflect metadata.
- `module: "commonjs"` with `moduleResolution: "node"`. The package has no `exports` map and no root entry, so `node16`, `nodenext` and `bundler` resolution cannot resolve the `@invilite/framework/<path>` imports (they fail with TS2307); classic `node` resolution can.
- `reflect-metadata` must be installed (a required peer). The decorator modules import it themselves, so the application does not have to import it; adding `import "reflect-metadata";` once at the application entry point is optional and harmless.

## Installation

```bash
npm install @invilite/framework express@^5.1.0 pg@^8.16.3 nats@^2.29.3 @invilite/logger@^1.1.1 @invilite/eventbus@^1.1.0 reflect-metadata@^0.2.2 zod@^4.1.13 jsonwebtoken@^9.0.2 handlebars@^4.7.8
```

Optional peers, install only the ones whose modules you use:

| Peer | Needed by |
| --- | --- |
| `sharp` and `exifr` | `utils/ImageMetadata` (both imported statically: image dimensions/metadata and EXIF, including GPS) |
| `openai` | `services/OpenAi` (OpenAI-protocol chat completions connector) |
| `@sentry/node` | `services/ErrorTracking` |
| `amqplib` | `infrastructure/Queue` (`AmqpConnection`), `services/amqp`, `decorators/Queue` (loaded lazily; no `@types/amqplib` needed, `AmqpTypes` declares the used surface) |
| `aws4fetch` | `infrastructure/Storage/S3Client`, `infrastructure/Storage/S3Storage` |

The `utils` index does not re-export `ImageMetadata`, so `@invilite/framework/utils` never needs `sharp` or `exifr`.

Type packages: the public `.d.ts` files reference `express`, `pg` and `jsonwebtoken`, so install `@types/express`, `@types/pg` and `@types/jsonwebtoken` (plus `@types/node`) for the code you compile against them. `handlebars`, `nats`, `zod` and `@sentry/node` ship their own types; `@types/ws`, `@types/compression` and `@types/serve-static` come with the framework as regular dependencies.

## Importing

There is no root import: `@invilite/framework` alone does not resolve. A file `src/<path>.ts` is imported as `@invilite/framework/<path>`:

```ts
import WebServer from "@invilite/framework/infrastructure/Server/WebServer";
import {Controller, Get, Render} from "@invilite/framework/decorators/WebServer";
import {Env} from "@invilite/framework/utils";
```

Directory indexes exist for `types`, `utils`, `decorators/WebServer`, `errors/ApplicationError/HttpError`, `infrastructure/Server/helpers` and `infrastructure/Server/http/middleware`; importing the directory (`@invilite/framework/utils`) resolves to them.

## Quick start

Application layout:

```text
src/
    main.ts
    controllers/ArticleController.ts
    views/
        layouts/main.hbs
        articles/list.hbs
```

`src/controllers/ArticleController.ts` (the class must be exported: `WebServer` registers the exported classes of the files it scans):

```ts
import {Request, Response} from "express";
import {Controller, Get, Render} from "@invilite/framework/decorators/WebServer";
import {AbstractController} from "@invilite/framework/controllers/AbstractController";

interface Article {
    id: number;
    title: string;
}

const articles: Article[] = [
    {id: 1, title: "Hello world"},
    {id: 2, title: "Second article"},
];

@Controller("/articles")
export class ArticleController extends AbstractController {

    @Get("/list")
    public async list(request: Request, response: Response): Promise<{ articles: Article[] }> {
        return {articles};
    }

    @Render("articles/list")
    @Get("/page")
    public async page(request: Request, response: Response): Promise<{ articles: Article[] }> {
        return {articles};
    }
}
```

`src/main.ts`:

```ts
import path from "path";
import {Logger} from "@invilite/logger";
import WebServer from "@invilite/framework/infrastructure/Server/WebServer";
import {WebServerOptions} from "@invilite/framework/infrastructure/Server/WebServerOptions";
import {AuthService} from "@invilite/framework/services/AuthService";

async function main(): Promise<void> {
    const logger: Logger = new Logger({processName: "example"});
    const secret: string = "change-me";
    const authService: AuthService = new AuthService("HS256", secret, secret, "example.com");

    const options: WebServerOptions = {
        trustProxy: false,
        controllersPath: path.join(__dirname, "controllers"),
        template: {
            viewsPath: path.join(__dirname, "views"),
        },
    };

    const server: WebServer = new WebServer(logger, options, authService);
    await server.listen(8080);
    logger.notice("Listening on http://localhost:8080");
}

void main();
```

`src/views/layouts/main.hbs`, the default layout, must contain `{{{body}}}` where the page is inserted:

```hbs
<!doctype html>
<html lang="en">
<body>
{{{body}}}
</body>
</html>
```

`src/views/articles/list.hbs`:

```hbs
<h1>Articles</h1>
{{#each articles}}
    <article>{{this.title}}</article>
{{/each}}
```

Minimal `tsconfig.json` of the application:

```json
{
    "compilerOptions": {
        "module": "commonjs",
        "moduleResolution": "node",
        "target": "ESNext",
        "esModuleInterop": true,
        "experimentalDecorators": true,
        "emitDecoratorMetadata": true,
        "outDir": "build",
        "rootDir": "src",
        "strict": true,
        "skipLibCheck": true
    },
    "include": ["src"]
}
```

Build, set the two required environment variables and run:

```bash
npx tsc
cp -r src/views build/views
export COOKIE_SECRET="$(openssl rand -hex 32)"
export HOST_NAME=http://localhost:8080
node build/main.js
```

`GET /articles/list` answers JSON; `GET /articles/page` renders the Handlebars view (`layouts` in `views/layouts`, partials in `views/partials`). `WebServer` scans `controllersPath` recursively for files ending in `Controller.ts` or `Controller.js` and registers the classes decorated with `@Controller`, so it points at the compiled controllers directory: `__dirname` of `build/main.js` is `build`, and `tsc` compiles `src/controllers/` to `build/controllers/`. `COOKIE_SECRET` is read at construction and `HOST_NAME` on every request, so both must be set before the server starts. Behind a reverse proxy, set `trustProxy` to the number of trusted proxy hops or their addresses (for example `1` or `'loopback'`): `true` trusts every hop and lets a direct client name its own address.

## Environment variables

The table lists what the framework reads itself (all through `Env` in `utils/Env`; there is no direct `process.env` access in the framework):

| Variable | Read by | Purpose |
| --- | --- | --- |
| `COOKIE_SECRET` | `infrastructure/Server/WebServer`, `infrastructure/Server/SocketServer` | Signing secret for cookies (`cookie-parser`); required, missing value throws. |
| `HOST_NAME` | `infrastructure/Server/http/middleware/CoreMiddleware` | Origin (base URL) used to build the absolute request URL; required, trailing slash trimmed. |
| `NODE_ENV` | `infrastructure/Task/AbstractTask` | Task worker console log verbosity: 6 in `production`, 8 otherwise (default `development`). Also exposed as `Env.isDevelopment()`. |
| `SEAWEED_HOST` | `infrastructure/Storage/LazySeaweedStorage` | SeaweedFS master host; required when the storage is first used. |
| `SEAWEED_SECRET` | `infrastructure/Storage/LazySeaweedStorage` | SeaweedFS secret; required when the storage is first used. |
| `SEAWEED_REPL` | `infrastructure/Storage/LazySeaweedStorage` | SeaweedFS replication placement, default `010`. |

Additionally, `OpenAiConnector` without `baseURL` passes the decision to the `openai` SDK, which then reads `OPENAI_BASE_URL`; the API key is always passed explicitly (the connector rejects an empty key), so `OPENAI_API_KEY` is not read.

## Registries filled by the application

The framework ships empty registries; the application (its composition root) registers what it knows.

`SecretPaths` masks secret fragments of paths and URLs in logs and error events (each pattern is applied with `String.replace`):

```ts
import {SecretPaths} from "@invilite/framework/utils/SecretPaths";
SecretPaths.register(/\/share\/[A-Za-z0-9_-]{20,}/g, "/share/***");
```

`SecretValues` replaces whole query parameter values that match a pattern with `***` in the database query log (`PgClient`):

```ts
import {SecretValues} from "@invilite/framework/utils/SecretValues";
SecretValues.register(/^[A-Za-z0-9_-]{32,}$/);
```

`TranslationService` holds the messages for `zod` issue codes; `ApiResponse` uses them for validation errors and falls back to the `zod` message:

```ts
import TranslationService from "@invilite/framework/services/TranslationService";
TranslationService.register({invalid_type: "Invalid value type.", too_small: "Value is too short."});
```

## Options worth knowing

- `WebServerOptions.internalErrorMessage`: plain-text message for a 500 response when no handler or template answers. Default (`WebServer.DEFAULT_INTERNAL_ERROR_MESSAGE`): `Internal server error. Please try again later.`
- `TaskService` option `processNamePrefix`: the process name of a task worker. Without it: `task cleanup`. With `"example"`: `example: task cleanup`.

## Module overview

| Folder under `src/` | Responsibility and main classes |
| --- | --- |
| `client/` | Browser WebSocket client (plain JavaScript, served by the socket endpoints). |
| `controllers/` | Controller bases: `AbstractController`, `AbstractSocketController`, `AbstractSocketEndpoint`. |
| `decorators/` | `WebServer/` (routing, auth, upload, sockets: `Controller`, `Get`, `Post`, `Render`, `RequiresAuth`, `Upload`, `SocketEndpoint`, `SocketChannel`, `SocketMessage`, ...), `Service`, `Module`, `Task`, `Queue/QueueConsumer`, `SecretGuard`. |
| `errors/` | `ApplicationError`, one `HttpError` subclass per status, `SqlError`, `StorageError`, `SocketRefusalError`, `SystemError`, `ValidationError`, `UnloadedFieldError`. |
| `infrastructure/` | `Server/` (`WebServer`, `SocketServer`, `SocketRegistry`, middleware), `Database/` (`PgClient`, `PgTransaction`, `AdvisoryLock`), `Storage/` (SeaweedFS, S3, file), `Task/` (`AbstractTask`, `TaskWorker`, `ManagedTask`), `Service/` (`AbstractService`, `ServiceRegistry`), `Module/` (`ModuleRegistry`), `Queue/` (AMQP), `Cache/` (`LRUCache`, `RevalidatingCache`), `ServiceContainer`, `Filesystem/Domains`. |
| `models/` | `AbstractModel`, `ExtendedRequest`, `AuthorizedRequest`, `ExtendedWebSocket`, `RefreshTokenModel`, response objects (`ApiResponse`, `JsonResponse`, `RedirectResponse`, `NotFoundResponse`). |
| `repository/` | `AbstractRepository`, `PostgresRepository` (CRUD, row locks, change tracking). |
| `services/` | `Session/` (`SessionService`, `SessionCookies`), `AuthService`, `TaskService`, `TranslationService`, `Email/` (`HbsEmailService`), `ErrorTracking/`, `ThreatDetection/` (`HttpThreatDetector`), `OAuth/` (`OAuthAuthorizationServer`), `OpenAi/`, `Ollama/`, `SeaweedService`, `Socket/` (`SocketPublisher`, `MemorySocketBroker`, `NatsSocketBroker`), `TokenBlacklistService`, `HeartbeatService`, `IndexNow/`, `amqp/`. |
| `types/` | Shared enums, interfaces and types (`HttpStatusCodes`, `Language`, `RouteDefinition`, `SocketBroker`, task/service/module types). |
| `utils/` | Standalone helpers (`Env`, `DateTime`, `CronExpression`, `String`, `Url`, `ByteSize`, `Semaphore`, `RequestRateLimiter`, ...) plus `SecretPaths`, `SecretValues`. |
| `validators/` | `AbstractValidator`. |

## Documentation

The package tarball carries only `README.md`, `CHANGELOG.md` and `LICENSE`, so the links below are absolute:

- [Task service](https://github.com/Invilite/framework/blob/master/docs/task-service.md)
- [Socket channels](https://github.com/Invilite/framework/blob/master/docs/socket-channels.md)
- [Domain modules](https://github.com/Invilite/framework/blob/master/docs/domain-modules.md)
- [HTTP threat detector](https://github.com/Invilite/framework/blob/master/docs/http-threat-detector.md)
- [OAuth authorization server](https://github.com/Invilite/framework/blob/master/docs/oauth.md)
- [REVIEW.md](https://github.com/Invilite/framework/blob/master/REVIEW.md): traps for contributors
- [CHANGELOG.md](CHANGELOG.md)

## Developing against an application

In this repository run `npm run pack:local`: it builds and creates `dist/invilite-framework-<version>.tgz`. In the application run `npm install --no-save /path/to/framework/dist/invilite-framework-<version>.tgz`, then build and test there; `npm ci` in the application restores the registry version.

Do not use `npm link`: the linked package resolves its peers from its own `node_modules`, so the application ends up with a second copy of `express`, `reflect-metadata` and the rest, which breaks `instanceof` checks and decorator metadata. The tarball install, unlike a link, installs the framework into the application's own `node_modules` next to the single copy of each peer.

## License

GPL-3.0, author Marek Ulwański.
