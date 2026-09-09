# @dsh-browser-automation/dsh-tool-browser

Model-facing browser tools (Consumer) for the `dsh-browser` capability seam. A single manifest (`manifest.ts`) owns every tool's name, description, schema, timeout budget, approval kind, render, and executor; the registered set is asserted against it.

## Tool set

| Tool | Approval | Notes |
| --- | --- | --- |
| `browser_start` | auto | Isolated session, single blank page |
| `browser_navigate` | one-shot | Exact public http(s) URL; egress policy per hop |
| `browser_snapshot` | auto | Bounded semantic snapshot, untrusted content |
| `browser_screenshot` | one-shot | Image-route gate + durable attachment; only registered with `attachments`+`llm` |
| `browser_click` | one-shot | TOCTOU re-verification at the action site |
| `browser_fill` | one-shot | Plain text only; password/file/hidden never exposed |
| `browser_press` | one-shot | Fixed single-key allowlist |
| `browser_scroll` | auto | Page or element, bounded distance |
| `browser_wait` | auto | Bounded time only, abortable |
| `browser_close` | auto | Idempotent, own session only |

Every executor rejects unknown root parameters against its manifest key set (the harness parameter root is an open object by design). Canonical results carry closed schemas; renders are pure functions of the same value.

## Security notes

- Approval flows through the service's operation executor (`ctx.approval`); the tools never mint or forward approval state.
- `browser_screenshot` checks the current model route's `inputModalities` through `ctx.llm.resolveModelInfo` before capture; text-only routes get `ROUTE_NOT_IMAGE_CAPABLE` without capturing or persisting anything.
- Screenshots are validated against the deployment's attachment limits and committed via `ctx.attachments.saveImage`; only the durable reference is returned, never paths or base64.
- `browser_fill` arguments are durably logged with the session; never enter secrets (documented in the tool description and PRIVACY).

## Known limitations and deferred work

- Turn-boundary auto-close relies on the service's idle deadline, plugin disposal, and explicit close; no plugin-subscribable turn-end event exists at this baseline.
- The screenshot tool appears only in profiles that compose `attachments` and `llm`; in others the nine non-screenshot tools remain available.

## Model, token, and KV-cache effects

Snapshots are the dominant token cost: provider budgets (`snapshotMaxNodes`, `snapshotMaxTextBytes`) bound every observation, and the render lists elements one line each. Screenshot renders add one image block and the attachment's byte cost, gated to image-capable routes only.
