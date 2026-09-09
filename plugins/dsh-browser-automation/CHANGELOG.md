# CHANGELOG.md

Notable changes per release line. The workspace is a pre-release local implementation; publication tags will follow `0.1.0-rc.*`.

## 0.1.0-rc.1 (unreleased)

### Added

- `dsh-browser`: Service Definition (`ctx.browsers`) — owner-scoped sessions, branded ids, one-shot approval orchestration, per-session serialization, idle deadlines, awaited cleanup, stable error contract.
- `dsh-browser-playwright`: isolated Playwright/Chromium provider — egress policy (exact http(s), public-DNS enforcement, same-origin subresources, no WebSockets/service workers/downloads/popups), operation-scoped network leases, sandbox-confined spawn (`ctx.sandbox`, full enforcement required), bounded semantic snapshots, TOCTOU-verified actions, budgeted screenshots.
- `dsh-tool-browser`: ten model-facing tools from a single manifest; image-route gate and durable-attachment commit for `browser_screenshot`; keyless schema snapshot.
- `dsh-browser-standard`: profile bundle (`dsh.bundle.patch` + `cordis.patch.yml`).
- Real-harness acceptance script: CLI install, composition dump, real boot via app-boot, keyless read-only call, tarball pack/install/uninstall.
- Per-file 100% coverage gate (types-only files and the page-side extractor exempted, with the extractor behavior covered by the real-Chrome suite).

### Fixed

- Deterministic route/WebSocket interception install before the first operation (a spawn/install race previously allowed early requests to bypass the control plane).
- Navigation now answers the caller's AbortSignal (previously a stale goto could settle after abort).
- IPv6 documentation range `2001:db8:/32` is now blocked as a prefix (only the exact `2001:db8::` was matched before).
- Chrome pipe transport: correct fd direction, early-frame buffering, mock keychain, and non-leaking teardown; no more macOS keychain prompts.
