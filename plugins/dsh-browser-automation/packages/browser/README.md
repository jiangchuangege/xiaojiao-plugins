# @dsh-browser-automation/dsh-browser

Service Definition for the isolated public-web browser automation capability seam (`ctx.browsers`) of DeepSeek Harness.

The service owns the provider registry, owner-scoped sessions, public branded ids, one-shot approval orchestration, per-session serialization, idle deadlines, and awaited cleanup. Providers (`BrowserBackend` implementations) own browser mechanics only. This package exposes no Playwright types, selectors, or handles: opaque refs bind `session + page + generation + observation + element fingerprint`.

> Scope: the local placeholder scope `@dsh-browser-automation` is a development stand-in; a publisher scope replaces it before any npm publication.

## Service surface

- `registerBackend(backend)` — register a `BrowserBackend`; returns the exact disposer (unregister + close its sessions). Duplicate backend types throw.
- `start(owner, request, operation)` — one owner-exclusive session with a single blank page. Zero backends → `PROVIDER_UNAVAILABLE`; multiple without explicit selection → `PROVIDER_AMBIGUOUS`; more than `maxSessionsPerAgent` → `SESSION_LIMIT_EXCEEDED`.
- `navigate(owner, request, operation)` — exact-URL navigation after a one-shot `allowed-once` approval bound to the reduced origin.
- `observe(owner, request, operation)` — bounded semantic observation; read-only, auto-allowed.
- `act(owner, request, operation)` — one mutation (`click`/`fill`/`press`/`scroll`) after a one-shot approval; `scroll` is auto-allowed by default. The backend re-verifies the target at the action site (TOCTOU).
- `screenshot(owner, request, operation)` — viewport capture after a one-shot approval; returns in-memory PNG bytes. Attachment persistence belongs to the Consumer.
- `close(owner, request, operation)` — idempotent close that waits for quiescence.
- `closeAllFor(owner)` — close every session of one agent (turn cleanup, HMR).

Every operation carries a caller `AbortSignal`, an operation budget (`timeoutMs`), and the live agent; owner checks compare agent identity, never model-forgeable strings. Approval asks go through `ctx.approval` (`approval/request` waterfall); a missing approval service fails closed with `APPROVAL_UNAVAILABLE`.

## Error contract

Stable codes (see `BROWSER_ERROR_CODES`): `INVALID_ARGUMENT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_AMBIGUOUS`, `RUNTIME_MISSING`, `SESSION_NOT_FOUND`, `SESSION_LIMIT_EXCEEDED`, `OWNER_MISMATCH`, `STALE_REF`, `TARGET_NOT_FOUND`, `TARGET_NOT_ACTIONABLE`, `APPROVAL_REJECTED`, `APPROVAL_CANCELLED`, `APPROVAL_UNAVAILABLE`, `NAVIGATION_BLOCKED`, `NETWORK_POLICY_BLOCKED`, `ROUTE_NOT_IMAGE_CAPABLE`, `UNSUPPORTED_ACTION`, `OUTPUT_LIMIT_EXCEEDED`, `TIMEOUT`, `ABORTED`, `PAGE_CRASHED`, `BROWSER_CRASHED`, `UNKNOWN`.

Messages never contain absolute paths, argv, environment variables, secrets, raw stderr, HTML, cookies, headers, or undisclosed URLs.

## Known limitations and deferred work

- Turn-boundary auto-close relies on idle deadlines, plugin disposal, and explicit close; DeepSeek Harness exposes no plugin-subscribable turn-end event at this baseline.
- Approval `reason` strings and the `approval/asked` / `approval/decided` audit pair are durably logged with the session; the Consumer/README must disclose this retention.
- `OWNER_MISMATCH` is declared but structurally unreachable through this service's identity-checked entry points; it remains part of the contract for future remote providers.

## Model, token, and KV-cache effects

This package registers no tools and produces no model-visible content by itself. The Consumer (`dsh-tool-browser`) owns tool schemas and renders; observations rendered to the model count as tool-result tokens bounded by the provider's snapshot budgets.
