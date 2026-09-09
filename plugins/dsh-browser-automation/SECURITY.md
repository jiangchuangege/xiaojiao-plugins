# SECURITY.md

## Reporting

Report vulnerabilities privately to the maintainers (contact channel is set when the public repository exists). Provide the affected version, a minimal reproduction, and whether the report may be disclosed after remediation. Target response: acknowledgement within 5 business days; supported versions are the latest release line and the immediately preceding minor.

## Threat model (V1)

Trusted: the harness Loader, the browser Service Definition, the audited provider, the tool Consumer, the live agent owner, the in-turn approval outcome, and operator configuration.

Untrusted: model-generated arguments, every page and its DOM/ARIA/images/iframes/popups, URLs and redirects, download names, site scripts, browser error text, remote responses, and anything a page claims ("user already consented").

Enforced at the operation site, never by prompt alone:

- One-shot `allowed-once` approval per write action, bound to call id, agent, session, page, origin, argument digest, element fingerprint, generation, nonce, and expiry; rejected/cancelled/unavailable/timeout all fail closed.
- TOCTOU re-verification at the action site; stale or changed targets fail with `STALE_REF`/`TARGET_NOT_FOUND`/`TARGET_NOT_ACTIONABLE` — no fuzzy re-matching.
- Egress policy on every request: exact http(s), no userinfo/control characters, DNS answers must be public (loopback only under the test-only flag), navigation targets carry no query/fragment, subresources same-origin by default, WebSockets/service workers/downloads/popups disabled, operation-scoped network leases.
- Browser process file confinement through the harness `ctx.sandbox` seam with full enforcement required; `read-only` and partial enforcement fail closed. No `--no-sandbox`, mock keychain, env allowlist, per-session temp profile.
- No interface to cookies, storage, credentials, arbitrary JS/CDP, uploads, downloads, or files; password/file/hidden fields never extracted or writable.

## Not promised

- Same-process plugins are not a security boundary against malicious plugins; the Service is a capability boundary, not a sandbox.
- DNS-resolution-based egress reduces but cannot eliminate DNS-rebinding races; platforms without a connect-IP proof must not be claimed SSRF-proof.
- The plugin cannot detect all dangerous business semantics (payments, deletions); it hard-rejects identifiable ones and relies on no-inherited-login + per-action approval for the rest.
- Browser/kernel zero-days are out of scope; disclose and upgrade.

## Deployment guidance

- Write tools require a profile whose approval answerer shows the exact target (`web` profile); without an answerer everything fails closed.
- Keep `allowLoopback` at its default `false` outside tests; it exists for fixture servers only.
- `staticResourceOrigins` entries are data receivers: only allowlist origins you accept receiving page data, and disclose them in PRIVACY.
- FULL telemetry profiles log tool arguments and results; do not use them with sensitive browsing.
