# Code Review Traps

Register of non-obvious behaviors in this framework: things that caused (or could cause) a bug and that a reviewer cannot see from the diff alone. One entry = one trap, in the format **Trap** (what goes wrong) -> *Tell* (how to spot it in a diff) -> *Check* (what to verify), plus the file or symbol. `SEC` marks security-critical entries (data leak, XSS, injection, SSRF, authz). When a trap is fixed systemically, its entry describes the current state; update an existing entry instead of adding a duplicate.

---

## Web server and routing

1. **`@Render` always calls `response.render()` after the method returns.**
   *Tell:* a `@Render`-decorated method that also calls `response.redirect()`, `response.render()`, `response.end()` or `res.status().send()` in its body.
   *Check:* that is a double response (`ERR_HTTP_HEADERS_SENT`). Signal 404 or a redirect by returning the `NotFoundResponse` / `RedirectResponse` sentinel; plain POST handlers without `@Render` may call `response.redirect()` themselves. `src/decorators/WebServer/Render.ts`.

2. **Route registration order is the method declaration order.** A single-segment static route (`@Get('/search')`) declared after `@Get('/:slug')` on the same controller falls into the param handler.
   *Tell:* a new static `@Get`/`@Post` sharing a prefix with a `:param` route of the same controller.
   *Check:* the static route is declared earlier in the file. `src/infrastructure/Server/RegisterRouteMetadata.ts`, `src/infrastructure/Server/WebServer.ts` (`registerControllers`).

3. **The controller scan is order-undefined across files and silently skips classes.** Controllers register in `fs.readdirSync` order (no guarantee between files sharing a prefix with a param route); a file with both `export class Foo` and `export default Foo` registers every route twice; a class that is not a `@Controller`, does not extend `AbstractController`, or has no route is skipped with only a trace/warning log; a constructor that throws abandons the rest of the file with a single `emergency` log line.
   *Tell:* a new controller whose route answers 404 despite correct decorators; `export default` in a controller file; a new controller next to one that has a single-segment `/:param` route.
   *Check:* static and param routes that could collide live in the same file (static first); no default export next to the named class; socket classes are collected during the scan and verified after it (a socket mistake stops the start, see `test/unit/WebServerSocketScan.test.ts`). `src/infrastructure/Server/WebServer.ts` (`registerControllers`).

4. **A route behind a role must answer exactly like a missing path.** `SEC` `@RequiresAuth(roles)` throws `NotFoundError` for anyone without the role (guests included), and the 405 handler answers `respondNotFound` when the caller could use no route of that path. A login redirect, 401, 403 or an open 405 confirms to a scanner that the route exists.
   *Tell:* a hand-written role check in a handler (`request.auth.role !== 'admin'` -> 401/403/redirect), a role route answering its own 404, a change to the 405 registration or `registerNotFoundHandler`.
   *Check:* roles only through `@RequiresAuth([...])`; `WebServer.respondNotFound` stays the single "not found" answer. No test in this repo covers the 405 registration (`test/unit/RequiresAuthMetadata.test.ts` covers the decorator only), so a diff here needs an integration test comparing the answer (status, headers, body) of a role-only path with a missing path for a guest, a logged-in user without the role, and an unlisted HTTP method. `src/decorators/WebServer/RequiresAuth.ts`, `src/infrastructure/Server/WebServer.ts` (405 registration, `respondNotFound`).

5. **`compilerOptions: {preventIndent: true}` in the template engine is load-bearing.** Without it an indented partial invocation prepends spaces to every output line; inside a `<textarea>` prefill those spaces become a markdown code block.
   *Tell:* removal of `preventIndent` or a change to the engine options.
   *Check:* keep it; watch new partials invoked with indentation that feed editable content. `src/infrastructure/Server/WebServer.ts`.

6. **`WebServer.listen` rejects when the port cannot be bound.** A bind error that only goes to the log leaves the process running without a listener while it still holds open WebSockets, which wedges browsers per host. The stop path is the caller's responsibility.
   *Tell:* an `error` handler on the HTTP server that only logs; a startup or shutdown step that waits on a resource without a deadline.
   *Check:* `listen()` must stay a rejecting promise (the caller exits on failure); every stop step in the application bootstrap has a hard timeout. `src/infrastructure/Server/WebServer.ts` (`listen`).

7. **The terminal error handler is always registered.** Without it, `next(err)` from body parsing or middleware reaches Express's final handler, which sends the stack trace outside production. Client errors raised by body parsing (`expose: true`, status 4xx) keep their status with a plain status text; everything else goes through `respondError` (the configured `internalServerError`, or the JSON 500 with `internalErrorMessage`).
   *Tell:* the handler registration made conditional again; a new middleware that answers errors itself.
   *Check:* a malformed JSON body answers 400 without a stack trace, with and without `internalServerError`. `src/infrastructure/Server/WebServer.ts` (`registerInternalServerErrorHandler`).

8. **The request URL is built from `HOST_NAME` and the request path, never from the request target's host.** `SEC` An absolute-form target (`GET http://other.example/x`) would otherwise put a foreign origin into `currentUrl` and `canonicalUrl`, which pages print into meta tags.
   *Tell:* `new URL(request.originalUrl, origin)` used directly; `request.hostname` in URL building.
   *Check:* `test/unit/CoreMiddlewareRequestUrl.test.ts`. `src/infrastructure/Server/http/middleware/CoreMiddleware.ts` (`requestUrlOf`).

9. **`request.ip` is the only client address, and `CoreMiddleware` writes it.** Behind a CDN, Express's own `request.ip` follows `X-Forwarded-For` from the proxy next to the server and gives the CDN edge address, so a second accessor next to it made code pick the wrong one silently: whatever read `request.ip` logged and stored the edge address while other code had the client. Now `clientAddressOf` (CDN header when `trustCloudflare`, otherwise the `trust proxy` chain, never a non-address) runs once per request and `CoreMiddleware` overwrites `request.ip` with the result; the request event carries the same value as `clientAddress`.
   *Tell:* a new property or helper for the client address on the request; `CF-Connecting-IP`, `X-Forwarded-For` or `socket.remoteAddress` read outside `clientAddressOf`; middleware registered before `CoreMiddleware` that reads `request.ip`.
   *Check:* application and framework code read `request.ip` and nothing else; a change of the address rules goes into `clientAddressOf` only. `test/unit/CoreMiddlewareClientAddress.test.ts`. `src/infrastructure/Server/http/middleware/CoreMiddleware.ts`.

---

## Responses and sentinels

1. **A `@Render` method signals 404 by returning `new NotFoundResponse({title})`, never by touching the response.** Calling `response.render('404')` or `response.status(404)` inside the method is a double response; a bare `return;` renders an empty view with status 200 because the route is matched and the terminal 404 handler cannot reach it.
   *Tell:* a not-found branch in a `@Render` method using `response.*`, or a bare `return;` where a 404 page is expected.
   *Check:* the branch returns the sentinel; the controller does not set the status (the sentinel owns it); the `instanceof NotFoundResponse` branch in `Render.ts` is unchanged. `src/models/response/NotFoundResponse.ts`, `src/decorators/WebServer/Render.ts`.

2. **A `@Render` method signals a redirect by returning `new RedirectResponse({location, statusCode})`.** The decorator checks it before `NotFoundResponse` and calls `response.redirect(statusCode, location)` with an explicit status. The location must be a relative path (see `SafeRedirect`); the constructor validates a non-empty location and a 3xx status (304/305 rejected), default 301.
   *Tell:* `response.redirect(...)` inside a `@Render` method; an absolute or `//host` location passed to the sentinel.
   *Check:* the branch returns the sentinel; the location is validated as a local path at the call site. `src/models/response/RedirectResponse.ts`, `src/decorators/WebServer/Render.ts`.

