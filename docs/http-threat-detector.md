# HTTP threat detector

`HttpThreatDetector` is a lightweight detector of hostile HTTP requests. It judges each request on its own (one rule keeps a short per-address memory), reads the `http.request.completed` facts the web server publishes on the `EventBus`, and announces `http.threat.detected` to subscribers. It blocks nothing and stores nothing outside the process; the only state it keeps is the bounded in-memory User-Agent memory of that one rule. The reaction (log, database, blocking) belongs to a subscriber.

- Sources: `src/services/ThreatDetection/` (`HttpThreatDetector`, `HttpThreatRules`, `HttpThreatText`, `UserAgentClassifier`, `UserAgentConsistencyTracker`), `src/types/interfaces/HttpThreatDetectedEvent.ts`, `src/types/enums/HttpThreatCategory.ts`
- Implementation traps: `REVIEW.md`

## 1. Enabling

The detector is optional: without an instance there is no subscriber, and `EventBus.emit` without listeners returns immediately. The application creates it in its composition root, for example behind an environment flag:

```ts
if (Env.getBoolean('HTTP_THREAT_DETECTION_ENABLED', false)) {
    const origin: string = Env.requireUrl('HOST_NAME');
    const canonicalHost: string = new URL(origin).hostname;
    const detector: HttpThreatDetector = new HttpThreatDetector({
        allowedOrigin: origin,
        allowedHosts: [canonicalHost, `www.${canonicalHost}`, 'localhost', '127.0.0.1', '::1'],
    }, logger);
    detector.start();

    EventBus.getChannel().on(HTTP_THREAT_DETECTED_EVENT, (event: HttpThreatDetectedEvent): void => {
        logger.warning(HttpThreatDetector.describe(event));
    });
}
```

`start()` subscribes to `http.request.completed`; `stop()` unsubscribes. Options:

```ts
interface HttpThreatDetectorOptions {
    allowedOrigin: string;                      // the service's own origin (category 8, absolute URL)
    allowedHosts: string[];                     // Host headers considered ours, port ignored (public names only)
    disabledCategories?: HttpThreatCategory[];  // by default every category is enabled
    now?: () => number;                         // clock of the User-Agent memory (tests); default Date.now
}
```

`allowedOrigin` is normalized to `new URL(...).origin`. The host list must cover every name the service legally answers on (canonical host, `www.`, `localhost`, health check addresses), or category 8 reports them as `malformed-host`. The reverse proxy must also pass the original `Host` header through (in nginx `proxy_set_header Host $host`); without it every request lands in `malformed-host`, so check the configuration before enabling in production.

The `Host` check does not apply to requests from internal addresses: loopback (`127.0.0.0/8`, `::1/128`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), link-local (`169.254.0.0/16`, `fe80::/10`) and carrier-grade NAT (`100.64.0.0/10`, never a public client address behind a proxy); IPv4-mapped forms (`::ffff:a.b.c.d`) are judged by the embedded IPv4. Load balancer and container health checks that send `Host: _` or a service name therefore never land in `malformed-host`. The exemption covers `Host` only: `malformed-origin`, `malformed-method` and the other categories apply to these addresses unchanged.

## 2. The `http.threat.detected` contract

One event per request, with the list of all hits (not one per category). It is emitted when the response closes, so a subscriber never delays the client.

```ts
interface HttpThreatDetectedEvent {
    requestId: string;
    clientAddress?: string;      // as in HttpRequestCompletedEvent: with a broad trust proxy it is client-controlled
    method: string;
    host?: string;               // the Host header, distinguishes entry through www. from the canonical name
    targetOrigin?: string;       // only when the request origin differs from allowedOrigin (category 8)
    path: string;                // decoded, redacted, truncated and sanitized
    query: string;               // decoded, redacted, truncated and sanitized
    userAgent?: string;          // truncated and sanitized
    claimedUserAgent?: string;   // only on a 'spoofing-automation-after-browser' hit; truncated, sanitized
    clientHints?: string;        // only on a hit from the 'client-hints' input; truncated, sanitized
    referer?: string;            // only when a hit concerns the referer; redacted, truncated, sanitized
    statusCode: number;
    aborted: boolean;            // true when the client broke the connection (processingTime === null)
    threats: HttpThreat[];       // at least one
}

interface HttpThreat {
    category: HttpThreatCategory;
    rule: string;                // stable rule identifier, e.g. 'sql-union-select'
    input: 'path' | 'query' | 'user-agent' | 'referer' | 'method' | 'host' | 'origin' | 'client-hints';
}
```

