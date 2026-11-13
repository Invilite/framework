# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). During 0.x a new feature or a breaking change bumps the minor version, a fix bumps the patch.

## [0.2.1] - Unreleased

### Fixed

- `request.ip` is the client address resolved by `clientAddressOf` (`CF-Connecting-IP` when `trustCloudflare`, otherwise the `trust proxy` chain, never a non-address): `CoreMiddleware` overwrites Express's getter once per request. Behind a CDN Express alone gave the edge address there.

### Removed

- `ExtendedRequest.clientAddress`: read `request.ip`, the single client address. `SessionService` and `LoggerMiddleware` read `request.ip`. The `clientAddress` field of the request events is unchanged and carries the same value.

## [0.2.0] - Unreleased

### Added

- `TokenRevocationSource` and `TokenRevocation` in `services/TokenBlacklistService`: an optional third constructor argument of `TokenBlacklistService`. On `start()` the service subscribes to the transport first and then loads the source (a revocation broadcast during the load is not lost), and it reloads the source after every transport reconnect, so revocations survive an instance restart and missed NATS messages; a failing source makes `start()` reject.
- `REVOCATION_CONFIRM_TIMEOUT_MS` in `services/NatsTokenRevocationTransport`.

### Changed

- **Breaking:** `TokenRevocationTransport` requires `subscribeToReconnects(handler)`; `NatsTokenRevocationTransport` implements it with the connection status stream.
- `NatsTokenRevocationTransport.publishRevocation` waits for the server confirmation (`flush`) up to `REVOCATION_CONFIRM_TIMEOUT_MS` and rejects otherwise.
- **Breaking:** `TokenBlacklistService.revokeAllForUser` and `SessionService.endAll` resolve `true` when the revocation was broadcast (or there is no transport) and `false` when the broadcast failed; the local revocation stands either way. An application interface that declares `endAll(userId): Promise<void>` and receives a `SessionService` no longer type-checks: declare `Promise<boolean>` (or `Promise<unknown>`).

## [0.1.0] - 2026-11-08

### Added

- First public release.
- Decorator routing: `@Controller`, `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`, `@All`, `@Render`, `@RequiresAuth`, `@Upload`, `@WebSocketListener`.
- `WebServer` with middleware, static files, Handlebars views, 404/405/500 handling and Express 5.
- PostgreSQL client `PgClient` with query logging and slow-operation events, `PgTransaction` and `AdvisoryLock`.
- Repository and model layer: `AbstractRepository`, `PostgresRepository`, `AbstractModel`, response objects.
- JWT auth and sessions: `AuthService`, `SessionService`, refresh-token store, `TokenBlacklistService`.
- Background tasks: `TaskService`, `AbstractTask`, worker threads with cron schedules.
- Service registry: `@Service`, `AbstractService`, `ServiceRegistry`, `ServiceContainer`.
- Domain module registry: `@Module`, `ModuleRegistry`.
- WebSocket channels: `@SocketEndpoint`, `@SocketChannel`, `@SocketMessage`, socket brokers (in-memory, NATS) and the browser client.
- Storage adapters: SeaweedFS (`SeaweedStorage`, `LazySeaweedStorage`, `SeaweedService`), S3 (`S3Client`, `S3Storage`) and file storage.
- E-mail: `HbsEmailService` with Handlebars templates over a pluggable transporter.
- HTTP threat detection: `HttpThreatDetector` with rules, user-agent classification and consistency tracking.
- OAuth authorization server with PKCE, client metadata fetching and PostgreSQL stores.
- AI connectors: OpenAI-protocol (`OpenAiConnector`) and Ollama (`OllamaConnector`).
- AMQP queue plumbing (`AmqpConnection`, `@QueueConsumer`, `AbstractQueueConsumer`).
- Utilities: `Env`, `DateTime`, `CronExpression`, caches, rate limiter, `SecretPaths`/`SecretValues` redaction and more.