3. **A controller that returns nothing on a plain route gets a 204, and self-responding controllers must not be coerced.** The void branch ends with 204 only when `!response.writableEnded && !request.selfResponding`; `end(data)` after the response finished is `ERR_STREAM_WRITE_AFTER_END` (process crash), while a bare `end()` is a silent no-op.
   *Tell:* changes to the void branch, especially "improving" it to `end('...')`; a controller that ends the response itself and also throws.
   *Check:* both guards stay; `respondError` keeps its `headersSent` guard (log-only when the response already went out); a controller that self-responds sets `selfResponding` when it keeps piping asynchronously. `src/infrastructure/Server/WebServer.ts` (`requestHandler`, `respondError`).

4. **The SSR cache policy is decided in two places: `@Render` on success, `respondError` on a throw.** The decorator only flags the route (`renderRoute`) before calling the method; it sets `private, no-cache, no-transform` after the method returns, and only when the controller did not set its own header. When the method throws, the policy comes from `respondError`, which picks the HTML policy for a `renderRoute` route and `private, no-store` otherwise.
   *Tell:* moving the header set before the method call (a controller-set header must still win); the catch in `requestHandler` applying a cache policy before the route type is known.
   *Check:* SSR 500 stays `private, no-cache, no-transform` and JSON 500 stays `private, no-store`; the decorator's header set stays guarded by `getHeader`; `applyDefaultCacheHeaders` never overrides an explicit header. `src/decorators/WebServer/Render.ts`, `src/infrastructure/Server/WebServer.ts` (`respondError`).

5. **API responses without `Cache-Control` leak across users behind a CDN.** `SEC` A CDN cache key is the URL alone; a per-user JSON 200 stored at the edge is served to everyone. The framework's seam (`applyDefaultCacheHeaders`: `private, no-store` for everything that is not `@Render` HTML) is the single authority.
   *Tell:* a response path that ends the response manually (`response.end()` in a controller or decorator) and bypasses `requestHandler`; a new response type added to `requestHandler` without the seam.
   *Check:* every GET reachable per-user carries `private, no-store`; self-ending paths set the header themselves before `end()` (the pattern is the `@Upload` rejection in `Upload.ts`). `src/infrastructure/Server/WebServer.ts` (`applyDefaultCacheHeaders`).

6. **`express.set('etag', 'strong')` only takes effect on the `res.send()`/`res.render()` path.** The JSON/buffer branches of `requestHandler` finish with `response.end()`, which skips ETag generation and 304 handling - intentional, but easy to break in either direction.
   *Tell:* a change from `end()` to `send()` in `requestHandler`; a new response path expecting ETags.
   *Check:* if `end()` becomes `send()`, set `Content-Type` explicitly first (`send()` defaults a string to `text/html`); verify with response headers on an API route. `src/infrastructure/Server/WebServer.ts`.

7. **Error pages render with a callback; without one a failing template leaks the stack trace.** `SEC` `response.render(template, data)` without a callback forwards a render error to Express's default final handler, which outside `NODE_ENV=production` sends the stack to the visitor.
   *Tell:* `response.render(...)` with fewer than three arguments on an error/404 path; a stack line without a timestamp in the logs.
   *Check:* `renderErrorPage` keeps its callback (log + plain-text fallback); no other error-page render path appears without one. `src/infrastructure/Server/WebServer.ts` (`renderErrorPage`).

8. **`@Upload` without options has no size limit.** The default multer instance is plain `memoryStorage`, so the whole multipart body lands in RAM. With options the decorator bounds the payload, decodes filenames as UTF-8, converts multer rejections into a JSON 413/400 response (self-responding, with its own `Cache-Control`), and skips the controller when the response already went out.
   *Tell:* `@Upload('...')` with one argument on a new route; removal of the `headersSent || writableEnded` guard or of the rejection response's cache header.
   *Check:* public upload routes pass `{maxFileSize}` (and `maxFieldSize` for large text fields, default 64 KiB); image decoding of user input has a pixel limit at the call site. `src/decorators/WebServer/Upload.ts`, `test/unit/UploadDecorator.test.ts`.

---

## Data layer

1. **int8 arrives as `number` globally; the residuals still bite.** `PgTypeParsers` parses int8 into a JS `number` and throws `RangeError` above 2^53. Ids from `request.params` are always **strings**, and a string used as a `Map` key or in `===` with a number silently never matches.
   *Tell:* a param value used directly as a map key or compared to a model id; removal/loosening of the int8 parser; a genuinely 64-bit column (snowflake, hash) read without a cast.
   *Check:* normalize types at the boundary; read 64-bit columns as `::text` and handle them as string/BigInt on purpose. `src/infrastructure/Database/PgTypeParsers.ts`.

2. **`AVG`/`SUM` and other `numeric` results still arrive as strings.** The int8 parser covers only int8; `COUNT(*)` is covered by coincidence. A missing `Number()` at the row-mapping site yields `NaN` silently inside a score.
   *Tell:* a query reading aggregates without `Number(...)` at the mapping site.
   *Check:* every aggregate is wrapped in `Number()` before use. `src/infrastructure/Database/PgTypeParsers.ts`.

3. **A hydrated model throws `UnloadedFieldError` on fields the query did not select.** This replaced the old behavior where an unselected field silently kept its model default (getters lied, `updateOne` wrote defaults back to the DB). Assigning the field marks it loaded; `toJSON` and `updateOne` skip unloaded fields.
   *Tell:* `UnloadedFieldError` in logs or tests; a new explicit SELECT list hydrating a model whose getters callers use; a test fixture built from a partial row.
   *Check:* add the column to the query - never catch the error or fall back to a default; build partial fixtures as `{...new Model().toJSON(), ...fields}`. `src/models/AbstractModel.ts` (`hydrateModel`), `src/errors/UnloadedFieldError.ts`, `test/unit/AbstractModelUnloadedFields.test.ts`.

4. **`insertOne`/`updateOne` serialize `toJSON()`, which skips `_`-prefixed fields.** A new column needs a field + getter/setter + hydration mapping or it silently does not persist; a generated column (`GENERATED ALWAYS ... STORED`) must be declared as `_name` so writes never include it.
   *Tell:* a model field without accessors; a plain (non-underscore) field backed by a generated column.
   *Check:* fields follow the accessor convention; generated columns use the `_` prefix and are read through a getter. `src/repository/PostgresRepository.ts` (`insertOne`), `src/models/AbstractModel.ts` (`toJSON`).

5. **`updateOne` writes only fields changed since hydration.** `getChangedData` diffs against the persisted state, so unselected-but-loaded columns do not overwrite concurrent changes; a model built in code (`new Model()`) has no baseline and writes every field.
   *Tell:* a test or caller expecting `updateOne` to persist a value that was never assigned after hydration.
   *Check:* assign before saving; do not reintroduce whole-model updates. `src/repository/PostgresRepository.ts` (`updateOne`), `src/models/AbstractModel.ts` (`getChangedData`).

6. **A hydrated model read like a `QueryResultRow` gives `undefined`, not an error.** Fields are protected and the id lives in `_id`, so `row.id`/`row.title` on a model are `undefined` at runtime; a parameter typed `(Model | QueryResultRow)[]` hides it from `tsc`.
   *Tell:* `row.<column>` access on a repository result; a mapper parameter typed as a union with `QueryResultRow`.
   *Check:* models are read through getters only. `src/models/AbstractModel.ts`.

7. **A PostgreSQL `date` column hydrates as a `Date` at local midnight.** `toISOString().slice(0, 10)` then returns the previous day in any positive-offset timezone.
   *Tell:* `toISOString()` applied to a value read from a `date` column.
   *Check:* format date-only values with `toLocaleDateString('sv-SE', {timeZone})`; `toISOString()` is only for `timestamptz`. `src/models/AbstractModel.ts` (`hydrateModel`).

