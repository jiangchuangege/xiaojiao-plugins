# PRIVACY.md

## What the plugin touches

- It opens only the URLs the model asks to open, inside an isolated temporary browser profile; the user's real browser, profiles, logins, cookies, history, and passwords are never touched.
- Browsed sites receive normal page requests from the isolated context (same-origin subresources by default, plus explicitly allowlisted static origins). Text entered with `browser_fill` is sent to the target site; the plugin cannot control what the site then does with it.

## What is recorded in the harness session

- Tool arguments (`browser_navigate` URLs, `browser_fill` text, refs) are durably logged with the session. Never enter secrets, credentials, OTP codes, or payment data — this is a caller contract, not a technical guarantee.
- Snapshot results (title, origin, bounded element labels) and action results are logged as tool results.
- Every approval ask logs an `approval/asked` / `approval/decided` audit pair, including the approval `reason` string (origin, action kind, redacted target, nonce). Reasons never contain page-provided prose or entered text.
- Screenshots become durable attachments owned by the deployment's attachment store. The current harness attachment seam has no delete/TTL/GC API, so the plugin cannot promise deletion at session close; retention is the operator's attachment backend policy. If that boundary is unacceptable, set the consumer config `screenshot: false` to disable the tool entirely.

## What is not recorded or exposed

- No console, network bodies, cookies, storage, history, HAR, traces, or raw DOM collection or export exists.
- No absolute paths, browser argv, environment variables, or base64 blobs enter tool results or errors.
- The plugin ships no telemetry of its own.

## Deployment notes

- The harness's FULL telemetry level may record messages, tool arguments/results, and paths; avoid it for sensitive browsing.
- Browser stderr goes to a session-private log file inside the temporary directory and is deleted with the session.
- Temporary directories (profile, home, captures) are removed on close; a hard process kill can strand them in the OS temp directory until the OS reaps them.
