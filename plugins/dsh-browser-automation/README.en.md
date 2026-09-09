# dsh-browser-automation

A DeepSeek Harness (DSH) plugin family for isolated public-web browser automation: open public pages, read bounded semantic snapshots, perform controlled interactions, and capture screenshots — without inheriting the user's logins, profiles, or secrets.

> 中文：[README.md](README.md)
> **Community plugins, not an official DeepSeek product.** DSH is in developer preview; pin versions per release.
> The npm scope is undecided: packages use the development placeholder scope `@dsh-browser-automation`, to be replaced mechanically when a publisher scope exists.

## Packages

| Package | Role |
| --- | --- |
| `packages/browser` | Service Definition: `ctx.browsers`, branded ids, owner sessions, one-shot approval orchestration, awaited cleanup |
| `packages/browser-playwright` | Isolated Playwright/Chromium provider: egress policy, network leases, sandbox-confined spawn, snapshot/act/screenshot mechanics |
| `packages/tool-browser` | Consumer: ten model-facing `browser_*` tools from one manifest |
| `packages/browser-standard` | Profile bundle (`dsh.bundle.patch` + `cordis.patch.yml`) composing the three above |

## Security model (V1)

- Fresh temporary browser profile per session; no extensions, no existing logins, mock keychain, never `--no-sandbox`.
- File confinement through the harness `ctx.sandbox` seam (full enforcement required; `read-only`/partial fail closed); network isolation is this plugin's own egress policy.
- Egress: exact http(s) only, no userinfo/control characters, DNS answers must be public, no query/fragment navigation targets, same-origin subresources by default, WebSockets/service workers/downloads/popups disabled, operation-scoped network leases.
- One-shot user approval per write action (`approval/request` waterfall), TOCTOU re-verification at the action site; opaque refs bound to generation + observation + fingerprint.
- Untrusted web content is never a trust statement; snapshots never expose HTML, selectors, hidden values, or password fields.

See the package READMEs, `PROVENANCE.md`, `SECURITY.md`, `PRIVACY.md`, and `docs/`.

## Development and acceptance

```bash
pnpm install
pnpm run typecheck
pnpm run test            # includes real-Chrome integration (self-skips without Chrome)
pnpm run test:coverage   # per-file 100% hard gate
pnpm run build
node scripts/exports-check.mjs
```

Real-harness acceptance (run inside a DeepSeek Harness checkout, isolated DSH_HOME):

```bash
node plugins/dsh-browser-automation/scripts/acceptance.mjs
# CLI install → composed dump → official boot() mount assertions → tarball
# pack/install → keyless read-only call → uninstall; the whole chain exits 0
```

## Install (profile bundle)

```bash
dsh plugin --profile web add <bundle package name or local tgz path>
```

Write actions need an answerer that displays tool calls (`web` profile); profiles without one fail closed. Uninstalling never deletes browsers or user data outside the plugin's own per-session temporary directories.

## Known limitations (V1)

- DNS-based egress reduces but cannot eliminate DNS-rebinding races; platforms without a connect-IP proof are documented, not claimed SSRF-proof.
- Turn-boundary cleanup relies on idle deadlines, plugin disposal, and explicit close (no plugin-subscribable turn-end event at this baseline).
- Approval reasons and the `approval/asked`/`approval/decided` audit pair are durably logged with the session.
- The same-origin default blocks common CDN patterns; operators must allowlist static origins explicitly, accepting the data-receiver disclosure.