8. **`PostgresRepository` interpolates schema, table and `*ByField` names into SQL.** `SEC` Schema and table are validated once in the constructor; `getOneByField`/`getManyByField`/`deleteByField` validate the caller-supplied field with `/^[A-Za-z_][A-Za-z0-9_$]*$/` and throw otherwise. Identifiers are deliberately not quoted (quoting changes case semantics); `insertOne`/`updateOne` column names come from model internals.
   *Tell:* a new public SQL-building method taking a field/schema/table string without `assertIdentifier`; identifier quoting added "for safety".
   *Check:* invalid identifiers throw before any query; uppercase, digits and `$` stay allowed. `src/repository/PostgresRepository.ts`, `test/unit/PostgresRepositoryUpdateOne.test.ts`.

---

## Database client

1. **`SqlError` must carry `code` and `constraint`.** The wrapper re-throws every driver error; dropping the SQLSTATE kills every `e?.code === '23505'` branch (unique violations become a 500).
   *Tell:* a `catch` reading `e.code`/`e.constraint`; a change to the re-throw in `PgClient.getClient()`.
   *Check:* the constructor receives `e.code` and `e.constraint`; the branch is covered by a test with a real violation. `src/errors/ApplicationError/SqlError.ts`, `src/infrastructure/Database/PgClient.ts`.

2. **A JS array bound to a `jsonb` column is sent as a PostgreSQL array literal, not JSON.** node-pg serializes objects via `JSON.stringify` but arrays as `{...}` array syntax, so an array of objects becomes `{"[object Object]"}` and the INSERT fails with `invalid input syntax for type json`.
   *Tell:* a query parameter holding an array destined for `jsonb`.
   *Check:* pass arrays as `JSON.stringify(value)` with `$n::jsonb`; plain objects may go directly. `src/infrastructure/Database/PgClient.ts`.

3. **PostgreSQL rejects U+0000 in `text` and `jsonb`.** One NUL byte inside a string parsed from an uploaded file (cameras pad EXIF/maker-note strings) turns the whole INSERT into a 500.
   *Tell:* a new code path storing file-derived strings (EXIF, XMP/IPTC, PNG comments) that skips the shared readers; a new parser option added to `ImageMetadata`.
   *Check:* file-derived data passes through `NulChar.strip` before the query (`ImageMetadata.readExif`/`readMetadata` already do); user-typed text is not stripped, so keep NUL out of the payload at the validation layer. `src/utils/NulChar.ts`, `src/utils/ImageMetadata.ts`.

4. **A manual `BEGIN`/`COMMIT` without `try/finally` leaks a `PoolClient`.** `PgTransaction.run` wraps begin/rollback/commit/release once; hand-rolled transactions on a raw `getClient()` lose the connection on any throw.
   *Tell:* `client.query('BEGIN')` outside `PgTransaction`; a `release()` that is not in a `finally`.
   *Check:* transactional code goes through `PgTransaction.run` (or replicates its rollback + release guarantees). `src/infrastructure/Database/PgTransaction.ts`.

5. **Advisory lock namespaces collide silently.** `pg_advisory_*_lock(namespace, key)` namespaces are bare constants chosen by each caller; two services that pick the same number block each other on `hashtext` collisions. Text keys go through `hashtext`; casting a bigint key to `int` throws above 2^31-1.
   *Tell:* a new numeric namespace literal in a call instead of one shared registry constant; `$n::int` on an id that can exceed 2^31-1.
   *Check:* every namespace comes from a single registry with a uniqueness test (the application owns the registry); keys use `hashtext($n::text)`. `src/infrastructure/Database/AdvisoryLock.ts`.

6. **`COMMIT` returns the tag `ROLLBACK` instead of throwing when the transaction is aborted.** If `work()` caught a failing statement, PostgreSQL has already aborted the transaction; reporting success silently drops every write. `PgTransaction.run` treats any tag other than `COMMIT` as a failure and throws.
   *Tell:* `await client.query('COMMIT')` whose result is ignored; a `catch` inside a transaction callback that swallows a query error.
   *Check:* `run()` rejects with "Transaction was rolled back" and still releases the client. `src/infrastructure/Database/PgTransaction.ts`, `test/unit/PgTransaction.test.ts`.

---

## Cache

1. **`RevalidatingCache` keeps serving the stale value until the background refresh finishes (stale-while-revalidate).** After the TTL every `get()` returns the expired data and only triggers the refresh; the refreshed value first appears once the in-flight fetch completes.
   *Tell:* a cache test asserting the new value immediately after the TTL.
   *Check:* wait for the refresh to finish (await the promise returned by `refresh()`, or poll past completion) or use a fresh instance before asserting the new value. `src/infrastructure/Cache/RevalidatingCache.ts` (`get`).

2. **`clear()` vs a fetch already in flight.** A refresh started before `clear()` must not store its (older) result afterwards; the generation counter makes the stale store impossible.
   *Tell:* a new cache class with `clear()` and a background refresh; removal of the generation check.
   *Check:* a result fetched before `clear()` is returned to its caller but not stored; `test/unit/RevalidatingCacheClear.test.ts` stays green. `src/infrastructure/Cache/RevalidatingCache.ts`.

---

## Sessions and authentication

1. **Any failed cookie token triggers an inline refresh, not a specific error branch.** Missing, expired, bad-signature and blacklisted cookie tokens all lead to `session.refresh()` in the same request; tying the refresh to one error (e.g. `TokenExpiredError`) or to the cookie's presence creates a dead branch: the cookie often disappears at the same moment the token expires, so users are logged out mid-session.
   *Tell:* a diff that narrows the refresh condition; a redirect to a token endpoint instead of the inline refresh.
   *Check:* `test/unit/AuthorizationMiddleware.test.ts` covers the "access cookie gone" case. `src/infrastructure/Server/http/middleware/AuthorizationMiddleware.ts`.

2. **A storage failure during refresh must not clear the cookies.** Only a certain refusal (token unknown, expired, revoked, identity refused) clears both cookies; a DB error keeps them and the request proceeds as anonymous.
   *Tell:* `cookies.clear` inside the `catch` of the refresh path.
   *Check:* the catch only logs; the refusal branch clears. `src/services/Session/SessionService.ts` (`refresh`).

3. **Cookies and refresh tokens exist only through `SessionService`.** Names, options and `maxAge` come from `SessionCookies` (lifetime always derived from the token TTL); the JWT payload's `userId`/`username` are set by `SessionService` and cannot be overridden by the application's metadata.
   *Tell:* `response.cookie('accessToken'|'refreshToken', ...)` or `createToken(` outside the session services; a manual `revokeAllForUser` + blacklist pair instead of `endAll`.
   *Check:* session writes go through `SessionService` (`start`/`refresh`/`reissue`/`end`/`endAll`); `endAll` revokes the store first, then broadcasts the blacklist. `src/services/Session/SessionService.ts`, `src/services/Session/SessionCookies.ts`.

4. **`SameSite=Lax` means no GET may mutate session state.** `SEC` Lax (required so following an external link does not land on a guest page) sends cookies on cross-site GET navigations; a state-changing GET is therefore a CSRF.
   *Tell:* a new `@Get` that inserts/updates/deletes on the logged-in user.
   *Check:* mutations use POST/PUT/DELETE (logout included) or a token-bearing link. `src/services/Session/SessionCookies.ts` (`options`).

5. **Static files must be registered before the auth middleware.** `SEC` Otherwise a session refresh can attach `Set-Cookie` to a publicly cacheable asset, and a CDN may store and replay it to other users.
   *Tell:* a diff moving `express.static` behind `AuthorizationMiddleware` in the constructor.
   *Check:* the static block stays before the auth middleware (the constructor comment documents the reason). `src/infrastructure/Server/WebServer.ts`.

