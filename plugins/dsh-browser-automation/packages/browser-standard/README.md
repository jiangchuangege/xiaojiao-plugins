# @dsh-browser-automation/dsh-browser-standard

Profile bundle for the isolated browser automation capability. Install into a dsh profile:

```bash
dsh plugin --profile web add @dsh-browser-automation/dsh-browser-standard@0.1.0-rc.1
```

Composition: `dsh-browser` (Service Definition, `ctx.browsers`), `dsh-browser-playwright` (isolated Playwright/Chromium provider), `dsh-tool-browser` (ten model-facing tools). All security defaults ship conservative: fresh temporary profile per session, egress policy with same-origin subresources, one-shot approvals for every write action, sandbox-confined browser process where the host enforces it.

> Scope: the local placeholder scope `@dsh-browser-automation` is a development stand-in; the publisher scope is decided before any publication.

## Interactive approval

Write actions (`browser_navigate`, `browser_click`, `browser_fill`, `browser_press`, `browser_screenshot`) require one-shot user approval through `ctx.approval`. Use a profile whose answerer can display tool calls (the `web` profile); a profile without an answerer fails closed.

## Uninstall

```bash
dsh plugin --profile web remove @dsh-browser-automation/dsh-browser-standard
```

Uninstalling never deletes browsers, profiles, or user data outside the plugin's own per-session temporary directories (which close removes).
