# threat-model.md

## Assets

User browsing privacy, host files, ambient credentials, session logs, and the model's decision quality.

## Adversaries

1. **Malicious or compromised web pages** — the primary adversary. They control all DOM/ARIA content, URLs, redirects, and network timing.
2. **A prompt-injection attempt through page content** — text crafted to make the model misuse tools.
3. **Network-positioned attackers** — redirects, DNS manipulation.
4. **A malicious model call** (prompt-crafted tool arguments).
5. **A malicious plugin sharing the process** (documented as out of scope: same-process plugins are not a sandbox boundary).

## Threats and controls

| Threat | Control |
| --- | --- |
| SSRF via private/metadata targets | Egress policy on every request: exact http(s), no userinfo/control chars, DNS answers must be public; per-request re-validation; loopback only under the test-only flag. Residual: DNS-rebinding races; platforms without a connect-IP proof are documented, not claimed SSRF-proof. |
| Exfiltration by subresources | Same-origin subresources by default plus an operator allowlist whose entries are disclosed as data receivers. |
| Cross-origin navigation without approval | Approval bound to the exact origin; navigation scope enforced at the route; post-goto origin re-check; cross-origin link clicks blocked at the network layer. |
| WebSocket/service worker/download/popup bypasses | Disabled at the control plane; WebSocket handshakes closed via `routeWebSocket`. |
| Stale target (TOCTOU) | Refs bind observation id + document generation + element fingerprint; actions re-extract and require an exact single match; any change fails with `STALE_REF`/`TARGET_NOT_FOUND`/`TARGET_NOT_ACTIONABLE`. |
| Prompt injection | Content is tagged `untrusted-web-content`; approvals are minted only by the Service from live provider data; page text never enters approval reasons or grants. |
| Credential theft via the browser process | Fresh temp profile, env allowlist, mock keychain, sandbox-confined spawn (full enforcement required), no `--no-sandbox`. |
| Model misuse of write tools | One-shot `allowed-once` approvals per action; rejected/cancelled/unavailable fail closed; permits are one-shot and expiring. |
| Argument/result leakage | Password/file/hidden fields never extracted; errors and renders are redacted; screenshots commit as durable attachments without paths or base64. |
| Resource exhaustion | Snapshot/scroll/screenshot/wait budgets, operation deadlines, network leases, idle session close, total process teardown. |

## Documented non-goals

Same-process plugin isolation, kernel/browser zero-day resistance, perfect detection of dangerous business semantics (payments, deletions), and durable-attachment retention control (the harness attachment seam has no delete/TTL API).