6. **Refresh token rotation would need a grace window.** Today the token is not rotated, so parallel refreshes (several tabs) are harmless; introducing rotation without accepting the previous token briefly logs users out on concurrent requests.
   *Tell:* a `replaced_by`/rotation change in the store or `refresh`.
   *Check:* rotation accepts the predecessor for a short window. `src/services/Session/SessionService.ts` (`refresh`).

7. **Token blacklist semantics: `iat` is in seconds, revocations move forward, and the map is in-memory.** Comparing `iat` (seconds) with `Date.now()` (ms) makes the blacklist never match; keeping `Math.min` of two revocations resurrects tokens issued between them. The map survives a restart or a missed NATS message only through the application's `TokenRevocationSource` (read on `start()` and after every transport reconnect): a revocation the source does not return is lost on restart and revoked access tokens work again for up to the TTL. `start()` rejects when the source fails, and `revokeAllForUser` resolves `false` when NATS did not confirm the broadcast within `REVOCATION_CONFIRM_TIMEOUT_MS`.
   *Tell:* a comparison without `/1000`; `Math.min` in `rememberRevocation`; `start()` loading the source before subscribing to the transport (a broadcast during the load is lost); an application that adds a new way to end sessions (`endAll`) without extending its source; a source returning revocations older than the TTL (they only fill the map); a caller of `endAll`/`revokeAllForUser` on an admin path that ignores the `false` result.
   *Check:* `test/unit/TokenBlacklistService.test.ts` (seconds, monotonicity, source, reconnect) stays green. `src/services/TokenBlacklistService.ts`, `src/services/NatsTokenRevocationTransport.ts`.

8. **A Bearer token with the default audience is a full web session.** `SEC` `verifyToken` defaults to `aud: ['web']`, so a token minted for an API/MCP client verifies everywhere `AuthorizationMiddleware` runs, including write routes, although it never had a cookie.
   *Tell:* a new route accepting `Authorization: Bearer` without choosing an audience; a change to the default audience list.
   *Check:* token-issuing paths mint a distinct audience and verifying routes pass it explicitly to `verifyToken(token, ['...'])`. `src/services/AuthService.ts` (`createToken`/`verifyToken`).

9. **`@RequiresAuth` on a socket entry point is read from metadata, not the wrapper.** The HTTP wrapper reads `request.auth` from the first argument; socket methods receive `(ws, request)` and call `unguardedMethod`. The upgrade path checks the requirement before the handshake (401 guest / 404 missing role); `@SocketMessage` handlers check it before the method.
   *Tell:* a socket code path calling `controller[method]` instead of `unguardedMethod`, or reading roles differently than `readRequiredAuth`.
   *Check:* `test/unit/RequiresAuthMetadata.test.ts`, `test/unit/SocketDecorators.test.ts` stay green. `src/decorators/WebServer/RequiresAuth.ts`, `src/infrastructure/Server/SocketRegistry.ts`.

10. **Middleware running on a WebSocket upgrade sees a fake request/response.** `SEC` The adapter builds a minimal req (no `query`, no Express parser chain) and res (no `redirect()`); a middleware written for HTTP can crash the process from a promise handler (an unhandled rejection kills Node), and an unreturned promise chain lets the upgrade proceed before auth settles.
    *Tell:* new middleware on the upgrade path assuming `request.query`/`response.redirect` exist; an async middleware whose internal promise chain is not returned; removal of the try/catch or the `typeof response.redirect === 'function'` guard.
    *Check:* upgrade middleware tolerates the missing fields; the adapter awaits the chain; failures end in `rejectHandshake` (401/500); `test/unit/SocketServerUpgrade.test.ts` and `test/unit/AuthorizationMiddleware.test.ts` stay green. `src/infrastructure/Server/MiddlewareAdapter.ts`, `src/infrastructure/Server/SocketServer.ts`.

---

## Tasks and scheduling

1. **Worker messages are dispatched by `'key' in message`, never by truthiness.** Falsy payloads (`0`, `''`, `false`, `null`) must still reach the stats; the `result` key only stores, `error`/`data`/`message` emit.
   *Tell:* a change to the `worker.on('message')` handler using `message?.message` style checks.
   *Check:* falsy payloads reach the stats (`test/unit/ManagedTask.test.ts`). `src/infrastructure/Task/TaskWorker.ts`.

2. **Run accounting: no boot-time state report, `error` before `idle`, `idle` ignored without `inFlight`.** A constructor-time `isRunning:false` would count as a phantom success; a state message outside a dispatched run is either the boot report or the reset after an error, and the idle handler must ignore both.
   *Tell:* `postMessage` of state in `initializeWorker`; reordering `sendError` after the `finally` in `startTask`; dropping the `inFlight` guard.
   *Check:* `successCount == startedCount` after N successful runs; a failed run reports `error` then `idle`. `src/infrastructure/Task/AbstractTask.ts`, `src/infrastructure/Task/ManagedTask.ts`.

3. **A dead worker kills the schedule; a failed run does not.** Worker exit (any code, except a stop) clears the timer and marks the task crashed - no respawn by design; an `error` from a run leaves the thread alive, so the next cron occurrence is a fresh run, not a retry. The exit handler's `status !== 'crashed'` guard prevents double-counting when an error is followed by an exit.
   *Tell:* timer cleanup in the `error` handler; auto-respawn in the `exit` handler.
   *Check:* after an error `nextRunAt` is still defined; recovery is a restart or an explicit `TaskService.startTask(name)`. `src/infrastructure/Task/ManagedTask.ts`.

4. **`setTimeout` delays above ~24.8 days are clamped to 1 ms.** Monthly/yearly schedules would fire immediately and busy-loop; `MAX_ARM_DELAY_MS` (24 h) caps the arm delay and the early-wake branch re-arms until the occurrence is due. Ticks never overlap: a tick during a run is counted as skipped, and the timer is always a self-re-arming `setTimeout` (never `setInterval`), unref'd.
   *Tell:* `setInterval` in the scheduler; removal of the cap or of the `armedFor` early-wake check.
   *Check:* after a capped tick `startedCount` does not grow and `nextRunAt` still points at the same occurrence (`test/unit/ManagedTask.test.ts`, rare-schedule case). `src/infrastructure/Task/ManagedTask.ts`.

5. **`CronExpression.next()` iterates wall-clock time, materializing each match through DST candidates.** A UTC-cursor loop skips the first instant of a fall-back overlap; ambiguous wall times map to two round-trip-verified UTC instants (and none during a spring gap).
   *Tell:* a rewrite of `next()` onto a UTC cursor; collapsing `wallTimeToUtcCandidates` to a single result.
   *Check:* `test/unit/CronExpression.test.ts` keeps the fall-back/gap cases. `src/utils/CronExpression.ts`.

6. **Two `start()` calls in one tick can double-dispatch a raw `TaskWorker`.** `workerRunning` is only confirmed by a message from the thread; `ManagedTask` guards this synchronously via `inFlight`.
   *Tell:* a new unmanaged consumer of `TaskWorker` calling `start()` from multiple triggers.
   *Check:* serialize dispatches in the caller or go through `ManagedTask`. `src/infrastructure/Task/TaskWorker.ts` (`start`).

