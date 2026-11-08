# AGENTS.md

Compact guidance for anyone, human or agent, changing `@invilite/framework`. Read before editing.

## Project goal and prime directive

This repository is a **generic framework with its own design**, published to npm as `@invilite/framework`. The overarching rule:

> **Nothing application-specific enters this repository.** No application names, domain terms or business rules. Anything an application must decide comes in through options, registries or subclasses. Code is not moved here only to share it between applications: if a piece only serves one application, it stays in that application.

This shapes every decision: a hardcoded value an application could disagree with is a bug; a class that knows a domain is in the wrong repository; examples and test data use neutral names (`ArticleController`, `UserRepository`, `example.com`). Code, tests, docs and commits never name an application, company, deployment or incident (the author line is the only exception).

## Architecture

Source lives in `src/`:

- `client/` - the browser WebSocket client, plain JavaScript, no build step. Served by `SocketRegistry`; `stage-package.js` copies it into the package because `tsc` does not emit it.
- `controllers/` - abstract bases every application controller extends (`AbstractController`, `AbstractSocketController`, `AbstractSocketEndpoint`).
- `decorators/` - all decorators: `WebServer/` (HTTP routes, auth, uploads, sockets), `Service`, `Module`, `Task`, `Queue/QueueConsumer`, `SecretGuard`.
- `errors/` - the error hierarchy: `ApplicationError`, one `HttpError` subclass per status, database/storage/socket errors.
- `infrastructure/` - the machinery behind the decorators: HTTP server and middleware, PostgreSQL client, transactions and advisory locks, storage adapters, task workers, service and module registries, AMQP queue plumbing, caches, `ServiceContainer`.
- `models/` - `AbstractModel`, request/socket extensions, response objects.
- `repository/` - `AbstractRepository` and `PostgresRepository`.
- `services/` - the ready-made services: sessions, auth, tasks, translations, e-mail, error tracking, threat detection, OAuth, AI connectors, storage, socket brokers, heartbeat.
- `types/` - shared enums, interfaces and types.
- `utils/` - standalone helpers without dependencies on the rest of the framework.
- `validators/` - validation bases.

Tests in `test/unit/` run with jest and ts-jest; fixtures only in `test/unit/fixtures/`.

## Public API is the file layout

The published package root equals `src/`: a file `src/<path>.ts` is imported as `@invilite/framework/<path>`, and there is no root import and no `exports` map. Consequences:

- Renaming or moving a file under `src/`, or changing an exported name, is a **breaking change**: bump the minor version in 0.x and say so in `CHANGELOG.md`.
- Do not add a root entry or an `exports` field without a deliberate version bump: both change how every existing import resolves.
- Directory indexes (`types`, `utils`, `decorators/WebServer`, `errors/ApplicationError/HttpError`, `infrastructure/Server/helpers`, `infrastructure/Server/http/middleware`) must not re-export modules that need optional peers: importing an index must never force `sharp`, `exifr`, `openai`, `@sentry/node`, `amqplib` or `aws4fetch` on the application.

## Compatibility

Compile against the lowest supported toolchain, run on the newest:

- `typescript ~5.5`, `@types/express ^4.17`, `@types/node ^22`, CommonJS output.
- Node.js >= 24 (`engines`), `moduleResolution: node` in consumers.
- `zod` v4 (peer): `z.record` takes the key and the value schema, `z.record(z.string(), z.any())`.

## Versioning

During 0.x: a new feature or a breaking change bumps the **minor** version, a fix bumps the **patch**. Every release consists of: the version in `package.json`, an entry in `CHANGELOG.md` (Keep a Changelog) and the tag `vX.Y.Z`. Unreleased work for the same version is added to the same `CHANGELOG.md` entry, not to a new one.

## Release gate

Before every release, in this order, all must pass:

1. `npm run build && npm test`.
2. `npm pack ./build --dry-run` lists only `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, `*.js` and `*.d.ts` (plus the directories they live in). Anything else in the tarball is a packaging bug.
3. Private data scan, reviewed by hand: e-mail addresses, domains other than `example.com`/`example.org`, local paths and private network addresses, in every tracked text file and in the build output. The author line in `package.json`, `README.md` and `LICENSE` and the RFC-style test addresses (`user@example.com`) are expected hits.
   ```bash
   git grep -nIiE "[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|https?://[a-z0-9.-]+|/home/|192\.168\.|10\.[0-9]+\.[0-9]+\.[0-9]+" -- . ':!package-lock.json'
   grep -rnIiE "[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|https?://[a-z0-9.-]+|/home/|192\.168\.|10\.[0-9]+\.[0-9]+\.[0-9]+" build
   ```
4. The maintainer alone pushes, tags and runs `npm publish ./build` (2FA). `npm publish` in the repository root is blocked on purpose by `prepublishOnly`; do not remove that block.

## Traps go to REVIEW.md

A trap is a non-obvious behavior that caused (or could have caused) a bug and is not visible from the code alone. When you hit or diagnose one, append it to `REVIEW.md` in the same session:

- one entry = one trap, format: **Trap** (what) -> *Tell* (how to spot it in a diff) -> *Check* (what to verify) + file/symbol; tag `SEC` for security traps;
- if the entry already exists, update it instead of duplicating;
- when a trap is fixed systemically, update the entry to the current state (what is fixed, which residual traps remain) instead of deleting it.

## Code style

- Explicit types, also on `const`; descriptive names without abbreviations; no `any` in new code.
- `public` keyword explicitly on public methods; opening braces on the same line.
- No new comments, in any file (source, tests, the browser client, scripts, configuration), JSDoc included. An existing comment may be corrected when the code it describes changes, or deleted. Knowledge the code cannot show goes into names, tests and `REVIEW.md`. When a comment seems truly necessary, ask the maintainer for approval before adding it.

## Commands

- `npm run build` - clean, then `tsc -p tsconfig.json`, then `scripts/stage-package.js` which writes `build/package.json` (from the root one, minus scripts and devDependencies) and copies `LICENSE`, `README.md`, `CHANGELOG.md` (it fails when any of the three is missing) and every non-TypeScript, non-dotfile file from `src/` (the browser client). The published tarball contains only those three documents plus `package.json` and the compiled code (`*.js`, `*.d.ts`), compiled without comments (`removeComments`): comments stay in the repository only. `docs/` and `REVIEW.md` are repository-only.
- `npm test` - the jest unit suite.
- `npm run pack:local` - build plus `npm pack ./build` into `dist/invilite-framework-<version>.tgz` for testing in an application.

## Commits

Format: `Area: description` (for example `WebServer: explain 405 handler order`). No AI attribution of any kind.
