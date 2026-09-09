# model-experience.md

## When tools appear

The Consumer registers the ten tools with the `browsers` + `tools` seams; `browser_screenshot` additionally requires the `attachments` + `llm` seams and an image-capable model route (checked per call through `inputModalities`). A text-only default route (the current DeepSeek default) rejects screenshots with `ROUTE_NOT_IMAGE_CAPABLE` before capture.

## Recommended flow

1. `browser_start` once per task (one session per agent; the limit error is `SESSION_LIMIT_EXCEEDED`).
2. `browser_navigate` to an exact public URL (no query/fragment/userinfo).
3. `browser_snapshot` → element refs.
4. Act on refs (`browser_click`/`browser_fill`/`browser_press`/`browser_scroll`); every mutation invalidates prior refs, so re-snapshot after each action.
5. `browser_wait` for bounded settling; `browser_screenshot` where the route allows.
6. `browser_close` (or rely on idle/dispose cleanup).

## Failure recovery

- `STALE_REF` / `TARGET_NOT_FOUND`: re-snapshot and use a fresh ref.
- `APPROVAL_REJECTED`/`APPROVAL_CANCELLED`/`APPROVAL_UNAVAILABLE`: do not retry the same action without user consent.
- `NETWORK_POLICY_BLOCKED`: the target (or a hop) is not public or carries a query/fragment; pick another URL.
- `NAVIGATION_BLOCKED`: a redirect left the approved origin or the navigation failed.
- `PROVIDER_UNAVAILABLE`: no browser backend is registered in this profile.
- `SESSION_NOT_FOUND`: no live session — start one first.

## Token/KV/latency impact

Snapshots dominate token cost: `snapshotMaxNodes`/`snapshotMaxTextBytes`/`snapshotMaxNameChars`/`snapshotMaxDepth` bound every observation, and the render is one line per element. Screenshots add one image block plus attachment bytes, gated to image routes. Cold Chrome start dominates latency; sessions persist per turn only (idle deadline, explicit close, or plugin disposal end them).

## Out of scope

Multi-tab, frame targeting, uploads/downloads, credentials, arbitrary JavaScript, CDP, and user-login flows.