7. **The worker bootstrap must not interpolate a module path or class name into code.** A path containing `'` or `\` breaks the generated `require`, and a default export is registered as className `default`, producing `const default = ...` (SyntaxError). `TaskService` passes both through `workerData` and looks the class up as `module[className]`.
   *Tell:* a `${...}` inside the `new Worker(workerCode, ...)` template; a new field added to `workerData` but still interpolated in the code.
   *Check:* worker code contains no task-specific text; a default-exported task registers with className `default` and spawns. `src/services/TaskService.ts` (`startWorker`), `test/unit/TaskServiceWorkerData.test.ts`.

8. **Anything a task throws must be normalized to `Error` before it crosses the worker boundary.** `throw null` passes a `typeof error === 'object'` check and `undefined` becomes an empty-message error, so a parent reading `error.message` crashes. `AbstractTask.sendError`, `TaskWorker.handleMessage` and `ManagedTask` all use `instanceof Error ? error : new Error(String(error))`.
   *Tell:* `typeof error === 'object'`; `error.message`/`error.stack` on a caught value typed `unknown`.
   *Check:* `test/unit/AbstractTaskSendError.test.ts`, `test/unit/TaskWorker.test.ts` and the null-error case in `test/unit/ManagedTask.test.ts` stay green. `src/infrastructure/Task/AbstractTask.ts`, `src/infrastructure/Task/TaskWorker.ts`, `src/infrastructure/Task/ManagedTask.ts`.

---

## Services and modules

1. **A domain module's container view is `register`/`has` only.** Casting `context.container` to `ServiceContainer` to call `get` restores grabbing other domains' objects by name with no startup error; cross-module access goes through `context.modules.get(...)` on a module declared in `after`.
   *Tell:* `as ServiceContainer` or an import of `ServiceContainer` inside a module file.
   *Check:* `test/unit/ModuleRegistry.test.ts` stays green; modules only use the narrowed view. `src/infrastructure/Module/ModuleRegistry.ts`, `src/types/types/ModuleTypes.ts`.

2. **One `NatsTokenRevocationTransport` instance holds one subscription.** `SEC` Re-subscribing replaces the `subscription` field; sharing a single instance between two services silently disables one of them on the revocation subject.
   *Tell:* the same transport instance passed to two services; a second `start()` on one instance.
   *Check:* every subscriber owns its instance and both `start()` calls run. `src/services/NatsTokenRevocationTransport.ts`.

3. **AMQP `onReconnect` callbacks run only after a successful connect.** `connect()` swallows its own failure and schedules the next retry, so the retry timer must check `connected` before notifying; otherwise every consumer resubscribes on a dead connection and fails on each attempt.
   *Tell:* `await this.connect(); await this.notifyReconnect();` without a `this.connected` guard; a failure path that calls the reconnect callbacks.
   *Check:* a failed retry leaves `onReconnect` uncalled; a successful retry calls it once. `src/infrastructure/Queue/AmqpConnection.ts` (`scheduleReconnect`), `test/unit/AmqpConnection.test.ts`.

---

## WebSocket channels and browser client

1. **The browser client is plain `.js`; `tsc` does not emit it.** The package build stages `src/client/socket` into the output next to the compiled code; an application compiling the framework from source without copying that directory gets `ENOENT` from the `socketClient` helper at first render.
   *Tell:* a build script change dropping the copy step; an app build that only runs `tsc`.
   *Check:* the compiled output contains `client/socket/websocket-events*.js`; `SocketRegistry` resolves `CLIENT_DIRECTORY` next to `__dirname`. `scripts/stage-package.js`, `src/infrastructure/Server/SocketRegistry.ts`.

2. **Framework routes `<endpoint>/session` and `<endpoint>/client/:file` must stay reachable.** They are registered after the application's middleware; a gate middleware (age gate, geo, auth wall) that redirects them breaks the client script (a `SyntaxError` in the browser) or loops the identity check.
   *Tell:* a new catch-all middleware or gate without exemptions.
   *Check:* the gate's test requests both paths without credentials and expects 200. `src/infrastructure/Server/SocketRegistry.ts`.

3. **A slow or never-resolving `@SocketMessage` handler blocks the connection.** Messages of one connection in one channel run in order, so awaiting a slow external service delays every next frame of that tab; `leave` waits for the in-flight method and `disconnect` waits for all leaves, so a method that never returns leaves presence stuck forever.
   *Tell:* `await` on an external API or unbounded queue inside a `@SocketMessage` method.
   *Check:* long work moves out of the method (task/queue, result published via `SocketPublisher`); channel methods finish in bounded time. `src/infrastructure/Server/socket/SocketHub.ts`.

4. **`context.state` lives in the memory of one instance.** A reconnect (possibly to another instance) starts from zero.
   *Tell:* anything in `state` whose loss changes outcomes (permission, durable counter).
   *Check:* state holds only caches and rate limiting; rules and counters live in the database. `src/types/interfaces/SocketContext.ts`.

5. **Every `join` side effect needs its `leave` counterpart, exactly once.** `leave` runs after each `join` that returned `true`, including when the client unsubscribed during the join.
   *Tell:* a `join` that writes (presence, membership) with no matching cleanup in `leave`.
   *Check:* the channel's test asserts the join/leave pair. `src/infrastructure/Server/socket/SocketHub.ts`.

6. **The SharedWorker URL carries two versions.** The worker address (`v=`) and the connection core it imports (`c=`) are both derived from file contents; changing the core without changing the worker address leaves new tabs on an old worker importing an old core.
   *Tell:* a change to how `data-worker`/`data-connection` URLs are built; a fix tested only in the no-worker mode.
   *Check:* `SocketRegistry.scriptTag` keeps both parameters; `test/unit/SocketClientFacade.test.ts` stays green. `src/infrastructure/Server/SocketRegistry.ts`, `src/client/socket/websocket-events-worker.js`.

7. **Closing a port on the worker side orphans the tab forever.** The other end gets no event and its messages vanish without an error; a port may only be closed on `detach` or a `postMessage` failure.
   *Tell:* `port.close()` in cleanup of silent/expired tabs.
   *Check:* an expired port loses its channels and is rebuilt by the tab's next signal; `test/unit/SocketClientWorker.test.ts` stays green. `src/client/socket/websocket-events-worker.js`.

8. **One `SocketPublisher` per application, shared with the hub.** The hub takes its broker and subject prefix from `options.socket.publisher`; a second publisher (different prefix or broker) makes published events miss the sockets subscribed through the hub.
   *Tell:* a second `SocketPublisher` constructed for domain code; a different instance passed in `WebServerOptions.socket`.
   *Check:* a single instance in the container, the same one given to `WebServer`. `src/services/Socket/SocketPublisher.ts`, `src/infrastructure/Server/SocketRegistry.ts`.

9. **Presence derives from the last beat time, never from KV expiry.** KV TTL expiration produces no reliable watch event, and a per-user `get` is a broker round-trip per listing; the tracker subscribes to the heartbeat subjects **before** snapshotting (a beat during the snapshot must not be overwritten by an older entry) and keeps `Math.max` of timestamps.
   *Tell:* `kv.watch` replacing the subject subscription; a `get` in the liveness path; ordering changes in `start`.
   *Check:* `test/unit/HeartbeatTracker.test.ts` (snapshot/beat race) stays green. `src/services/HeartbeatTracker.ts`.

10. **An exception thrown from a NATS subscription callback stops the connection's reader loop.** A malformed heartbeat JSON or a throwing `deliver()` must never escape the callback; `HeartbeatService.watch` ignores unparseable/non-boolean payloads and `NatsSocketBroker` routes delivery failures to its `failed` callback.
   *Tell:* `JSON.parse(...)` or `deliver(...)` directly inside a `callback:` without try/catch; a new subscription wrapper that forgets this.
   *Check:* malformed messages are ignored and a throwing consumer calls `failed`; `test/unit/HeartbeatService.test.ts`, `test/unit/NatsSocketBroker.test.ts`. `src/services/HeartbeatService.ts` (`watch`), `src/services/Socket/NatsSocketBroker.ts`.

11. **A JetStream KV promise created in a constructor poisons the service when JetStream is down at boot.** Nobody awaits that rejected promise (an unhandled rejection kills the process) and every later call reuses it. `HeartbeatService` creates the bucket lazily on first use and clears the cached promise on rejection so the next call retries.
   *Tell:* `private readonly status = this.jetStreamClient.views.kv(...)` in a constructor; a cached promise returned without a rejection reset.
   *Check:* construction does not touch JetStream; after a boot failure the next `beat()`/`isAlive()` retries. `src/services/HeartbeatService.ts` (`getStatus`), `test/unit/HeartbeatService.test.ts`.

12. **One upgrade listener per HTTP server answers every upgrade request.** `SEC` Upgrades arrive before Express, without its error handling: a throw in an async listener is an unhandled rejection, a client reset while the upgrade awaits the middleware or `beforeUpgrade` is an unhandled socket `error`, and an upgrade nobody answers keeps the socket open. Each kills the process or leaks sockets from a single unauthenticated request. The listener reads the path from the request target only (never from `Host`), attaches a socket `error` handler first, answers 404 for a path without a socket server and 500 for a failed handler; `SocketServer` calls the `connection` listeners itself and closes the socket (1011, or 4401 for `UnauthorizedError`) when one throws or rejects.
   *Tell:* a new `server.on('upgrade', ...)`; `new URL(..., request.headers.host)`; an `await` in the upgrade path before the socket has an `error` handler; `emit('connection', ...)` replacing the listener loop.
   *Check:* `test/unit/SocketServerUpgrade.test.ts` ("SocketServer upgrade robustness") stays green. `src/infrastructure/Server/SocketServer.ts`.

13. **`presenceChanged` runs on one instance per change.** The instance that decided it calls the hook once for the whole cluster, so state or sockets touched there reach only that instance's clients.
    *Tell:* a `presenceChanged` that writes to a local map, `context.state` or local sockets instead of publishing; a publish from the `enter`/`exit` path of the presence.
    *Check:* the hook publishes through `SocketPublisher` or writes shared storage; consumers treat `joined` of a present account and `left` of an absent one as no-ops and read `members()` for the truth. `src/services/Socket/SocketPresence.ts`.

---

## Storage

1. **aws4fetch silently sends `UNSIGNED-PAYLOAD`.** `SEC` For `service: 's3'` it skips signing the body when the header is absent, so the SigV4 signature does not cover the payload even though it is a Buffer.
   *Tell:* removal of the content hash header in `S3Client.send()`.
   *Check:* `X-Amz-Content-Sha256` is set to the SHA-256 of the body (empty string for bodyless requests) before `aws.sign()`; the unit test compares header and hash. `src/infrastructure/Storage/S3Client.ts`.

2. **An interrupted upload must destroy the source stream.** `putStream` aborts the multipart upload and rethrows; without `stream.destroy()` the source (file, HTTP response) stays paused with an open descriptor.
   *Tell:* a `catch` in `putStream` that only aborts the multipart and rethrows.
   *Check:* every error path calls `stream.destroy()`; the test asserts `destroyed === true`. `src/infrastructure/Storage/S3Storage.ts` (`putStream`).

3. **Only the common S3 operation set is supported.** The client implements just the operations all major R2-compatible providers agree on (Put, Get with Range, Head, Delete, the four multipart calls); anything else (object ACLs, tagging, checksums, listing, presigning, batch delete) is not portable.
   *Tell:* a new method using `x-amz-meta-*`, `x-amz-checksum-*`, ACLs, tags, `DeleteObjects` or listing.
   *Check:* extend only after verifying the behavior on every supported provider. `src/infrastructure/Storage/S3Client.ts`.

4. **Content type is inferred from the key's extension when not passed explicitly.** Saving WebP bytes under a `.jpg` key serves `image/jpeg`; browsers may refuse to render the image.
   *Tell:* a `put(key, ...)` without `contentType` where the key's extension does not match the encoding.
   *Check:* pass `options.contentType` whenever the extension can lie. `src/infrastructure/Storage/AbstractStorage.ts` (`inferContentType`), `src/infrastructure/Storage/SeaweedStorage.ts`.

5. **Seaweed keys and multipart filenames are placed into a filer URL and `Content-Disposition`.** `SEC` `a/../b` is normalised by the URL, `?`/`#` change the filer request, and `"`/CR/LF inject a header. `SeaweedStorage` rejects empty keys, empty/`.`/`..` segments, `?`, `#`, `%`, `\`, quotes, whitespace, control characters and NUL with `StorageError('INVALID_PATH')` (uppercase stays allowed); `SeaweedService` sanitizes the multipart filename.
   *Tell:* a new path that builds a filer URL or an upload filename without the shared validation/sanitizer; a lowercase-only key regex (would reject existing keys).
   *Check:* invalid keys are rejected before any request and the sanitized filename contains no quotes or CR/LF; `test/unit/SeaweedStorage.test.ts`, `test/unit/SeaweedService.test.ts`. `src/infrastructure/Storage/SeaweedStorage.ts` (`assertValidKey`), `src/services/SeaweedService.ts` (`sanitizeFilename`).