The payload is safe to log without extra processing: `path`, `query` and `referer` pass through `SecretPaths.redact` (the application registers its secret path patterns with `SecretPaths.register`; with none registered nothing is masked), and control characters in `path`, `query`, `userAgent`, `claimedUserAgent`, `clientHints`, `referer` and `clientAddress` become `\xNN`, or `\uNNNN` for codes above `0xff`. The payload carries no cookies and no other request headers.

For a one-line log there is `HttpThreatDetector.describe(event)`:

```
HTTP threat sql-injection from 203.0.113.7: GET /search?q=1 UNION ALL SELECT NULL-- -> 404 [sql-union-select/query] (request 6f1c...)
```

After the rules bracket the line appends the inputs the hits concern, in the order `host=...`, `origin=...`, `ua="..."`, `claimed="..."`, `ch="..."`, `referer="..."` (only for inputs present in the hit list). `claimed` is the User-Agent the address presented itself with as a browser before the automation; `ch` is the `sec-ch-ua` value. The status reads `-> <code>` or `-> aborted` when the client broke the connection.

## 3. Categories and rules

The category is a stable identifier (`HttpThreatCategory`), the rule a stable identifier within the category. Hits of the same rule on the same input are deduplicated; one rule may check several inputs.

| # | Category | Rules | Inputs |
|---|---|---|---|
| 1 | `foreign-technology-probe` | `foreign-script-file`, `foreign-wordpress`, `foreign-phpmyadmin`, `foreign-cgi`, `foreign-actuator`, `foreign-solr`, `foreign-phpunit`, `foreign-php-cgi`, `foreign-php-include`, `foreign-server-path` | `path` (also `query` for `foreign-php-include`) |
| 2 | `secret-file-probe` | `secret-dotenv`, `secret-git`, `secret-vcs`, `secret-cloud`, `secret-backup`, `secret-ds-store`, `secret-config`, `secret-project-file` | `path` |
| 3 | `sql-injection` | `sql-union-select`, `sql-error-function`, `sql-timing-function`, `sql-hex-concat`, `sql-order-by-comment`, `sql-boolean-injection`, `sql-numeric-boolean`, `sql-comment-keyword`, `sql-stacked-query`, `sql-waitfor-delay` | `path`, `query` |
| 4 | `path-traversal` | `traversal-parent-directory`, `traversal-system-file`, `traversal-file-uri` | `path`, `query` |
| 5 | `xss` | `xss-script-tag`, `xss-svg-tag`, `xss-event-handler`, `xss-javascript-uri`, `xss-alert-call`, `xss-document-cookie` | `path`, `query` |
| 6 | `command-injection` | `command-jndi`, `command-jndi-obfuscated`, `command-template-expression`, `command-shell-chain`, `command-substitution`, `command-backtick`, `command-pipe-shell`, `command-shell-binary`, `command-shellshock` | `path`, `query`, `user-agent`, `referer` |
| 7 | `scanner-user-agent` | `scanner-sqlmap`, `scanner-web-scanner`, `scanner-network-scanner` | `user-agent` |
| 8 | `malformed-request` | `malformed-method`, `malformed-origin`, `malformed-host` | `method`, `origin`, `host` |
| 9 | `user-agent-spoofing` | `spoofing-automation-after-browser`, `spoofing-client-hints-headless`, `spoofing-client-hints-non-chromium` | `user-agent`, `client-hints` |

Rules that do not follow from the table:

- path and query are percent-decoded up to twice (double encoding is a known trick) and `+` becomes a space in the query, like Express parses it; broken encoding does not stop the analysis,
- text is truncated: path and query to 2048 characters, User-Agent, Referer and `sec-ch-ua` to 512,
- rules match case-insensitively,
- category 3 requires SQL syntax, not the bare words `select`/`union`/`order`: a search box and tags accept arbitrary text,
- category 7 is a weak signal; an empty User-Agent is not a hit,
- category 8 compares the `Host` name without the port against `allowedHosts`, and the origin against `allowedOrigin`. For internal addresses (the ranges in section 1) the `Host` comparison is skipped, but `origin` and `method` are still checked,
- category 9 `spoofing-automation-after-browser` is the only stateful rule: the detector remembers, per address, the last ordinary browser User-Agent for 60 s and reports an automation (`HeadlessChrome`, `PhantomJS`, `Puppeteer`, `Playwright`) that presents itself from that address. The memory holds at most 10 000 addresses (the oldest falls out), IPv6 is grouped by the `/64` network (canonical notation, no leading zeros), IPv4-mapped addresses (`::ffff:a.b.c.d`) count as the embedded IPv4, and the automation itself stores nothing. The memory is per process: it disappears on restart and is not shared between instances,
- category 9 `spoofing-client-hints-headless` fires when `sec-ch-ua` contains the `HeadlessChrome` brand while the User-Agent does not; `spoofing-client-hints-non-chromium` fires when a non-empty `sec-ch-ua` arrives with a Safari User-Agent (without `Chrome`, `Chromium`, `CriOS`, `Edg`, `OPR`, `SamsungBrowser`) or a Firefox one. Both fire only when the User-Agent itself looks like an ordinary browser (it starts with `Mozilla/5.0` and carries no bot marker) and `sec-ch-ua` is non-empty. Edge, Opera, Samsung Internet and CriOS never hit,
- `sec-ch-ua` is read only as a mismatch signal and truncated to 512 characters. Whether a reverse proxy passes the header and whether an automation sends the `HeadlessChrome` brand after changing its User-Agent is not assumed: a missing header means no hit, so effectiveness shows in production observation,
- the category 9 memory is keyed by the client address, which a broad `trust proxy` makes client-controlled: a hit is a signal to watch, never a basis for blocking, like the whole event,
- category 9 hits can be false: an automation may share an exit address with browsers (link scanners in e-mail, VPN or proxy exits, your own headless tools), and extensions that change the User-Agent or DevTools device mode can look like a mismatch. `claimed=` is the last browser User-Agent seen for the address key, not necessarily from the same client.

## 4. What the detector cannot see

- Request bodies (`POST`/`PUT`) and headers other than `user-agent`, `referer`, `host` and `sec-ch-ua`: reading bodies costs and touches personal data.
- Requests rejected by Node's HTTP parser (a malformed request line, an unknown method parsed as a protocol error, exceeded header limits): they never reach the middleware that emits the events.
- `CONNECT`: Node handles it with a `connect` event, outside Express.
- The WebSocket handshake (`upgrade`): the socket server handles it, also outside the request middleware.
- An absolute URL with the service's own origin: the web server resolves `originalUrl` against the configured `HOST_NAME`, such a request is indistinguishable from an ordinary one and is not a threat.
- The difference between a scanner and a stale external link: a saved link like `//p/john` resolves to a foreign origin and category 8 reports it as `malformed-origin`, the same as a scanner.
- Address behaviour beyond the User-Agent inconsistency (404 series, brute force, scraping, flooding): those rules need state and counters and are deliberately left out. The User-Agent memory is bounded (60 s, 10 000 addresses), so an automation that never presented itself as a browser is not detected.

## 5. Adding a rule

1. Add an entry to `RULES` in `src/services/ThreatDetection/HttpThreatRules.ts`: `category`, a `rule` unique within the category, `inputs` (from `HttpThreatInput`) and `pattern`. The expression compiles once at module load. A rule comparing several inputs at once (like `sec-ch-ua` against the User-Agent) goes into the `match` method, next to the category 9 branch.
2. Add a hit test in `test/unit/`: every rule has at least one case, for every input it concerns. For payloads taken from the network, pass them through the detector's decoding, do not feed already-decoded text.
3. Add cases to the legitimate corpus: service addresses, accented letters, apostrophes (`o'neil`, `rock'n'roll`), the words `select`/`union`/`order`/`script` as plain text, search engine and monitoring User-Agents. The legitimate corpus must produce zero hits.
4. Do not use nested quantifiers (`(a+)+`, `(.*)*`) and bound repetitions (`{0,40}`): a test with pathological input keeps the rules free of ReDoS.

A new category needs a value in `HttpThreatCategory` and a row in the table above.

## 6. Performance

Budget: on average under 20 microseconds per request for a typical address, under 1 ms for the worst input after truncation. Rules are compiled once; the only per-address state is the bounded User-Agent memory (60 s, 10 000 addresses) of category 9. An exception in a rule is caught and logged through `RepeatThrottle` (a 10-minute window); after the window the line reports the number of suppressed errors (`... (N similar errors suppressed)`), and the request and the process continue.
