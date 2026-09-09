# architecture.md

Four packages, one capability seam, following the DeepSeek Harness Service Definition / Provider / Consumer / Bundle split.

## Composition

`dsh-browser-standard` (bundle) contributes three rows: the Service (`ctx.browsers`), the Playwright provider (registers a `BrowserBackend`), and the tool Consumer (registers ten tools). Row order carries no load semantics; activation is service-availability driven.

## Service Definition (`dsh-browser`)

Owns everything except browser mechanics: the backend registry, branded ids (`BrowserSessionId`, `BrowserPageId`, `ObservationId`, `ElementRef`), owner identity checks, one-shot approval orchestration through `ctx.approval`, per-session serialization, operation deadlines derived from tool budgets, idle deadlines, and awaited teardown. Providers implement `BrowserBackendSession`: `navigate`/`observe`/`act`/`screenshot`/`wait`/`close`, receiving service-minted permits for approved actions.

## Provider (`dsh-browser-playwright`)

- **Launch**: Chrome over `--remote-debugging-pipe` (fd 3 write / fd 4 read, null-terminated JSON, early-frame buffering), private temp profile + env allowlist, mock keychain on macOS, never `--no-sandbox`. Under a `workspace-write` sandbox policy the full argv passes through `ctx.sandbox.confine` with full enforcement required; `danger-full-access` runs unconfined; `read-only` fails closed.
- **Network control plane**: one `context.route` handler gates every request (lease → scheme → egress/DNS → navigation origin scope → subresource origin scope); WebSockets closed via `routeWebSocket`; downloads/popups/service workers disabled at the context level. Each mutation/navigation runs under an operation-scoped lease; outside the lease all in-flight and new requests are aborted.
- **Observations**: a frozen, self-contained extraction function runs inside the page; elements become opaque refs bound to observation id + document generation + a fingerprint of role/name/text/editable/disabled. Actions re-extract, match the fingerprint exactly, and act through a fresh internal path; generation bumps invalidate prior refs.
- **Teardown**: the launcher disposer races a graceful close against a 2s bound, then SIGTERM/SIGKILL, then removes private temp dirs.

## Consumer (`dsh-tool-browser`)

One manifest declares name, description, parameter schema, output schema, timeout, approval kind, render, and executor for all ten tools. Executors reject unknown root parameters (the harness parameter root is open by design) and build `BrowserOperation`s from the live `ToolRunContext`. `browser_screenshot` registers through a nested inject of `attachments` + `llm`: the image-route gate reads `agent.options` and `resolveModelInfo.inputModalities` before capture; bytes are validated against attachment limits and committed via `saveImage`; renders return the durable image block.

## Cross-cutting

- Untrusted web content is data, never a trust statement; approval reasons are built from live provider data plus a nonce and are durably logged with the `approval/asked`/`approval/decided` audit pair.
- Coverage: per-file 100% with two documented exemptions — `types.ts` (types-only) and the page-side extractor (executes inside the browser process; behavior asserted by the real-Chrome suite).