---

## E-mail

1. **Handlebars auto-escapes `{{ }}` but not `{{{ }}}` - in e-mail templates too.** `HbsEmailService` compiles templates with `Handlebars.compile`; a triple-stash around user-controlled data is an HTML injection in the mail body (and the plaintext fallback is derived from that HTML).
   *Tell:* `{{{` in any e-mail template rendering user content; pre-sanitized values passed through double braces.
   *Check:* user content only through `{{ }}`, or pre-sanitized before a triple-stash. `src/services/Email/HbsEmailService.ts`.

---

## Error tracking

1. **Every `error`/`critical`/`alert`/`emergency` log line leaves the server.** `SEC` The transport ships the message text (and object args) to the external tracker; PostgreSQL also embeds row values in the error `detail` (`Key (email)=(...)`), which `SqlError` carries in its message.
   *Tell:* `logger.error/critical(...)` with request bodies, SQL parameter values, e-mails, tokens or message content; a new field in `SqlError`; re-enabling the Console integration or loosening `dataCollection`.
   *Check:* values stay on `debug`/`trace` only (the `PgClient` pattern: SQL + parameter count on `critical`, values in a separate `debug` line); new error formats get a mask in `ErrorTracking.scrubText`. `src/services/ErrorTracking/ErrorTrackingTransport.ts`, `src/services/ErrorTracking/ErrorTracking.ts`, `src/infrastructure/Database/PgClient.ts`.

2. **A number inside an error message is a separate issue and a separate quota slot.** The transport groups by text with numbers replaced by `<n>` and throttles repeats; an error logged in a loop with an identifier in the text exhausts the tracker quota.
   *Tell:* `error` logs inside a loop or a per-request path; a numeric id (or any changing token) in the message text.
   *Check:* non-numeric identifiers move to a separate `debug` line correlated by `requestId`; the `RepeatThrottle` window stays configured. `src/services/ErrorTracking/ErrorTrackingTransport.ts`, `src/utils/RepeatThrottle.ts`.

---

## Threat detection

1. **`EventBus.emit` is synchronous.** A subscriber of `http.request.received` runs before `next()` and delays every response; request analysis belongs on `http.request.completed` (emitted after the response is sent).
   *Tell:* a new `on('http.request.received', ...)`; I/O, external calls or batching in an `http.request.*` subscriber.
   *Check:* only in-memory microsecond-scale inspection stays synchronous; anything costlier moves to `completed`. `src/services/ThreatDetection/HttpThreatDetector.ts`, `src/types/interfaces/HttpRequestCompletedEvent.ts`.

2. **Anything outliving the request must be a detached copy of a header string.** `SEC` V8 `slice`/`truncate` do not copy: a truncated 512-char slice of a 14 000-char User-Agent keeps the whole parent alive (hundreds of MB across thousands of map entries).
   *Tell:* a `Map.set(key, {userAgent: header.slice(...)})` or any header/URL string stored past the request.
   *Check:* store `HttpThreatText.detach(...)` results (a Buffer round-trip copy) for keys and values; truncating the key bounds only its length, not the retained parent. `src/services/ThreatDetection/HttpThreatText.ts`, `src/services/ThreatDetection/UserAgentConsistencyTracker.ts`.

