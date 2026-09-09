# PROVENANCE.md

Clean-room record for the public release candidates. This workspace is the local implementation; the public repository is cut from it only after owner-only provenance review.

## Sources used

- **DeepSeek Harness public surface** — `CONTRIBUTING.md`, `docs/user/develop/basic/publish.md`, `README.md`, the published `@deepseek-ai/cordis@4.0.1` and `@deepseek-ai/dsh-*` npm packages, and the harness's documented capability-seam conventions (Service Definition / Provider / Consumer / Bundle). Every API named in code (`ctx.tools.register`, `defineTool`, `ctx.approval`, `ctx.attachments.saveImage`, `ctx.llm.resolveModelInfo`, `ctx.sandbox.confine`, `dsh.bundle.patch`) was verified against the baseline commit `47f943859bef60e4160492346772ded9b24f765a`.
- **Playwright** — `playwright-core@^1.62.1` (Apache-2.0) and its public documentation for isolated contexts and the `--remote-debugging-pipe` transport.
- **Chromium/Chrome** — the operator-provided executable; the plugin never downloads binaries.

## Not copied

- No CrabCode/Acosmi private source, protocols, prompts, rule tables, tests, error strings, URLs, extension ids, or brand assets were consulted or copied. The implementation was written from the public contract listed above; behavioral parallels (isolated contexts, approval-per-action, stale-ref fences) are re-derived from public requirements, not from any private implementation.
- No files from the DeepSeek Harness repository are vendored; runtime dependencies resolve from npm (or the operator's profile installation).

## Dependency inventory (runtime)

| Package | Version | License |
| --- | --- | --- |
| `@deepseek-ai/cordis` (peer) | `>=4.0.1 <5` | MIT (per published metadata) |
| `@deepseek-ai/schemastery` | `^3.18.1` | per published metadata |
| `@deepseek-ai/dsh-tools` | `0.0.1-rc.1` | per published metadata |
| `playwright-core` | `^1.62.1` | Apache-2.0 |

All other `@deepseek-ai/dsh-*` references are type-only (erased at build). Exact tarball-level license audit (`THIRD_PARTY_NOTICES.md`) is completed before any publication.

## Publication status (2026-08-13)

- [x] Source published to the community plugin collection `acosmi/dsh-plugin` (public), under `plugins/dsh-browser-automation/`. The exported tree contains only this plugin's clean-room source, tests, docs, and lockfile — no node_modules, build outputs, private audit drafts, absolute local paths, or internal URLs (verified by a pre-push scan).
- [ ] npm publication: No-Go until a publisher scope, a locked npm harness baseline, SBOM/NOTICE generation, and the owner-only offline provenance review below are complete.

## Publication checklist (before any npm release)

- [ ] Publisher npm scope decided; `@dsh-browser-automation` placeholder replaced mechanically.
- [ ] Harness release baseline locked to an npm-published version; compatibility verified against it (the local workspace tracks a newer `master`).
- [ ] `pnpm pack` artifacts allowlist-audited (no src maps, fixtures, absolute paths, internal URLs, CrabCode/Acosmi identifiers).
- [ ] SBOM (CycloneDX/SPDX) + per-tarball LICENSE/NOTICES generated.
- [ ] Owner-only offline provenance/similarity review completed and signed.
