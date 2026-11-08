# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). During 0.x a new feature or a breaking change bumps the minor version, a fix bumps the patch.

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