3. **The memory key is built from a spoofable `clientAddress`.** `SEC` Forwarded-IP headers are client-controlled, so a forged address can poison another visitor's tracker entry and trigger false alerts.
   *Tell:* `observe(event.clientAddress, ...)` without normalization and truncation.
   *Check:* `MAX_CLIENT_ADDRESS_LENGTH` truncation before `observe`, the map bounded by `maxAddresses`, and a detection is never used to block before the IP-resolution path is trusted. `src/services/ThreatDetection/HttpThreatDetector.ts`.

4. **Internal health checks send `Host: _`.** The `malformed-host` rule would flood the log every few seconds from internal balancers; internal addresses skip exactly this one rule.
   *Tell:* a new `Host`-based rule without the internal-network exemption; detector tests using only public addresses.
   *Check:* `fromInternalNetwork` (via `InternalAddress.isInternal`) skips only the host rule; every other category still fires for internal addresses. `src/services/ThreatDetection/HttpThreatRules.ts`, `src/utils/InternalAddress.ts`.

---

## OAuth

1. **`revoke` accepts a missing `client_id` - with public clients the revoke route must check it.** `SEC` `OAuthAuthorizationServer.revoke` deliberately revokes without a `client_id` (RFC 7009 allows this for confidential clients) and only skips the revocation when the presented `client_id` mismatches the token's grant; an application whose clients are all public must therefore require `client_id` in its revoke route, or anyone can revoke another client's token.
   *Tell:* a revoke route calling `revoke` without first checking `client_id`; a change to the `client_id` condition inside `revoke`.
   *Check:* the application's route rejects a request without `client_id` (public clients); `revoke` keeps rejecting a mismatching `client_id` while tolerating a missing one. `src/services/OAuth/OAuthAuthorizationServer.ts` (`revoke`).

2. **Re-consent must not resurrect revoked tokens.** `SEC` An upsert on `(user_id, client_id)` that clears `revoked_at` makes access tokens of the old grant valid again after the user re-connects; the partial unique index (`WHERE revoked_at IS NULL`) plus `createOrRenew` (a new row for a revoked grant) close this.
   *Tell:* `ON CONFLICT (user_id, client_id)` without the index predicate; `SET revoked_at = NULL` in the upsert.
   *Check:* `test/unit/PostgresOAuthStores.test.ts` keeps the re-consent case green. `src/services/OAuth/PostgresOAuthStores.ts` (`createOrRenew`).

3. **A registered loopback redirect URI matches any port.** Native clients listen on a runtime-picked port (RFC 8252 section 7.3); an exact `includes` comparison breaks them, a loose substring match opens redirects.
   *Tell:* a change to the redirect URI comparison.
   *Check:* port-insensitive matching applies only to registered HTTP loopback URIs with identical host, path and query; HTTPS stays exact. `src/services/OAuth/RedirectUriPolicy.ts`.

4. **Client metadata fetches are port- and cache-bounded.** A `client_id` may be an HTTPS URL, so validation can trigger an outbound fetch: only port 443 is allowed, and failures (status, parse) are cached for 60 s so a repeated bogus `client_id` does not fetch on every request.
   *Tell:* removal of `allowedPorts: ['443']` or of the failure cache.
   *Check:* `test/unit/OAuthClientMetadataFetcher.test.ts` (non-443 port, cached failure) stays green. `src/services/OAuth/ClientMetadataFetcher.ts`.

---

## AI connectors

1. **"OpenAi" in names means the protocol, not the vendor.** One `OpenAiConnector` over the SDK with a `baseURL` override serves any chat-completions endpoint; there is deliberately no factory or env-driven instance schema - each use case composes its connector at its composition site.
   *Tell:* a diff reintroducing a factory/env instance list, or a second connector class "because the native API has more parameters".
   *Check:* the need does not fit `new OpenAiConnector(config, logger)`; a native implementation would be an additive class implementing `OpenAiClient`. `src/services/OpenAi/OpenAiConnector.ts`, `src/services/OpenAi/OpenAiTypes.ts`.

2. **`maxRetries: 0` in the SDK is deliberate.** Retry belongs to the caller, which decides on the error's `retryable` flag; SDK auto-retry would multiply timeouts.
   *Tell:* someone "fixing" flakiness by raising `maxRetries`.
   *Check:* retry policy stays with the caller. `src/services/OpenAi/OpenAiConnector.ts`.

3. **The `thinking` option maps to exactly one parameter.** `true`/`false` -> Ollama-style `think`; `'low'|'medium'|'high'` -> OpenAI-style `reasoning_effort`; never both at once. Reasoning comes back in the separate `message.reasoning` field (an extension the SDK types do not know), mapped to `completion.reasoning`. Note: OpenAI-compatible endpoints of some hosts ignore `think:false` - only the native connector reliably disables thinking there.
   *Tell:* a diff sending both keys; reading thinking out of `content`.
   *Check:* `resolveThinking` returns exactly one key; the parser reads `message.reasoning`. `src/services/OpenAi/OpenAiConnector.ts`.

4. **`fetchImages: false` passes image URLs through; the connector's own `fetchImage` has no SSRF validation.** `SEC` The URL pass-through assumes the host fetches URLs itself; when the connector fetches (inline base64 for endpoints that require it), any URL source must be trusted (internal storage), never raw user input.
   *Tell:* a caller passing a user-supplied URL as `kind: 'url'` with `fetchImages: true`.
   *Check:* the URL source is trusted infrastructure; user-supplied URLs need the `SafeHttpsFetch`/`PublicAddress` guards first. `src/services/OpenAi/OpenAiConnector.ts` (`fetchImage`).

5. **The SDK reads `OPENAI_BASE_URL` from env as its default baseURL.** A connector constructed without an explicit `config.baseURL` silently redirects all traffic when that variable is set anywhere in the environment.
   *Tell:* relying on the default baseURL.
   *Check:* `baseURL` is always set per connector. `src/services/OpenAi/OpenAiConnector.ts`.

6. **`jest.mock("openai")` factories must export every named import the class uses.** A missing export is `undefined` at import time and only explodes at `instanceof` in the test run; the mock class hierarchy must mirror the real one because error classification depends on `instanceof` order.
   *Tell:* a new named import from `"openai"` in the connector without updating the mock factory.
   *Check:* the factory exports the name and the hierarchy order matches. `test/unit/OpenAiConnector.test.ts`.

7. **Decision models speak only the decision endpoint.** Chat endpoints reject them and a chat model on the decision endpoint is rejected the other way; classification of both errors relies on regexes over the host's error text - if the wording changes, the error degrades to a generic non-retryable one.
   *Tell:* a decision model passed to `complete()`; a chat model passed to `decide()`; a brittle assumption that `AiModelError` always matches.
   *Check:* decision consumers depend on the decision client; both rejection paths map to non-retryable errors. `src/services/Ollama/OllamaConnector.ts` (`decide`, `WRONG_MODEL_KIND`).

8. **Decision `confidence` is distribution concentration, not probability of correctness; text models ignore images silently.** Thresholds are computed from option probabilities (ties resolve by option order, so the safe option goes first); decision inputs are validated against the host's limits client-side except the pixel count (a >16 MPx image fails server-side with an unreadable 400); a text-only model answers a vision request with a hallucinated 200, so multimodality must be verified with a control image.
   *Tell:* a threshold on `confidence`; an oversized image fed to `decide()`; a vision call on an unverified model.
   *Check:* thresholds use probabilities; image dimensions are bounded by the caller; new models get a known-image smoke test. `src/services/Ollama/OllamaConnector.ts`, `src/services/Ollama/OllamaDecisionTypes.ts`.

