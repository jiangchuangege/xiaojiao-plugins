# @dsh-browser-automation/dsh-browser-playwright

Isolated Playwright/Chromium provider for the `dsh-browser` capability seam. Registers backend type `playwright-isolated`.

## Security model

- **Process file confinement via the harness sandbox seam.** Under a `workspace-write` policy the backend calls `ctx.sandbox.confine(argv, policy)` and requires `enforcement: 'full'`; `partial` enforcement fails closed. `danger-full-access` runs unconfined (explicit operator choice). `read-only` fails closed: a browser needs writable temporary storage. The sandbox seam governs file effects only — network isolation is this provider's own job.
- **Egress policy.** Every request (navigation, redirect hops, subresources, iframes) is routed through a policy: exact http(s), no userinfo/control characters, DNS answers must be public (loopback only under the test-only `allowLoopback` flag), navigation targets carry no query/fragment and use port 80/443. Subresources are same-origin by default plus an operator `staticResourceOrigins` allowlist. WebSockets, service workers, downloads, and popups are disabled. Each mutation/navigation runs under an operation-scoped network lease; outside the lease all requests are aborted.
- **Isolation.** Fresh temporary user-data-dir per session, env allowlist (`HOME`, `TMPDIR`, `LANG`, `PATH`), extensions disabled, no existing profiles, no `--no-sandbox`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.
- **Untrusted content.** Snapshots come from a frozen extraction script and are always treated as untrusted web content; password/file/hidden inputs are never extracted; no HTML, attributes, scripts, or selectors are returned.

## Known limitations and deferred work

- Egress classification resolves DNS at request time; it reduces but cannot eliminate DNS-rebinding races. Platforms where a connect-IP proof is impossible are documented, not claimed as SSRF-proof.
- The confined launch path uses Chrome's `--remote-debugging-pipe` as provider-internal Playwright transport (never exposed); on platforms where Seatbelt/Landlock/ACL confinement of Chrome is unavailable the spawn fails closed.
- Same-origin default blocks common CDN patterns; operators must explicitly allowlist static origins, accepting the data-receiver disclosure documented in the plan.

## Model, token, and KV-cache effects

This package produces no model-visible content directly. Snapshot sizes bound the tool-result tokens the Consumer renders: `snapshotMaxNodes`, `snapshotMaxTextBytes`, `snapshotMaxNameChars`, and `snapshotMaxDepth` cap every observation.