9. **A raw `AxiosError` must never become an error `cause`.** `SEC` It carries `config.headers.Authorization` (the API key/JWT) and `config.data` (prompts, base64 images), which escape through `JSON.stringify`, `util.inspect`, loggers and error tracking. `OllamaConnector` and `SeaweedService` pass only a plain `{message, code, status, responseData}`; the Seaweed error also never rethrows the axios object.
   *Tell:* `new Ai*Error(..., error)` or `throw err` in a catch around `axios.*`; a cause assigned from the caught value unchecked.
   *Check:* serializing and inspecting the thrown error does not contain the API key or request body; `test/unit/OllamaConnector.test.ts`, `test/unit/SeaweedService.test.ts`. `src/services/Ollama/OllamaConnector.ts` (`sanitizedCause`), `src/services/SeaweedService.ts` (`throwSanitized`).

---

## Utilities

1. **`ScriptJson.serialize` is the only mechanism that makes JSON safe inside `<script>`.** `SEC` It escapes `<` to `\u003c`; the Handlebars `json` helper (`WebServer.ts`) is pretty-printing only and does NOT escape - user content containing `</script>` breaks out of the element. HTML entities (`&lt;`) do not work inside script blocks either.
   *Tell:* `{{json ...}}` inside `<script type="application/ld+json">`; a hand-rolled `JSON.stringify(...).replace(/</g, ...)` (check the replacement is `\u003c`, not a no-op or an entity).
   *Check:* JSON embedded in templates goes through `ScriptJson.serialize` only. `src/utils/ScriptJson.ts`, `src/infrastructure/Server/WebServer.ts` (`helpers.json`).

2. **Redirect targets from input must go through `SafeRedirect.localPath`.** `SEC` `startsWith('/')` alone is not enough: `//host`, `/\host` and control characters before a slash (stripped by URL parsers) all lead to another origin, and dot segments normalize into a protocol-relative path (`/..//host`, `/%2e%2e//host` become `//host`), so the normalized result is checked again.
   *Tell:* any code reading `redirect`/`returnTo`/`next` from query or body and using it in a redirect; a change in `localPath` that checks only the raw input.
   *Check:* the value passes `SafeRedirect.localPath(value, fallback)` before use; the dot-segment cases in `test/unit/SafeRedirect.test.ts` stay green. `src/utils/SafeRedirect.ts`.

3. **Absolute URLs are built from `Env.requireUrl` + `Url.join`, never from the request.** `SEC` `request.baseUrl` is the router mount path (effectively `''`), and building from the `Host` header is a host-header injection into e-mailed links; manual `${base}/${path}` concatenation produces `//` when the base ends with a slash.
   *Tell:* `request.baseUrl`/`request.hostname`/`Host` used to build an absolute URL; `${base}/...` string concatenation; a hardcoded domain.
   *Check:* the base comes from `Env.requireUrl` (requires a non-empty string and trims trailing slashes; it does not validate the URL) and assembly goes through `Url.join`. `src/utils/Env.ts` (`requireUrl`), `src/utils/Url.ts`.

4. **`Env.getNumber` parses with `parseInt`.** A fractional value like `0.01` becomes `0` and `1.5` becomes `1`, silently.
   *Tell:* a new env variable holding a fraction read via `getNumber`.
   *Check:* fractional settings use a `parseFloat`-based reader with range validation. `src/utils/Env.ts` (`getNumber`).

5. **Secrets in URLs and parameter values are redacted only through the registered patterns.** `SEC` `LoggerMiddleware` and `ErrorTracking` redact paths via `SecretPaths.redact`; `PgClient`'s debug line redacts values via `SecretValues.redactValue` (the query itself still gets the originals). An unregistered pattern (a new capability URL, a new secret parameter) leaks into logs and the tracker.
   *Tell:* a new secret-bearing URL path or query/body parameter with no `SecretPaths.register`/`SecretValues.register` call in the application bootstrap; logging a raw `request.originalUrl`.
   *Check:* every secret format is registered at startup; an empty registry means no redaction at all. `src/utils/SecretPaths.ts`, `src/utils/SecretValues.ts`, `src/infrastructure/Server/http/middleware/LoggerMiddleware.ts`.

6. **Outbound requests to user-supplied URLs go through `SafeHttpsFetch`, and IP checks through `PublicAddress`.** `SEC` String/regex comparisons of addresses miss IPv4-mapped IPv6 and embedded-IPv6 forms (`::ffff:10.0.0.1`, 6to4, Teredo, NAT64); literal IPs bypass DNS lookup, so every redirect target must be re-validated; the fetcher pins the vetted address (DNS-rebinding defense), restricts ports, enforces a deadline and does not follow redirects.
   *Tell:* a new outbound HTTP client for user input; `maxRedirects > 0`; IP comparisons on strings; a `lookup` implementation ignoring `options.all`.
   *Check:* `test/unit/PublicAddress.test.ts` and the SafeHttpsFetch tests stay green; new fetch paths reuse the fetcher with `allowedPorts`. `src/utils/PublicAddress.ts`, `src/utils/SafeHttpsFetch.ts`.

7. **An emoji file name is the `EmojiKey`, not "the hex".** Code points joined by `-`, the variation selector `fe0f` dropped, the zero-width joiner kept as `200d` (`'❤️'` -> `2764`, the mermaid -> `1f9dc-200d-2640`); any second implementation of this derivation drifts.
   *Tell:* hand-built `/img/emoji/...` paths or ad-hoc `codePointAt(...).toString(16)` outside `EmojiKey`.
   *Check:* keys come from `EmojiKey`; `test/unit/EmojiKey.test.ts` stays green. `src/utils/EmojiKey.ts`.

8. **iCalendar line folding counts UTF-8 octets, not characters.** RFC 5545 limits a line to 75 octets: cutting by `string.length` produces overlong lines, cutting by bytes splits a code point (U+FFFD after unfolding); `foldLine` iterates code points.
   *Tell:* a change to the folding logic or new long-property generation without folding.
   *Check:* folding tests cover non-ASCII and 4-byte characters. `src/utils/ICalendar.ts` (`foldLine`).

9. **EXIF from untrusted files needs `NulChar` (built in) and defensive consumers.** The shared readers (`readExif`/`readMetadata`) already strip NUL and lone surrogates, but `reviveValues: true` still returns a raw string for an unparseable camera date (`"0000:00:00 00:00:00"` - not `Date`-parsable) and `NaN`/`Infinity` for broken rationals; `NaN` is truthy, so truthiness filters pass garbage through to formatting.
   *Tell:* a consumer doing `new Date(exif.field)` or `if (exif.Number)` on reader output; a new exifr option bypassing the shared readers.
   *Check:* guard dates with `Number.isNaN(date.getTime())` and numbers with `Number.isFinite(n) && n > 0` (EXIF 0 means "unknown"). `src/utils/ImageMetadata.ts`.

10. **The `canonicalUrl` helper drops the query string (`origin + pathname`).** Two URLs differing only in query parameters canonicalize to the same address.
    *Tell:* a change adding `search` to the helper's output; a consumer expecting query variants to keep distinct canonicals.
    *Check:* the helper stays query-less; consumers needing distinct canonicals per query variant must not rely on it. `src/infrastructure/Server/helpers/CanonicalUrl.ts`.

11. **Only TEXT values are escaped in the iCalendar writer.** `SEC` `UID`, `URL`, `PRODID`, `METHOD` and `STATUS` are written raw, so a CR/LF in any of them injects extra properties into the feed. `ICalendar` rejects C0 control characters in those properties and requires `URL` to be an absolute `http:`/`https:` URL.
    *Tell:* a new `PROP:${value}` where `value` is caller- or user-supplied; escaping applied only to `SUMMARY`/`DESCRIPTION`/`LOCATION`.
    *Check:* control characters throw and `javascript:`/`ftp:` URLs are rejected; `test/unit/ICalendar.test.ts` covers both. `src/utils/ICalendar.ts` (`assertSafeValue`, `assertHttpUrl`).
